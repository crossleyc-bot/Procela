// computeSchemaFingerprint / hasSchemaDrifted — the schema-drift baseline.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { computeSchemaFingerprint, hasSchemaDrifted, computeRescanHealth } from '../lib/schema-drift';

describe('computeSchemaFingerprint', () => {
  it('is order-independent and case/whitespace-insensitive', () => {
    const a = computeSchemaFingerprint([
      { name: 'id', dataType: 'integer' },
      { name: 'email', dataType: 'text' },
    ]);
    const b = computeSchemaFingerprint([
      { name: ' Email ', dataType: 'TEXT' },
      { name: 'ID', dataType: 'Integer' },
    ]);
    assert.strictEqual(a, b);
  });

  it('changes when a column is added, removed, or retyped', () => {
    const base = computeSchemaFingerprint([{ name: 'id', dataType: 'int' }, { name: 'name', dataType: 'text' }]);
    const added = computeSchemaFingerprint([{ name: 'id', dataType: 'int' }, { name: 'name', dataType: 'text' }, { name: 'age', dataType: 'int' }]);
    const removed = computeSchemaFingerprint([{ name: 'id', dataType: 'int' }]);
    const retyped = computeSchemaFingerprint([{ name: 'id', dataType: 'bigint' }, { name: 'name', dataType: 'text' }]);
    assert.notStrictEqual(base, added);
    assert.notStrictEqual(base, removed);
    assert.notStrictEqual(base, retyped);
  });

  it('ignores a missing data type consistently', () => {
    const a = computeSchemaFingerprint([{ name: 'id' }]);
    const b = computeSchemaFingerprint([{ name: 'id', dataType: null }]);
    const c = computeSchemaFingerprint([{ name: 'id', dataType: '' }]);
    assert.strictEqual(a, b);
    assert.strictEqual(a, c);
  });

  it('returns null when there is no usable column signal', () => {
    assert.strictEqual(computeSchemaFingerprint(null), null);
    assert.strictEqual(computeSchemaFingerprint(undefined), null);
    assert.strictEqual(computeSchemaFingerprint([]), null);
    assert.strictEqual(computeSchemaFingerprint([{ name: '' }, { name: '   ' }]), null);
  });
});

describe('hasSchemaDrifted', () => {
  it('is true only when a prior fingerprint existed and differs', () => {
    assert.strictEqual(hasSchemaDrifted('aaa', 'bbb'), true);
    assert.strictEqual(hasSchemaDrifted('aaa', 'aaa'), false);
  });

  it('treats a missing prior or current fingerprint as no signal, not drift', () => {
    assert.strictEqual(hasSchemaDrifted(null, 'bbb'), false);     // first fingerprint — establishes baseline
    assert.strictEqual(hasSchemaDrifted('aaa', null), false);     // column-less scan — no signal
    assert.strictEqual(hasSchemaDrifted(undefined, undefined), false);
  });
});

describe('computeRescanHealth (direct-connect discover/reconcile)', () => {
  const cols = (names: string[]) => names.map((name) => ({ name }));

  it('first sighting establishes a fingerprint and never reports drift', () => {
    const r = computeRescanHealth({ columns: cols(['id', 'email']), rowCount: 100 });
    assert.ok(r.schemaFingerprint);
    assert.strictEqual(r.drifted, false);
    // No freshness signal + a stable/first row count → neutral-ish base, no penalty.
    assert.ok(r.healthScore > 0 && r.healthScore <= 100);
  });

  it('an unchanged column set on a re-scan does not drift', () => {
    const base = computeSchemaFingerprint(cols(['id', 'email']));
    const r = computeRescanHealth({ previousFingerprint: base, previousRowCount: 100, columns: cols(['id', 'email']), rowCount: 100 });
    assert.strictEqual(r.drifted, false);
  });

  it('a changed column set drifts and lowers the score vs the stable case', () => {
    const base = computeSchemaFingerprint(cols(['id', 'email']));
    const stable = computeRescanHealth({ previousFingerprint: base, previousRowCount: 100, columns: cols(['id', 'email']), rowCount: 100 });
    const drifted = computeRescanHealth({ previousFingerprint: base, previousRowCount: 100, columns: cols(['id', 'email', 'created_at']), rowCount: 100 });
    assert.strictEqual(drifted.drifted, true);
    assert.ok(drifted.healthScore < stable.healthScore);
  });

  it('a large row-count drop lowers the score even without drift', () => {
    const base = computeSchemaFingerprint(cols(['id']));
    const stable = computeRescanHealth({ previousFingerprint: base, previousRowCount: 1000, columns: cols(['id']), rowCount: 1000 });
    const shrunk = computeRescanHealth({ previousFingerprint: base, previousRowCount: 1000, columns: cols(['id']), rowCount: 200 });
    assert.strictEqual(shrunk.drifted, false);
    assert.ok(shrunk.healthScore < stable.healthScore);
  });

  it('carries the previous row count forward when this scan omits one', () => {
    const base = computeSchemaFingerprint(cols(['id']));
    // rowCount null but previousRowCount 0 → empty-table cap still applies.
    const r = computeRescanHealth({ previousFingerprint: base, previousRowCount: 0, columns: cols(['id']), rowCount: null });
    assert.ok(r.healthScore <= 35);
  });
});
