// Shared shapes for the live database-source drivers. A sync connection
// whose sourceType is DATABASE resolves its config + credentials into a
// DbSourceRequest, and the driver layer turns that into a real connection
// and a batch of source rows the sync engine upserts.

/** The engines the direct-connect *row-sync* driver supports. The Connection
 *  profile also models MONGODB: it now has real schema discovery (collection
 *  listing + sampled field/type inference — see mongo-introspect.ts), but is
 *  still not wired for direct row sync, so it stays out of this union and
 *  fetchDbRows rejects it. */
export type DbSourceType = 'POSTGRESQL' | 'MYSQL' | 'SQLSERVER' | 'ORACLE';

export const SUPPORTED_DB_SOURCE_TYPES: DbSourceType[] = ['POSTGRESQL', 'MYSQL', 'SQLSERVER', 'ORACLE'];

/** Everything a driver needs to open a connection and read one table
 *  (or run one query). Assembled by resolveDbSource() from the sync's
 *  own config overlaid with a saved Connection profile's host/credentials. */
export interface DbSourceRequest {
  dbType: DbSourceType;
  host: string;
  port?: number;
  database: string;
  /** Schema (Postgres/SQL Server) or database qualifier (MySQL). Optional —
   *  when omitted the engine's default resolution applies. */
  schema?: string;
  /** Table to read. Ignored when `query` is set. */
  table?: string;
  /** Raw SELECT to run instead of table-scanning. Admin-authored and
   *  trusted; used verbatim. */
  query?: string;
  username?: string;
  password?: string;
  /** Row cap for a table-scan (ignored for a raw `query`, which owns its
   *  own limiting). */
  limit?: number;
  /** Positional bind values for a parameterized `query`. Rule *values*
   *  (allowed set, range bounds) are always bound, never interpolated, so a
   *  rule definition can't inject SQL. The `query` must use the engine's
   *  placeholder style ($1 / ? / @p0 / :1); buildDqAggregateSql emits the
   *  right one per engine. */
  params?: unknown[];
}

/** A source row, stringified — matches the shape the CSV/JSON path already
 *  hands the sync engine, so applyRow treats every source uniformly. */
export type SourceRow = Record<string, string>;
