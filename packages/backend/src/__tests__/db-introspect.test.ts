// Unit tests for the driver-free introspection SQL builders + grouping. No
// live database — the same pure/adapter split as db-source-sql.test.ts. The
// real fetch (discoverDbSchema) is exercised against live Postgres in
// live-db.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTableListSql,
  buildColumnListSql,
  buildRowCountSql,
  applyRowCounts,
  groupAssets,
  pickField,
  escapeLiteral,
  defaultSchema,
  MAX_DISCOVERED_TABLES,
  MAX_DISCOVERED_COLUMNS,
  type DiscoveredAsset,
} from '../lib/db-source/introspect';

test('defaultSchema: per-engine catalog scope', () => {
  assert.equal(defaultSchema('POSTGRESQL', 'app'), 'public');
  assert.equal(defaultSchema('SQLSERVER', 'app'), 'dbo');
  assert.equal(defaultSchema('MYSQL', 'app'), 'app'); // schema == database
  assert.equal(defaultSchema('ORACLE', 'app'), '');   // resolved to USER
});

test('escapeLiteral: doubles embedded single quotes (injection boundary)', () => {
  assert.equal(escapeLiteral("public"), 'public');
  assert.equal(escapeLiteral("o'brien"), "o''brien");
  assert.equal(escapeLiteral("'; DROP TABLE x; --"), "''; DROP TABLE x; --");
});

test('buildTableListSql: Postgres filters schema + caps rows', () => {
  const sql = buildTableListSql('POSTGRESQL', 'public');
  assert.match(sql, /information_schema\.tables/);
  assert.match(sql, /table_schema = 'public'/);
  assert.match(sql, /table_type IN \('BASE TABLE', 'VIEW'\)/);
  assert.match(sql, new RegExp(`LIMIT ${MAX_DISCOVERED_TABLES}`));
});

test('buildTableListSql: SQL Server uses TOP (no LIMIT)', () => {
  const sql = buildTableListSql('SQLSERVER', 'dbo');
  assert.match(sql, new RegExp(`TOP \\(${MAX_DISCOVERED_TABLES}\\)`));
  assert.doesNotMatch(sql, /LIMIT/);
  assert.match(sql, /table_schema = 'dbo'/);
});

test('buildTableListSql: Oracle unions tables + views by owner', () => {
  const sql = buildTableListSql('ORACLE', 'HR');
  assert.match(sql, /all_tables/);
  assert.match(sql, /all_views/);
  assert.match(sql, /owner = UPPER\('HR'\)/);
  assert.match(sql, new RegExp(`FETCH FIRST ${MAX_DISCOVERED_TABLES} ROWS ONLY`));
});

test('buildTableListSql: Oracle with no schema falls back to USER', () => {
  const sql = buildTableListSql('ORACLE', '');
  assert.match(sql, /owner = USER/);
  assert.doesNotMatch(sql, /UPPER\(''\)/);
});

test('buildColumnListSql: Postgres orders by ordinal + caps', () => {
  const sql = buildColumnListSql('POSTGRESQL', 'public');
  assert.match(sql, /information_schema\.columns/);
  assert.match(sql, /ORDER BY table_name, ordinal_position/);
  assert.match(sql, new RegExp(`LIMIT ${MAX_DISCOVERED_COLUMNS}`));
});

test('buildColumnListSql: a hostile schema name is quote-escaped, not injected', () => {
  const sql = buildTableListSql('POSTGRESQL', "x'; DROP TABLE users; --");
  assert.match(sql, /table_schema = 'x''; DROP TABLE users; --'/);
});

test('pickField: reads case-insensitively (PG lower, Oracle upper)', () => {
  assert.equal(pickField({ table_name: 'orders' }, 'table_name'), 'orders');
  assert.equal(pickField({ TABLE_NAME: 'ORDERS' }, 'table_name'), 'ORDERS');
  assert.equal(pickField({}, 'table_name'), '');
});

test('groupAssets: groups columns under their table, tags view vs table', () => {
  const tableRows = [
    { table_name: 'customers', table_type: 'BASE TABLE' },
    { table_name: 'customer_v', table_type: 'VIEW' },
  ];
  const columnRows = [
    { table_name: 'customers', column_name: 'id', ordinal_position: '1' },
    { table_name: 'customers', column_name: 'email', ordinal_position: '2' },
    { table_name: 'customer_v', column_name: 'full_name', ordinal_position: '1' },
    { table_name: 'orphan', column_name: 'ignored', ordinal_position: '1' }, // no table → dropped
  ];
  const assets = groupAssets(tableRows, columnRows);
  assert.equal(assets.length, 2);
  const customers = assets.find((a) => a.name === 'customers')!;
  assert.equal(customers.type, 'TABLE');
  assert.deepEqual(customers.columns, ['id', 'email']);
  const view = assets.find((a) => a.name === 'customer_v')!;
  assert.equal(view.type, 'VIEW');
  assert.deepEqual(view.columns, ['full_name']);
});

test('groupAssets: handles Oracle upper-cased keys', () => {
  const assets = groupAssets(
    [{ TABLE_NAME: 'EMPLOYEES', TABLE_TYPE: 'BASE TABLE' }],
    [{ TABLE_NAME: 'EMPLOYEES', COLUMN_NAME: 'EMP_ID', ORDINAL_POSITION: '1' }],
  );
  assert.equal(assets.length, 1);
  assert.equal(assets[0].name, 'EMPLOYEES');
  assert.deepEqual(assets[0].columns, ['EMP_ID']);
});

test('buildRowCountSql: per-engine catalog-stats sources, schema-scoped', () => {
  const pg = buildRowCountSql('POSTGRESQL', 'public');
  assert.match(pg, /pg_class/); assert.match(pg, /reltuples/); assert.match(pg, /nspname = 'public'/);
  const my = buildRowCountSql('MYSQL', 'app');
  assert.match(my, /information_schema\.tables/); assert.match(my, /table_rows/); assert.match(my, /table_schema = 'app'/);
  const ss = buildRowCountSql('SQLSERVER', 'dbo');
  assert.match(ss, /sys\.partitions/); assert.match(ss, /SUM\(p\.rows\)/); assert.match(ss, /SCHEMA_NAME\(t\.schema_id\) = 'dbo'/);
  const or = buildRowCountSql('ORACLE', 'HR');
  assert.match(or, /all_tables/); assert.match(or, /num_rows/); assert.match(or, /owner = UPPER\('HR'\)/);
  // No schema → Oracle scopes to the connecting user.
  assert.match(buildRowCountSql('ORACLE', ''), /owner = USER/);
});

test('buildRowCountSql: a hostile schema name is quote-escaped, not injected', () => {
  const sql = buildRowCountSql('POSTGRESQL', "x'; DROP TABLE users; --");
  assert.ok(sql.includes("'x''; DROP TABLE users; --'"));
});

test('applyRowCounts: merges by table name; unknown/negative/missing → undefined', () => {
  const assets: DiscoveredAsset[] = [
    { name: 'customers', type: 'TABLE', columns: ['id'] },
    { name: 'orders', type: 'TABLE', columns: ['id'] },
    { name: 'empty_t', type: 'TABLE', columns: ['id'] },
    { name: 'never_analyzed', type: 'TABLE', columns: ['id'] },
    { name: 'a_view', type: 'VIEW', columns: ['id'] },
  ];
  applyRowCounts(assets, ([
    { table_name: 'customers', row_count: 1200 },
    { table_name: 'orders', row_count: '42' },      // string from the driver
    { table_name: 'empty_t', row_count: 0 },        // a real zero survives
    { table_name: 'never_analyzed', row_count: -1 },// PG reltuples "unknown"
    // a_view: no row — stays undefined
    { table_name: 'ghost', row_count: 99 },         // no matching asset — ignored
  ] as any));
  const by = (n: string) => assets.find((a) => a.name === n)!;
  assert.equal(by('customers').rowCount, 1200);
  assert.equal(by('orders').rowCount, 42);
  assert.equal(by('empty_t').rowCount, 0);
  assert.equal(by('never_analyzed').rowCount, undefined);
  assert.equal(by('a_view').rowCount, undefined);
});

test('applyRowCounts: Oracle upper-cased keys', () => {
  const assets: DiscoveredAsset[] = [{ name: 'EMPLOYEES', type: 'TABLE', columns: ['ID'] }];
  applyRowCounts(assets, [{ TABLE_NAME: 'EMPLOYEES', ROW_COUNT: 500 }] as any);
  assert.equal(assets[0].rowCount, 500);
});
