// Snowflake warehouse discovery. Snowflake has an ANSI INFORMATION_SCHEMA
// (TABLES / COLUMNS) but a connection model unlike the host:port SQL engines
// (account + warehouse + database), so — like MongoDB — it gets its own module
// and request type instead of joining the host-based DbSourceType. The catalog
// SQL is parameterized (Snowflake `?` binds), and the flat rows are grouped by
// the same engine-agnostic groupAssets / applyRowCounts the other engines use.
//
// The SQL builders are PURE (no driver) so they unit-test without snowflake-sdk;
// only discoverSnowflakeSchema opens a real connection.

import {
  groupAssets,
  applyRowCounts,
  MAX_DISCOVERED_TABLES,
  MAX_DISCOVERED_COLUMNS,
  type DiscoveredAsset,
} from './introspect';
import { normalizeRow } from './sql';
import type { SourceRow } from './types';

/** Everything the Snowflake driver needs. Auth is a password today; key-pair is
 *  a follow-on. `schema` defaults to PUBLIC. */
export interface SnowflakeSourceRequest {
  account: string;
  username: string;
  password?: string;
  warehouse?: string;
  database: string;
  schema?: string;
  role?: string;
}

const CONNECT_TIMEOUT_MS = 20_000;

// Parameterized catalog queries — the schema is bound (`?`), never interpolated.
export function buildSnowflakeTableListSql(): string {
  return `SELECT table_name, table_type FROM information_schema.tables `
    + `WHERE table_schema = ? AND table_type IN ('BASE TABLE', 'VIEW') `
    + `ORDER BY table_name LIMIT ${MAX_DISCOVERED_TABLES}`;
}

export function buildSnowflakeColumnListSql(): string {
  return `SELECT table_name, column_name, data_type, ordinal_position FROM information_schema.columns `
    + `WHERE table_schema = ? ORDER BY table_name, ordinal_position LIMIT ${MAX_DISCOVERED_COLUMNS}`;
}

export function buildSnowflakeRowCountSql(): string {
  // Snowflake's INFORMATION_SCHEMA.TABLES carries a maintained row_count for
  // base tables — approximate, cheap (no COUNT(*)), same contract as the others.
  return `SELECT table_name, row_count FROM information_schema.tables `
    + `WHERE table_schema = ? AND table_type = 'BASE TABLE'`;
}

/**
 * Run real discovery against a live Snowflake account. Throws on connection /
 * auth / query failure (fail-loud — never a silent fallback to samples). The
 * snowflake-sdk driver is imported lazily so this module loads (and its pure SQL
 * builders unit-test) without it.
 */
export async function discoverSnowflakeSchema(req: SnowflakeSourceRequest): Promise<DiscoveredAsset[]> {
  if (!req.account) throw new Error('Snowflake source is missing an account');
  if (!req.username) throw new Error('Snowflake source is missing a username');
  if (!req.database) throw new Error('Snowflake source is missing a database');
  // Unquoted Snowflake identifiers fold to upper case, and INFORMATION_SCHEMA
  // stores them that way, so match the schema filter in upper case.
  const schema = (req.schema && req.schema.trim() ? req.schema : 'PUBLIC').toUpperCase();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ns: any = await import('snowflake-sdk');
  const snowflake = ns.default ?? ns;
  const connection = snowflake.createConnection({
    account: req.account,
    username: req.username,
    password: req.password,
    warehouse: req.warehouse,
    database: req.database,
    schema,
    role: req.role,
    timeout: CONNECT_TIMEOUT_MS,
    application: 'Procela',
  });

  await new Promise<void>((resolve, reject) => {
    connection.connect((err: unknown) => (err ? reject(err) : resolve()));
  });

  const run = (sqlText: string, binds: unknown[]): Promise<SourceRow[]> =>
    new Promise((resolve, reject) => {
      connection.execute({
        sqlText,
        binds,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        complete: (err: unknown, _stmt: unknown, rows: Array<Record<string, unknown>>) => {
          if (err) return reject(err);
          resolve((rows || []).map((r) => normalizeRow(r)));
        },
      });
    });

  try {
    const tableRows = await run(buildSnowflakeTableListSql(), [schema]);
    const columnRows = await run(buildSnowflakeColumnListSql(), [schema]);
    const assets = groupAssets(tableRows, columnRows);
    // Row counts are best-effort — a permission-gated view mustn't fail discovery.
    try {
      const rowCountRows = await run(buildSnowflakeRowCountSql(), [schema]);
      applyRowCounts(assets, rowCountRows);
    } catch { /* leave rowCount undefined */ }
    return assets;
  } finally {
    await new Promise<void>((resolve) => {
      try { connection.destroy(() => resolve()); } catch { resolve(); }
    });
  }
}
