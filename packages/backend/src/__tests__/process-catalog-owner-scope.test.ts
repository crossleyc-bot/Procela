// Tenant guard: a process node's owner / responsible person must come from
// within the node's org scope. A caller with cross-org visibility (e.g. a
// super-admin) must NOT be able to assign someone from a sibling company.
//
// Sibling companies orgA and orgB. personA lives in orgA, personB in orgB.
// An activity in orgA: assigning personB (sibling tenant) is rejected 400;
// assigning personA (same org) succeeds. Same for both owner and
// responsible-person fields.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const processCatalogRouter = require('../routes/process-catalog').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { processNodes } = require('../routes/process-catalog');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { organizations } = require('../routes/organizations');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { people } = require('../routes/people');

function request(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data!) } : {} },
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

describe('process-catalog — owner/responsible person tenant scope', () => {
  let server: http.Server;
  let port: number;
  const P = 'test-ownerscope-';
  const orgA = P + 'orgA';
  const orgB = P + 'orgB';
  const personA = P + 'personA';
  const personB = P + 'personB';
  const nodeId = P + 'activity';

  const clean = () => {
    for (const arr of [organizations, people, processNodes]) {
      for (let i = arr.length - 1; i >= 0; i--) if (String(arr[i].id).startsWith(P)) arr.splice(i, 1);
    }
  };

  before(async () => {
    clean();
    const now = new Date().toISOString();
    // Two sibling top-level companies (neither is an ancestor of the other).
    organizations.push({ id: orgA, name: 'Alpha Co', industry: 'Utilities', type: 'company', parentId: null, createdAt: now, updatedAt: now });
    organizations.push({ id: orgB, name: 'Beta Co', industry: 'Shipbuilding', type: 'company', parentId: null, createdAt: now, updatedAt: now });
    people.push({ id: personA, orgIds: [orgA], accessibleOrgIds: [orgA], name: 'Ann Alpha', email: 'ann@alpha.test', role: 'VIEWER', title: '', skillIds: [] });
    people.push({ id: personB, orgIds: [orgB], accessibleOrgIds: [orgB], name: 'Ben Beta', email: 'ben@beta.test', role: 'VIEWER', title: '', skillIds: [] });
    processNodes.push({
      id: nodeId, parentId: null, level: 'ACTIVITY', name: 'Load Usage Data', description: '',
      status: 'DRAFT', orderIndex: 0, orgId: orgA, orgIds: [orgA], ownerId: null, version: 1,
      createdAt: now, updatedAt: now,
    });

    const app = express();
    app.use(express.json());
    app.use('/process-catalog', processCatalogRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => { clean(); await new Promise<void>((r) => server.close(() => r())); });

  it('rejects an OWNER from a sibling tenant (400)', async () => {
    const res = await request(port, 'PUT', `/process-catalog/nodes/${nodeId}`, { ownerId: personB });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /organization scope/i);
  });

  it('accepts an OWNER from the node\'s own org (200)', async () => {
    const res = await request(port, 'PUT', `/process-catalog/nodes/${nodeId}`, { ownerId: personA });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.ownerId, personA);
  });

  it('rejects a RESPONSIBLE PERSON from a sibling tenant (400)', async () => {
    const res = await request(port, 'PUT', `/process-catalog/nodes/${nodeId}`, { responsiblePersonId: personB });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /organization scope/i);
  });

  it('accepts a RESPONSIBLE PERSON from the node\'s own org (200)', async () => {
    const res = await request(port, 'PUT', `/process-catalog/nodes/${nodeId}`, { responsiblePersonId: personA });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.responsiblePersonId, personA);
  });

  it('still allows clearing the owner (empty string)', async () => {
    const res = await request(port, 'PUT', `/process-catalog/nodes/${nodeId}`, { ownerId: '' });
    assert.strictEqual(res.status, 200);
  });
});
