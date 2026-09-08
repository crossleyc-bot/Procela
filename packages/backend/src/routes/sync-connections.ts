import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { loadStore, saveStore, registerStore } from '../lib/persistence';
import { parseCsv } from '../lib/csv';
import { organizations } from './organizations';
import { people } from './people';
import { systems } from './systems';
import { glossaryTerms } from './business-glossary';
import { connections } from './connections';
import { connectors } from './connectors';
import { decryptCredentials } from '../services/connection-secrets';
import logger from '../lib/logger';
import { getSyncConnectionsRepository } from '../db/sync-connections.repo';
import { getConnectionsRepository } from '../db/connections.repo';
import { getConnectorsRepository } from '../db/connectors.repo';
import { getOrganizationsRepository } from '../db/organizations.repo';
import { getPeopleRepository } from '../db/people.repo';
import { getSystemsRepository } from '../db/systems.repo';
import { getGlossaryTermsRepository } from '../db/glossary-terms.repo';
import type { Repository } from '../db/repository';
import { hasDatabase } from '../db/prisma';
import { fetchDbRows, SUPPORTED_DB_SOURCE_TYPES } from '../lib/db-source';
import type { DbSourceRequest, DbSourceType } from '../lib/db-source';

// Lazy repo for the saved Connection profiles — the imported `connections`
// array is empty in Postgres mode, so resolving a connectionId must go
// through the repository.
let _connectionsRepo: ReturnType<typeof getConnectionsRepository> | null = null;
const connectionsRepo = () => (_connectionsRepo ??= getConnectionsRepository(connections));

// Lazy repo for on-prem connectors — same rationale as connectionsRepo, and
// lazy so importing the `connectors` array never runs at module-init time
// (keeps the connectors.ts ↔ sync-connections.ts boundary one-directional).
let _connectorsRepo: ReturnType<typeof getConnectorsRepository> | null = null;
const connectorsRepo = () => (_connectorsRepo ??= getConnectorsRepository(connectors));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncConnection {
  id: string;
  orgId: string;
  name: string;
  targetEntity: 'organizations' | 'people' | 'systems' | 'business-glossary';
  sourceType: 'DATABASE' | 'CSV_URL' | 'JSON_URL';
  /** Optional reference to a saved Connection profile in the admin
   *  Connections area. When set, the sync resolves host/port/credentials
   *  from the profile at run time and `config` only carries source-
   *  specific overrides (table, query, URL path suffix, etc.). When
   *  null, the sync owns its config inline. */
  connectionId: string | null;
  /** How a DATABASE sync executes:
   *   - DIRECT (default): the backend connects to the source and pulls rows.
   *   - AGENT: an on-prem connector runs the query inside the customer network
   *     and pushes rows to the backend. Used when the source DB isn't reachable
   *     from the cloud. AGENT syncs are skipped by the direct auto-runner. */
  executionMode?: 'DIRECT' | 'AGENT';
  /** For AGENT execution: the connector responsible for running this sync.
   *  null for DIRECT syncs. */
  connectorId?: string | null;
  config: {
    // DATABASE
    dbType?: 'POSTGRESQL' | 'MYSQL' | 'SQLSERVER' | 'ORACLE';
    host?: string;
    port?: number;
    database?: string;
    schema?: string;
    table?: string;
    query?: string;
    // URL-based
    url?: string;
    authHeader?: string;
    // Shared
    /** Row cap for a DATABASE table-scan. A raw `query` owns its own
     *  limiting and ignores this. */
    limit?: number;
    /** Explicit opt-in to simulated sample rows for a DATABASE source.
     *  Demos and seeds set this so they run without a live database; when
     *  false/absent a DATABASE sync attempts a real direct connection and
     *  fails loudly if it can't reach the source. */
    sampleData?: boolean;
    /** AGENT execution only: the name of the connector's configured source
     *  to run this sync against. When unset the agent uses its first source
     *  whose engine matches `dbType`. */
    agentSourceName?: string;
  };
  fieldMapping: Record<string, string>;
  matchKey: string;
  schedule: {
    enabled: boolean;
    intervalMinutes: number;
    lastRunAt: string | null;
    nextRunAt: string | null;
  };
  status: 'ACTIVE' | 'PAUSED' | 'ERROR';
  lastSyncResult: {
    timestamp: string;
    created: number;
    updated: number;
    skipped: number;
    errors: number;
    errorMessages: string[];
  } | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_TYPES = ['DATABASE', 'CSV_URL', 'JSON_URL'] as const;
const TARGET_ENTITIES = ['organizations', 'people', 'systems', 'business-glossary'] as const;
const DB_TYPES = ['POSTGRESQL', 'MYSQL', 'SQLSERVER', 'ORACLE'] as const;

const TARGET_FIELD_MAP: Record<string, string[]> = {
  organizations: ['name', 'type', 'industry', 'description'],
  people: ['name', 'email', 'role', 'title', 'jobRole'],
  systems: ['name', 'description', 'systemType', 'vendor', 'businessCriticality'],
};

const DEV_ORG_ID = '00000000-0000-0000-0000-000000000010';

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

export const syncConnections: SyncConnection[] = loadStore<SyncConnection>('syncConnections');
registerStore('syncConnections', syncConnections);

const syncConnectionsRepo = getSyncConnectionsRepository(syncConnections);

// Request-body schemas — Zod at the API boundary. Enum checks + type
// guarantees fall out of the parse so downstream code can use the
// typed body directly.
const syncConfigSchema = z.object({
  dbType: z.enum(DB_TYPES).optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  database: z.string().optional(),
  schema: z.string().optional(),
  table: z.string().optional(),
  query: z.string().optional(),
  url: z.string().optional(),
  authHeader: z.string().optional(),
  limit: z.number().optional(),
  sampleData: z.boolean().optional(),
  agentSourceName: z.string().optional(),
});
const syncScheduleSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().optional(),
});
const createSyncConnectionBodySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  targetEntity: z.enum(TARGET_ENTITIES, {
    message: `targetEntity must be one of: ${TARGET_ENTITIES.join(', ')}`,
  }),
  sourceType: z.enum(SOURCE_TYPES, {
    message: `sourceType must be one of: ${SOURCE_TYPES.join(', ')}`,
  }),
  matchKey: z.string().min(1, 'matchKey is required'),
  config: syncConfigSchema.optional(),
  fieldMapping: z.record(z.string(), z.string()).optional(),
  schedule: syncScheduleSchema.optional(),
  orgId: z.string().optional(),
  connectionId: z.string().nullable().optional(),
  executionMode: z.enum(['DIRECT', 'AGENT']).optional(),
  connectorId: z.string().nullable().optional(),
});
const updateSyncConnectionBodySchema = z.object({
  name: z.string().optional(),
  targetEntity: z.enum(TARGET_ENTITIES, {
    message: `targetEntity must be one of: ${TARGET_ENTITIES.join(', ')}`,
  }).optional(),
  sourceType: z.enum(SOURCE_TYPES, {
    message: `sourceType must be one of: ${SOURCE_TYPES.join(', ')}`,
  }).optional(),
  matchKey: z.string().optional(),
  config: syncConfigSchema.optional(),
  fieldMapping: z.record(z.string(), z.string()).optional(),
  schedule: syncScheduleSchema.optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'ERROR']).optional(),
  connectionId: z.string().nullable().optional(),
  executionMode: z.enum(['DIRECT', 'AGENT']).optional(),
  connectorId: z.string().nullable().optional(),
});

// Backfill connectionId on legacy rows so consumers can rely on the
// field existing. null = inline (no saved-connection reference). JSON
// mode only — Postgres rows always carry the column (create sets it,
// schema defaults it), and reading the boot array in PG mode would just
// be a stale-store read.
if (!hasDatabase()) {
  let connectionIdMigrated = false;
  for (const sc of syncConnections) {
    if (sc.connectionId === undefined) {
      sc.connectionId = null;
      connectionIdMigrated = true;
    }
  }
  if (connectionIdMigrated) saveStore('syncConnections', syncConnections);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the effective config a sync run will use. When a `connectionId`
 * is set, we overlay the saved Connection profile's host/port/database/
 * baseUrl/auth on top of the sync's own config so the source can be
 * fetched without re-entering credentials per sync. Sync-owned fields
 * (table, query, URL path) always win — those are sync-specific even
 * when the underlying server isn't.
 *
 * For URL-based syncs we synthesize an Authorization header from saved
 * credentials (apiKey or token) when the sync didn't already set one.
 * Returns the original config unchanged if the connection ref is dead.
 */
async function resolveEffectiveConfig(sc: SyncConnection): Promise<SyncConnection['config']> {
  if (!sc.connectionId) return sc.config;
  const conn = await connectionsRepo().get(sc.connectionId);
  if (!conn) return sc.config;

  const merged: SyncConnection['config'] = { ...sc.config };
  if (sc.sourceType === 'DATABASE') {
    if (conn.config.dbType && !merged.dbType) merged.dbType = conn.config.dbType as any;
    if (conn.config.host && !merged.host) merged.host = conn.config.host;
    if (conn.config.port && !merged.port) merged.port = conn.config.port;
    if (conn.config.database && !merged.database) merged.database = conn.config.database;
    if (conn.config.schema && !merged.schema) merged.schema = conn.config.schema;
  } else {
    // CSV_URL / JSON_URL — pull baseUrl when sync didn't carry its own
    if (conn.config.baseUrl && !merged.url) merged.url = conn.config.baseUrl;
    if (!merged.authHeader) {
      // Decrypt at-rest credentials before building the outbound auth header.
      const cred = await decryptCredentials(conn.credentials) || {};
      if (cred.apiKey) merged.authHeader = `Bearer ${cred.apiKey}`;
      else if (cred.token) merged.authHeader = `Bearer ${cred.token}`;
      else if (cred.username && cred.password) {
        merged.authHeader = `Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString('base64')}`;
      }
    }
  }
  return merged;
}

/**
 * Assemble the DbSourceRequest a live DATABASE sync connects with. Starts
 * from the sync's own config and overlays a saved Connection profile's
 * host/port/database/schema and credentials when a connectionId is set
 * (sync-owned fields win, matching resolveEffectiveConfig). Throws when the
 * effective dbType isn't one the direct-connect drivers support — the sync
 * then records a failed run rather than silently doing nothing.
 */
async function resolveDbSource(sc: SyncConnection): Promise<DbSourceRequest> {
  const cfg: SyncConnection['config'] = { ...sc.config };
  let creds: { username?: string; password?: string } = {};

  if (sc.connectionId) {
    const conn = await connectionsRepo().get(sc.connectionId);
    if (conn) {
      if (conn.config.dbType && !cfg.dbType) cfg.dbType = conn.config.dbType as SyncConnection['config']['dbType'];
      if (conn.config.host && !cfg.host) cfg.host = conn.config.host;
      if (conn.config.port && !cfg.port) cfg.port = conn.config.port;
      if (conn.config.database && !cfg.database) cfg.database = conn.config.database;
      if (conn.config.schema && !cfg.schema) cfg.schema = conn.config.schema;
      const dc = await decryptCredentials(conn.credentials);
      creds = { username: dc?.username, password: dc?.password };
    }
  }

  const dbType = cfg.dbType;
  if (!dbType || !SUPPORTED_DB_SOURCE_TYPES.includes(dbType as DbSourceType)) {
    throw new Error(
      `Live database sync supports ${SUPPORTED_DB_SOURCE_TYPES.join(', ')}; got ${dbType ?? 'none'}`,
    );
  }

  return {
    dbType: dbType as DbSourceType,
    host: cfg.host ?? '',
    port: cfg.port,
    database: cfg.database ?? '',
    schema: cfg.schema,
    table: cfg.table,
    query: cfg.query,
    username: creds.username,
    password: creds.password,
    limit: cfg.limit,
  };
}

function isConnectionCompatible(conn: { connectionType: string }, sourceType: string): boolean {
  if (sourceType === 'DATABASE') return conn.connectionType === 'DATABASE' || conn.connectionType === 'DATA_WAREHOUSE';
  return conn.connectionType === 'API' || conn.connectionType === 'FILE_STORAGE';
}

// The sync engine writes target entities through their repositories, so a run
// persists in Postgres as well as JSON mode. The per-row sync-tracking fields
// (syncConnectionId / syncStatus) now have real columns on each target model,
// so a run can update its own prior rows and mark those dropped from the
// source. Returns the repository for the target entity, or null if unknown.
function getEntityRepo(targetEntity: string): Repository<Record<string, unknown> & { id: string }> | null {
  switch (targetEntity) {
    case 'organizations': return getOrganizationsRepository(organizations) as unknown as Repository<Record<string, unknown> & { id: string }>;
    case 'people': return getPeopleRepository(people) as unknown as Repository<Record<string, unknown> & { id: string }>;
    case 'systems': return getSystemsRepository(systems) as unknown as Repository<Record<string, unknown> & { id: string }>;
    case 'business-glossary': return getGlossaryTermsRepository(glossaryTerms) as unknown as Repository<Record<string, unknown> & { id: string }>;
    default: return null;
  }
}

function computeNextRunAt(intervalMinutes: number): string {
  return new Date(Date.now() + intervalMinutes * 60_000).toISOString();
}

/**
 * Attempt to fetch rows from a URL-based source.
 * For CSV_URL: fetches the URL, splits by newlines, parses as CSV.
 * For JSON_URL: fetches the URL, expects a JSON array.
 */
async function fetchUrlRows(
  sourceType: 'CSV_URL' | 'JSON_URL',
  config: SyncConnection['config'],
): Promise<Record<string, string>[]> {
  const { url, authHeader } = config;
  if (!url) throw new Error('No URL configured');

  const headers: Record<string, string> = {};
  if (authHeader) headers['Authorization'] = authHeader;

  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);

  if (sourceType === 'JSON_URL') {
    const data = await resp.json();
    if (!Array.isArray(data)) throw new Error('JSON response is not an array');
    return data;
  }

  // CSV_URL
  const text = await resp.text();
  const parsed = parseCsv(text);
  if (parsed.length < 2) return [];
  const headerRow = parsed[0].map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < parsed.length; i++) {
    const cols = parsed[i].map((c) => c.trim());
    const row: Record<string, string> = {};
    for (let j = 0; j < headerRow.length; j++) {
      row[headerRow[j]] = cols[j] || '';
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Generate simulated rows for DATABASE sources (prototype only).
 */
function generateMockRows(
  targetEntity: string,
  fieldMapping: Record<string, string>,
): Record<string, string>[] {
  const count = 5;
  const rows: Record<string, string>[] = [];
  for (let i = 1; i <= count; i++) {
    const row: Record<string, string> = {};
    for (const [_targetField, sourceColumn] of Object.entries(fieldMapping)) {
      row[sourceColumn] = `mock_${sourceColumn}_${i}`;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Apply a single source row against the target entity, persisting through its
 * repository. `all` is the working set (the repo's current list, kept in sync
 * so later rows in the same batch can match freshly-created rows).
 * Returns 'created' | 'updated' | 'skipped'.
 */
async function applyRow(
  all: any[],
  repo: Repository<Record<string, unknown> & { id: string }>,
  targetEntity: string,
  fieldMapping: Record<string, string>,
  matchKey: string,
  sourceRow: Record<string, string>,
  orgId: string,
  syncConnectionId?: string,
  syncedRecordIds?: Set<string>,
): Promise<'created' | 'updated' | 'skipped'> {
  // Resolve the source column for the match key
  const matchSourceColumn = fieldMapping[matchKey];
  if (!matchSourceColumn) return 'skipped';

  const matchValue = sourceRow[matchSourceColumn];
  if (!matchValue) return 'skipped';

  // Find existing record by matchKey value
  const existing = all.find((item: any) => {
    const targetValue = item[matchKey];
    return targetValue !== undefined && String(targetValue).toLowerCase() === String(matchValue).toLowerCase();
  });

  if (existing) {
    syncedRecordIds?.add(existing.id);
    // Update fields that differ
    let changed = false;
    for (const [targetField, sourceColumn] of Object.entries(fieldMapping)) {
      if (targetField === matchKey) continue;
      const newValue = sourceRow[sourceColumn];
      if (newValue !== undefined && newValue !== '' && existing[targetField] !== newValue) {
        existing[targetField] = newValue;
        changed = true;
      }
    }
    if (syncConnectionId && existing.syncConnectionId !== syncConnectionId) {
      existing.syncConnectionId = syncConnectionId;
      changed = true;
    }
    if (existing.syncStatus === 'MISSING_FROM_SOURCE') {
      existing.syncStatus = 'ACTIVE';
      changed = true;
    }
    if (changed) {
      existing.updatedAt = new Date().toISOString();
      await repo.update(existing.id, existing);
      return 'updated';
    }
    return 'skipped';
  }

  // Create new record
  const now = new Date().toISOString();
  const newRecord: any = {
    id: uuid(),
    createdAt: now,
    updatedAt: now,
    syncConnectionId: syncConnectionId || null,
    syncStatus: 'ACTIVE',
  };
  syncedRecordIds?.add(newRecord.id);

  // Set org scoping based on entity type
  if (targetEntity === 'people') {
    newRecord.orgIds = [orgId];
    newRecord.accessibleOrgIds = [orgId];
  } else {
    newRecord.orgId = orgId;
  }

  // Apply field mapping
  for (const [targetField, sourceColumn] of Object.entries(fieldMapping)) {
    const value = sourceRow[sourceColumn];
    if (value !== undefined && value !== '') {
      newRecord[targetField] = value;
    }
  }

  // Set defaults for missing required fields
  if (targetEntity === 'organizations') {
    if (!newRecord.name) return 'skipped';
    if (!newRecord.type) newRecord.type = 'department';
    if (!newRecord.industry) newRecord.industry = '';
    if (!newRecord.description) newRecord.description = '';
    if (newRecord.headCount === undefined) newRecord.headCount = 0;
    if (!newRecord.parentId) newRecord.parentId = null;
  } else if (targetEntity === 'people') {
    if (!newRecord.name) return 'skipped';
    if (!newRecord.email) newRecord.email = '';
    if (!newRecord.role) newRecord.role = 'VIEWER';
    if (!newRecord.title) newRecord.title = '';
  } else if (targetEntity === 'systems') {
    if (!newRecord.name) return 'skipped';
    if (!newRecord.description) newRecord.description = '';
    if (!newRecord.systemType) newRecord.systemType = 'Other';
  } else if (targetEntity === 'business-glossary') {
    if (!newRecord.term) return 'skipped';
    if (!newRecord.definition) newRecord.definition = '';
    if (!newRecord.category) newRecord.category = 'BUSINESS';
    if (!newRecord.status) newRecord.status = 'DRAFT';
    if (!Array.isArray(newRecord.synonyms)) newRecord.synonyms = [];
    if (newRecord.domainId === undefined) newRecord.domainId = null;
    if (newRecord.ownerPersonId === undefined) newRecord.ownerPersonId = null;
    if (!newRecord.context) newRecord.context = '';
    if (!newRecord.exampleValues) newRecord.exampleValues = '';
    if (!newRecord.businessRules) newRecord.businessRules = '';
    if (!newRecord.sourceOfTruth) newRecord.sourceOfTruth = '';
  }

  // Keep the working set current so later rows in this batch can match the
  // row we just created, then persist it through the repository.
  all.push(newRecord);
  await repo.create(newRecord);
  return 'created';
}

// In-flight guard — ids of sync connections a run is currently executing for.
// Both the manual /run route and the auto-runner tick check this so a slow run
// never overlaps itself (the tick fires every minute; a run touching many rows
// can outlast one tick).
const runningSyncIds = new Set<string>();

// ---------------------------------------------------------------------------
// Run engine — shared by the manual POST /:id/run route and the background
// auto-runner tick. Fetches source rows, upserts each through the target
// repository, marks rows dropped from the source, and persists the run
// metadata (lastSyncResult / schedule.lastRunAt / nextRunAt / status) back
// onto the sync connection. Returns a discriminated outcome the caller maps
// to an HTTP response or a log line.
// ---------------------------------------------------------------------------

interface SyncRunResult {
  timestamp: string;
  created: number;
  updated: number;
  skipped: number;
  missingFromSource: number;
  errors: number;
  errorMessages: string[];
}

type RunSyncOutcome =
  | { status: 'ok'; result: SyncRunResult; simulated: boolean }
  | { status: 'fetch-error'; result: SyncRunResult; error: string }
  | { status: 'config-error'; error: string };

/**
 * Apply an already-fetched batch of source rows to the sync's target entity:
 * upsert each row through the repo, flag rows previously synced by this
 * connection but absent from this batch, then persist the run metadata
 * (lastSyncResult / schedule.lastRunAt / nextRunAt / status) back onto the
 * connection. Shared by the direct-connect `runSync` and the agent-push
 * ingest path — both differ only in where the rows come from.
 */
async function applySyncRows(
  sc: SyncConnection,
  repo: Repository<Record<string, unknown> & { id: string }>,
  rows: Record<string, string>[],
): Promise<SyncRunResult> {
  // Working set: the entity's current rows from the repository (Postgres in DB
  // mode, the in-memory array in JSON mode). applyRow matches against this and
  // pushes newly-created rows into it so later rows in the batch can match.
  const all = await repo.list();

  const result: SyncRunResult = {
    timestamp: new Date().toISOString(),
    created: 0,
    updated: 0,
    skipped: 0,
    missingFromSource: 0,
    errors: 0,
    errorMessages: [],
  };
  const syncedRecordIds = new Set<string>();

  // Apply each row (create/update persists through the repo inside applyRow).
  for (const row of rows) {
    try {
      const action = await applyRow(all, repo, sc.targetEntity, sc.fieldMapping, sc.matchKey, row, sc.orgId, sc.id, syncedRecordIds);
      if (action === 'created') result.created++;
      else if (action === 'updated') result.updated++;
      else result.skipped++;
    } catch (err) {
      result.errors++;
      const msg = err instanceof Error ? err.message : 'Unknown error';
      result.errorMessages.push(msg);
    }
  }

  // Mark records previously synced by this connection but missing from this
  // batch, persisting each transition through the repo.
  for (const item of all) {
    if ((item as any).syncConnectionId === sc.id && !syncedRecordIds.has(item.id)) {
      if ((item as any).syncStatus !== 'MISSING_FROM_SOURCE') {
        (item as any).syncStatus = 'MISSING_FROM_SOURCE';
        (item as any).updatedAt = new Date().toISOString();
        await repo.update(item.id, item);
        result.missingFromSource++;
      }
    }
  }

  // Update sync connection metadata
  sc.lastSyncResult = result;
  sc.schedule.lastRunAt = result.timestamp;
  if (sc.schedule.enabled) {
    sc.schedule.nextRunAt = computeNextRunAt(sc.schedule.intervalMinutes);
  }
  if (result.errors > 0 && result.created === 0 && result.updated === 0) {
    sc.status = 'ERROR';
  } else {
    sc.status = 'ACTIVE';
  }
  sc.updatedAt = new Date().toISOString();
  await syncConnectionsRepo.update(sc.id, {
    lastSyncResult: sc.lastSyncResult,
    schedule: sc.schedule,
    status: sc.status,
    updatedAt: sc.updatedAt,
  });
  return result;
}

async function runSync(sc: SyncConnection): Promise<RunSyncOutcome> {
  const repo = getEntityRepo(sc.targetEntity);
  if (!repo) {
    return { status: 'config-error', error: `Unknown target entity: ${sc.targetEntity}` };
  }

  let rows: Record<string, string>[] = [];
  let simulated = false;

  try {
    if (sc.sourceType === 'DATABASE') {
      if (sc.config.sampleData) {
        // Explicit sample source — labelled simulated rows for demos/seeds.
        rows = generateMockRows(sc.targetEntity, sc.fieldMapping);
        simulated = true;
      } else {
        // Live direct-connect: read real rows from the source database. Any
        // failure (unreachable host, auth, missing table) throws and the run
        // is recorded as failed — no silent fallback to mock data.
        rows = await fetchDbRows(await resolveDbSource(sc));
      }
    } else {
      // CSV_URL or JSON_URL — attempt real fetch
      rows = await fetchUrlRows(sc.sourceType, await resolveEffectiveConfig(sc));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown fetch error';
    const result: SyncRunResult = {
      timestamp: new Date().toISOString(),
      created: 0, updated: 0, skipped: 0, missingFromSource: 0,
      errors: 1, errorMessages: [`Source fetch failed: ${msg}`],
    };
    sc.status = 'ERROR';
    sc.lastSyncResult = result;
    // Advance the schedule even on failure so a broken source doesn't get
    // retried every tick — it waits for its normal interval.
    sc.schedule.lastRunAt = result.timestamp;
    if (sc.schedule.enabled) {
      sc.schedule.nextRunAt = computeNextRunAt(sc.schedule.intervalMinutes);
    }
    sc.updatedAt = new Date().toISOString();
    await syncConnectionsRepo.update(sc.id, {
      status: sc.status,
      lastSyncResult: sc.lastSyncResult,
      schedule: sc.schedule,
      updatedAt: sc.updatedAt,
    });
    logger.error({ err, id: sc.id }, 'Sync connection fetch failed');
    return { status: 'fetch-error', result, error: msg };
  }

  const result = await applySyncRows(sc, repo, rows);
  logger.info(
    { id: sc.id, created: result.created, updated: result.updated, skipped: result.skipped, missingFromSource: result.missingFromSource, errors: result.errors, simulated },
    'Sync connection run completed',
  );
  return { status: 'ok', result, simulated };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router();

/** GET /api/v1/sync-connections — list all, supports ?orgId= and ?targetEntity= filters */
router.get('/', async (req: Request, res: Response) => {
  const { orgId, targetEntity } = req.query;
  let filtered = await syncConnectionsRepo.list(
    orgId && typeof orgId === 'string' ? { orgId } : undefined,
  );
  if (targetEntity && typeof targetEntity === 'string') {
    filtered = filtered.filter((sc) => sc.targetEntity === targetEntity);
  }
  res.json({
    success: true,
    data: filtered,
    sourceTypes: SOURCE_TYPES,
    targetEntities: TARGET_ENTITIES,
    dbTypes: DB_TYPES,
  });
});

/** GET /api/v1/sync-connections/:id — get single connection */
router.get('/:id', async (req: Request, res: Response) => {
  const sc = await syncConnectionsRepo.get(String(req.params.id));
  if (!sc) {
    res.status(404).json({ success: false, error: 'Sync connection not found' });
    return;
  }
  res.json({ success: true, data: sc });
});

/** POST /api/v1/sync-connections — create new sync connection */
router.post('/', async (req: Request, res: Response) => {
  const parsed = createSyncConnectionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const { name, targetEntity, sourceType, config, fieldMapping, matchKey, schedule, orgId, connectionId, executionMode, connectorId } = parsed.data;

  if (connectionId) {
    const conn = await connectionsRepo().get(connectionId);
    if (!conn) {
      res.status(400).json({ success: false, error: `connectionId ${connectionId} not found` });
      return;
    }
    if (!isConnectionCompatible(conn, sourceType)) {
      res.status(400).json({ success: false, error: `connection type ${conn.connectionType} is not compatible with sourceType ${sourceType}` });
      return;
    }
  }

  const mode = executionMode || 'DIRECT';
  if (mode === 'AGENT') {
    // Agent-push only makes sense for a database source the connector reaches
    // locally; it needs a connector to run the query and push rows.
    if (sourceType !== 'DATABASE') {
      res.status(400).json({ success: false, error: 'AGENT execution is only valid for a DATABASE source' });
      return;
    }
    if (!connectorId) {
      res.status(400).json({ success: false, error: 'AGENT execution requires a connectorId' });
      return;
    }
    const connector = await connectorsRepo().get(connectorId);
    if (!connector) {
      res.status(400).json({ success: false, error: `connectorId ${connectorId} not found` });
      return;
    }
  }

  const now = new Date().toISOString();
  const intervalMinutes = schedule?.intervalMinutes || 360;

  const sc: SyncConnection = {
    id: uuid(),
    orgId: orgId || DEV_ORG_ID,
    name,
    targetEntity,
    sourceType,
    connectionId: connectionId || null,
    executionMode: mode,
    connectorId: mode === 'AGENT' ? connectorId! : null,
    config: config || {},
    fieldMapping: fieldMapping || {},
    matchKey,
    schedule: {
      enabled: schedule?.enabled ?? false,
      intervalMinutes,
      lastRunAt: null,
      nextRunAt: schedule?.enabled ? computeNextRunAt(intervalMinutes) : null,
    },
    status: 'ACTIVE',
    lastSyncResult: null,
    createdAt: now,
    updatedAt: now,
  };

  await syncConnectionsRepo.create(sc);
  logger.info({ id: sc.id, name: sc.name, targetEntity: sc.targetEntity, sourceType: sc.sourceType }, 'Created sync connection');
  res.status(201).json({ success: true, data: sc });
});

/** PUT /api/v1/sync-connections/:id — update connection */
router.put('/:id', async (req: Request, res: Response) => {
  const sc = await syncConnectionsRepo.get(String(req.params.id));
  if (!sc) {
    res.status(404).json({ success: false, error: 'Sync connection not found' });
    return;
  }

  const parsed = updateSyncConnectionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const { name, targetEntity, sourceType, config, fieldMapping, matchKey, schedule, status, connectionId, executionMode, connectorId } = parsed.data;

  if (name !== undefined) sc.name = name;
  if (targetEntity !== undefined) sc.targetEntity = targetEntity;
  if (sourceType !== undefined) sc.sourceType = sourceType;
  if (connectionId !== undefined) {
    if (connectionId === null || connectionId === '') {
      sc.connectionId = null;
    } else {
      const conn = await connectionsRepo().get(connectionId);
      if (!conn) {
        res.status(400).json({ success: false, error: `connectionId ${connectionId} not found` });
        return;
      }
      if (!isConnectionCompatible(conn, sc.sourceType)) {
        res.status(400).json({ success: false, error: `connection type ${conn.connectionType} is not compatible with sourceType ${sc.sourceType}` });
        return;
      }
      sc.connectionId = connectionId;
    }
  }
  if (executionMode !== undefined) sc.executionMode = executionMode;
  if (connectorId !== undefined) sc.connectorId = (connectorId === null || connectorId === '') ? null : connectorId;
  // Validate the resulting AGENT invariants (source must be DATABASE, a real
  // connector must be assigned) whenever the sync ends up in AGENT mode.
  if ((sc.executionMode || 'DIRECT') === 'AGENT') {
    if (sc.sourceType !== 'DATABASE') {
      res.status(400).json({ success: false, error: 'AGENT execution is only valid for a DATABASE source' });
      return;
    }
    if (!sc.connectorId) {
      res.status(400).json({ success: false, error: 'AGENT execution requires a connectorId' });
      return;
    }
    const connector = await connectorsRepo().get(sc.connectorId);
    if (!connector) {
      res.status(400).json({ success: false, error: `connectorId ${sc.connectorId} not found` });
      return;
    }
  }
  if (config !== undefined) sc.config = { ...sc.config, ...config };
  if (fieldMapping !== undefined) sc.fieldMapping = fieldMapping;
  if (matchKey !== undefined) sc.matchKey = matchKey;
  if (status !== undefined) sc.status = status;
  if (schedule !== undefined) {
    if (schedule.enabled !== undefined) sc.schedule.enabled = schedule.enabled;
    if (schedule.intervalMinutes !== undefined) sc.schedule.intervalMinutes = schedule.intervalMinutes;
    if (sc.schedule.enabled) {
      sc.schedule.nextRunAt = computeNextRunAt(sc.schedule.intervalMinutes);
    } else {
      sc.schedule.nextRunAt = null;
    }
  }

  sc.updatedAt = new Date().toISOString();
  await syncConnectionsRepo.update(sc.id, {
    name: sc.name,
    targetEntity: sc.targetEntity,
    sourceType: sc.sourceType,
    connectionId: sc.connectionId,
    executionMode: sc.executionMode,
    connectorId: sc.connectorId,
    config: sc.config,
    fieldMapping: sc.fieldMapping,
    matchKey: sc.matchKey,
    schedule: sc.schedule,
    status: sc.status,
    updatedAt: sc.updatedAt,
  });
  res.json({ success: true, data: sc });
});

/** DELETE /api/v1/sync-connections/:id — delete connection */
router.delete('/:id', async (req: Request, res: Response) => {
  const removed = await syncConnectionsRepo.get(String(req.params.id));
  if (!removed) {
    res.status(404).json({ success: false, error: 'Sync connection not found' });
    return;
  }
  await syncConnectionsRepo.delete(removed.id);
  logger.info({ id: removed.id, name: removed.name }, 'Deleted sync connection');
  res.status(204).send();
});

/** POST /api/v1/sync-connections/:id/run — execute sync now (manual trigger) */
router.post('/:id/run', async (req: Request, res: Response) => {
  const sc = await syncConnectionsRepo.get(String(req.params.id));
  if (!sc) {
    res.status(404).json({ success: false, error: 'Sync connection not found' });
    return;
  }

  // AGENT syncs execute inside the customer network via the on-prem connector,
  // which pushes rows to the ingest endpoint — the backend can't reach the
  // source to pull. Refuse a direct run rather than fail confusingly.
  if ((sc.executionMode || 'DIRECT') === 'AGENT') {
    res.status(400).json({ success: false, error: 'This sync runs on an on-prem connector; it is triggered by the agent, not a direct run.' });
    return;
  }

  // A manual run against a connection the auto-runner is mid-flight on would
  // race the same repo writes; refuse rather than double-run.
  if (runningSyncIds.has(sc.id)) {
    res.status(409).json({ success: false, error: 'Sync is already running' });
    return;
  }

  runningSyncIds.add(sc.id);
  let outcome: RunSyncOutcome;
  try {
    outcome = await runSync(sc);
  } finally {
    runningSyncIds.delete(sc.id);
  }

  if (outcome.status === 'config-error') {
    res.status(500).json({ success: false, error: outcome.error });
    return;
  }
  if (outcome.status === 'fetch-error') {
    res.json({ success: false, data: outcome.result, error: outcome.error });
    return;
  }
  res.json({ success: true, data: outcome.result, simulated: outcome.simulated });
});

/** GET /api/v1/sync-connections/:id/preview — dry run showing first 10 rows */
router.get('/:id/preview', async (req: Request, res: Response) => {
  const sc = await syncConnectionsRepo.get(String(req.params.id));
  if (!sc) {
    res.status(404).json({ success: false, error: 'Sync connection not found' });
    return;
  }

  const repo = getEntityRepo(sc.targetEntity);
  if (!repo) {
    res.status(500).json({ success: false, error: `Unknown target entity: ${sc.targetEntity}` });
    return;
  }

  let rows: Record<string, string>[] = [];
  let simulated = false;

  try {
    if (sc.sourceType === 'DATABASE') {
      if (sc.config.sampleData) {
        rows = generateMockRows(sc.targetEntity, sc.fieldMapping);
        simulated = true;
      } else {
        rows = await fetchDbRows(await resolveDbSource(sc));
      }
    } else {
      rows = await fetchUrlRows(sc.sourceType, await resolveEffectiveConfig(sc));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown fetch error';
    res.json({
      success: false,
      error: `Source fetch failed: ${msg}`,
      suggestedFields: TARGET_FIELD_MAP[sc.targetEntity] || [],
    });
    return;
  }

  // Current rows for the create/update/skip classification below.
  const all = await repo.list();

  // Preview at most 10 rows
  const previewRows = rows.slice(0, 10);
  const matchSourceColumn = sc.fieldMapping[sc.matchKey];

  const preview = previewRows.map((row) => {
    const matchValue = matchSourceColumn ? row[matchSourceColumn] : undefined;
    let action: 'create' | 'update' | 'skip' = 'create';

    if (matchValue) {
      const existing = all.find((item: any) => {
        const targetValue = item[sc.matchKey];
        return targetValue !== undefined && String(targetValue).toLowerCase() === String(matchValue).toLowerCase();
      });

      if (existing) {
        // Check if any mapped fields differ
        let differs = false;
        for (const [targetField, sourceColumn] of Object.entries(sc.fieldMapping)) {
          if (targetField === sc.matchKey) continue;
          const newValue = row[sourceColumn];
          if (newValue !== undefined && newValue !== '' && existing[targetField] !== newValue) {
            differs = true;
            break;
          }
        }
        action = differs ? 'update' : 'skip';
      }
    } else {
      action = 'skip';
    }

    return {
      sourceRow: row,
      action,
      matchValue: matchValue || null,
    };
  });

  res.json({
    success: true,
    data: {
      totalSourceRows: rows.length,
      previewRows: preview,
      suggestedFields: TARGET_FIELD_MAP[sc.targetEntity] || [],
    },
    simulated,
  });
});

// ---------------------------------------------------------------------------
// Auto-runner — a leader-gated tick that runs enabled sync connections when
// their schedule is due. Mirrors the agent-schedules / data-quality tickers:
// fires once a minute, and (via startBackgroundSweep's leaderOnly option) only
// the elected scheduler leader executes it, so a due sync runs on exactly one
// server with failover. Missed ticks are not caught up — a sync due while the
// process was down fires once on the next tick, not once per missed interval.
// ---------------------------------------------------------------------------

const SYNC_TICK_MS = 60 * 1000;

async function tickSyncScheduler(): Promise<void> {
  const now = Date.now();
  let list: SyncConnection[];
  try {
    list = await syncConnectionsRepo.list();
  } catch (err) {
    logger.error({ err }, 'Sync auto-runner: failed to list sync connections');
    return;
  }

  for (const sc of list) {
    if (!sc.schedule?.enabled) continue;
    if (sc.status === 'PAUSED') continue;
    // AGENT syncs are driven by the on-prem connector, not the backend tick —
    // the connector pulls due jobs and pushes rows. Never direct-run them here.
    if ((sc.executionMode || 'DIRECT') === 'AGENT') continue;
    if (!sc.schedule.nextRunAt) continue;
    if (new Date(sc.schedule.nextRunAt).getTime() > now) continue;
    // Skip if a run (manual or a previous tick's) is still in flight.
    if (runningSyncIds.has(sc.id)) continue;

    runningSyncIds.add(sc.id);
    // Fire-and-forget so one slow sync doesn't block the others in this tick.
    // runSync persists its own metadata (including the nextRunAt advance), so
    // the guard set is the only shared state to release here.
    void runSync(sc)
      .catch((err) => {
        logger.error({ err, id: sc.id }, 'Sync auto-runner: run threw');
      })
      .finally(() => {
        runningSyncIds.delete(sc.id);
      });
  }
}

// ---------------------------------------------------------------------------
// Agent-push surface — consumed by the connector-token endpoints in
// routes/connector-sync.ts. An on-prem connector pulls the sync jobs it owns,
// runs the query locally, and pushes the resulting rows back. The push reuses
// applySyncRows (the same upsert + missing-from-source + metadata path a
// direct run uses), so an agent sync behaves identically to a direct one once
// the rows arrive.
// ---------------------------------------------------------------------------

/** A job spec handed to the connector: what to read and how to map it. The
 *  connector already holds the DB connection string (in its local config); the
 *  job only names the table/query and the mapping. */
export interface AgentSyncJob {
  id: string;
  name: string;
  targetEntity: SyncConnection['targetEntity'];
  matchKey: string;
  fieldMapping: Record<string, string>;
  dbType?: 'POSTGRESQL' | 'MYSQL' | 'SQLSERVER' | 'ORACLE';
  schema?: string;
  table?: string;
  query?: string;
  limit?: number;
  /** Which of the connector's configured sources to run against (by name). */
  sourceName?: string;
  intervalMinutes: number;
  nextRunAt: string | null;
}

export type AgentPushOutcome =
  | { status: 'ok'; result: SyncRunResult }
  | { status: 'not-found' }
  | { status: 'forbidden'; error: string }
  | { status: 'busy' }
  | { status: 'config-error'; error: string };

/** List the AGENT-mode syncs a connector is responsible for. With
 *  `onlyDue`, restricts to those whose schedule is due now (what the agent
 *  polls each cycle); without it, returns all assigned jobs (admin/debug). */
export async function listAgentSyncJobs(
  connector: { id: string; orgId: string },
  opts: { onlyDue?: boolean } = {},
): Promise<AgentSyncJob[]> {
  const now = Date.now();
  const all = await syncConnectionsRepo.list({ orgId: connector.orgId });
  return all
    .filter((sc) => (sc.executionMode || 'DIRECT') === 'AGENT' && sc.connectorId === connector.id)
    .filter((sc) => sc.schedule?.enabled && sc.status !== 'PAUSED')
    .filter((sc) => {
      if (!opts.onlyDue) return true;
      // A never-scheduled job (nextRunAt null) is due immediately.
      if (!sc.schedule.nextRunAt) return true;
      return new Date(sc.schedule.nextRunAt).getTime() <= now;
    })
    .map((sc) => ({
      id: sc.id,
      name: sc.name,
      targetEntity: sc.targetEntity,
      matchKey: sc.matchKey,
      fieldMapping: sc.fieldMapping,
      dbType: sc.config.dbType,
      schema: sc.config.schema,
      table: sc.config.table,
      query: sc.config.query,
      limit: sc.config.limit,
      sourceName: sc.config.agentSourceName,
      intervalMinutes: sc.schedule.intervalMinutes,
      nextRunAt: sc.schedule.nextRunAt,
    }));
}

/** Apply rows a connector pushed for one of its AGENT syncs. Enforces that
 *  the sync is AGENT-mode, in the connector's org, and assigned to this
 *  connector before touching anything, then runs the shared applySyncRows. */
export async function applyAgentSyncPush(
  syncId: string,
  connector: { id: string; orgId: string },
  rows: Record<string, string>[],
): Promise<AgentPushOutcome> {
  const sc = await syncConnectionsRepo.get(syncId);
  if (!sc) return { status: 'not-found' };
  if (sc.orgId !== connector.orgId) {
    return { status: 'forbidden', error: 'sync belongs to another org' };
  }
  if ((sc.executionMode || 'DIRECT') !== 'AGENT' || sc.connectorId !== connector.id) {
    return { status: 'forbidden', error: 'sync is not assigned to this connector' };
  }

  const repo = getEntityRepo(sc.targetEntity);
  if (!repo) return { status: 'config-error', error: `Unknown target entity: ${sc.targetEntity}` };

  if (runningSyncIds.has(sc.id)) return { status: 'busy' };
  runningSyncIds.add(sc.id);
  try {
    const result = await applySyncRows(sc, repo, rows);
    logger.info(
      { id: sc.id, connectorId: connector.id, created: result.created, updated: result.updated, skipped: result.skipped, missingFromSource: result.missingFromSource, errors: result.errors },
      'Agent-push sync applied',
    );
    return { status: 'ok', result };
  } finally {
    runningSyncIds.delete(sc.id);
  }
}

import { startBackgroundSweep } from '../lib/background-timer';
startBackgroundSweep(() => { void tickSyncScheduler(); }, SYNC_TICK_MS, { leaderOnly: true });

// Exported for tests that want to deterministically trigger the loop.
export { tickSyncScheduler, runSync };

export default router;
