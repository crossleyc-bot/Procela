// New activity-level attributes landed with the BCM + controls track:
//   - criticalityTier (TIER_1..TIER_4)
//   - rtoHours (non-negative number)
//   - successMeasure (free-text)
//   - slaTarget (free-text)
//   - controlIds[] linking to StoredGovernanceControl rows
//
// Cover: POST accepts + validates; PUT accepts + clears; enum reject;
// control-delete cascade sweeps ids off activities.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const processCatalogRouter = require('../routes/process-catalog').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { processNodes } = require('../routes/process-catalog');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const controlsRouter = require('../routes/governance-controls').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { governanceControls } = require('../routes/governance-controls');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { organizations } = require('../routes/organizations');

function request(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data!) } : {},
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode || 0, body: chunks ? JSON.parse(chunks) : null }); }
          catch { resolve({ status: res.statusCode || 0, body: chunks }); }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('activity attributes — criticality, RTO, SLA, controls', () => {
  let server: http.Server;
  let port: number;
  const PREFIX = 'test-attrs-';
  const orgId = PREFIX + 'org';
  const vsId = PREFIX + 'vs';
  const procId = PREFIX + 'proc';
  const spId = PREFIX + 'sp';
  const actId = PREFIX + 'act';
  const ctlA = PREFIX + 'ctl-a';
  const ctlB = PREFIX + 'ctl-b';

  before(async () => {
    if (!organizations.find((o: any) => o.id === orgId)) {
      const now = new Date().toISOString();
      organizations.push({
        id: orgId, name: 'Test Org', type: 'company', parentId: null,
        createdAt: now, updatedAt: now,
      });
    }
    const app = express();
    app.use(express.json());
    app.use('/process-catalog', processCatalogRouter);
    app.use('/governance-controls', controlsRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    const sweep = (arr: any[], pred: (r: any) => boolean) => {
      for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) arr.splice(i, 1);
    };
    sweep(processNodes, (n: any) => n.id?.startsWith(PREFIX));
    sweep(governanceControls, (c: any) => c.id?.startsWith(PREFIX));

    const now = new Date().toISOString();
    const base = {
      orgId, orgIds: [orgId], ownerId: null, status: 'DRAFT',
      orderIndex: 0, version: 1, activityId: null, description: '',
      createdAt: now, updatedAt: now,
    };
    processNodes.push({ ...base, id: vsId, level: 'VALUE_STREAM', name: 'VS', parentId: null });
    processNodes.push({ ...base, id: procId, level: 'PROCESS', name: 'Proc', parentId: vsId });
    processNodes.push({ ...base, id: spId, level: 'SUB_PROCESS', name: 'SP', parentId: procId });
    processNodes.push({ ...base, id: actId, level: 'ACTIVITY', name: 'Act', parentId: spId });
    governanceControls.push(
      { id: ctlA, orgId, policyId: PREFIX + 'pol', code: 'CTL-A', name: 'Test Control A', description: '', controlType: 'PREVENTIVE', automationMode: 'HUMAN', status: 'ACTIVE', ownerAssignmentId: null, evidenceRequired: false, createdAt: now, updatedAt: now },
      { id: ctlB, orgId, policyId: PREFIX + 'pol', code: 'CTL-B', name: 'Test Control B', description: '', controlType: 'DETECTIVE', automationMode: 'HUMAN', status: 'ACTIVE', ownerAssignmentId: null, evidenceRequired: false, createdAt: now, updatedAt: now },
    );
  });

  describe('PUT /nodes/:id', () => {
    it('accepts all four new attributes at once', async () => {
      const res = await request(port, 'PUT', `/process-catalog/nodes/${actId}`, {
        criticalityTier: 'TIER_1',
        rtoHours: 4,
        successMeasure: 'Field crew on site within 30 min',
        slaTarget: 'P95 30min',
        controlIds: [ctlA],
      });
      assert.strictEqual(res.status, 200);
      const node = processNodes.find((n: any) => n.id === actId);
      assert.strictEqual(node.criticalityTier, 'TIER_1');
      assert.strictEqual(node.rtoHours, 4);
      // successMeasure + slaTarget were merged into one "Target / SLA"
      // field: a client sending both gets them folded into successMeasure,
      // and slaTarget is no longer persisted separately.
      assert.strictEqual(node.successMeasure, 'Field crew on site within 30 min\n\nP95 30min');
      assert.ok(!node.slaTarget);
      assert.deepStrictEqual(node.controlIds, [ctlA]);
    });

    it('rejects an unknown criticalityTier', async () => {
      const res = await request(port, 'PUT', `/process-catalog/nodes/${actId}`, {
        criticalityTier: 'GOLDEN_TIER',
      });
      assert.strictEqual(res.status, 400);
      assert.match(res.body.error, /Unknown criticalityTier/);
    });

    it('rejects a negative rtoHours', async () => {
      const res = await request(port, 'PUT', `/process-catalog/nodes/${actId}`, {
        rtoHours: -1,
      });
      assert.strictEqual(res.status, 400);
    });

    it('clears criticalityTier and rtoHours when set to null', async () => {
      await request(port, 'PUT', `/process-catalog/nodes/${actId}`, { criticalityTier: 'TIER_2', rtoHours: 8 });
      const res = await request(port, 'PUT', `/process-catalog/nodes/${actId}`, {
        criticalityTier: null, rtoHours: null,
      });
      assert.strictEqual(res.status, 200);
      const node = processNodes.find((n: any) => n.id === actId);
      assert.strictEqual(node.criticalityTier, undefined);
      assert.strictEqual(node.rtoHours, undefined);
    });

    it('accepts RPO, trigger, and volume; validates RPO and clears each', async () => {
      const set = await request(port, 'PUT', `/process-catalog/nodes/${actId}`, {
        rpoHours: 1, trigger: 'Event-driven', volume: '  ~10k events/day  ',
        nextReviewDate: '2026-12-31', riskMitigation: '  Compensating manual control  ',
      });
      assert.strictEqual(set.status, 200);
      let node = processNodes.find((n: any) => n.id === actId);
      assert.strictEqual(node.rpoHours, 1);
      assert.strictEqual(node.trigger, 'Event-driven');
      assert.strictEqual(node.volume, '~10k events/day'); // trimmed
      assert.strictEqual(node.nextReviewDate, '2026-12-31');
      assert.strictEqual(node.riskMitigation, 'Compensating manual control'); // trimmed

      // RPO is range-checked like RTO.
      const badRpo = await request(port, 'PUT', `/process-catalog/nodes/${actId}`, { rpoHours: -2 });
      assert.strictEqual(badRpo.status, 400);

      // Empty / null clears each.
      const clear = await request(port, 'PUT', `/process-catalog/nodes/${actId}`, {
        rpoHours: null, trigger: '', volume: '', nextReviewDate: '', riskMitigation: '',
      });
      assert.strictEqual(clear.status, 200);
      node = processNodes.find((n: any) => n.id === actId);
      assert.strictEqual(node.rpoHours, undefined);
      assert.strictEqual(node.trigger, undefined);
      assert.strictEqual(node.volume, undefined);
      assert.strictEqual(node.nextReviewDate, undefined);
      assert.strictEqual(node.riskMitigation, undefined);
    });

    it('silently drops unknown controlIds from the request', async () => {
      const res = await request(port, 'PUT', `/process-catalog/nodes/${actId}`, {
        controlIds: [ctlA, 'nonexistent-id'],
      });
      assert.strictEqual(res.status, 200);
      const node = processNodes.find((n: any) => n.id === actId);
      assert.deepStrictEqual(node.controlIds, [ctlA]);
    });
  });

  describe('DELETE /governance-controls/:id — cascade', () => {
    it('sweeps the deleted control off every activity that referenced it', async () => {
      // Wire both controls onto the activity.
      await request(port, 'PUT', `/process-catalog/nodes/${actId}`, { controlIds: [ctlA, ctlB] });
      // Delete control A.
      const del = await request(port, 'DELETE', `/governance-controls/${ctlA}`);
      assert.strictEqual(del.status, 204);
      // Activity should now only reference control B.
      const node = processNodes.find((n: any) => n.id === actId);
      assert.deepStrictEqual(node.controlIds, [ctlB]);
    });

    it('sets controlIds to undefined when the last control is deleted', async () => {
      await request(port, 'PUT', `/process-catalog/nodes/${actId}`, { controlIds: [ctlA] });
      await request(port, 'DELETE', `/governance-controls/${ctlA}`);
      const node = processNodes.find((n: any) => n.id === actId);
      assert.strictEqual(node.controlIds, undefined);
    });
  });
});
