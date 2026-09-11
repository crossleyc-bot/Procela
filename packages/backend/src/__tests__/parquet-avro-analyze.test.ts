// E1: Parquet + Avro schema discovery via the local-file connector. Fixtures
// are written with the same libraries the analyzer reads with, so the test is
// self-contained — no committed binaries, no cloud, no live account.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import avro from 'avsc';
import parquet from '@dsnp/parquetjs';

import { analyzeLocalFileAsync, analyzeLocalFile, isDqExecutableFile } from '../lib/local-file-connector';

let dir: string;
const p = (name: string) => path.join(dir, name);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'procela-pa-'));

  // Parquet with a flat column set + a nested struct + an optional column.
  const pschema = new parquet.ParquetSchema({
    id: { type: 'INT64' },
    name: { type: 'UTF8', optional: true },
    price: { type: 'DOUBLE' },
    addr: { fields: { city: { type: 'UTF8' }, zip: { type: 'INT64', optional: true } } },
  });
  const w = await parquet.ParquetWriter.openFile(pschema, p('data.parquet'));
  await w.appendRow({ id: 1n, name: 'a', price: 2.5, addr: { city: 'Norfolk', zip: 23500n } });
  await w.appendRow({ id: 2n, name: null, price: 3.0, addr: { city: 'Newport', zip: null } });
  await w.close();

  // Avro with a nested record, a nullable union, and an array (a leaf).
  const type = avro.Type.forSchema({
    type: 'record', name: 'R', fields: [
      { name: 'id', type: 'long' },
      { name: 'name', type: ['null', 'string'] },
      { name: 'addr', type: { type: 'record', name: 'Addr', fields: [{ name: 'city', type: 'string' }] } },
      { name: 'tags', type: { type: 'array', items: 'string' } },
    ],
  });
  const enc = avro.createFileEncoder(p('data.avro'), type);
  enc.write({ id: 1, name: 'a', addr: { city: 'Norfolk' }, tags: ['x'] });
  enc.write({ id: 2, name: null, addr: { city: 'Newport' }, tags: [] });
  await new Promise<void>((r) => enc.end(r));
});

after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('analyzeLocalFileAsync — Parquet', () => {
  it('reads leaf columns (structs as dotted paths) + the footer row count', async () => {
    const res = await analyzeLocalFileAsync(p('data.parquet'));
    assert.strictEqual(res.rowCount, 2);
    assert.deepStrictEqual(res.columns.sort(), ['addr.city', 'addr.zip', 'id', 'name', 'price']);
  });
});

describe('analyzeLocalFileAsync — Avro', () => {
  it('flattens nested records, unwraps a nullable union, counts records', async () => {
    const res = await analyzeLocalFileAsync(p('data.avro'));
    assert.strictEqual(res.rowCount, 2);
    // `name` is [null,string] → unwrapped to a leaf; `tags` (array) stays a leaf.
    assert.deepStrictEqual(res.columns.sort(), ['addr.city', 'id', 'name', 'tags']);
  });
});

describe('format gating', () => {
  it('the synchronous analyzer refuses Parquet/Avro and points to the async path', () => {
    assert.throws(() => analyzeLocalFile(p('data.parquet')), /asynchronous/i);
    assert.throws(() => analyzeLocalFile(p('data.avro')), /asynchronous/i);
  });

  it('isDqExecutableFile is true for text formats, false for Parquet/Avro', () => {
    assert.strictEqual(isDqExecutableFile('/x/a.csv'), true);
    assert.strictEqual(isDqExecutableFile('/x/a.jsonl'), true);
    assert.strictEqual(isDqExecutableFile('/x/a.parquet'), false);
    assert.strictEqual(isDqExecutableFile('/x/a.avro'), false);
  });

  it('async analyzer still handles the text formats (delegates to the sync parser)', async () => {
    fs.writeFileSync(p('t.csv'), 'a,b\n1,2\n3,4\n');
    const res = await analyzeLocalFileAsync(p('t.csv'));
    assert.deepStrictEqual(res.columns, ['a', 'b']);
    assert.strictEqual(res.rowCount, 2);
  });
});
