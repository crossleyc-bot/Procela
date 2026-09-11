import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { analyzeLocalFile } from '../lib/local-file-connector';

describe('analyzeLocalFile', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'procela-lf-'));

  before(() => {
    fs.writeFileSync(path.join(tmpDir, 'simple.csv'), 'id,name,email\n1,Alice,a@x.com\n2,Bob,b@x.com\n');
    fs.writeFileSync(path.join(tmpDir, 'quoted.csv'), 'id,description\n1,"Hello, world"\n2,"He said ""hi"""\n');
    fs.writeFileSync(path.join(tmpDir, 'simple.tsv'), 'id\tname\n1\tAlice\n2\tBob\n');
    fs.writeFileSync(path.join(tmpDir, 'array.json'), JSON.stringify([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob', extra: 'field' },
    ]));
    fs.writeFileSync(path.join(tmpDir, 'wrapped.json'), JSON.stringify({
      data: [{ id: 1 }, { id: 2 }, { id: 3 }],
    }));
    fs.writeFileSync(path.join(tmpDir, 'lines.jsonl'), '{"id":1}\n{"id":2,"name":"x"}\n');
    fs.writeFileSync(path.join(tmpDir, 'nested.json'), JSON.stringify([
      { id: 1, address: { city: 'Norfolk', geo: { lat: 1 } }, tags: ['a'] },
      { id: 2, address: { city: 'Newport' } },
    ]));
    fs.writeFileSync(path.join(tmpDir, 'empty.csv'), '');
    fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{not json');
    fs.writeFileSync(path.join(tmpDir, 'nope.xml'), '<x/>');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a basic CSV', () => {
    const res = analyzeLocalFile(path.join(tmpDir, 'simple.csv'));
    assert.deepStrictEqual(res.columns, ['id', 'name', 'email']);
    assert.strictEqual(res.rowCount, 2);
  });

  it('handles quoted CSV fields with embedded commas and escaped quotes', () => {
    const res = analyzeLocalFile(path.join(tmpDir, 'quoted.csv'));
    assert.deepStrictEqual(res.columns, ['id', 'description']);
    assert.strictEqual(res.rowCount, 2);
  });

  it('parses TSV on .tsv extension', () => {
    const res = analyzeLocalFile(path.join(tmpDir, 'simple.tsv'));
    assert.deepStrictEqual(res.columns, ['id', 'name']);
    assert.strictEqual(res.rowCount, 2);
  });

  it('unions columns across JSON array objects', () => {
    const res = analyzeLocalFile(path.join(tmpDir, 'array.json'));
    assert.strictEqual(res.rowCount, 2);
    assert.deepStrictEqual(res.columns.sort(), ['extra', 'id', 'name']);
  });

  it('accepts JSON object with a "data" array', () => {
    const res = analyzeLocalFile(path.join(tmpDir, 'wrapped.json'));
    assert.strictEqual(res.rowCount, 3);
    assert.deepStrictEqual(res.columns, ['id']);
  });

  it('parses newline-delimited JSON', () => {
    const res = analyzeLocalFile(path.join(tmpDir, 'lines.jsonl'));
    assert.strictEqual(res.rowCount, 2);
    assert.deepStrictEqual(res.columns.sort(), ['id', 'name']);
  });

  it('flattens nested JSON objects into dotted-path columns (arrays stay a leaf)', () => {
    const res = analyzeLocalFile(path.join(tmpDir, 'nested.json'));
    assert.strictEqual(res.rowCount, 2);
    assert.deepStrictEqual(
      res.columns.sort(),
      ['address.city', 'address.geo.lat', 'id', 'tags'],
    );
  });

  it('throws on empty CSV', () => {
    assert.throws(() => analyzeLocalFile(path.join(tmpDir, 'empty.csv')), /empty/i);
  });

  it('throws on malformed JSON', () => {
    assert.throws(() => analyzeLocalFile(path.join(tmpDir, 'broken.json')), /Invalid JSON/i);
  });

  it('rejects unsupported extensions', () => {
    assert.throws(() => analyzeLocalFile(path.join(tmpDir, 'nope.xml')), /Unsupported file type/i);
  });
});
