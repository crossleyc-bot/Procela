// Health/liveness heuristic for connector-discovered data assets.
//
// A scan reports two signals per table: how recently it was written
// (`lastWriteAt`) and its row count. This turns those into a coarse 0–100
// health score. It is a Bronze, audit-only stand-in — a real health/DQ
// score comes from source-system metrics later — but it grades freshness
// instead of the old binary "90 if written in the last day, else 60", and
// it treats an empty table as a genuine liveness concern.
//
// Pure and deterministic (time is injected) so it is unit-testable.

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DiscoveredAssetHealthInput {
  /** ISO timestamp of the table's most recent write, if the scan reported one. */
  lastWriteAt?: string | null;
  /** Row count from this scan, if reported. */
  rowCount?: number | null;
  /** Row count recorded by the previous scan, if any (activity signal). */
  previousRowCount?: number | null;
  /** True when this scan's schema (column set) drifted from the previously
   *  fingerprinted one — a column added, removed, or retyped. An unexpected
   *  schema change is a real risk to downstream consumers, so it lowers the
   *  score. Undefined/false when there is no drift or no schema signal. */
  schemaDrift?: boolean;
  /** Injected clock for testability; defaults to now. */
  nowMs?: number;
}

/**
 * Grade a discovered asset's freshness / liveness into a 0–100 health score.
 *
 * Signals, in order:
 *   - Freshness decays by age since the last write.
 *   - An empty table is capped low regardless of write time.
 *   - A row count that *shrank* since the last scan is graded by magnitude
 *     (a table that lost half its rows is a stronger concern than one that
 *     lost a few); growth earns a small "actively maintained" bump.
 *   - Schema drift (a changed column set) applies a fixed penalty.
 */
export function computeDiscoveredAssetHealth(input: DiscoveredAssetHealthInput): number {
  const now = input.nowMs ?? Date.now();

  // ── Freshness: graded decay by age since the last write ──
  let score: number;
  const writeMs = input.lastWriteAt ? new Date(input.lastWriteAt).getTime() : NaN;
  if (!Number.isFinite(writeMs)) {
    // No freshness signal reported (older agent, or a source without a
    // write-time column) — stay neutral rather than punishing or rewarding.
    score = 50;
  } else {
    const ageDays = Math.max(0, (now - writeMs) / DAY_MS);
    if (ageDays < 1) score = 95;
    else if (ageDays < 7) score = 85;
    else if (ageDays < 30) score = 70;
    else if (ageDays < 90) score = 55;
    else score = 40;
  }

  // ── Row-count signals ──
  const rowCount = typeof input.rowCount === 'number' ? input.rowCount : null;
  if (rowCount === 0) {
    // An empty table is a liveness concern no matter how recently it was
    // touched — cap the score low.
    score = Math.min(score, 35);
  } else if (rowCount !== null && typeof input.previousRowCount === 'number') {
    const prev = input.previousRowCount;
    if (prev > 0 && rowCount < prev) {
      // The table shrank since the last scan. A large drop often signals a
      // broken load (a truncated / half-loaded table), so grade by magnitude.
      const dropRatio = (prev - rowCount) / prev;
      if (dropRatio >= 0.5) score = Math.min(score, 40);        // lost half or more
      else if (dropRatio >= 0.2) score = Math.min(score, 65);   // notable shrink
      else score = Math.min(100, score + 5);                    // minor churn — still active
    } else if (rowCount !== prev) {
      // Grew (or recovered from empty) → the table is actively maintained.
      score = Math.min(100, score + 5);
    }
  }

  // ── Schema drift ──
  // A changed column set since the last fingerprinted scan is an early
  // warning: silent schema changes are a classic cause of broken downstream
  // reports. Apply a fixed penalty after the row-count signals.
  if (input.schemaDrift) {
    score = score - 15;
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}

// ── Effective (display-facing) asset health ────────────────────────────────
//
// Health is earned from measured data quality, not asserted. The number an
// asset SHOWS across the app (list, 360, dashboard, gaps, AI context) is its
// rolled-up DQ score only when at least one measured (non-simulated) rule
// backs it; otherwise it is 0 — an asset with no measured quality has no
// established health, so a connector-freshness or manual stand-in is never
// surfaced as "health". The stored `healthScore` field is left untouched;
// this derivation happens at read time.

/** Minimal shape a DQ rule contributes to the measured-health test. */
export interface MeasuredRuleInput {
  dataAssetId?: string | null;
  lastRun?: { simulated?: boolean } | null;
}

/**
 * Count the MEASURED (real, non-simulated) DQ rules backing each asset id.
 * A rule counts only when its last run actually measured data — a simulated
 * run carries a fabricated pass rate and must not establish health. Mirrors
 * the measured test in `rollupAssetHealth` (dq-engine).
 */
export function countMeasuredRulesByAsset(rules: MeasuredRuleInput[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rules) {
    if (!r.dataAssetId) continue;
    if (r.lastRun && r.lastRun.simulated === false) {
      counts.set(r.dataAssetId, (counts.get(r.dataAssetId) || 0) + 1);
    }
  }
  return counts;
}

/**
 * The health to SHOW for a data asset: its stored (rolled-up) score when at
 * least one measured DQ rule backs it, otherwise 0.
 */
export function effectiveHealthScore(
  storedScore: number | null | undefined,
  measuredRuleCount: number,
): number {
  if (!measuredRuleCount || measuredRuleCount <= 0) return 0;
  const s = typeof storedScore === 'number' ? storedScore : 0;
  return Math.max(0, Math.min(100, Math.round(s)));
}
