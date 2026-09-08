// Live database-source driver layer. `fetchDbRows` is the one entry point
// the sync engine calls: it validates the request, builds the engine-
// specific SELECT, and dispatches to the matching driver. Drivers open a
// real connection and read rows — there is no simulation here, so any
// failure (bad host, auth, missing table) throws and the caller records a
// failed run.

import { buildSelectSql } from './sql';
import { assertConnectableHost } from './ssrf-guard';
import type { DbSourceRequest, SourceRow } from './types';
import { SUPPORTED_DB_SOURCE_TYPES } from './types';
import { fetchPostgresRows } from './postgres';
import { fetchMysqlRows } from './mysql';
import { fetchSqlServerRows } from './sqlserver';
import { fetchOracleRows } from './oracle';

export async function fetchDbRows(req: DbSourceRequest): Promise<SourceRow[]> {
  if (!SUPPORTED_DB_SOURCE_TYPES.includes(req.dbType)) {
    throw new Error(
      `Unsupported database type for live sync: ${req.dbType}. Supported: ${SUPPORTED_DB_SOURCE_TYPES.join(', ')}`,
    );
  }
  if (!req.host || !req.host.trim()) throw new Error('Database source is missing a host');
  if (!req.database || !req.database.trim()) throw new Error('Database source is missing a database name');

  // SSRF guard: refuse the cloud metadata / link-local range before opening a
  // socket (and loopback/private too when DB_SOURCE_BLOCK_PRIVATE_HOSTS is set).
  await assertConnectableHost(req.host);

  const sql = buildSelectSql(req.dbType, {
    schema: req.schema,
    table: req.table,
    query: req.query,
    limit: req.limit,
  });

  switch (req.dbType) {
    case 'POSTGRESQL': return fetchPostgresRows(req, sql);
    case 'MYSQL': return fetchMysqlRows(req, sql);
    case 'SQLSERVER': return fetchSqlServerRows(req, sql);
    case 'ORACLE': return fetchOracleRows(req, sql);
  }
}

export { buildSelectSql, normalizeRow, normalizeValue } from './sql';
export { SUPPORTED_DB_SOURCE_TYPES } from './types';
export type { DbSourceRequest, DbSourceType, SourceRow } from './types';
