// computeDiscoveredAssetHealth — the graded freshness/liveness heuristic
// that replaces the old binary 90/60 connector health signal.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  computeDiscoveredAssetHealth,
  countMeasuredRulesByAsset,
  effectiveHealthScore,
} from '../lib/asset-health';

const NOW = Date.UTC(2026, 7, 25, 12, 0, 0); // fixed clock
const agoDays = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

describe('computeDiscoveredAssetHealth', () => {
  it('grades freshness by age since last write', () => {
    assert.strictEqual(computeDiscoveredAssetHealth({ lastWriteAt: agoDays(0.5), nowMs: NOW }), 95);
    assert.strictEqual(computeDiscoveredAssetHealth({ lastWriteAt: agoDays(3), nowMs: NOW }), 85);
    assert.strictEqual(computeDiscoveredAssetHealth({ lastWriteAt: agoDays(14), nowMs: NOW }), 70);
    assert.strictEqual(computeDiscoveredAssetHealth({ lastWriteAt: agoDays(45), nowMs: NOW }), 55);
    assert.strictEqual(computeDiscoveredAssetHealth({ lastWriteAt: agoDays(200), nowMs: NOW }), 40);
  });

  it('is monotonic — staler never scores higher than fresher', () => {
    const ages = [0, 2, 14, 45, 200];
    const scores = ages.map((d) => computeDiscoveredAssetHealth({ lastWriteAt: agoDays(d), nowMs: NOW }));
    for (let i = 1; i < scores.length; i++) assert.ok(scores[i] <= scores[i - 1]);
  });

  it('returns a neutral 50 when no write time is reported', () => {
    assert.strictEqual(computeDiscoveredAssetHealth({ nowMs: NOW }), 50);
    assert.strictEqual(computeDiscoveredAssetHealth({ lastWriteAt: null, nowMs: NOW }), 50);
    assert.strictEqual(computeDiscoveredAssetHealth({ lastWriteAt: 'not-a-date', nowMs: NOW }), 50);
  });

  it('caps an empty table low regardless of freshness', () => {
    // Written seconds ago but zero rows — still a liveness concern.
    assert.strictEqual(computeDiscoveredAssetHealth({ lastWriteAt: agoDays(0), rowCount: 0, nowMs: NOW }), 35);
  });

  it('bumps a table whose row count changed since the last scan', () => {
    const stable = computeDiscoveredAssetHealth({ lastWriteAt: agoDays(3), rowCount: 100, previousRowCount: 100, nowMs: NOW });
    const active = computeDiscoveredAssetHealth({ lastWriteAt: agoDays(3), rowCount: 120, previousRowCount: 100, nowMs: NOW });
    assert.strictEqual(stable, 85);
    assert.strictEqual(active, 90);
  });

  it('never exceeds 100 or drops below 0', () => {
    const hi = computeDiscoveredAssetHealth({ lastWriteAt: agoDays(0), rowCount: 5, previousRowCount: 1, nowMs: NOW });
    assert.ok(hi <= 100);
    const lo = computeDiscoveredAssetHealth({ lastWriteAt: agoDays(9999), rowCount: 0, nowMs: NOW });
    assert.ok(lo >= 0);
  });

  it('grades a row-count shrink by magnitude', () => {
    // Fresh write (95) so the row-count band is what moves the number.
    const severe = computeDiscoveredAssetHealth({ lastWriteAt: agoDays(0.5), rowCount: 40, previousRowCount: 100, nowMs: NOW });
    const notable = computeDiscoveredAssetHealth({ lastWriteAt: agoDays(0.5), rowCount: 75, previousRowCount: 100, nowMs: NOW });
    const minor = computeDiscoveredAssetHealth({ lastWriteAt: agoDays(3), rowCount: 98, previousRowCount: 100, nowMs: NOW });
    assert.strictEqual(severe, 40);   // lost ≥50% — capped low
    assert.strictEqual(notable, 65);  // lost ≥20% — notable shrink
    assert.strictEqual(minor, 90);    // <20% churn keeps the actively-maintained bump
  });

  it('growth still earns the actively-maintained bump, not a shrink penalty', () => {
    const grew = computeDiscoveredAssetHealth({ lastWriteAt: agoDays(3), rowCount: 500, previousRowCount: 100, nowMs: NOW });
    assert.strictEqual(grew, 90); // 85 + 5
  });

  it('penalizes schema drift', () => {
    const stable = computeDiscoveredAssetHealth({ lastWriteAt: agoDays(0.5), rowCount: 100, previousRowCount: 100, nowMs: NOW });
    const drifted = computeDiscoveredAssetHealth({ lastWriteAt: agoDays(0.5), rowCount: 100, previousRowCount: 100, schemaDrift: true, nowMs: NOW });
    assert.strictEqual(stable, 95);
    assert.strictEqual(drifted, 80); // 95 − 15
  });

  it('combines a shrink penalty with a drift penalty, clamped at 0', () => {
    const both = computeDiscoveredAssetHealth({ lastWriteAt: agoDays(0.5), rowCount: 40, previousRowCount: 100, schemaDrift: true, nowMs: NOW });
    assert.strictEqual(both, 25); // 40 (severe shrink) − 15 (drift)
    const floor = computeDiscoveredAssetHealth({ lastWriteAt: agoDays(9999), rowCount: 0, schemaDrift: true, nowMs: NOW });
    assert.strictEqual(floor, 20); // 35 (empty cap) − 15, still ≥ 0
  });
});

describe('countMeasuredRulesByAsset', () => {
  it('counts only rules whose last run actually measured data', () => {
    const counts = countMeasuredRulesByAsset([
      { dataAssetId: 'a', lastRun: { simulated: false } }, // measured
      { dataAssetId: 'a', lastRun: { simulated: false } }, // measured
      { dataAssetId: 'a', lastRun: { simulated: true } },  // simulated — excluded
      { dataAssetId: 'a' },                                 // never run — excluded
      { dataAssetId: 'b', lastRun: { simulated: false } }, // measured
      { dataAssetId: null, lastRun: { simulated: false } },// no asset — skipped
    ]);
    assert.strictEqual(counts.get('a'), 2);
    assert.strictEqual(counts.get('b'), 1);
    assert.strictEqual(counts.has('c'), false);
  });

  it('is empty for an empty rule list', () => {
    assert.strictEqual(countMeasuredRulesByAsset([]).size, 0);
  });
});

describe('effectiveHealthScore', () => {
  it('is 0 when no measured rule backs the asset — no rules, or unmeasured only', () => {
    assert.strictEqual(effectiveHealthScore(95, 0), 0);
    assert.strictEqual(effectiveHealthScore(95, undefined as unknown as number), 0);
    // A high stored (connector-freshness / manual) score is never surfaced
    // as health without a measured rule behind it.
    assert.strictEqual(effectiveHealthScore(100, 0), 0);
  });

  it('returns the stored (measured) score when ≥1 measured rule backs it', () => {
    assert.strictEqual(effectiveHealthScore(88, 1), 88);
    assert.strictEqual(effectiveHealthScore(0, 3), 0); // measured but all-failing
    assert.strictEqual(effectiveHealthScore(73.6, 2), 74); // rounded
  });

  it('clamps to 0..100 and tolerates a missing stored score', () => {
    assert.strictEqual(effectiveHealthScore(140, 1), 100);
    assert.strictEqual(effectiveHealthScore(-20, 1), 0);
    assert.strictEqual(effectiveHealthScore(null, 1), 0);
    assert.strictEqual(effectiveHealthScore(undefined, 1), 0);
  });
});
