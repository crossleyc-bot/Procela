// Pure SQL construction + result normalization for the live DB drivers.
// Kept driver-free so it unit-tests without pg / mysql2 / mssql or a live
// database — exactly the split the on-prem connector uses (discovery.ts vs
// the engine adapters).

import type { DbSourceType, SourceRow } from './types';

/** Default and hard cap on a table-scan's row count. A raw `query` bypasses
 *  this — it's admin-authored and owns its own limiting. */
export const DEFAULT_ROW_LIMIT = 1000;
export const MAX_ROW_LIMIT = 50_000;

/** SQL identifiers (schema / table) can't be parameterized, so they're
 *  interpolated — which makes validation the injection boundary. Allow only
 *  a conservative identifier charset; anything else (quotes, dots, spaces,
 *  semicolons) is rejected before it can reach a query string. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function assertIdentifier(kind: string, value: string): string {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`Invalid ${kind} identifier: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Clamp a caller-supplied limit into [1, MAX], defaulting when absent or
 *  non-finite. */
export function clampLimit(limit?: number): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_ROW_LIMIT;
  return Math.max(1, Math.min(MAX_ROW_LIMIT, Math.floor(limit)));
}

function quoteIdent(dbType: DbSourceType, ident: string): string {
  // The charset is already validated, so wrapping is safe.
  switch (dbType) {
    case 'POSTGRESQL':
    case 'REDSHIFT': return `"${ident}"`; // Redshift is Postgres-compatible
    case 'MYSQL': return `\`${ident}\``;
    case 'SQLSERVER': return `[${ident}]`;
    // Oracle folds unquoted identifiers to upper case; a table created as
    // EMPLOYEES is stored uppercase, so quoting a lower-case name would fail
    // to match. Emit the validated identifier BARE (the identifier charset
    // already blocks injection) and let Oracle's normal case-folding apply.
    case 'ORACLE': return ident;
  }
}

function qualifiedName(dbType: DbSourceType, schema: string | undefined, table: string): string {
  const t = quoteIdent(dbType, assertIdentifier('table', table));
  if (schema && schema.trim()) {
    return `${quoteIdent(dbType, assertIdentifier('schema', schema))}.${t}`;
  }
  return t;
}

export interface SelectSpec {
  schema?: string;
  table?: string;
  query?: string;
  limit?: number;
}

/**
 * Build the SELECT a table-scan runs. When `query` is provided it's returned
 * verbatim (trusted admin SQL). Otherwise a `SELECT * FROM <table>` with an
 * engine-appropriate row cap is generated: LIMIT for Postgres/MySQL, TOP for
 * SQL Server (which has no LIMIT clause).
 */
export function buildSelectSql(dbType: DbSourceType, spec: SelectSpec): string {
  const raw = spec.query?.trim();
  if (raw) return raw;

  if (!spec.table || !spec.table.trim()) {
    throw new Error('Database source requires either a table or a query');
  }
  const target = qualifiedName(dbType, spec.schema, spec.table.trim());
  const n = clampLimit(spec.limit);

  if (dbType === 'SQLSERVER') {
    return `SELECT TOP (${n}) * FROM ${target}`;
  }
  if (dbType === 'ORACLE') {
    // Oracle has no LIMIT; FETCH FIRST … ROWS ONLY is the 12c+ standard.
    return `SELECT * FROM ${target} FETCH FIRST ${n} ROWS ONLY`;
  }
  return `SELECT * FROM ${target} LIMIT ${n}`;
}

/** Coerce one engine-returned cell to the string shape the sync engine
 *  consumes. null/undefined collapse to '' (applyRow treats '' as "no
 *  value"); Dates become ISO; Buffers and objects are stringified so a
 *  JSON/BLOB column can't crash a run. */
export function normalizeValue(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Normalize a whole result row to Record<string,string>. */
export function normalizeRow(row: Record<string, unknown>): SourceRow {
  const out: SourceRow = {};
  for (const [k, v] of Object.entries(row)) out[k] = normalizeValue(v);
  return out;
}
