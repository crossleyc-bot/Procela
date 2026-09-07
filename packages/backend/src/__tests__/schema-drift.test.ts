// computeSchemaFingerprint / hasSchemaDrifted — the schema-drift baseline.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { computeSchemaFingerprint, hasSchemaDrifted } from '../lib/schema-drift';

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
