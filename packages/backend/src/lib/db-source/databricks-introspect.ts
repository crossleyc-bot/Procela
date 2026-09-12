// Databricks (Unity Catalog) warehouse discovery. Databricks exposes a
// per-catalog `information_schema` (TABLES / COLUMNS) but is reached with a
// workspace host + SQL-warehouse HTTP path + token (not host:port), so — like
// Snowflake and BigQuery — it gets its own module and request type instead of
// joining the host-based DbSourceType. The catalog is part of the table path
// (`<catalog>.information_schema.tables`) and can't be a query parameter, so it
// is validated against a strict charset (the injection boundary) and
// back-tick quoted; the schema filter is validated the same way and single-
// quoted. The flat rows group through the shared engine-agnostic
// groupAssets / applyRowCounts.
//
// The SQL builders are PURE so they unit-test without @databricks/sql; only
// discoverDatabricksSchema opens a real connection.

import {
  groupAssets,
  MAX_DISCOVERED_TABLES,
  MAX_DISCOVERED_COLUMNS,
  type DiscoveredAsset,
} from './introspect';
import { normalizeRow } from './sql';
import type { SourceRow } from './types';

/** Everything the Databricks SQL driver needs. `host` is the workspace server
 *  hostname, `httpPath` the SQL-warehouse / cluster HTTP path, `token` a PAT.
 *  `schema` defaults to `default`. */
export interface DatabricksSourceRequest {
  host: string;
  httpPath: string;
  token?: string;
  catalog: string;
  schema?: string;
}

// Unity Catalog identifiers (catalog / schema) allow letters, digits and
// underscores. Anything else is rejected before it can reach an interpolated
// table path or a single-quoted filter.
const IDENT_RE = /^[A-Za-z0-9_]{1,255}$/;

export function assertDbxCatalog(id: string): string {
  if (!IDENT_RE.test(id)) throw new Error(`Invalid Databricks catalog: ${JSON.stringify(id)}`);
  return id;
}
export function assertDbxSchema(id: string): string {
  if (!IDENT_RE.test(id)) throw new Error(`Invalid Databricks schema: ${JSON.stringify(id)}`);
  return id;
}

/** The back-ticked `<catalog>`.information_schema.<view> prefix. */
function schemaView(catalog: string, view: string): string {
  return `\`${assertDbxCatalog(catalog)}\`.information_schema.${view}`;
}

export function buildDatabricksTableListSql(catalog: string, schema: string): string {
  return `SELECT table_name, table_type FROM ${schemaView(catalog, 'tables')} `
    + `WHERE table_schema = '${assertDbxSchema(schema)}' `
    + `ORDER BY table_name LIMIT ${MAX_DISCOVERED_TABLES}`;
}

export function buildDatabricksColumnListSql(catalog: string, schema: string): string {
  return `SELECT table_name, column_name, data_type, ordinal_position FROM ${schemaView(catalog, 'columns')} `
    + `WHERE table_schema = '${assertDbxSchema(schema)}' `
    + `ORDER BY table_name, ordinal_position LIMIT ${MAX_DISCOVERED_COLUMNS}`;
}

/**
 * Run real discovery against a live Databricks SQL warehouse. Throws on
 * connection / auth / query failure (fail-loud — never a silent fallback to
 * samples). The @databricks/sql driver is imported lazily so this module loads
 * (and its pure SQL builders unit-test) without it.
 *
 * Databricks' information_schema does not carry a maintained approximate row
 * count, so — unlike the other warehouses — row counts are left undefined
 * rather than run a full COUNT(*) per table during discovery.
 */
export async function discoverDatabricksSchema(req: DatabricksSourceRequest): Promise<DiscoveredAsset[]> {
  if (!req.host) throw new Error('Databricks source is missing a server hostname');
  if (!req.httpPath) throw new Error('Databricks source is missing an HTTP path');
  if (!req.catalog) throw new Error('Databricks source is missing a catalog');
  const schema = req.schema && req.schema.trim() ? req.schema : 'default';
  assertDbxCatalog(req.catalog);
  assertDbxSchema(schema);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ns: any = await import('@databricks/sql');
  const DBSQLClient = ns.DBSQLClient ?? ns.default?.DBSQLClient ?? ns.default;
  const client = new DBSQLClient();

  const connection = await client.connect({
    host: req.host,
    path: req.httpPath,
    token: req.token,
  });
  const session = await connection.openSession();

  const run = async (sqlText: string): Promise<SourceRow[]> => {
    const op = await session.executeStatement(sqlText, { runAsync: true });
    try {
      const rows = (await op.fetchAll()) as Array<Record<string, unknown>>;
      return (rows || []).map((r) => normalizeRow(r));
    } finally {
      try { await op.close(); } catch { /* ignore close error */ }
    }
  };

  try {
    const tableRows = await run(buildDatabricksTableListSql(req.catalog, schema));
    const columnRows = await run(buildDatabricksColumnListSql(req.catalog, schema));
    return groupAssets(tableRows, columnRows);
  } finally {
    try { await session.close(); } catch { /* ignore */ }
    try { await client.close(); } catch { /* ignore */ }
  }
}
