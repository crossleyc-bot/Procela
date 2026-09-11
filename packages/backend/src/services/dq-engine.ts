/**
 * Data Quality Rule Engine
 *
 * Evaluates a typed DQ rule against the values of a single column. Works in
 * two modes:
 *
 *  - Real (file): when the rule's Data Asset was imported from a
 *    FILE_STORAGE/LOCAL connection with a concrete `sourceColumn`, the engine
 *    reads the uploaded file and runs the rule against the actual values.
 *
 *  - Simulated: when no driver can measure the rule — an unconfigured source,
 *    or a rule type (REGEX_MATCH / CUSTOM) that doesn't push down — the engine
 *    returns a clearly-labelled simulated result, deterministic per (asset,
 *    rule) so repeated runs don't thrash.
 *
 * A configured direct-connect DATABASE is measured for real by the pushdown
 * path in services/dq-db.ts (and the on-prem connector), not here — this
 * module stays driver-free so it unit-tests without a live database.
 */

import { readColumnValues, isDqExecutableFile } from '../lib/local-file-connector';

export type RuleType =
  | 'NOT_NULL'
  | 'UNIQUE'
  | 'REGEX_MATCH'
  | 'IN_SET'
  | 'NUMERIC_RANGE'
  | 'LENGTH_RANGE'
  | 'CUSTOM';

export interface RuleParameters {
  pattern?: string;              // REGEX_MATCH
  allowedValues?: string[];      // IN_SET
  min?: number;                  // NUMERIC_RANGE
  max?: number;                  // NUMERIC_RANGE
  minLength?: number;            // LENGTH_RANGE
  maxLength?: number;            // LENGTH_RANGE
  language?: 'js' | 'sql';       // CUSTOM
  body?: string;                 // CUSTOM
}

export interface RuleRunResult {
  ranAt: string;
  simulated: boolean;
  totalRows: number;
  passCount: number;
  failCount: number;
  passRate: number; // 0-100, integer
  failureSamples: string[];
  message: string;
}

/** Minimal shape a rule contributes to an asset's health rollup. */
export interface RuleHealthContribution {
  weight: number;
  currentScore: number;
  lastRun?: { simulated?: boolean } | null;
}

/**
 * Roll an asset's health up from its DQ rules — MEASURED rules only.
 *
 * A rule whose last run was simulated (no driver wired for the connection
 * type) carries a hash-derived pass rate, not a measurement. Letting that
 * feed the asset's persisted `healthScore` — which is surfaced app-wide
 * (dashboard, gaps, list, AI context) with no "simulated" caveat — is the
 * leak this guards against. Rules that have never run are excluded too.
 *
 * Returns `health: null` when the asset has no measured rule, so callers
 * LEAVE the existing healthScore (connector freshness / manual) untouched
 * rather than overwriting it with a fabricated number or zeroing it out.
 */
export function rollupAssetHealth(rules: RuleHealthContribution[]): {
  health: number | null;
  measuredCount: number;
  simulatedCount: number;
} {
  const measured = rules.filter((r) => r.lastRun && r.lastRun.simulated === false);
  const simulatedCount = rules.filter((r) => r.lastRun && r.lastRun.simulated === true).length;
  const totalWeight = measured.reduce((sum, r) => sum + (r.weight || 0), 0);
  if (measured.length === 0 || totalWeight <= 0) {
    return { health: null, measuredCount: 0, simulatedCount };
  }
  const weightedSum = measured.reduce((sum, r) => sum + r.currentScore * (r.weight || 0), 0);
  return { health: Math.round(weightedSum / totalWeight), measuredCount: measured.length, simulatedCount };
}

export interface RuleSubject {
  // Information about the Data Asset's source, looked up by the caller.
  connectionType?: string;
  storageType?: string;
  localFilePath?: string;
  sourceColumn?: string;
  originalFileName?: string;
  // Fallback context for simulated evaluation.
  assetId: string;
  ruleId: string;
}

// ── Public API ────────────────────────────────────────────────────────────

export function evaluateRule(
  ruleType: RuleType,
  params: RuleParameters,
  subject: RuleSubject,
): RuleRunResult {
  const canExecuteForReal =
    subject.connectionType === 'FILE_STORAGE' &&
    subject.storageType === 'LOCAL' &&
    !!subject.localFilePath &&
    !!subject.sourceColumn &&
    // Parquet/Avro are discoverable (schema) but their values aren't read
    // synchronously here yet, so DQ on them stays simulated, not a hard failure.
    isDqExecutableFile(subject.localFilePath);

  if (canExecuteForReal) {
    try {
      const values = readColumnValues(subject.localFilePath!, subject.sourceColumn!);
      return evaluateValues(ruleType, params, values);
    } catch (err) {
      return emptyFailure(err instanceof Error ? err.message : String(err), false);
    }
  }
  return simulate(ruleType, subject);
}

// ── Real evaluation ───────────────────────────────────────────────────────

function evaluateValues(
  ruleType: RuleType,
  params: RuleParameters,
  values: Array<string | null>,
): RuleRunResult {
  const total = values.length;
  const now = new Date().toISOString();

  switch (ruleType) {
    case 'NOT_NULL': {
      const failures: string[] = [];
      let fails = 0;
      for (const v of values) {
        if (v === null || v === '') fails++;
      }
      // NOT_NULL failures are by definition empty — report row positions.
      if (fails > 0) failures.push(`${fails} empty / missing value${fails === 1 ? '' : 's'}`);
      return finaliseResult(total, fails, failures, now,
        `${total - fails}/${total} rows have a value for this column`);
    }

    case 'UNIQUE': {
      const seen = new Map<string | null, number>();
      for (const v of values) {
        const key = v === null ? '__NULL__' : v;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
      const duplicates = Array.from(seen.entries()).filter(([, count]) => count > 1);
      const failingRows = duplicates.reduce((s, [, c]) => s + c, 0);
      const samples = duplicates
        .slice(0, 5)
        .map(([v, c]) => `${String(v)} (×${c})`);
      return finaliseResult(total, failingRows, samples, now,
        duplicates.length === 0
          ? `All ${total} values are unique`
          : `${duplicates.length} duplicate value${duplicates.length === 1 ? '' : 's'} across ${failingRows} rows`);
    }

    case 'REGEX_MATCH': {
      if (!params.pattern) return emptyFailure('REGEX_MATCH requires a `pattern` parameter', false);
      let re: RegExp;
      try {
        re = new RegExp(params.pattern);
      } catch (err) {
        return emptyFailure(`Invalid regex: ${err instanceof Error ? err.message : String(err)}`, false);
      }
      const failures: string[] = [];
      let fails = 0;
      for (const v of values) {
        if (v === null || !re.test(v)) {
          fails++;
          if (failures.length < 5 && v !== null) failures.push(v);
        }
      }
      return finaliseResult(total, fails, failures, now,
        `${total - fails}/${total} rows match /${params.pattern}/`);
    }

    case 'IN_SET': {
      if (!params.allowedValues || params.allowedValues.length === 0) {
        return emptyFailure('IN_SET requires a non-empty `allowedValues` list', false);
      }
      const set = new Set(params.allowedValues);
      const failures: string[] = [];
      let fails = 0;
      for (const v of values) {
        if (v === null || !set.has(v)) {
          fails++;
          if (failures.length < 5 && v !== null && !failures.includes(v)) failures.push(v);
        }
      }
      return finaliseResult(total, fails, failures, now,
        `${total - fails}/${total} rows are in the allowed set`);
    }

    case 'NUMERIC_RANGE': {
      const min = params.min;
      const max = params.max;
      if (min === undefined && max === undefined) {
        return emptyFailure('NUMERIC_RANGE requires `min` and/or `max`', false);
      }
      const failures: string[] = [];
      let fails = 0;
      for (const v of values) {
        if (v === null) { fails++; continue; }
        const n = Number(v);
        if (Number.isNaN(n)) {
          fails++;
          if (failures.length < 5) failures.push(v);
          continue;
        }
        if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
          fails++;
          if (failures.length < 5) failures.push(v);
        }
      }
      const rangeLabel =
        min !== undefined && max !== undefined ? `${min}..${max}` :
        min !== undefined ? `>= ${min}` :
        `<= ${max}`;
      return finaliseResult(total, fails, failures, now,
        `${total - fails}/${total} rows fall within ${rangeLabel}`);
    }

    case 'LENGTH_RANGE': {
      const minL = params.minLength;
      const maxL = params.maxLength;
      if (minL === undefined && maxL === undefined) {
        return emptyFailure('LENGTH_RANGE requires `minLength` and/or `maxLength`', false);
      }
      const failures: string[] = [];
      let fails = 0;
      for (const v of values) {
        const len = v === null ? 0 : v.length;
        if ((minL !== undefined && len < minL) || (maxL !== undefined && len > maxL)) {
          fails++;
          if (failures.length < 5 && v !== null) failures.push(v);
        }
      }
      const rangeLabel =
        minL !== undefined && maxL !== undefined ? `${minL}..${maxL} chars` :
        minL !== undefined ? `>= ${minL} chars` :
        `<= ${maxL} chars`;
      return finaliseResult(total, fails, failures, now,
        `${total - fails}/${total} rows are ${rangeLabel}`);
    }

    case 'CUSTOM': {
      // Execute the user's JS expression once per value. The expression is
      // either a bare expression ("value.startsWith('MSB-')") or a full
      // statement block ("return value > 0;"). Syntax errors fail upfront;
      // per-value runtime errors count as failures.
      //
      // SECURITY: `new Function` runs in the Node process. In this prototype
      // that's acceptable because the app is single-tenant and the users
      // creating rules are trusted. For any multi-tenant deployment this
      // must be swapped for a real sandbox (isolated-vm or similar).
      if (params.language === 'sql') {
        // SQL custom rules have no executor here — they're display-only.
        return emptyFailure('SQL custom rules have no local executor; execution is simulated when the source is a database.', false);
      }
      if (!params.body || !params.body.trim()) {
        return emptyFailure('CUSTOM requires a `body` expression', false);
      }
      let fn: (value: unknown) => unknown;
      try {
        const trimmed = params.body.trim();
        const wrapped = /\breturn\b|;/.test(trimmed) ? trimmed : `return (${trimmed});`;
        fn = new Function('value', wrapped) as (value: unknown) => unknown;
      } catch (err) {
        return emptyFailure(`Invalid expression: ${err instanceof Error ? err.message : String(err)}`, false);
      }
      const failures: string[] = [];
      let fails = 0;
      for (const v of values) {
        let ok = false;
        try { ok = !!fn(v); } catch { ok = false; }
        if (!ok) {
          fails++;
          if (failures.length < 5 && v !== null) failures.push(v);
        }
      }
      return finaliseResult(total, fails, failures, now,
        `${total - fails}/${total} rows satisfied the expression`);
    }
  }
}

function finaliseResult(
  total: number,
  fails: number,
  samples: string[],
  ranAt: string,
  message: string,
): RuleRunResult {
  const pass = total - fails;
  const passRate = total === 0 ? 100 : Math.round((pass * 100) / total);
  return {
    ranAt, simulated: false,
    totalRows: total,
    passCount: pass,
    failCount: fails,
    passRate,
    failureSamples: samples,
    message,
  };
}

function emptyFailure(message: string, simulated: boolean): RuleRunResult {
  return {
    ranAt: new Date().toISOString(),
    simulated,
    totalRows: 0,
    passCount: 0,
    failCount: 0,
    passRate: 0,
    failureSamples: [],
    message,
  };
}

// ── Simulated evaluation ─────────────────────────────────────────────────

// Deterministic hash so repeated runs of the same (rule, asset) return the
// same number — users shouldn't see numbers fluctuate on every click.
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function simulate(ruleType: RuleType, subject: RuleSubject): RuleRunResult {
  const seed = hashCode(`${subject.assetId}:${subject.ruleId}:${ruleType}`);
  const totalRows = 10_000 + (seed % 90_000);
  // Typed rules have different realistic pass-rate bands so outcomes feel
  // appropriate to what the rule is checking.
  const band = RULE_PASS_BANDS[ruleType];
  const passRate = band.min + (seed % (band.max - band.min + 1));
  const passCount = Math.round((totalRows * passRate) / 100);
  const failCount = totalRows - passCount;
  return {
    ranAt: new Date().toISOString(),
    simulated: true,
    totalRows,
    passCount,
    failCount,
    passRate,
    failureSamples: [],
    message: `Simulated result (no driver wired for this connection type). Upload the data as a local file to get real DQ numbers.`,
  };
}

const RULE_PASS_BANDS: Record<RuleType, { min: number; max: number }> = {
  NOT_NULL: { min: 92, max: 100 },
  UNIQUE: { min: 85, max: 100 },
  REGEX_MATCH: { min: 80, max: 99 },
  IN_SET: { min: 88, max: 100 },
  NUMERIC_RANGE: { min: 90, max: 100 },
  LENGTH_RANGE: { min: 90, max: 100 },
  CUSTOM: { min: 70, max: 100 },
};

// ── Out-of-the-box rule templates ─────────────────────────────────────────

export interface RuleTemplate {
  id: string;           // stable id, e.g. 'not-null', 'regex-email'
  ruleType: RuleType;
  dimension: 'COMPLETENESS' | 'ACCURACY' | 'TIMELINESS' | 'CONSISTENCY' | 'UNIQUENESS' | 'VALIDITY';
  name: string;
  description: string;
  parameters: RuleParameters;
  // Heuristic: this template is *suggested* when the column name matches.
  // Undefined means "applicable to every column".
  columnNamePattern?: RegExp;
}

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: 'not-null',
    ruleType: 'NOT_NULL',
    dimension: 'COMPLETENESS',
    name: 'Not null',
    description: 'Fails if any value is empty or missing.',
    parameters: {},
  },
  {
    id: 'unique',
    ruleType: 'UNIQUE',
    dimension: 'UNIQUENESS',
    name: 'Unique values',
    description: 'Fails if any value appears more than once.',
    parameters: {},
    columnNamePattern: /(^|_)id$|_key$/i,
  },
  {
    id: 'regex-email',
    ruleType: 'REGEX_MATCH',
    dimension: 'VALIDITY',
    name: 'Valid email format',
    description: 'Fails if values don\u2019t match a reasonable email pattern.',
    parameters: { pattern: '^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$' },
    columnNamePattern: /email/i,
  },
  {
    id: 'regex-phone',
    ruleType: 'REGEX_MATCH',
    dimension: 'VALIDITY',
    name: 'Valid phone format',
    description: 'Fails on values that don\u2019t look like a phone number (digits, spaces, dashes, parentheses, optional + prefix).',
    parameters: { pattern: '^\\+?[0-9 ()\\-]{7,}$' },
    columnNamePattern: /(phone|tel|mobile)/i,
  },
  {
    id: 'regex-iso-date',
    ruleType: 'REGEX_MATCH',
    dimension: 'VALIDITY',
    name: 'ISO-8601 date/time',
    description: 'Fails on values that don\u2019t match YYYY-MM-DD or a full ISO timestamp.',
    parameters: { pattern: '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+\\-]\\d{2}:\\d{2})?)?$' },
    columnNamePattern: /(date|_at$|time)/i,
  },
  {
    id: 'regex-url',
    ruleType: 'REGEX_MATCH',
    dimension: 'VALIDITY',
    name: 'Valid URL',
    description: 'Fails on values that aren\u2019t http(s) URLs.',
    parameters: { pattern: '^https?://[\\w.-]+(:\\d+)?(/[^\\s]*)?$' },
    columnNamePattern: /(url|website|link)/i,
  },
  {
    id: 'regex-zip-us',
    ruleType: 'REGEX_MATCH',
    dimension: 'VALIDITY',
    name: 'US ZIP code',
    description: 'Fails on values that aren\u2019t 5-digit or 5+4 US ZIP codes.',
    parameters: { pattern: '^\\d{5}(-\\d{4})?$' },
    columnNamePattern: /(zip|postal)/i,
  },
  {
    id: 'in-set-status',
    ruleType: 'IN_SET',
    dimension: 'CONSISTENCY',
    name: 'One of allowed values',
    description: 'Fails on values that aren\u2019t in a caller-supplied allowed list. Fill in values after adding.',
    parameters: { allowedValues: [] },
    columnNamePattern: /(status|state|type|category|tier|role)/i,
  },
  {
    id: 'numeric-range',
    ruleType: 'NUMERIC_RANGE',
    dimension: 'VALIDITY',
    name: 'Numeric range',
    description: 'Fails on non-numeric values or values outside the min/max you supply.',
    parameters: {},
    columnNamePattern: /(amount|price|qty|quantity|count|score|age|year)/i,
  },
  {
    id: 'length-range',
    ruleType: 'LENGTH_RANGE',
    dimension: 'VALIDITY',
    name: 'Length range',
    description: 'Fails on values whose character length is outside the min/max you supply.',
    parameters: {},
  },
  {
    id: 'custom',
    ruleType: 'CUSTOM',
    dimension: 'VALIDITY',
    name: 'Custom rule',
    description: 'Write your own expression. Use "js" to evaluate per-value on local files; use "sql" for a database query (display-only here — simulated until a driver is wired).',
    parameters: { language: 'js', body: '' },
  },
];

// ── Rule definition describer ────────────────────────────────────────────

export interface DescribeContext {
  connectionType?: string;
  storageType?: string;
  dbType?: string;
  sourceAsset?: string;   // table / file / endpoint / sheet
  sourceColumn?: string;
  originalFileName?: string;
}

export interface RuleDefinition {
  /** 'sql' for database-style rules, 'js' for per-row file evaluation, 'pseudo' for descriptive-only. */
  language: 'sql' | 'js' | 'pseudo';
  /** The concrete body a driver would execute, or pseudocode if no driver applies. */
  body: string;
  /** True when the definition could actually be executed by the engine for this source. */
  executable: boolean;
}

/**
 * Render the concrete "definition" of a rule for its bound source — the SQL
 * a database driver would run, the JS an in-process engine applies to a file,
 * or pseudocode when no real executor exists for the source. Placeholders
 * like `{table}` and `{column}` appear when the asset isn't bound to a
 * specific table / column yet.
 */
export function describeRule(
  ruleType: RuleType,
  params: RuleParameters,
  ctx: DescribeContext,
): RuleDefinition {
  const table = ctx.sourceAsset || '{table}';
  const col = ctx.sourceColumn || '{column}';
  const file = ctx.originalFileName || '{file}';
  const isDb = ctx.connectionType === 'DATABASE' || ctx.connectionType === 'DATA_WAREHOUSE';
  const isLocal = ctx.connectionType === 'FILE_STORAGE' && ctx.storageType === 'LOCAL';
  const regexOp = ctx.dbType === 'MYSQL' ? 'NOT REGEXP' : '!~';

  const sql = (body: string): RuleDefinition => ({ language: 'sql', body, executable: false });
  const js = (body: string, executable: boolean): RuleDefinition => ({ language: 'js', body, executable });
  const pseudo = (body: string): RuleDefinition => ({ language: 'pseudo', body, executable: false });

  if (isDb) {
    switch (ruleType) {
      case 'NOT_NULL':
        return sql(`SELECT COUNT(*) FILTER (WHERE ${col} IS NULL) AS fail_count,\n       COUNT(*)                              AS total\nFROM ${table};`);
      case 'UNIQUE':
        return sql(`SELECT COUNT(*) - COUNT(DISTINCT ${col}) AS duplicate_count,\n       COUNT(DISTINCT ${col})            AS distinct_count,\n       COUNT(*)                          AS total\nFROM ${table};`);
      case 'REGEX_MATCH':
        return sql(`SELECT COUNT(*) FILTER (WHERE ${col} ${regexOp} '${params.pattern || '{pattern}'}') AS fail_count,\n       COUNT(*) AS total\nFROM ${table};`);
      case 'IN_SET': {
        const vals = (params.allowedValues && params.allowedValues.length > 0 ? params.allowedValues : ['{v1}', '{v2}'])
          .map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ');
        return sql(`SELECT COUNT(*) FILTER (WHERE ${col} NOT IN (${vals})) AS fail_count,\n       COUNT(*) AS total\nFROM ${table};`);
      }
      case 'NUMERIC_RANGE': {
        const bits: string[] = [];
        if (params.min !== undefined) bits.push(`${col} < ${params.min}`);
        if (params.max !== undefined) bits.push(`${col} > ${params.max}`);
        const where = bits.length > 0 ? bits.join(' OR ') : 'FALSE /* set min and/or max */';
        return sql(`SELECT COUNT(*) FILTER (WHERE ${where}) AS fail_count,\n       COUNT(*) AS total\nFROM ${table};`);
      }
      case 'LENGTH_RANGE': {
        const bits: string[] = [];
        if (params.minLength !== undefined) bits.push(`LENGTH(${col}) < ${params.minLength}`);
        if (params.maxLength !== undefined) bits.push(`LENGTH(${col}) > ${params.maxLength}`);
        const where = bits.length > 0 ? bits.join(' OR ') : 'FALSE /* set minLength and/or maxLength */';
        return sql(`SELECT COUNT(*) FILTER (WHERE ${where}) AS fail_count,\n       COUNT(*) AS total\nFROM ${table};`);
      }
      case 'CUSTOM':
        return {
          language: (params.language as 'sql' | 'js') || 'sql',
          body: params.body || '-- paste custom SQL',
          executable: false, // real DB driver not wired
        };
    }
  }

  if (isLocal) {
    switch (ruleType) {
      case 'NOT_NULL':
        return js(`// For each row of ${file}:\n//   fail if ${col} is null or empty\nvalues.filter(v => v === null || v === '').length   // failures`, true);
      case 'UNIQUE':
        return js(`const counts = new Map();\nfor (const v of values) counts.set(v, (counts.get(v) || 0) + 1);\nconst duplicates = [...counts].filter(([, c]) => c > 1);\n// fail = sum of the row counts of each duplicate value`, true);
      case 'REGEX_MATCH':
        return js(`const re = /${params.pattern || '{pattern}'}/;\nvalues.filter(v => v === null || !re.test(v)).length  // failures`, true);
      case 'IN_SET': {
        const vals = JSON.stringify(params.allowedValues || []);
        return js(`const allowed = new Set(${vals});\nvalues.filter(v => v === null || !allowed.has(v)).length  // failures`, true);
      }
      case 'NUMERIC_RANGE': {
        const parts: string[] = [`v === null`, `Number.isNaN(Number(v))`];
        if (params.min !== undefined) parts.push(`Number(v) < ${params.min}`);
        if (params.max !== undefined) parts.push(`Number(v) > ${params.max}`);
        return js(`values.filter(v => ${parts.join(' || ')}).length  // failures`, true);
      }
      case 'LENGTH_RANGE': {
        const parts: string[] = [];
        if (params.minLength !== undefined) parts.push(`(v?.length ?? 0) < ${params.minLength}`);
        if (params.maxLength !== undefined) parts.push(`(v?.length ?? 0) > ${params.maxLength}`);
        return js(`values.filter(v => ${parts.length ? parts.join(' || ') : 'false /* set minLength/maxLength */'}).length  // failures`, true);
      }
      case 'CUSTOM': {
        const lang = params.language === 'sql' ? 'sql' : 'js';
        const body = params.body || '// e.g. value.startsWith("MSB-")';
        // SQL against a LOCAL file isn't executable here.
        return { language: lang, body, executable: lang === 'js' };
      }
    }
  }

  // Fallback: API / SPREADSHEET / cloud FILE_STORAGE / unknown — pseudocode.
  const summary = (() => {
    switch (ruleType) {
      case 'NOT_NULL': return `Count rows in ${table} where ${col} is null or empty.`;
      case 'UNIQUE': return `Count duplicate values of ${col} in ${table}.`;
      case 'REGEX_MATCH': return `Count values of ${col} in ${table} that do not match /${params.pattern || '{pattern}'}/.`;
      case 'IN_SET': return `Count values of ${col} in ${table} that are not in the allowed list.`;
      case 'NUMERIC_RANGE': return `Count values of ${col} in ${table} outside ${params.min ?? '-\u221E'}..${params.max ?? '+\u221E'}.`;
      case 'LENGTH_RANGE': return `Count values of ${col} in ${table} whose length is outside ${params.minLength ?? 0}..${params.maxLength ?? '+\u221E'}.`;
      case 'CUSTOM': return params.body || 'Custom expression (provide body).';
    }
  })();
  return pseudo(`${summary}\n(No driver is wired for ${ctx.connectionType || 'this connection type'} \u2014 execution is simulated.)`);
}

// ── Templates ────────────────────────────────────────────────────────────

/**
 * Return templates applicable to a column. Templates with a matching
 * `columnNamePattern` come first (sorted as "suggested"); generic ones
 * follow. The caller decides how to present them.
 */
export function suggestTemplates(columnName: string | undefined): {
  suggested: RuleTemplate[];
  generic: RuleTemplate[];
} {
  if (!columnName) {
    return { suggested: [], generic: RULE_TEMPLATES };
  }
  const suggested: RuleTemplate[] = [];
  const generic: RuleTemplate[] = [];
  for (const t of RULE_TEMPLATES) {
    if (t.columnNamePattern && t.columnNamePattern.test(columnName)) {
      suggested.push(t);
    } else if (!t.columnNamePattern) {
      generic.push(t);
    } else {
      generic.push(t);
    }
  }
  return { suggested, generic };
}
