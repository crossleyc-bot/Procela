// E3: Databricks (Unity Catalog) warehouse discovery. The pure pieces —
// request mapping, the per-catalog information_schema SQL builders, and the
// identifier-injection guard — test without @databricks/sql or a live
// workspace.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { toDatabricksRequest, type ConnectionProfileLike } from '../services/connector.service';
import {
  buildDatabricksTableListSql,
  buildDatabricksColumnListSql,
  assertDbxCatalog,
  assertDbxSchema,
} from '../lib/db-source/databricks-introspect';
import { MAX_DISCOVERED_TABLES, MAX_DISCOVERED_COLUMNS } from '../lib/db-source/introspect';

const dbx = (over: Partial<ConnectionProfileLike['config']>, creds?: ConnectionProfileLike['credentials']): ConnectionProfileLike => ({
  connectionType: 'DATA_WAREHOUSE',
  config: { warehouseType: 'DATABRICKS', ...over },
  credentials: creds,
});

describe('toDatabricksRequest', () => {
  it('maps account→host, warehouse→httpPath, database→catalog, token→token', () => {
    const req = toDatabricksRequest(dbx(
      { account: 'dbc-abc.cloud.databricks.com', warehouse: '/sql/1.0/warehouses/xyz', database: 'main', schema: 'sales' },
      { token: 'dapi-secret' },
    ));
    assert.ok(req);
    assert.strictEqual(req!.host, 'dbc-abc.cloud.databricks.com');
    assert.strictEqual(req!.httpPath, '/sql/1.0/warehouses/xyz');
    assert.strictEqual(req!.catalog, 'main');
    assert.strictEqual(req!.schema, 'sales');
    assert.strictEqual(req!.token, 'dapi-secret');
  });

  it('returns null without host/httpPath/catalog, and for other warehouses', () => {
    assert.strictEqual(toDatabricksRequest(dbx({ warehouse: '/p', database: 'c' })), null); // no host
    assert.strictEqual(toDatabricksRequest(dbx({ account: 'h', database: 'c' })), null);     // no httpPath
    assert.strictEqual(toDatabricksRequest(dbx({ account: 'h', warehouse: '/p' })), null);   // no catalog
    assert.strictEqual(
      toDatabricksRequest({ connectionType: 'DATA_WAREHOUSE', config: { warehouseType: 'SNOWFLAKE', account: 'h', warehouse: '/p', database: 'c' } }),
      null,
    );
  });
});

describe('Databricks catalog SQL builders', () => {
  it('qualify information_schema by back-ticked catalog, filter the schema, bound the scan', () => {
    const t = buildDatabricksTableListSql('main', 'default');
    assert.match(t, /`main`\.information_schema\.tables/);
    assert.match(t, /table_schema = 'default'/);
    assert.match(t, new RegExp(`LIMIT ${MAX_DISCOVERED_TABLES}`));

    const c = buildDatabricksColumnListSql('main', 'sales');
    assert.match(c, /`main`\.information_schema\.columns/);
    assert.match(c, /data_type/);
    assert.match(c, /table_schema = 'sales'/);
    assert.match(c, new RegExp(`LIMIT ${MAX_DISCOVERED_COLUMNS}`));
  });

  it('reject a hostile catalog / schema identifier (injection boundary)', () => {
    assert.throws(() => assertDbxCatalog('main`.information_schema.tables; --'), /Invalid Databricks catalog/);
    assert.throws(() => assertDbxSchema("sales'; DROP"), /Invalid Databricks schema/);
    assert.throws(() => buildDatabricksTableListSql('ok_catalog', 'bad name'), /Invalid Databricks schema/);
    assert.throws(() => buildDatabricksColumnListSql('bad-catalog', 'sales'), /Invalid Databricks catalog/);
    // Valid underscore identifiers pass through unchanged.
    assert.strictEqual(assertDbxCatalog('my_catalog_2'), 'my_catalog_2');
    assert.strictEqual(assertDbxSchema('default'), 'default');
  });
});
