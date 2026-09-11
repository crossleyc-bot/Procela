// E3: Snowflake warehouse discovery. The pure pieces — the request mapping and
// the INFORMATION_SCHEMA SQL builders — test without snowflake-sdk or a live
// account; the driver (discoverSnowflakeSchema) is exercised only against a real
// Snowflake, and the row grouping it feeds is the shared groupAssets covered by
// db-introspect.test.ts.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { toSnowflakeRequest, type ConnectionProfileLike } from '../services/connector.service';
import {
  buildSnowflakeTableListSql,
  buildSnowflakeColumnListSql,
  buildSnowflakeRowCountSql,
} from '../lib/db-source/snowflake-introspect';
import { MAX_DISCOVERED_TABLES, MAX_DISCOVERED_COLUMNS } from '../lib/db-source/introspect';

const warehouse = (over: Partial<ConnectionProfileLike['config']>, creds?: ConnectionProfileLike['credentials']): ConnectionProfileLike => ({
  connectionType: 'DATA_WAREHOUSE',
  config: { warehouseType: 'SNOWFLAKE', ...over },
  credentials: creds,
});

describe('toSnowflakeRequest', () => {
  it('maps account / warehouse / database / schema + credentials', () => {
    const req = toSnowflakeRequest(warehouse(
      { account: 'org-acct', warehouse: 'COMPUTE_WH', database: 'ANALYTICS', schema: 'SALES' },
      { username: 'svc', password: 'pw' },
    ));
    assert.ok(req);
    assert.strictEqual(req!.account, 'org-acct');
    assert.strictEqual(req!.warehouse, 'COMPUTE_WH');
    assert.strictEqual(req!.database, 'ANALYTICS');
    assert.strictEqual(req!.schema, 'SALES');
    assert.strictEqual(req!.username, 'svc');
    assert.strictEqual(req!.password, 'pw');
  });

  it('returns null without account / database / username, and for other warehouses', () => {
    assert.strictEqual(toSnowflakeRequest(warehouse({ database: 'D' }, { username: 'u' })), null); // no account
    assert.strictEqual(toSnowflakeRequest(warehouse({ account: 'a' }, { username: 'u' })), null);   // no database
    assert.strictEqual(toSnowflakeRequest(warehouse({ account: 'a', database: 'D' })), null);       // no username
    assert.strictEqual(
      toSnowflakeRequest({ connectionType: 'DATA_WAREHOUSE', config: { warehouseType: 'BIGQUERY', account: 'a', database: 'D' }, credentials: { username: 'u' } }),
      null,
    );
  });
});

describe('Snowflake catalog SQL builders', () => {
  it('table + column lists read information_schema, are schema-parameterised, and bounded', () => {
    const t = buildSnowflakeTableListSql();
    assert.match(t, /information_schema\.tables/);
    assert.match(t, /table_schema = \?/);              // bound, never interpolated
    assert.match(t, /table_type IN \('BASE TABLE', 'VIEW'\)/);
    assert.match(t, new RegExp(`LIMIT ${MAX_DISCOVERED_TABLES}`));

    const c = buildSnowflakeColumnListSql();
    assert.match(c, /information_schema\.columns/);
    assert.match(c, /data_type/);
    assert.match(c, /table_schema = \?/);
    assert.match(c, new RegExp(`LIMIT ${MAX_DISCOVERED_COLUMNS}`));
  });

  it('row count reads the maintained information_schema.tables.row_count', () => {
    const r = buildSnowflakeRowCountSql();
    assert.match(r, /row_count/);
    assert.match(r, /information_schema\.tables/);
    assert.match(r, /table_type = 'BASE TABLE'/);
    assert.match(r, /table_schema = \?/);
  });
});
