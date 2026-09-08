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
import { computeDiscoveredAssetHealth } from './asset-health';

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

export interface RescanHealthInput {
  /** Fingerprint stored on the asset from the previous scan, if any. */
  previousFingerprint?: string | null;
  /** Row count recorded on the asset from the previous scan, if any. */
  previousRowCount?: number | null;
  /** Column set reported by this scan (names, optionally with dataType). */
  columns: FingerprintColumn[] | null | undefined;
  /** Row count reported by this scan, if the source provided one. */
  rowCount?: number | null;
}

export interface RescanHealthResult {
  /** Fingerprint of this scan's column set — persist as the new baseline. */
  schemaFingerprint: string | null;
  /** True when the column set drifted from the stored baseline. */
  drifted: boolean;
  /** The freshness/liveness health score after the drift + row-count signals. */
  healthScore: number;
}

/**
 * Compose the drift verdict, the new fingerprint baseline, and the health
 * score for a discovered asset that was (re-)scanned. This is the shared
 * kernel behind both scan paths' "recompute health from this scan" step: the
 * connector report ingest does it inline; the direct-connect discover/reconcile
 * flow calls this. Freshness is left neutral here — direct-connect introspection
 * has no per-table write time — so the score is driven by the row-count delta
 * and the schema-drift penalty.
 */
export function computeRescanHealth(input: RescanHealthInput): RescanHealthResult {
  const schemaFingerprint = computeSchemaFingerprint(input.columns);
  const drifted = hasSchemaDrifted(input.previousFingerprint, schemaFingerprint);
  const prevRow = typeof input.previousRowCount === 'number' ? input.previousRowCount : null;
  const rowCount = typeof input.rowCount === 'number' ? input.rowCount : prevRow;
  const healthScore = computeDiscoveredAssetHealth({
    rowCount,
    previousRowCount: prevRow,
    schemaDrift: drifted,
  });
  return { schemaFingerprint, drifted, healthScore };
}
