// Cloud-side data-quality aggregate SQL, for measuring a rule against a
// direct-connect database. Mirrors the on-prem connector's buildAggregateQuery
// (packages/connector/src/dq.ts) so a rule measured over a direct connection
// and one measured by the edge agent produce identical counts.
//
// Only the pushdown-safe rule types are handled — the same set the connector
// and the backend plan already restrict to (NOT_NULL / UNIQUE / IN_SET /
// NUMERIC_RANGE / LENGTH_RANGE). REGEX_MATCH (no portable engine support) and
// CUSTOM (arbitrary code) stay on the file / simulated path.
//
// Identifiers (schema/table/column) are quoted per dialect; rule *values*
// (allowed set, range bounds) are always bound as parameters, never
// interpolated, so a rule definition can't inject SQL.

import type { DbSourceType } from './types';
import type { RuleType, RuleParameters } from '../../services/dq-engine';

export const DB_MEASURABLE_RULE_TYPES: RuleType[] =
  ['NOT_NULL', 'UNIQUE', 'IN_SET', 'NUMERIC_RANGE', 'LENGTH_RANGE'];

export interface DqAggregateEntry {
  /** Physical table (optionally `schema.table`). */
  table: string;
  /** Physical column. */
  column: string;
  ruleType: RuleType;
  parameters: RuleParameters;
}

function quoteId(dbType: DbSourceType, id: string): string {
  if (dbType === 'MYSQL') return '`' + id.replace(/`/g, '``') + '`';
  if (dbType === 'SQLSERVER') return '[' + id.replace(/]/g, ']]') + ']';
  return '"' + id.replace(/"/g, '""') + '"'; // POSTGRESQL, ORACLE
}

function qualifiedTable(dbType: DbSourceType, name: string): string {
  const i = name.indexOf('.');
  if (i < 0) return quoteId(dbType, name);
  return `${quoteId(dbType, name.slice(0, i))}.${quoteId(dbType, name.slice(i + 1))}`;
}

/** Positional placeholder in the engine's own style. */
function placeholder(dbType: DbSourceType, idx: number): string {
  switch (dbType) {
    case 'POSTGRESQL':
    case 'REDSHIFT': return '$' + (idx + 1); // Redshift uses the Postgres protocol
    case 'ORACLE': return ':' + (idx + 1);
    case 'SQLSERVER': return '@p' + idx;
    case 'MYSQL': return '?';
  }
}

const lengthFn = (dbType: DbSourceType): string => (dbType === 'SQLSERVER' ? 'LEN' : 'LENGTH');

/**
 * Build the aggregate query for one rule. Returns `{ sql, params }` — the query
 * always projects `total` (row count) and `passes` (rows satisfying the rule) —
 * or null when the rule type isn't DB-measurable or its parameters are
 * missing/invalid (the caller then falls back to the simulated path).
 */
export function buildDqAggregateSql(dbType: DbSourceType, entry: DqAggregateEntry): { sql: string; params: unknown[] } | null {
  const col = quoteId(dbType, entry.column);
  const tbl = qualifiedTable(dbType, entry.table);
  const params: unknown[] = [];
  const ph = () => placeholder(dbType, params.length - 1);
  const passes = (cond: string) => `COALESCE(SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END), 0) AS passes`;

  switch (entry.ruleType) {
    case 'NOT_NULL':
      return { sql: `SELECT COUNT(*) AS total, ${passes(`${col} IS NOT NULL`)} FROM ${tbl}`, params };

    case 'UNIQUE':
      // total = all rows; passes = rows whose value appears exactly once
      // (matches the file engine: every row in a duplicate group fails).
      return {
        sql: `SELECT COALESCE(SUM(cnt), 0) AS total, `
          + `COALESCE(SUM(CASE WHEN cnt = 1 THEN 1 ELSE 0 END), 0) AS passes `
          + `FROM (SELECT ${col} AS v, COUNT(*) AS cnt FROM ${tbl} GROUP BY ${col}) g`,
        params,
      };

    case 'IN_SET': {
      const vals = entry.parameters.allowedValues || [];
      if (vals.length === 0) return null;
      const list = vals.map((v) => { params.push(v); return ph(); }).join(', ');
      return { sql: `SELECT COUNT(*) AS total, ${passes(`${col} IN (${list})`)} FROM ${tbl}`, params };
    }

    case 'NUMERIC_RANGE': {
      const parts: string[] = [];
      if (entry.parameters.min !== undefined) { params.push(entry.parameters.min); parts.push(`${col} >= ${ph()}`); }
      if (entry.parameters.max !== undefined) { params.push(entry.parameters.max); parts.push(`${col} <= ${ph()}`); }
      if (parts.length === 0) return null;
      return { sql: `SELECT COUNT(*) AS total, ${passes(parts.join(' AND '))} FROM ${tbl}`, params };
    }

    case 'LENGTH_RANGE': {
      const len = `COALESCE(${lengthFn(dbType)}(${col}), 0)`;
      const parts: string[] = [];
      if (entry.parameters.minLength !== undefined) { params.push(entry.parameters.minLength); parts.push(`${len} >= ${ph()}`); }
      if (entry.parameters.maxLength !== undefined) { params.push(entry.parameters.maxLength); parts.push(`${len} <= ${ph()}`); }
      if (parts.length === 0) return null;
      return { sql: `SELECT COUNT(*) AS total, ${passes(parts.join(' AND '))} FROM ${tbl}`, params };
    }

    default:
      return null; // REGEX_MATCH / CUSTOM — not DB-measurable
  }
}
