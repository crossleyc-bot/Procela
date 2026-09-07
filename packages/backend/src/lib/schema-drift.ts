// Schema-fingerprint helper for connector-discovered data assets.
//
// A scan reports a table's column set (name + data type). To detect *schema
// drift* — a column added, removed, or retyped since the last scan — we store
// a compact fingerprint of that column set on the asset and compare the next
// scan's fingerprint against it.
//
// Why a fingerprint rather than diffing the materialized `data_asset_columns`
// rows: that table is audit-only — a column that disappears from the source is
// never deleted from it — so it accumulates and cannot represent the *current*
// schema. The fingerprint captures the exact set reported by each scan,
// independent of that accumulation, so a dropped column is detectable.
//
// Pure and deterministic so it is unit-testable.

import { createHash } from 'crypto';

export interface FingerprintColumn {
  name?: string | null;
  dataType?: string | null;
}

/**
 * Stable fingerprint of a reported column set. Order-independent and
 * case/whitespace-insensitive on both name and type, so a reordered or
 * cosmetically-different scan of the same schema fingerprints identically —
 * only a genuine add / removal / type change moves it.
 *
 * Returns null when no usable columns were reported (an older agent that omits
 * columns), so callers can tell "no schema signal" apart from "empty schema"
 * and avoid recording a meaningless baseline.
 */
export function computeSchemaFingerprint(columns: FingerprintColumn[] | null | undefined): string | null {
  if (!Array.isArray(columns)) return null;
  const parts = columns
    .map((c) => {
      const name = String(c?.name ?? '').trim().toLowerCase();
      if (!name) return null;
      const type = String(c?.dataType ?? '').trim().toLowerCase();
      return `${name}:${type}`;
    })
    .filter((p): p is string => p !== null)
    .sort();
  if (parts.length === 0) return null;
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * Did the schema drift between two scans? True only when a prior fingerprint
 * existed and the new one differs — a first-ever fingerprint establishes the
 * baseline and is never itself drift. A null `next` (no columns reported this
 * scan) is treated as "no signal", not drift, so an older agent doesn't raise
 * a false alarm.
 */
export function hasSchemaDrifted(
  previousFingerprint: string | null | undefined,
  nextFingerprint: string | null | undefined,
): boolean {
  if (!previousFingerprint || !nextFingerprint) return false;
  return previousFingerprint !== nextFingerprint;
}
