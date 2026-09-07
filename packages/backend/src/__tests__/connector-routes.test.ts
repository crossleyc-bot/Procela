// HTTP tests for routes/connectors — the on-prem agent surface.
// Covers both halves of the routes file:
//   - Admin-side (user JWT): pair/start, list, delete, events
//   - Agent-side (connector token): pair/claim, heartbeat, report
// Plus the scanForOfflineConnectors() helper that drives offline
// notifications without waiting on a real timer.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';

import config from '../config';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const connectorsRouter = require('../routes/connectors').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { connectors, connectorEvents, scanForOfflineConnectors } = require('../routes/connectors');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { dataAssets, dataAssetColumns } = require('../routes/data-assets');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { notifications } = require('../routes/notifications');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { governanceIssues } = require('../routes/governance-issues');

function request(
  port: number, method: string, path: string,
  opts: { body?: unknown; bearer?: string } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = opts.body ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = {};
    if (opts.body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(data!));
    }
    if (opts.bearer) headers['Authorization'] = `Bearer ${opts.bearer}`;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 0, body: chunks ? JSON.parse(chunks) : null }); }
        catch { resolve({ status: res.statusCode || 0, body: chunks }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function mintAdminJwt(orgId: string): string {
  return jwt.sign(
    { sub: 'test-admin', email: 'admin@example.test', orgId, role: 'ORG_ADMIN', type: 'access' },
    config.jwtSecret, { expiresIn: '1h' },
  );
}

describe('connector routes', () => {
  let server: http.Server;
  let port: number;
  const orgId = 'test-org-connectors';
  const PREFIX = 'test-conn-';
  let adminJwt: string;

  before(async () => {
    adminJwt = mintAdminJwt(orgId);
    const app = express();
    app.use(express.json());
    app.use('/connectors', connectorsRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;

    // Sweep leftovers from prior runs.
    const sweep = (arr: any[]) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].orgId === orgId || (typeof arr[i].name === 'string' && arr[i].name.startsWith(PREFIX))) {
          arr.splice(i, 1);
        }
      }
    };
    sweep(connectors); sweep(connectorEvents); sweep(dataAssets); sweep(dataAssetColumns); sweep(notifications); sweep(governanceIssues);
  });

  after(async () => {
    const sweep = (arr: any[]) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].orgId === orgId || (typeof arr[i].name === 'string' && arr[i].name.startsWith(PREFIX))) {
          arr.splice(i, 1);
        }
      }
    };
    sweep(connectors); sweep(connectorEvents); sweep(dataAssets); sweep(dataAssetColumns); sweep(notifications); sweep(governanceIssues);
    await new Promise<void>((r) => server.close(() => r()));
  });

  describe('admin endpoints', () => {
    it('GET / returns 401 without a bearer token', async () => {
      const res = await request(port, 'GET', '/connectors');
      assert.strictEqual(res.status, 401);
    });

    it('POST /pair/start mints a pairing code', async () => {
      const res = await request(port, 'POST', '/connectors/pair/start', {
        body: { name: PREFIX + 'pair-test', orgId },
        bearer: adminJwt,
      });
      assert.strictEqual(res.status, 201);
      assert.match(res.body.data.pairingCode, /^\d{8}$/);
      assert.ok(res.body.data.id);
      assert.ok(res.body.data.expiresAt);
    });

    it('GET / lists the connector with its freshness bucket', async () => {
      const res = await request(port, 'GET', `/connectors?orgId=${orgId}`, { bearer: adminJwt });
      assert.strictEqual(res.status, 200);
      const row = res.body.data.find((r: any) => r.name === PREFIX + 'pair-test');
      assert.ok(row, 'created connector should appear in the list');
      assert.strictEqual(row.status, 'PAIRED');
      assert.strictEqual(row.pairingCodeActive, true);
    });

    it('DELETE /:id revokes the connector — status REVOKED, token invalidated', async () => {
      // Seed a fresh paired connector and a token to ensure revoke kills auth.
      const create = await request(port, 'POST', '/connectors/pair/start', {
        body: { name: PREFIX + 'revoke-test', orgId },
        bearer: adminJwt,
      });
      const claim = await request(port, 'POST', '/connectors/pair/claim', {
        body: { code: create.body.data.pairingCode, agentVersion: '1.0.0-test' },
      });
      assert.strictEqual(claim.status, 200);
      const token = claim.body.data.token;
      // Heartbeat works.
      const ok = await request(port, 'POST', '/connectors/heartbeat', { body: {}, bearer: token });
      assert.strictEqual(ok.status, 200);
      // Revoke.
      const del = await request(port, 'DELETE', `/connectors/${create.body.data.id}`, { bearer: adminJwt });
      assert.strictEqual(del.status, 200);
      // Heartbeat with the revoked token now 401s.
      const dead = await request(port, 'POST', '/connectors/heartbeat', { body: {}, bearer: token });
      assert.strictEqual(dead.status, 401);
    });
  });

  describe('pairing flow', () => {
    it('POST /pair/claim with the right code returns a pct_ token and marks ONLINE', async () => {
      const create = await request(port, 'POST', '/connectors/pair/start', {
        body: { name: PREFIX + 'claim-test', orgId }, bearer: adminJwt,
      });
      const code = create.body.data.pairingCode;
      const claim = await request(port, 'POST', '/connectors/pair/claim', {
        body: { code, agentVersion: '1.2.3-test' },
      });
      assert.strictEqual(claim.status, 200);
      assert.match(claim.body.data.token, /^pct_[0-9a-f]{96}$/);
      // List should now show ONLINE.
      const list = await request(port, 'GET', `/connectors?orgId=${orgId}`, { bearer: adminJwt });
      const row = list.body.data.find((r: any) => r.name === PREFIX + 'claim-test');
      assert.strictEqual(row.status, 'ONLINE');
      assert.strictEqual(row.agentVersion, '1.2.3-test');
      assert.strictEqual(row.pairingCodeActive, false);
    });

    it('POST /pair/claim with a wrong code 404s', async () => {
      const res = await request(port, 'POST', '/connectors/pair/claim', { body: { code: '00000001' } });
      assert.strictEqual(res.status, 404);
    });

    it('POST /pair/claim with the same code twice — second call 404s (single-use)', async () => {
      const create = await request(port, 'POST', '/connectors/pair/start', {
        body: { name: PREFIX + 'reclaim-test', orgId }, bearer: adminJwt,
      });
      const code = create.body.data.pairingCode;
      const first = await request(port, 'POST', '/connectors/pair/claim', { body: { code } });
      assert.strictEqual(first.status, 200);
      const second = await request(port, 'POST', '/connectors/pair/claim', { body: { code } });
      assert.strictEqual(second.status, 404);
    });
  });

  describe('agent endpoints', () => {
    let token: string;
    let connectorId: string;
    before(async () => {
      const create = await request(port, 'POST', '/connectors/pair/start', {
        body: { name: PREFIX + 'agent-test', orgId }, bearer: adminJwt,
      });
      connectorId = create.body.data.id;
      const claim = await request(port, 'POST', '/connectors/pair/claim', {
        body: { code: create.body.data.pairingCode },
      });
      token = claim.body.data.token;
    });

    it('POST /heartbeat 401s without a connector token', async () => {
      const res = await request(port, 'POST', '/connectors/heartbeat', { body: {} });
      assert.strictEqual(res.status, 401);
    });

    it('POST /heartbeat 401s with a non-connector token', async () => {
      const res = await request(port, 'POST', '/connectors/heartbeat', { body: {}, bearer: adminJwt });
      assert.strictEqual(res.status, 401);
    });

    it('POST /heartbeat updates lastHeartbeatAt', async () => {
      const res = await request(port, 'POST', '/connectors/heartbeat', {
        body: { agentVersion: '1.0.1-test' }, bearer: token,
      });
      assert.strictEqual(res.status, 200);
      const list = await request(port, 'GET', `/connectors?orgId=${orgId}`, { bearer: adminJwt });
      const row = list.body.data.find((r: any) => r.id === connectorId);
      assert.ok(row.lastHeartbeatAt);
      assert.strictEqual(row.agentVersion, '1.0.1-test');
    });

    it('POST /report upserts data assets and tags them with the connector', async () => {
      const res = await request(port, 'POST', '/connectors/report', {
        body: {
          assets: [
            { name: PREFIX + 'asset-a', description: 'first', rowCount: 1000,
              lastWriteAt: new Date().toISOString() },
            { name: PREFIX + 'asset-b', description: 'second', rowCount: 500 },
          ],
        },
        bearer: token,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.created, 2);
      assert.strictEqual(res.body.data.updated, 0);

      const seeded = dataAssets.find((d: any) => d.name === PREFIX + 'asset-a');
      assert.ok(seeded);
      assert.strictEqual(seeded.lastSyncedByConnectorId, connectorId);
      assert.ok(seeded.lastSyncedAt);
      // Fresh assets get a higher healthScore than stale ones.
      assert.ok(seeded.healthScore >= 90);
      // The reported row count is persisted on the asset.
      assert.strictEqual(seeded.rowCount, 1000);
      const seededB = dataAssets.find((d: any) => d.name === PREFIX + 'asset-b');
      assert.strictEqual(seededB.rowCount, 500);

      // Second report updates instead of creating, and refreshes rowCount.
      const second = await request(port, 'POST', '/connectors/report', {
        body: { assets: [{ name: PREFIX + 'asset-a', description: 'first', rowCount: 1200 }] },
        bearer: token,
      });
      assert.strictEqual(second.body.data.updated, 1);
      assert.strictEqual(second.body.data.created, 0);
      assert.strictEqual(dataAssets.find((d: any) => d.name === PREFIX + 'asset-a').rowCount, 1200);

      // A later scan that omits rowCount must NOT null the stored value.
      await request(port, 'POST', '/connectors/report', {
        body: { assets: [{ name: PREFIX + 'asset-a', description: 'first' }] },
        bearer: token,
      });
      assert.strictEqual(dataAssets.find((d: any) => d.name === PREFIX + 'asset-a').rowCount, 1200);
    });

    it('POST /report upserts column-level metadata, audit-only', async () => {
      // First report: asset + two columns are created.
      const first = await request(port, 'POST', '/connectors/report', {
        body: { assets: [
          { name: PREFIX + 'cols', description: 'with cols', rowCount: 3, columns: [
            { name: 'id', dataType: 'integer', nullable: false, ordinal: 1 },
            { name: 'email', dataType: 'text', nullable: true, ordinal: 2 },
          ] },
        ] },
        bearer: token,
      });
      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.body.data.columnsCreated, 2);
      assert.strictEqual(first.body.data.columnsUpdated, 0);

      const asset = dataAssets.find((d: any) => d.name === PREFIX + 'cols');
      assert.ok(asset);
      let cols = dataAssetColumns.filter((c: any) => c.dataAssetId === asset.id);
      assert.strictEqual(cols.length, 2);
      const idCol = cols.find((c: any) => c.columnName === 'id');
      assert.strictEqual(idCol.dataType, 'integer');
      // Discovery provenance is recorded so a steward sees it was scanned.
      assert.strictEqual(idCol.sourceColumn, 'id');
      assert.strictEqual(idCol.sourceAsset, PREFIX + 'cols');

      // Second report: unchanged col is a no-op, a type change updates,
      // a new column is created.
      const second = await request(port, 'POST', '/connectors/report', {
        body: { assets: [
          { name: PREFIX + 'cols', columns: [
            { name: 'id', dataType: 'integer' },           // unchanged
            { name: 'email', dataType: 'varchar' },        // changed -> update
            { name: 'created_at', dataType: 'timestamp' }, // new -> create
          ] },
        ] },
        bearer: token,
      });
      assert.strictEqual(second.body.data.columnsCreated, 1);
      assert.strictEqual(second.body.data.columnsUpdated, 1);
      cols = dataAssetColumns.filter((c: any) => c.dataAssetId === asset.id);
      assert.strictEqual(cols.length, 3);
      assert.strictEqual(cols.find((c: any) => c.columnName === 'email').dataType, 'varchar');

      // Third report omits columns entirely — must not touch the schema
      // (older agents, and a table-only rescan, don't wipe columns).
      const third = await request(port, 'POST', '/connectors/report', {
        body: { assets: [{ name: PREFIX + 'cols', rowCount: 9 }] },
        bearer: token,
      });
      assert.strictEqual(third.body.data.columnsCreated, 0);
      assert.strictEqual(third.body.data.columnsUpdated, 0);
      assert.strictEqual(dataAssetColumns.filter((c: any) => c.dataAssetId === asset.id).length, 3);
    });

    it('POST /report detects schema drift: lowers health and raises/resolves an issue', async () => {
      const assetName = PREFIX + 'drift';
      const fresh = () => new Date().toISOString();
      // Baseline scan — asset + fingerprint established, no drift.
      await request(port, 'POST', '/connectors/report', {
        body: { assets: [{ name: assetName, rowCount: 100, lastWriteAt: fresh(), columns: [
          { name: 'id', dataType: 'integer' },
          { name: 'email', dataType: 'text' },
        ] } ] },
        bearer: token,
      });
      const asset = dataAssets.find((d: any) => d.name === assetName);
      assert.ok(asset);
      assert.ok(asset.schemaFingerprint, 'baseline scan records a fingerprint');
      const baselineHealth = asset.healthScore;
      assert.strictEqual(governanceIssues.filter((i: any) => i.dataAssetId === asset.id && i.issueType === 'SCHEMA_DRIFT').length, 0);

      // Second scan — a column is added AND retyped. Same freshness/rowcount,
      // so any health drop is attributable to the drift penalty.
      await request(port, 'POST', '/connectors/report', {
        body: { assets: [{ name: assetName, rowCount: 100, lastWriteAt: fresh(), columns: [
          { name: 'id', dataType: 'bigint' },       // retyped
          { name: 'email', dataType: 'text' },
          { name: 'created_at', dataType: 'timestamp' }, // added
        ] } ] },
        bearer: token,
      });
      const drifted = dataAssets.find((d: any) => d.name === assetName);
      assert.ok(drifted.healthScore < baselineHealth, 'drift lowers the health score');
      const open = governanceIssues.filter((i: any) => i.dataAssetId === asset.id && i.issueType === 'SCHEMA_DRIFT' && i.status === 'OPEN');
      assert.strictEqual(open.length, 1, 'a schema-drift issue is raised');
      assert.strictEqual(open[0].severity, 'MEDIUM');

      // Third scan — schema matches the drifted set (no further change): the
      // fingerprint is stable, so the open drift issue auto-resolves.
      await request(port, 'POST', '/connectors/report', {
        body: { assets: [{ name: assetName, rowCount: 100, lastWriteAt: fresh(), columns: [
          { name: 'id', dataType: 'bigint' },
          { name: 'email', dataType: 'text' },
          { name: 'created_at', dataType: 'timestamp' },
        ] } ] },
        bearer: token,
      });
      const stillOpen = governanceIssues.filter((i: any) => i.dataAssetId === asset.id && i.issueType === 'SCHEMA_DRIFT' && i.status === 'OPEN');
      assert.strictEqual(stillOpen.length, 0, 'a stable rescan auto-resolves the drift issue');
    });

    it('GET /:id/events returns the connector\'s recent events newest-first', async () => {
      const res = await request(port, 'GET', `/connectors/${connectorId}/events`, { bearer: adminJwt });
      assert.strictEqual(res.status, 200);
      const types = res.body.data.map((e: any) => e.type);
      // We've fired PAIRED + at least one ASSETS_REPORTED in this suite.
      assert.ok(types.includes('PAIRED'));
      assert.ok(types.includes('ASSETS_REPORTED'));
      // Newest-first.
      for (let i = 1; i < res.body.data.length; i++) {
        assert.ok(res.body.data[i - 1].ts >= res.body.data[i].ts);
      }
    });
  });

  describe('scanForOfflineConnectors', () => {
    it('transitions a long-silent connector to OFFLINE and writes a notification', async () => {
      // Seed a row with an ancient heartbeat (well past the 4h
      // threshold).
      const ancient = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
      connectors.push({
        id: PREFIX + 'silent-conn',
        orgId,
        name: PREFIX + 'silent',
        tokenHash: 'dummy',
        pairingCode: null,
        pairingCodeExpiresAt: null,
        systemIds: [],
        lastHeartbeatAt: ancient,
        agentVersion: null,
        status: 'ONLINE',
        createdAt: ancient,
        updatedAt: ancient,
      });
      const result = await scanForOfflineConnectors();
      assert.ok(result.transitioned >= 1);
      const row = connectors.find((c: any) => c.id === PREFIX + 'silent-conn');
      assert.strictEqual(row.status, 'OFFLINE');
      // A notification was written for the transition.
      const note = notifications.find((n: any) => n.orgId === orgId && /silent.*offline/i.test(n.title));
      assert.ok(note, 'should write an OFFLINE notification on transition');
    });
  });
});
