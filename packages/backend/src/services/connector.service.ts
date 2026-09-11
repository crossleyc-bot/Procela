/**
 * Connector Service
 *
 * Connects to external data sources and discovers assets. Two paths are real:
 *   - LOCAL file uploads read the bytes from disk (real row/column counts).
 *   - Direct-connect DATABASE connections whose engine the drivers support
 *     (PostgreSQL / MySQL / SQL Server / Oracle) run real catalog SQL through
 *     the shared db-source driver layer (see lib/db-source/introspect.ts).
 *
 * The remaining branches (cloud file storage, API, data warehouse, spreadsheet,
 * and databases without a configured driver/credentials) still return clearly-
 * labelled sample assets; the UI surfaces `simulated: true` so they aren't
 * mistaken for a live scan. Those would use type-specific drivers
 * (@azure/storage-blob, snowflake-sdk, …) or route through the on-prem agent.
 */

import fs from 'fs';
import net from 'net';
import { analyzeLocalFileAsync } from '../lib/local-file-connector';
import { SUPPORTED_DB_SOURCE_TYPES } from '../lib/db-source';
import type { DbSourceRequest, DbSourceType } from '../lib/db-source';
import { discoverDbSchema } from '../lib/db-source/introspect';
import { discoverMongoSchema, type MongoSourceRequest } from '../lib/db-source/mongo-introspect';
import { discoverSnowflakeSchema, type SnowflakeSourceRequest } from '../lib/db-source/snowflake-introspect';
import { discoverBigQuerySchema, type BigQuerySourceRequest } from '../lib/db-source/bigquery-introspect';
import { discoverObjectStoreAssets } from '../lib/object-storage/discover';
import type { ObjectStore } from '../lib/object-storage/types';
import { createS3Store } from '../lib/object-storage/s3';
import { createAzureBlobStore } from '../lib/object-storage/azure-blob';
import { createGcsStore } from '../lib/object-storage/gcs';
import { createSftpStore } from '../lib/object-storage/sftp';
import { decryptCredentials } from './connection-secrets';
import logger from '../lib/logger';

export interface ConnectorResult {
  success: boolean;
  message: string;
  latencyMs: number;
  /** True when the assets are illustrative sample data rather than a real
   *  discovery. A configured direct-connect DATABASE (supported engine +
   *  host + credentials) and LOCAL file uploads are REAL; API / WAREHOUSE /
   *  SPREADSHEET / cloud file storage, and databases without a driver or
   *  credentials, are still simulated. The UI surfaces this so simulated
   *  results aren't mistaken for live ones. */
  simulated?: boolean;
  details?: {
    version?: string;
    tableCount?: number;
    assets?: Array<{ name: string; type: string; rowCount?: number; lastModified?: string; columns?: string[]; columnTypes?: Record<string, string> }>;
  };
}

export interface ConnectionProfileLike {
  connectionType: string;
  config: {
    dbType?: string;
    host?: string;
    port?: number;
    database?: string;
    schema?: string;
    storageType?: string;
    bucket?: string;
    path?: string;
    region?: string;
    baseUrl?: string;
    authType?: string;
    warehouseType?: string;
    account?: string;
    warehouse?: string;
    spreadsheetType?: string;
    documentUrl?: string;
    // LOCAL file-storage-specific
    localFilePath?: string;
    originalFileName?: string;
    fileSize?: number;
    rowCount?: number;
    columns?: string[];
  };
  credentials?: {
    username?: string;
    password?: string;
    apiKey?: string;
    token?: string;
  };
}

// ---------------------------------------------------------------------------
// Real "reachability" tests
// ---------------------------------------------------------------------------
// These tests verify that the configured endpoint is reachable from the
// backend — they do NOT authenticate or query data. A real credential-
// validating test would need a per-type driver (pg, mysql2, snowflake-sdk,
// @aws-sdk/client-s3, …) which is intentionally out of scope for this
// prototype. Error messages surface timeouts, DNS failures, connection
// refused, and HTTP status codes directly.

const DB_DEFAULT_PORTS: Record<string, number> = {
  POSTGRESQL: 5432,
  MYSQL: 3306,
  SQLSERVER: 1433,
  ORACLE: 1521,
  MONGODB: 27017,
};

const TCP_TIMEOUT_MS = 5000;
const HTTP_TIMEOUT_MS = 10000;

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection to ${host}:${port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

async function httpProbe(url: string, timeoutMs: number, method: 'GET' | 'HEAD' = 'HEAD'): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { method, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Derive the probe URL for a cloud file-storage bucket. Returns null for
 * unsupported storage types (the caller falls back to a different strategy).
 */
export function resolveCloudFileUrl(storageType: string | undefined, bucket: string): string | null {
  switch (storageType) {
    case 'S3': return `https://${bucket}.s3.amazonaws.com`;
    case 'AZURE_BLOB': return `https://${bucket}.blob.core.windows.net`;
    case 'GCS': return `https://storage.googleapis.com/${bucket}`;
    default: return null;
  }
}

/**
 * Derive the probe URL for a data warehouse. Snowflake auto-completes
 * `<account>.snowflakecomputing.com`; BigQuery uses a fixed endpoint; other
 * warehouses accept either a raw host or a full URL in `account`.
 */
export function resolveDataWarehouseUrl(warehouseType: string | undefined, account: string): string {
  switch (warehouseType) {
    case 'SNOWFLAKE':
      return account.includes('.') ? `https://${account}` : `https://${account}.snowflakecomputing.com`;
    case 'BIGQUERY':
      return 'https://bigquery.googleapis.com';
    case 'REDSHIFT':
    case 'DATABRICKS':
    default:
      return /^https?:\/\//i.test(account) ? account : `https://${account}`;
  }
}

async function testDatabase(profile: ConnectionProfileLike): Promise<ConnectorResult> {
  const { host, port, dbType } = profile.config;
  const start = Date.now();
  if (!host) return { success: false, message: 'No host configured', latencyMs: 0 };
  const resolvedPort = port || DB_DEFAULT_PORTS[dbType || ''] || 0;
  if (!resolvedPort) {
    return { success: false, message: 'No port configured and no default for this database type', latencyMs: 0 };
  }
  try {
    await tcpProbe(host, resolvedPort, TCP_TIMEOUT_MS);
    return {
      success: true,
      message: `Reached ${host}:${resolvedPort} — TCP connection opened (credentials not verified)`,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  }
}

async function testApi(profile: ConnectionProfileLike): Promise<ConnectorResult> {
  const { baseUrl } = profile.config;
  const start = Date.now();
  if (!baseUrl) return { success: false, message: 'No base URL configured', latencyMs: 0 };
  try {
    // GET is more widely supported than HEAD across API gateways. A 2xx/3xx
    // is clearly healthy; 4xx is still a reachable endpoint so we surface
    // it as a warning-level success. 5xx or network errors are failures.
    const res = await httpProbe(baseUrl, HTTP_TIMEOUT_MS, 'GET');
    const reachable = res.status < 500;
    return {
      success: reachable,
      message: reachable
        ? `Reached ${baseUrl} — HTTP ${res.status}${res.status >= 400 ? ' (auth/permission may be required)' : ''}`
        : `HTTP ${res.status} from ${baseUrl}`,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start };
  }
}

async function testDataWarehouse(profile: ConnectionProfileLike): Promise<ConnectorResult> {
  const { warehouseType, account } = profile.config;
  const start = Date.now();
  if (!account) return { success: false, message: 'No account configured', latencyMs: 0 };
  const url = resolveDataWarehouseUrl(warehouseType, account);
  try {
    const res = await httpProbe(url, HTTP_TIMEOUT_MS, 'HEAD');
    return {
      success: res.status < 500,
      message: `Reached ${url} — HTTP ${res.status} (credentials not verified)`,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start };
  }
}

async function testCloudFileStorage(profile: ConnectionProfileLike): Promise<ConnectorResult> {
  const { storageType, bucket } = profile.config;
  const start = Date.now();
  if (!bucket) return { success: false, message: 'No bucket/container configured', latencyMs: 0 };

  // SFTP uses a different transport — probe port 22 on the configured host
  // (we re-use the `bucket` field as the hostname, matching the UI label).
  if (storageType === 'SFTP') {
    try {
      await tcpProbe(bucket, 22, TCP_TIMEOUT_MS);
      return {
        success: true,
        message: `Reached ${bucket}:22 — SFTP port open (credentials not verified)`,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start };
    }
  }

  const url = resolveCloudFileUrl(storageType, bucket);
  if (!url) {
    return { success: false, message: `Unsupported storage type: ${storageType || '(none)'}`, latencyMs: 0 };
  }
  try {
    const res = await httpProbe(url, HTTP_TIMEOUT_MS, 'HEAD');
    // S3/Azure/GCS typically return 403/404 for bucket-level HEAD without
    // credentials — that still proves the endpoint resolved and is live.
    return {
      success: res.status < 500,
      message: `Reached ${url} — HTTP ${res.status} (credentials not verified)`,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start };
  }
}

async function testSpreadsheet(profile: ConnectionProfileLike): Promise<ConnectorResult> {
  const { documentUrl } = profile.config;
  const start = Date.now();
  if (!documentUrl) return { success: false, message: 'No document URL configured', latencyMs: 0 };
  try {
    const res = await httpProbe(documentUrl, HTTP_TIMEOUT_MS, 'HEAD');
    return {
      success: res.status < 500,
      message: `Reached document — HTTP ${res.status} (credentials not verified)`,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start };
  }
}

export async function testConnection(profile: ConnectionProfileLike): Promise<ConnectorResult> {
  // Decrypt at-rest secrets just-in-time so the driver authenticates with the
  // real value (no-op for plaintext / when encryption isn't configured).
  profile = { ...profile, credentials: await decryptCredentials(profile.credentials) };
  switch (profile.connectionType) {
    case 'FILE_STORAGE':
      if (profile.config.storageType === 'LOCAL') return await testLocalFile(profile);
      return testCloudFileStorage(profile);
    case 'DATABASE': return testDatabase(profile);
    case 'API': return testApi(profile);
    case 'DATA_WAREHOUSE': return testDataWarehouse(profile);
    case 'SPREADSHEET': return testSpreadsheet(profile);
    default:
      return { success: false, message: `Unsupported connection type: ${profile.connectionType}`, latencyMs: 0 };
  }
}

/** Warehouse engines that resolve to a real SQL driver. Only Redshift today —
 *  it speaks the Postgres wire protocol, so it needs no new driver. Snowflake /
 *  BigQuery / Databricks require their own SDKs and stay simulated until wired. */
const WAREHOUSE_DB_TYPES: Record<string, DbSourceType> = { REDSHIFT: 'REDSHIFT' };

/** Per-engine default port applied when the profile didn't set one. Only
 *  engines whose driver doesn't already default correctly need an entry
 *  (Redshift's pg driver would otherwise assume Postgres 5432). */
const DEFAULT_DB_PORTS: Partial<Record<DbSourceType, number>> = { REDSHIFT: 5439 };

/** Map a connection profile to the driver request, when it's a database (or a
 *  Redshift warehouse) whose engine the direct-connect drivers support and it
 *  carries the host + username a real scan needs. Returns null when real
 *  discovery can't run (unsupported engine, or an unconfigured/demo connection)
 *  — the caller then falls back to the clearly-labelled sample assets. */
export function toDbSourceRequest(profile: ConnectionProfileLike): DbSourceRequest | null {
  const cfg = profile.config;
  let dbType: DbSourceType;
  let host: string | undefined;
  let database: string | undefined;
  if (profile.connectionType === 'DATABASE') {
    dbType = String(cfg.dbType || '').toUpperCase() as DbSourceType;
    if (!SUPPORTED_DB_SOURCE_TYPES.includes(dbType)) return null;
    host = cfg.host;
    database = cfg.database;
  } else if (profile.connectionType === 'DATA_WAREHOUSE') {
    const wh = WAREHOUSE_DB_TYPES[String(cfg.warehouseType || '').toUpperCase()];
    if (!wh) return null; // an SDK-only warehouse — fall back to samples
    dbType = wh;
    host = cfg.host || cfg.account;        // the cluster endpoint
    database = cfg.database || cfg.warehouse;
  } else {
    return null;
  }
  const username = profile.credentials?.username;
  if (!host || !database || !username) return null;
  return {
    dbType, host, database,
    port: cfg.port ?? DEFAULT_DB_PORTS[dbType],
    schema: cfg.schema,
    username,
    password: profile.credentials?.password,
  };
}

/** Map a MONGODB connection profile to a Mongo discovery request. Auth is
 *  optional (a no-auth dev instance connects with host + database alone), so
 *  unlike the SQL mapper this doesn't require a username. Returns null when the
 *  profile isn't a configured Mongo database — the caller then falls back to
 *  the sample assets. */
function toMongoSourceRequest(profile: ConnectionProfileLike): MongoSourceRequest | null {
  if (profile.connectionType !== 'DATABASE') return null;
  if (String(profile.config.dbType || '').toUpperCase() !== 'MONGODB') return null;
  const { host, port, database } = profile.config;
  if (!host || !database) return null;
  return { host, port, database, username: profile.credentials?.username, password: profile.credentials?.password };
}

/** Map a DATA_WAREHOUSE / SNOWFLAKE connection profile to a Snowflake discovery
 *  request. Snowflake's connection model is account + warehouse + database (not
 *  host:port), so it maps from the warehouse form's fields. Returns null when
 *  the profile isn't a configured Snowflake warehouse — the caller then falls
 *  back to the sample assets. */
export function toSnowflakeRequest(profile: ConnectionProfileLike): SnowflakeSourceRequest | null {
  if (profile.connectionType !== 'DATA_WAREHOUSE') return null;
  if (String(profile.config.warehouseType || '').toUpperCase() !== 'SNOWFLAKE') return null;
  const { account, warehouse, database, schema } = profile.config;
  const username = profile.credentials?.username;
  if (!account || !database || !username) return null;
  return { account, warehouse, database, schema, username, password: profile.credentials?.password };
}

/** Map a DATA_WAREHOUSE / BIGQUERY connection profile to a BigQuery discovery
 *  request. BigQuery's model is project + dataset; auth is a service-account
 *  JSON key (from the token credential) or Application Default Credentials.
 *  Account → project id, database → dataset. Returns null when not a configured
 *  BigQuery warehouse. */
export function toBigQueryRequest(profile: ConnectionProfileLike): BigQuerySourceRequest | null {
  if (profile.connectionType !== 'DATA_WAREHOUSE') return null;
  if (String(profile.config.warehouseType || '').toUpperCase() !== 'BIGQUERY') return null;
  const { account, database } = profile.config;
  if (!account || !database) return null;
  return { projectId: account, dataset: database, serviceAccountJson: profile.credentials?.token };
}

export async function discoverAssets(profile: ConnectionProfileLike): Promise<ConnectorResult> {
  // Decrypt at-rest secrets just-in-time before the driver authenticates.
  profile = { ...profile, credentials: await decryptCredentials(profile.credentials) };
  // Real discovery for LOCAL file uploads: surface the file as a single
  // asset with its parsed columns attached.
  if (profile.connectionType === 'FILE_STORAGE' && profile.config.storageType === 'LOCAL') {
    return await discoverLocalFile(profile);
  }

  // Real discovery for a cloud object store (S3 / Azure Blob / GCS): list
  // objects under the configured prefix, then infer each parseable file's schema
  // with the same analyzer the local upload uses. Fail-loud like the DB path.
  if (profile.connectionType === 'FILE_STORAGE' && profile.config.bucket) {
    const objStore = objectStoreDiscovery(profile);
    if (objStore) return await objStore;
  }

  // Real discovery for a configured direct-connect database: run engine-
  // specific catalog SQL through the live driver layer. A failure (bad host,
  // auth, permissions) surfaces the real error rather than falling back to
  // samples, so an operator isn't misled into thinking a broken connection
  // discovered data.
  const dbReq = toDbSourceRequest(profile);
  if (dbReq) {
    const start = Date.now();
    try {
      const assets = await discoverDbSchema(dbReq);
      return {
        success: true,
        message: `Discovered ${assets.length} asset${assets.length === 1 ? '' : 's'} from ${dbReq.database}`,
        latencyMs: Date.now() - start,
        simulated: false,
        details: { tableCount: assets.length, assets },
      };
    } catch (err) {
      logger.warn({ err, dbType: dbReq.dbType, host: dbReq.host }, 'Live asset discovery failed');
      return {
        success: false,
        message: err instanceof Error ? err.message : 'Live asset discovery failed',
        latencyMs: Date.now() - start,
      };
    }
  }

  // Real discovery for a configured MongoDB: list collections and infer a
  // field/type schema from a bounded document sample. Same fail-loud contract
  // and same DiscoveredAsset shape as the SQL path, so a document store
  // reconciles into the catalog through the identical downstream flow.
  const mongoReq = toMongoSourceRequest(profile);
  if (mongoReq) {
    const start = Date.now();
    try {
      const assets = await discoverMongoSchema(mongoReq);
      return {
        success: true,
        message: `Discovered ${assets.length} collection${assets.length === 1 ? '' : 's'} from ${mongoReq.database}`,
        latencyMs: Date.now() - start,
        simulated: false,
        details: { tableCount: assets.length, assets },
      };
    } catch (err) {
      logger.warn({ err, host: mongoReq.host }, 'Live MongoDB discovery failed');
      return {
        success: false,
        message: err instanceof Error ? err.message : 'Live MongoDB discovery failed',
        latencyMs: Date.now() - start,
      };
    }
  }

  // Real discovery for a configured Snowflake warehouse: run INFORMATION_SCHEMA
  // catalog SQL through the Snowflake driver. Same fail-loud contract and same
  // DiscoveredAsset shape as the other engines.
  const sfReq = toSnowflakeRequest(profile);
  if (sfReq) {
    const start = Date.now();
    try {
      const assets = await discoverSnowflakeSchema(sfReq);
      return {
        success: true,
        message: `Discovered ${assets.length} asset${assets.length === 1 ? '' : 's'} from ${sfReq.database}`,
        latencyMs: Date.now() - start,
        simulated: false,
        details: { tableCount: assets.length, assets },
      };
    } catch (err) {
      logger.warn({ err, account: sfReq.account }, 'Live Snowflake discovery failed');
      return {
        success: false,
        message: err instanceof Error ? err.message : 'Live Snowflake discovery failed',
        latencyMs: Date.now() - start,
      };
    }
  }

  // Real discovery for a configured BigQuery dataset: run per-dataset
  // INFORMATION_SCHEMA queries through the BigQuery client. Fail-loud.
  const bqReq = toBigQueryRequest(profile);
  if (bqReq) {
    const start = Date.now();
    try {
      const assets = await discoverBigQuerySchema(bqReq);
      return {
        success: true,
        message: `Discovered ${assets.length} asset${assets.length === 1 ? '' : 's'} from ${bqReq.projectId}.${bqReq.dataset}`,
        latencyMs: Date.now() - start,
        simulated: false,
        details: { tableCount: assets.length, assets },
      };
    } catch (err) {
      logger.warn({ err, project: bqReq.projectId, dataset: bqReq.dataset }, 'Live BigQuery discovery failed');
      return {
        success: false,
        message: err instanceof Error ? err.message : 'Live BigQuery discovery failed',
        latencyMs: Date.now() - start,
      };
    }
  }

  // Simulate discovery with delay
  await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));

  const hasEndpoint =
    profile.config.host ||
    profile.config.baseUrl ||
    profile.config.bucket ||
    profile.config.documentUrl ||
    profile.config.account;

  if (!hasEndpoint) {
    return { success: false, message: 'No connection endpoint configured', latencyMs: 0 };
  }

  // Generate mock discovered assets based on connection type. Each asset
  // carries a `columns` list so the UI can let the user drill down to a
  // specific data point (column/field) rather than just the whole table.
  const mockAssets: Array<{ name: string; type: string; rowCount?: number; lastModified?: string; columns?: string[] }> = [];
  const now = new Date().toISOString();

  if (profile.connectionType === 'DATABASE') {
    mockAssets.push(
      { name: 'customers', type: 'TABLE', rowCount: 45230, lastModified: now,
        columns: ['customer_id', 'first_name', 'last_name', 'email', 'phone', 'created_at', 'updated_at'] },
      { name: 'orders', type: 'TABLE', rowCount: 128450, lastModified: now,
        columns: ['order_id', 'customer_id', 'order_date', 'total_amount', 'status', 'shipped_at'] },
      { name: 'products', type: 'TABLE', rowCount: 3200, lastModified: now,
        columns: ['product_id', 'sku', 'name', 'price', 'category', 'in_stock'] },
      { name: 'customer_view', type: 'VIEW', rowCount: 45230,
        columns: ['customer_id', 'full_name', 'lifetime_value', 'last_order_date'] },
    );
  } else if (profile.connectionType === 'FILE_STORAGE') {
    mockAssets.push(
      { name: 'reports/monthly_sales.csv', type: 'FILE', lastModified: now,
        columns: ['month', 'region', 'product', 'units_sold', 'revenue'] },
      { name: 'exports/customer_data.parquet', type: 'FILE', lastModified: now,
        columns: ['customer_id', 'segment', 'churn_risk', 'annual_spend'] },
      { name: 'raw/transactions_2024.json', type: 'FILE', lastModified: now,
        columns: ['transaction_id', 'account_id', 'amount', 'currency', 'timestamp'] },
    );
  } else if (profile.connectionType === 'API') {
    mockAssets.push(
      { name: '/api/customers', type: 'ENDPOINT',
        columns: ['id', 'name', 'email', 'phone', 'tier'] },
      { name: '/api/orders', type: 'ENDPOINT',
        columns: ['id', 'customer_id', 'total', 'status'] },
      { name: '/api/products', type: 'ENDPOINT',
        columns: ['id', 'sku', 'name', 'price'] },
    );
  } else if (profile.connectionType === 'DATA_WAREHOUSE') {
    mockAssets.push(
      { name: 'analytics.fact_sales', type: 'TABLE', rowCount: 2450000, lastModified: now,
        columns: ['sale_id', 'customer_key', 'product_key', 'date_key', 'quantity', 'gross_revenue', 'discount', 'net_revenue'] },
      { name: 'analytics.dim_customer', type: 'TABLE', rowCount: 89200, lastModified: now,
        columns: ['customer_key', 'customer_id', 'name', 'segment', 'country', 'signup_date'] },
      { name: 'staging.raw_events', type: 'TABLE', rowCount: 15000000, lastModified: now,
        columns: ['event_id', 'user_id', 'event_type', 'event_payload', 'timestamp'] },
      { name: 'reporting.monthly_kpi', type: 'VIEW', rowCount: 360,
        columns: ['month', 'metric', 'value', 'yoy_change'] },
    );
  } else if (profile.connectionType === 'SPREADSHEET') {
    mockAssets.push(
      { name: 'Sheet1 - Revenue Tracker', type: 'SHEET', rowCount: 1200,
        columns: ['Date', 'Region', 'Salesperson', 'Amount', 'Notes'] },
      { name: 'Sheet2 - Cost Breakdown', type: 'SHEET', rowCount: 340,
        columns: ['Category', 'Vendor', 'Amount', 'Month'] },
    );
  }

  return {
    success: true,
    message: `Discovered ${mockAssets.length} sample assets (simulated — real discovery requires a ${profile.connectionType} driver)`,
    latencyMs: Math.round(500 + Math.random() * 1000),
    simulated: true,
    details: { tableCount: mockAssets.length, assets: mockAssets },
  };
}

// ── LOCAL file-storage helpers ────────────────────────────────────────────

async function testLocalFile(profile: ConnectionProfileLike): Promise<ConnectorResult> {
  const start = Date.now();
  const config = profile.config || {};
  const { localFilePath, originalFileName } = config;

  if (!localFilePath) {
    return { success: false, message: 'No file uploaded yet. Open this connection and use Browse to pick a file, then Save to upload it.', latencyMs: 0 };
  }
  if (!fs.existsSync(localFilePath)) {
    // Show enough of the path to debug a CWD or rename mismatch without
    // dumping the full absolute path into the toast.
    const tail = localFilePath.length > 60 ? `…${localFilePath.slice(-60)}` : localFilePath;
    return {
      success: false,
      message: `Uploaded file is missing on disk at ${tail}. Re-upload via the Browse button to fix.`,
      latencyMs: Date.now() - start,
    };
  }

  try {
    const { rowCount, columns } = await analyzeLocalFileAsync(localFilePath);
    return {
      success: true,
      message: `Read ${originalFileName || 'file'}: ${rowCount.toLocaleString()} rows × ${columns.length} column${columns.length === 1 ? '' : 's'}`,
      latencyMs: Date.now() - start,
      details: {
        assets: [{
          name: originalFileName || 'uploaded-file',
          type: 'FILE',
          rowCount,
          columns,
        }],
      },
    };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : 'Failed to read file',
      latencyMs: Date.now() - start,
    };
  }
}

/** Build the object-store adapter for a cloud file-storage profile, or null when
 *  the storage type isn't a wired cloud store (LOCAL is handled elsewhere; SFTP
 *  is not wired yet, so it falls through to the sample assets). Credentials were
 *  decrypted by discoverAssets: apiKey / password / token carry the per-provider
 *  secrets. */
function objectStoreDiscovery(profile: ConnectionProfileLike): Promise<ConnectorResult> | null {
  const cfg = profile.config;
  const creds = profile.credentials || {};
  // Store construction is deferred into a factory so a config error (a missing
  // Azure key) is caught by the runner's try/catch, not thrown synchronously.
  let makeStore: () => ObjectStore;
  let location: string;
  switch (cfg.storageType) {
    case 'S3':
      // apiKey → access key id, password → secret; absent → AWS default chain (IAM role).
      makeStore = () => createS3Store({ bucket: cfg.bucket!, region: cfg.region, accessKeyId: creds.apiKey, secretAccessKey: creds.password });
      location = `s3://${cfg.bucket}`;
      break;
    case 'AZURE_BLOB':
      if (!cfg.account) return null; // needs a storage account — fall back to samples
      makeStore = () => createAzureBlobStore({ account: cfg.account!, container: cfg.bucket!, accountKey: creds.apiKey, sasToken: creds.token });
      location = `azure://${cfg.account}/${cfg.bucket}`;
      break;
    case 'GCS':
      // token → inline service-account JSON; absent → Application Default Credentials.
      makeStore = () => createGcsStore({ bucket: cfg.bucket!, projectId: cfg.account, serviceAccountJson: creds.token });
      location = `gs://${cfg.bucket}`;
      break;
    case 'SFTP':
      // The host is stored in the bucket field (matching the reachability test);
      // path is the remote directory. token → PEM private key (or a password).
      makeStore = () => createSftpStore({ host: cfg.bucket!, port: cfg.port, username: creds.username, password: creds.password, privateKey: creds.token });
      location = `sftp://${cfg.bucket}`;
      break;
    default:
      return null;
  }
  return runObjectStoreDiscovery(makeStore, location, cfg.path);
}

async function runObjectStoreDiscovery(makeStore: () => ObjectStore, location: string, prefix?: string): Promise<ConnectorResult> {
  const start = Date.now();
  try {
    const store = makeStore();
    const cleanPrefix = (prefix || '').replace(/^\/+/, '');
    const assets = await discoverObjectStoreAssets(store, { prefix: cleanPrefix });
    return {
      success: true,
      message: `Discovered ${assets.length} object${assets.length === 1 ? '' : 's'} from ${location}${cleanPrefix ? '/' + cleanPrefix : ''}`,
      latencyMs: Date.now() - start,
      simulated: false,
      details: { tableCount: assets.length, assets },
    };
  } catch (err) {
    logger.warn({ err, location }, 'Live object-storage discovery failed');
    return {
      success: false,
      message: err instanceof Error ? err.message : 'Live object-storage discovery failed',
      latencyMs: Date.now() - start,
    };
  }
}

async function discoverLocalFile(profile: ConnectionProfileLike): Promise<ConnectorResult> {
  const start = Date.now();
  const { localFilePath, originalFileName } = profile.config;

  if (!localFilePath || !fs.existsSync(localFilePath)) {
    return { success: false, message: 'No file uploaded yet. Open this connection and use Browse to pick a file, then Save to upload it.', latencyMs: 0 };
  }

  try {
    const { rowCount, columns } = await analyzeLocalFileAsync(localFilePath);
    const stat = fs.statSync(localFilePath);
    // The file is the asset; columns are attached as metadata so the UI can
    // show the inferred schema when the user imports it as a Data Asset.
    const asset = {
      name: originalFileName || 'uploaded-file',
      type: 'FILE',
      rowCount,
      columns,
      lastModified: stat.mtime.toISOString(),
    };
    return {
      success: true,
      message: `Discovered 1 asset with ${columns.length} column${columns.length === 1 ? '' : 's'}`,
      latencyMs: Date.now() - start,
      simulated: false,   // real: parsed from the uploaded file's actual bytes
      details: { tableCount: 1, assets: [asset] },
    };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : 'Failed to read file',
      latencyMs: Date.now() - start,
    };
  }
}
