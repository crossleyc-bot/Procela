// E3: BigQuery warehouse discovery. The pure pieces — request mapping, the
// per-dataset INFORMATION_SCHEMA SQL builders, and the identifier-injection
// guard — test without @google-cloud/bigquery or a live project.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { toBigQueryRequest, type ConnectionProfileLike } from '../services/connector.service';
import {
  buildBigQueryTableListSql,
  buildBigQueryColumnListSql,
  buildBigQueryRowCountSql,
  assertBqProject,
  assertBqDataset,
} from '../lib/db-source/bigquery-introspect';
import { MAX_DISCOVERED_TABLES, MAX_DISCOVERED_COLUMNS } from '../lib/db-source/introspect';

const bq = (over: Partial<ConnectionProfileLike['config']>, creds?: ConnectionProfileLike['credentials']): ConnectionProfileLike => ({
  connectionType: 'DATA_WAREHOUSE',
  config: { warehouseType: 'BIGQUERY', ...over },
  credentials: creds,
});

describe('toBigQueryRequest', () => {
  it('maps account→project, database→dataset, token→service-account JSON', () => {
    const req = toBigQueryRequest(bq({ account: 'my-proj', database: 'analytics' }, { token: '{"project_id":"my-proj"}' }));
    assert.ok(req);
    assert.strictEqual(req!.projectId, 'my-proj');
    assert.strictEqual(req!.dataset, 'analytics');
    assert.strictEqual(req!.serviceAccountJson, '{"project_id":"my-proj"}');
  });

  it('returns null without project/dataset, and for other warehouses', () => {
    assert.strictEqual(toBigQueryRequest(bq({ database: 'd' })), null);   // no project
    assert.strictEqual(toBigQueryRequest(bq({ account: 'p' })), null);    // no dataset
    assert.strictEqual(
      toBigQueryRequest({ connectionType: 'DATA_WAREHOUSE', config: { warehouseType: 'SNOWFLAKE', account: 'p', database: 'd' } }),
      null,
    );
  });
});

describe('BigQuery catalog SQL builders', () => {
  it('qualify INFORMATION_SCHEMA by back-ticked project.dataset and bound the scan', () => {
    const t = buildBigQueryTableListSql('my-proj', 'analytics');
    assert.match(t, /`my-proj`\.`analytics`\.INFORMATION_SCHEMA\.TABLES/);
    assert.match(t, new RegExp(`LIMIT ${MAX_DISCOVERED_TABLES}`));

    const c = buildBigQueryColumnListSql('my-proj', 'analytics');
    assert.match(c, /`my-proj`\.`analytics`\.INFORMATION_SCHEMA\.COLUMNS/);
    assert.match(c, /data_type/);
    assert.match(c, new RegExp(`LIMIT ${MAX_DISCOVERED_COLUMNS}`));

    const r = buildBigQueryRowCountSql('my-proj', 'analytics');
    assert.match(r, /INFORMATION_SCHEMA\.TABLE_STORAGE/);
    assert.match(r, /total_rows AS row_count/);
  });

  it('reject a hostile project / dataset identifier (injection boundary)', () => {
    assert.throws(() => assertBqProject('proj`.`x`.INFORMATION_SCHEMA.TABLES; --'), /Invalid BigQuery project/);
    assert.throws(() => assertBqDataset('ds`; DROP'), /Invalid BigQuery dataset/);
    assert.throws(() => buildBigQueryTableListSql('ok-proj', 'bad name'), /Invalid BigQuery dataset/);
    // A valid domain-scoped project + underscore dataset pass.
    assert.strictEqual(assertBqProject('example.com:my-proj'), 'example.com:my-proj');
    assert.strictEqual(assertBqDataset('my_dataset_2'), 'my_dataset_2');
  });
});
