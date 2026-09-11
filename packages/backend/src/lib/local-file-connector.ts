import fs from 'fs';
import path from 'path';
import { walkLeafPaths, resolveLeafPath } from './flatten-paths';

const DATA_DIR = path.resolve(process.cwd(), '.procela-data');
const UPLOADS_ROOT = path.join(DATA_DIR, 'uploads');

export function getUploadsDir(connectionId: string): string {
  return path.join(UPLOADS_ROOT, connectionId);
}

/**
 * Remove the entire upload directory for a connection, if it exists.
 * No-ops silently if the directory doesn't exist.
 */
export function deleteLocalFileDir(connectionId: string): void {
  const dir = getUploadsDir(connectionId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface FileAnalysis {
  rowCount: number;
  columns: string[];
}

/**
 * Analyze an uploaded local data file and return row count + column names.
 *
 * Supported:
 *   .csv, .tsv  — delimited text with a header row
 *   .json       — either an array-of-objects or { data: [...] } shape
 *   .jsonl / .ndjson — newline-delimited JSON objects
 *
 * Throws on unsupported extensions or parse errors so the caller can surface
 * the message to the user.
 */
export function analyzeLocalFile(absPath: string): FileAnalysis {
  const ext = path.extname(absPath).toLowerCase();
  const buf = fs.readFileSync(absPath);
  const text = buf.toString('utf-8');

  switch (ext) {
    case '.csv':
      return analyzeDelimited(text, ',');
    case '.tsv':
      return analyzeDelimited(text, '\t');
    case '.jsonl':
    case '.ndjson':
      return analyzeJsonLines(text);
    case '.json':
      return analyzeJson(text);
    default:
      throw new Error(`Unsupported file type: ${ext || '(no extension)'}. Expected .csv, .tsv, .json, .jsonl, or .ndjson.`);
  }
}

// ── Parsers ──

function analyzeDelimited(text: string, delimiter: string): FileAnalysis {
  // Strip BOM if present; split on any newline style.
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error('File is empty');
  }
  const columns = splitDelimitedRow(lines[0], delimiter).map((c) => c.trim());
  if (columns.length === 0 || columns.every((c) => c === '')) {
    throw new Error('No columns detected in header row');
  }
  return { rowCount: Math.max(lines.length - 1, 0), columns };
}

// Minimal CSV/TSV splitter that respects double-quoted fields. Good enough for
// header extraction; full RFC 4180 quoting nuances aren't necessary here.
function splitDelimitedRow(row: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inQuotes) {
      if (ch === '"') {
        if (row[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = false; }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delimiter) { out.push(current); current = ''; }
      else current += ch;
    }
  }
  out.push(current);
  return out;
}

function analyzeJson(text: string): FileAnalysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Accept either a bare array of objects or { data: [...] }.
  const rows = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).data))
      ? (parsed as any).data
      : null;
  if (!rows) {
    throw new Error('Expected a JSON array or an object with a "data" array');
  }
  return buildJsonAnalysis(rows);
}

function analyzeJsonLines(text: string): FileAnalysis {
  const rows: any[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (let i = 0; i < lines.length; i++) {
    try {
      rows.push(JSON.parse(lines[i]));
    } catch (err) {
      throw new Error(`Invalid JSON on line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return buildJsonAnalysis(rows);
}

function buildJsonAnalysis(rows: any[]): FileAnalysis {
  if (rows.length === 0) {
    return { rowCount: 0, columns: [] };
  }
  // Union the FLATTENED leaf paths across the first handful of objects so we
  // don't miss columns that appear only on later rows — and so a nested object
  // (`{ address: { city } }`) is catalogued as `address.city`, not one opaque
  // `address` blob. Arrays stay a single leaf column (see flatten-paths.ts).
  const sample = rows.slice(0, 50);
  const columnSet = new Set<string>();
  for (const row of sample) {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      walkLeafPaths(row, (p) => columnSet.add(p));
    }
  }
  return { rowCount: rows.length, columns: Array.from(columnSet) };
}

// ── Column reader for DQ rule execution ───────────────────────────────────

/**
 * Read every value for a single column out of an uploaded file. Used by the
 * data-quality rule engine to evaluate rules (NOT_NULL, UNIQUE, REGEX, …)
 * against a specific data point. Missing keys in JSON produce `null`;
 * unknown columns throw so the caller can surface a clear error.
 */
export function readColumnValues(absPath: string, columnName: string): Array<string | null> {
  const ext = path.extname(absPath).toLowerCase();
  const text = fs.readFileSync(absPath, 'utf-8');
  switch (ext) {
    case '.csv': return readDelimitedColumn(text, ',', columnName);
    case '.tsv': return readDelimitedColumn(text, '\t', columnName);
    case '.jsonl':
    case '.ndjson': return readJsonLinesColumn(text, columnName);
    case '.json': return readJsonColumn(text, columnName);
    default:
      throw new Error(`Unsupported file type: ${ext || '(no extension)'}`);
  }
}

function readDelimitedColumn(text: string, delimiter: string, columnName: string): Array<string | null> {
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = splitDelimitedRow(lines[0], delimiter).map((c) => c.trim());
  const idx = header.indexOf(columnName);
  if (idx === -1) {
    throw new Error(`Column "${columnName}" not found in file (available: ${header.join(', ')})`);
  }
  const out: Array<string | null> = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitDelimitedRow(lines[i], delimiter);
    const v = cols[idx];
    out.push(v === undefined || v === '' ? null : v);
  }
  return out;
}

function readJsonColumn(text: string, columnName: string): Array<string | null> {
  const parsed = JSON.parse(text);
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).data))
      ? (parsed as any).data
      : [];
  return rows.map((r) => extractJsonValue(r, columnName));
}

function readJsonLinesColumn(text: string, columnName: string): Array<string | null> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.map((l) => extractJsonValue(JSON.parse(l), columnName));
}

function extractJsonValue(row: unknown, columnName: string): string | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  // Resolve a dotted leaf path (`address.city`) so a DQ rule can grade a
  // nested column surfaced by discovery. A plain key with no dots resolves as
  // before, so top-level columns are unaffected.
  const v = resolveLeafPath(row, columnName);
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}
