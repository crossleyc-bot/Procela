// E1 cloud object-listing: the provider-agnostic discovery orchestrator, driven
// by a fake ObjectStore (no S3 SDK, no network). Proves the list → filter →
// download → infer → assemble pipeline, its bounds, and per-object error
// isolation. The S3 adapter itself is a thin SDK wrapper exercised only against
// a live bucket.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import parquet from '@dsnp/parquetjs';

import { discoverObjectStoreAssets } from '../lib/object-storage/discover';
import type { ObjectStore, ObjectRef } from '../lib/object-storage/types';

class FakeStore implements ObjectStore {
  constructor(private files: Record<string, Buffer>, private sizes: Record<string, number> = {}) {}
  async list(prefix: string, max: number): Promise<ObjectRef[]> {
    return Object.keys(this.files)
      .filter((k) => k.startsWith(prefix))
      .slice(0, max)
      .map((k) => ({ key: k, size: this.sizes[k] ?? this.files[k]?.length }));
  }
  async download(key: string): Promise<Buffer> {
    const b = this.files[key];
    if (!b) throw new Error(`missing ${key}`);
    return b;
  }
}

let parquetBuf: Buffer;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'procela-obj-test-'));
  const pqPath = path.join(dir, 'x.parquet');
  const w = await parquet.ParquetWriter.openFile(new parquet.ParquetSchema({ id: { type: 'INT64' }, city: { type: 'UTF8' } }), pqPath);
  await w.appendRow({ id: 1n, city: 'Norfolk' });
  await w.close();
  parquetBuf = fs.readFileSync(pqPath);
  fs.rmSync(dir, { recursive: true, force: true });
});
after(() => { /* nothing global to clean */ });

describe('discoverObjectStoreAssets', () => {
  it('infers one asset per parseable object; skips unsupported extensions', async () => {
    const store = new FakeStore({
      'data/people.csv': Buffer.from('name,email\nAnn,a@x\nBen,b@x\n'),
      'data/orders.json': Buffer.from('[{"orderId":1},{"orderId":2}]'),
      'data/readme.txt': Buffer.from('ignore me'),   // unsupported → skipped
      'data/logo.png': Buffer.from('\x89PNG binary'),  // unsupported → skipped
      'data/metrics.parquet': parquetBuf,
    });
    const assets = await discoverObjectStoreAssets(store, { prefix: 'data/' });
    const byName = Object.fromEntries(assets.map((a) => [a.name, a]));
    assert.deepStrictEqual(Object.keys(byName).sort(), ['data/metrics.parquet', 'data/orders.json', 'data/people.csv']);
    assert.deepStrictEqual(byName['data/people.csv'].columns, ['name', 'email']);
    assert.strictEqual(byName['data/people.csv'].rowCount, 2);
    assert.deepStrictEqual(byName['data/orders.json'].columns, ['orderId']);
    assert.deepStrictEqual(byName['data/metrics.parquet'].columns.sort(), ['city', 'id']);
    assert.strictEqual(byName['data/metrics.parquet'].type, 'FILE');
  });

  it('respects the maxObjects bound', async () => {
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < 10; i++) files[`f${i}.csv`] = Buffer.from('a\n1\n');
    const assets = await discoverObjectStoreAssets(new FakeStore(files), { maxObjects: 3 });
    assert.strictEqual(assets.length, 3);
  });

  it('skips an object whose listed size exceeds the byte cap (no download)', async () => {
    let downloaded = false;
    const store = new FakeStore({ 'big.csv': Buffer.from('a\n1\n') }, { 'big.csv': 999_999_999 });
    const wrapped: ObjectStore = { list: (p, m) => store.list(p, m), download: (k) => { downloaded = true; return store.download(k); } };
    const assets = await discoverObjectStoreAssets(wrapped, { maxBytes: 1_000 });
    assert.strictEqual(assets.length, 0);
    assert.strictEqual(downloaded, false, 'oversized object must not be downloaded');
  });

  it('isolates a per-object failure — one bad file does not fail the scan', async () => {
    const store = new FakeStore({
      'good.csv': Buffer.from('a,b\n1,2\n'),
      'bad.json': Buffer.from('{ not valid json'),  // parse throws → skipped
    });
    const assets = await discoverObjectStoreAssets(store);
    assert.deepStrictEqual(assets.map((a) => a.name), ['good.csv']);
  });
});
