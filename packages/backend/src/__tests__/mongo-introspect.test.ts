// Pure schema-inference tests for MongoDB discovery (E2). No live MongoDB and
// no `mongodb` driver import — inferMongoAssets / mongoFieldType are pure, so
// they exercise the union-of-keys + type-collapse logic on hand-built samples.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { inferMongoAssets, mongoFieldType, type MongoCollectionSample } from '../lib/db-source/mongo-introspect';

// A minimal ObjectId stand-in: the real driver tags wrapper types with
// `_bsontype`, which mongoFieldType duck-types without importing mongodb.
const objectId = (hex: string) => ({ _bsontype: 'ObjectId', toHexString: () => hex });

describe('mongoFieldType', () => {
  it('distinguishes integers from doubles', () => {
    assert.strictEqual(mongoFieldType(3), 'int');
    assert.strictEqual(mongoFieldType(3.5), 'double');
  });

  it('reports arrays, dates, objects and null distinctly', () => {
    assert.strictEqual(mongoFieldType([1, 2]), 'array');
    assert.strictEqual(mongoFieldType(new Date()), 'date');
    assert.strictEqual(mongoFieldType({ a: 1 }), 'object');
    assert.strictEqual(mongoFieldType(null), 'null');
    assert.strictEqual(mongoFieldType(undefined), 'null');
  });

  it('duck-types BSON wrappers by _bsontype', () => {
    assert.strictEqual(mongoFieldType(objectId('abc')), 'objectId');
    assert.strictEqual(mongoFieldType({ _bsontype: 'Decimal128' }), 'decimal');
    assert.strictEqual(mongoFieldType({ _bsontype: 'Long' }), 'long');
  });

  it('handles primitive string/bool', () => {
    assert.strictEqual(mongoFieldType('x'), 'string');
    assert.strictEqual(mongoFieldType(true), 'bool');
  });
});

describe('inferMongoAssets', () => {
  it('unions field names across sampled documents and sorts _id first', () => {
    const collections: MongoCollectionSample[] = [{
      name: 'customers',
      docs: [
        { _id: objectId('1'), name: 'Ann', tier: 'gold' },
        { _id: objectId('2'), name: 'Ben', region: 'east' }, // extra field, missing tier
      ],
      estimatedCount: 42,
    }];
    const [asset] = inferMongoAssets(collections);
    assert.strictEqual(asset.name, 'customers');
    assert.strictEqual(asset.type, 'TABLE');
    assert.strictEqual(asset.rowCount, 42);
    // _id first, then alphabetical union of every field seen in the sample.
    assert.deepStrictEqual(asset.columns, ['_id', 'name', 'region', 'tier']);
    assert.strictEqual(asset.columnTypes?._id, 'objectId');
    assert.strictEqual(asset.columnTypes?.name, 'string');
  });

  it('collapses a polymorphic field into a joined type descriptor', () => {
    const [asset] = inferMongoAssets([{
      name: 'events',
      docs: [{ value: 1 }, { value: 'n/a' }, { value: 2 }],
    }]);
    // Seen as both int and string across documents → sorted, joined.
    assert.strictEqual(asset.columnTypes?.value, 'int|string');
  });

  it('ignores null when a field also has a real type, keeps null when that is all', () => {
    const [asset] = inferMongoAssets([{
      name: 'mixed',
      docs: [{ a: null }, { a: 'x' }, { b: null }],
    }]);
    assert.strictEqual(asset.columnTypes?.a, 'string'); // null dropped, real type kept
    assert.strictEqual(asset.columnTypes?.b, 'null');   // only ever null → reported
  });

  it('maps a view kind to VIEW and leaves an empty sample with no fields', () => {
    const [asset] = inferMongoAssets([{ name: 'active_view', kind: 'view', docs: [] }]);
    assert.strictEqual(asset.type, 'VIEW');
    assert.deepStrictEqual(asset.columns, []);
  });

  it('treats a negative/absent estimatedCount as unknown (undefined)', () => {
    const [a1] = inferMongoAssets([{ name: 'c1', docs: [{ x: 1 }], estimatedCount: -1 }]);
    const [a2] = inferMongoAssets([{ name: 'c2', docs: [{ x: 1 }] }]);
    assert.strictEqual(a1.rowCount, undefined);
    assert.strictEqual(a2.rowCount, undefined);
  });
});
