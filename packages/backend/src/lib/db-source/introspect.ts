// Cloud-side schema introspection for direct-connect DATABASE connections.
//
// This is the real-discovery path: instead of returning illustrative sample
// assets, it runs engine-specific catalog SQL through the same driver layer
// the live sync uses (fetchDbRows with a raw `query`), then groups the flat
// rows into { name, type, columns } assets the Connections UI can import.
//
// The SQL builders and the grouping are kept PURE (no driver, no live DB) so
// they unit-test without pg / mysql2 / mssql / oracledb — mirroring the split
// in sql.ts. Only discoverDbSchema() touches a real connection.

import { fetchDbRows } from './index';
import type { DbSourceRequest, DbSourceType, SourceRow } from './types';

/** Bound the catalog scan so a huge schema can't return an unbounded payload. */
export const MAX_DISCOVERED_TABLES = 2000;
export const MAX_DISCOVERED_COLUMNS = 20000;

export interface DiscoveredAsset {
  name: string;
  type: 'TABLE' | 'VIEW';
  columns: string[];
  /** Approximate row count from engine catalog statistics (not a live
   *  COUNT(*)) — mirrors the connector's rowCount signal. Undefined when the
   *  engine didn't report one (a view, un-analyzed table, or a stats view the
   *  connecting user can't read). */
  rowCount?: number;
  /** Column name → data type, when the catalog reported types. Lets the schema
   *  fingerprint include the type so a column *retype* counts as drift, not
   *  just an add/remove. Absent for an older scan that returned names only. */
  columnTypes?: Record<string, string>;
}

/** Default catalog scope per engine when the connection didn't set a schema.
 *  MySQL has no schema separate from the database, so the caller passes the
 *  database name as the scope. */
export function defaultSchema(dbType: DbSourceType, database: string): string {
  switch (dbType) {
    case 'POSTGRESQL': return 'public';
    case 'SQLSERVER': return 'dbo';
    case 'MYSQL': return database;
    case 'ORACLE': return ''; // resolved to the connecting user below
  }
}

/** Single-quote-escape a value for safe inclusion in a SQL string literal.
 *  The catalog filters compare against a string literal (schema/owner name),
 *  not an identifier, so doubling embedded quotes is the injection boundary.
 *
 *  MySQL (unless NO_BACKSLASH_ESCAPES is set) also treats backslash as an
 *  escape character inside a string literal, so a value ending in `\` could
 *  otherwise escape the closing quote and break out of the literal. Postgres
 *  (standard_conforming_strings, on by default), SQL Server and Oracle treat
 *  backslash literally, so doubling it there would corrupt a legitimate name —
 *  hence the escape is engine-specific. */
export function escapeLiteral(value: string, dbType?: DbSourceType): string {
  const quoted = value.replace(/'/g, "''");
  return dbType === 'MYSQL' ? quoted.replace(/\\/g, '\\\\') : quoted;
}

/**
 * Build the table/view list query for a schema. Returns rows of
 * (table_name, table_type). Bounded by MAX_DISCOVERED_TABLES.
 */
export function buildTableListSql(dbType: DbSourceType, schema: string): string {
  const s = escapeLiteral(schema, dbType);
  switch (dbType) {
    case 'POSTGRESQL':
    case 'MYSQL':
      return `SELECT table_name, table_type FROM information_schema.tables `
        + `WHERE table_schema = '${s}' AND table_type IN ('BASE TABLE', 'VIEW') `
        + `ORDER BY table_name LIMIT ${MAX_DISCOVERED_TABLES}`;
    case 'SQLSERVER':
      return `SELECT TOP (${MAX_DISCOVERED_TABLES}) table_name, table_type FROM information_schema.tables `
        + `WHERE table_schema = '${s}' AND table_type IN ('BASE TABLE', 'VIEW') `
        + `ORDER BY table_name`;
    case 'ORACLE': {
      // Oracle has no information_schema; all_tables / all_views split the two
      // object kinds. owner defaults to the connecting user when unset.
      const owner = s ? `UPPER('${s}')` : 'USER';
      return `SELECT table_name, 'BASE TABLE' AS table_type FROM all_tables WHERE owner = ${owner} `
        + `UNION ALL SELECT view_name AS table_name, 'VIEW' AS table_type FROM all_views WHERE owner = ${owner} `
        + `ORDER BY table_name FETCH FIRST ${MAX_DISCOVERED_TABLES} ROWS ONLY`;
    }
  }
}

/**
 * Build the column list query for a schema. Returns rows of
 * (table_name, column_name, data_type, ordinal_position). `data_type` lets
 * the schema fingerprint detect a column *retype* (not just add/remove).
 * Bounded by MAX_DISCOVERED_COLUMNS.
 */
export function buildColumnListSql(dbType: DbSourceType, schema: string): string {
  const s = escapeLiteral(schema, dbType);
  switch (dbType) {
    case 'POSTGRESQL':
    case 'MYSQL':
      return `SELECT table_name, column_name, data_type, ordinal_position FROM information_schema.columns `
        + `WHERE table_schema = '${s}' ORDER BY table_name, ordinal_position LIMIT ${MAX_DISCOVERED_COLUMNS}`;
    case 'SQLSERVER':
      return `SELECT TOP (${MAX_DISCOVERED_COLUMNS}) table_name, column_name, data_type, ordinal_position FROM information_schema.columns `
        + `WHERE table_schema = '${s}' ORDER BY table_name, ordinal_position`;
    case 'ORACLE': {
      const owner = s ? `UPPER('${s}')` : 'USER';
      return `SELECT table_name, column_name, data_type, column_id AS ordinal_position FROM all_tab_columns `
        + `WHERE owner = ${owner} ORDER BY table_name, column_id FETCH FIRST ${MAX_DISCOVERED_COLUMNS} ROWS ONLY`;
    }
  }
}

/**
 * Build the per-table row-count query for a schema. Returns rows of
 * (table_name, row_count) from the engine's catalog statistics — approximate,
 * not a live COUNT(*), so it stays cheap on large schemas (the same contract
 * as the connector's reported rowCount). Views and un-analyzed tables simply
 * don't appear or report null, which the caller maps to "unknown".
 */
export function buildRowCountSql(dbType: DbSourceType, schema: string): string {
  const s = escapeLiteral(schema, dbType);
  switch (dbType) {
    case 'POSTGRESQL':
      // reltuples is the planner's estimate; -1 (PG14+, never analyzed) maps
      // to unknown in applyRowCounts. relkind r/p = ordinary/partitioned table.
      return `SELECT c.relname AS table_name, c.reltuples AS row_count `
        + `FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace `
        + `WHERE n.nspname = '${s}' AND c.relkind IN ('r', 'p')`;
    case 'MYSQL':
      // information_schema.tables.table_rows is approximate for InnoDB.
      return `SELECT table_name, table_rows AS row_count FROM information_schema.tables `
        + `WHERE table_schema = '${s}' AND table_type = 'BASE TABLE'`;
    case 'SQLSERVER':
      // Heap (index_id 0) or clustered (1) partition row counts, summed.
      return `SELECT t.name AS table_name, SUM(p.rows) AS row_count `
        + `FROM sys.tables t JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1) `
        + `WHERE SCHEMA_NAME(t.schema_id) = '${s}' GROUP BY t.name`;
    case 'ORACLE': {
      // num_rows comes from the optimizer stats; null until the table is analyzed.
      const owner = s ? `UPPER('${s}')` : 'USER';
      return `SELECT table_name, num_rows AS row_count FROM all_tables WHERE owner = ${owner}`;
    }
  }
}

/** Read a field from a normalized row case-insensitively — Postgres lower-cases
 *  unquoted aliases while Oracle upper-cases them. */
export function pickField(row: SourceRow, key: string): string {
  if (row[key] !== undefined) return row[key];
  if (row[key.toUpperCase()] !== undefined) return row[key.toUpperCase()];
  if (row[key.toLowerCase()] !== undefined) return row[key.toLowerCase()];
  return '';
}

/**
 * Group flat catalog rows into assets. Pure: the driver runs the two queries,
 * this turns them into the { name, type, columns } shape. Column rows whose
 * table isn't in the table list are ignored (a view/table filtered out above).
 */
export function groupAssets(tableRows: SourceRow[], columnRows: SourceRow[]): DiscoveredAsset[] {
  const assets = new Map<string, DiscoveredAsset>();
  for (const r of tableRows) {
    const name = pickField(r, 'table_name');
    if (!name) continue;
    const rawType = pickField(r, 'table_type').toUpperCase();
    assets.set(name, { name, type: rawType.includes('VIEW') ? 'VIEW' : 'TABLE', columns: [] });
  }
  for (const r of columnRows) {
    const table = pickField(r, 'table_name');
    const column = pickField(r, 'column_name');
    if (!table || !column) continue;
    const asset = assets.get(table);
    if (!asset) continue;
    asset.columns.push(column);
    const dataType = pickField(r, 'data_type');
    if (dataType) {
      (asset.columnTypes ??= {})[column] = dataType;
    }
  }
  return [...assets.values()];
}

/**
 * Merge catalog row-count rows into the discovered assets by table name.
 * Pure — the driver runs the query, this attaches the numbers. A missing,
 * empty, non-numeric, or negative value (e.g. Postgres reltuples -1 = never
 * analyzed) maps to null ("unknown"), so it's never mistaken for a real 0.
 */
export function applyRowCounts(assets: DiscoveredAsset[], rowCountRows: SourceRow[]): void {
  const byName = new Map(assets.map((a) => [a.name, a]));
  for (const r of rowCountRows) {
    const name = pickField(r, 'table_name');
    if (!name) continue;
    const asset = byName.get(name);
    if (!asset) continue;
    const raw = (r as Record<string, unknown>).row_count ?? (r as Record<string, unknown>).ROW_COUNT;
    const n = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
    asset.rowCount = Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;
  }
}

/**
 * Run real schema introspection against a live database and return the
 * discovered assets. Throws on connection / auth / query failure so the caller
 * can surface a real error (fail-loud — never a silent fallback to samples).
 */
export async function discoverDbSchema(req: DbSourceRequest): Promise<DiscoveredAsset[]> {
  const schema = (req.schema && req.schema.trim()) || defaultSchema(req.dbType, req.database);
  const tableRows = await fetchDbRows({ ...req, table: undefined, query: buildTableListSql(req.dbType, schema) });
  const columnRows = await fetchDbRows({ ...req, table: undefined, query: buildColumnListSql(req.dbType, schema) });
  const assets = groupAssets(tableRows, columnRows);
  // Row counts are a best-effort enrichment: the stats views can be
  // permission-gated (e.g. a read-only user without access to pg_class /
  // sys.partitions), so a failure here must not fail discovery — the assets
  // just carry no rowCount, exactly as an older scan would.
  try {
    const rowCountRows = await fetchDbRows({ ...req, table: undefined, query: buildRowCountSql(req.dbType, schema) });
    applyRowCounts(assets, rowCountRows);
  } catch { /* leave rowCount undefined on every asset */ }
  return assets;
}
