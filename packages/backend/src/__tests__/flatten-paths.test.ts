// Pure tests for the semi-structured flattener (E4). Nested plain objects
// flatten into dotted paths; arrays, Dates, and BSON-style wrappers stay leaves.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { isPlainObject, leafPaths, resolveLeafPath, walkLeafPaths } from '../lib/flatten-paths';

const objectId = (hex: string) => ({ _bsontype: 'ObjectId', toHexString: () => hex });

describe('isPlainObject', () => {
  it('accepts plain and null-proto objects, rejects everything else', () => {
    assert.strictEqual(isPlainObject({}), true);
    assert.strictEqual(isPlainObject(Object.create(null)), true);
    assert.strictEqual(isPlainObject([]), false);
    assert.strictEqual(isPlainObject(null), false);
    assert.strictEqual(isPlainObject(new Date()), false);
    assert.strictEqual(isPlainObject(objectId('a')), false); // class-ish instance → leaf
    assert.strictEqual(isPlainObject('x'), false);
  });
});

describe('leafPaths', () => {
  it('flattens nested objects into dotted paths', () => {
    assert.deepStrictEqual(
      leafPaths({ id: 1, address: { city: 'Norfolk', geo: { lat: 1, lng: 2 } } }),
      ['id', 'address.city', 'address.geo.lat', 'address.geo.lng'],
    );
  });

  it('treats arrays and dates as single leaves, not descended', () => {
    assert.deepStrictEqual(
      leafPaths({ tags: ['a', 'b'], created: new Date(), owner: objectId('1') }),
      ['tags', 'created', 'owner'],
    );
  });

  it('keeps an empty object as a named leaf', () => {
    assert.deepStrictEqual(leafPaths({ id: 1, meta: {} }), ['id', 'meta']);
  });

  it('yields nothing for a root that is not a plain object', () => {
    assert.deepStrictEqual(leafPaths([1, 2, 3]), []);
    assert.deepStrictEqual(leafPaths('scalar'), []);
  });

  it('passes the leaf value to the visitor', () => {
    const seen: Record<string, unknown> = {};
    walkLeafPaths({ a: { b: 5 } }, (p, v) => { seen[p] = v; });
    assert.deepStrictEqual(seen, { 'a.b': 5 });
  });

  it('stops descending at the depth cap without throwing', () => {
    // Build a 30-deep chain; the cap is 12, so the path is bounded, not infinite.
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 30; i++) deep = { n: deep };
    const paths = leafPaths(deep);
    assert.strictEqual(paths.length, 1);
    assert.ok(paths[0].split('.').length <= 12, `path depth bounded: ${paths[0]}`);
  });
});

describe('resolveLeafPath', () => {
  const doc = { id: 1, address: { city: 'Norfolk' }, tags: ['x'] };
  it('resolves a dotted path through plain objects', () => {
    assert.strictEqual(resolveLeafPath(doc, 'address.city'), 'Norfolk');
  });
  it('resolves a plain top-level key unchanged', () => {
    assert.strictEqual(resolveLeafPath(doc, 'id'), 1);
  });
  it('returns undefined for a missing or non-object segment', () => {
    assert.strictEqual(resolveLeafPath(doc, 'address.zip'), undefined);
    assert.strictEqual(resolveLeafPath(doc, 'tags.0'), undefined); // won't index arrays
    assert.strictEqual(resolveLeafPath(doc, 'id.nope'), undefined);
  });
});
