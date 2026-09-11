// E3: a DATA_WAREHOUSE connection whose warehouseType is REDSHIFT resolves to a
// real Postgres-protocol driver request (Redshift speaks the pg wire protocol),
// so discovery runs for real instead of returning simulated sample assets. The
// SDK-only warehouses (Snowflake / BigQuery / Databricks) still resolve to null
// and fall back to samples.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { toDbSourceRequest, type ConnectionProfileLike } from '../services/connector.service';

const warehouse = (over: Partial<ConnectionProfileLike['config']>, creds?: ConnectionProfileLike['credentials']): ConnectionProfileLike => ({
  connectionType: 'DATA_WAREHOUSE',
  config: { warehouseType: 'REDSHIFT', ...over },
  credentials: creds,
});

describe('toDbSourceRequest — Redshift warehouse', () => {
  it('maps account→host, warehouse→database, defaults the 5439 port', () => {
    const req = toDbSourceRequest(warehouse(
      { account: 'my-cluster.abc.us-east-1.redshift.amazonaws.com', warehouse: 'analytics' },
      { username: 'svc', password: 'pw' },
    ));
    assert.ok(req);
    assert.strictEqual(req!.dbType, 'REDSHIFT');
    assert.strictEqual(req!.host, 'my-cluster.abc.us-east-1.redshift.amazonaws.com');
    assert.strictEqual(req!.database, 'analytics');
    assert.strictEqual(req!.port, 5439);
    assert.strictEqual(req!.username, 'svc');
  });

  it('prefers explicit host/database/port over account/warehouse when both are set', () => {
    const req = toDbSourceRequest(warehouse(
      { account: 'acct', warehouse: 'wh', host: 'h', database: 'db', port: 5555 },
      { username: 'u' },
    ));
    assert.strictEqual(req!.host, 'h');
    assert.strictEqual(req!.database, 'db');
    assert.strictEqual(req!.port, 5555);
  });

  it('returns null without credentials (a real scan needs a username)', () => {
    assert.strictEqual(toDbSourceRequest(warehouse({ account: 'a', warehouse: 'w' })), null);
  });

  it('returns null for SDK-only warehouses so they fall back to samples', () => {
    for (const warehouseType of ['SNOWFLAKE', 'BIGQUERY', 'DATABRICKS']) {
      const req = toDbSourceRequest({
        connectionType: 'DATA_WAREHOUSE',
        config: { warehouseType, account: 'a', warehouse: 'w' },
        credentials: { username: 'u', password: 'p' },
      });
      assert.strictEqual(req, null, `${warehouseType} must not resolve to a driver yet`);
    }
  });

  it('still maps a plain DATABASE connection unchanged (no port default for Postgres)', () => {
    const req = toDbSourceRequest({
      connectionType: 'DATABASE',
      config: { dbType: 'POSTGRESQL', host: 'h', database: 'd' },
      credentials: { username: 'u', password: 'p' },
    });
    assert.strictEqual(req!.dbType, 'POSTGRESQL');
    assert.strictEqual(req!.port, undefined); // pg driver applies its own 5432
  });
});
