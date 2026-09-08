// Tenant-isolation regression tests (B4 security fix).
//
// A restricted user (visible only to their own org tree) must never reach
// another tenant's rows — not by omitting ?orgId on a list, and not by
// hitting a cross-tenant /:id GET / PUT / DELETE. These drive the real
// systems router through authenticateToken, which is how requests arrive in
// production. The router is mounted WITHOUT requireResource so the test
// isolates the org-scope guard (not RBAC): the user is given a write-capable
// role, and it is the tenant guard alone that must block the cross-tenant
// mutation.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

import { authenticateToken } from '../middleware/auth';
import { errorHandler } from '../middleware/errorHandler';
import { sign as signJwt } from '../services/jwt-signer';
import { people } from '../routes/people';
import { organizations } from '../routes/organizations';
import { systems } from '../routes/systems';
import systemsRouter from '../routes/systems';
import { useStoreIsolation } from './_helpers/store-isolation';

const P = 'tenant-iso-';
const orgAcme = P + 'org-acme';
const orgUmbrella = P + 'org-umbrella';
const acmeSystemId = P + 'sys-acme';
const umbrellaSystemId = P + 'sys-umbrella';

function restrictedToken(): string {
  // Email matches the seeded restricted person; role is EDITOR so RBAC would
  // allow the write — only the tenant guard should stop the cross-tenant one.
  return signJwt(
    { sub: 'acme-sub', email: 'user@acme.example', orgId: orgAcme, role: 'EDITOR', type: 'access' },
    { expiresIn: '5m' },
  );
}
function superToken(): string {
  return signJwt(
    { sub: 'root-sub', email: 'root@example', orgId: orgAcme, role: 'SUPER_ADMIN', type: 'access' },
    { expiresIn: '5m' },
  );
}

function call(
  port: number, method: string, path: string, token: string, body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
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
    if (payload) req.write(payload);
    req.end();
  });
}

describe('tenant isolation — systems router', () => {
  useStoreIsolation(
    { file: 'organizations', memory: organizations },
    { file: 'people', memory: people },
    { file: 'systems', memory: systems },
  );

  let server: http.Server;
  let port: number;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/systems', authenticateToken, systemsRouter);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  beforeEach(() => {
    const now = new Date().toISOString();
    organizations.push(
      { id: orgAcme, parentId: null, name: 'Acme', type: 'company', industry: '', description: '', headCount: 0, createdAt: now, updatedAt: now },
      { id: orgUmbrella, parentId: null, name: 'Umbrella', type: 'company', industry: '', description: '', headCount: 0, createdAt: now, updatedAt: now },
    );
    people.push(
      { id: P + 'p-acme', orgIds: [orgAcme], accessibleOrgIds: [orgAcme], name: 'Restricted', email: 'user@acme.example', role: 'EDITOR', title: '', skillIds: [], active: true, createdAt: now, updatedAt: now },
    );
    systems.push(
      { id: acmeSystemId, orgId: orgAcme, name: 'Acme ERP', description: '', systemType: 'ERP', createdAt: now, updatedAt: now },
      { id: umbrellaSystemId, orgId: orgUmbrella, name: 'Umbrella GIS', description: '', systemType: 'GIS', createdAt: now, updatedAt: now },
    );
  });

  it('list without ?orgId returns only the caller-tenant rows (no cross-tenant leak)', async () => {
    const res = await call(port, 'GET', '/systems', restrictedToken());
    assert.strictEqual(res.status, 200);
    const ids = (res.body.data as Array<{ id: string }>).map((s) => s.id);
    assert.ok(ids.includes(acmeSystemId), 'own-tenant system present');
    assert.ok(!ids.includes(umbrellaSystemId), 'other-tenant system must be excluded');
  });

  it('GET /:id of a cross-tenant row is 404 (no existence disclosure)', async () => {
    const res = await call(port, 'GET', `/systems/${umbrellaSystemId}`, restrictedToken());
    assert.strictEqual(res.status, 404);
  });

  it('PUT /:id of a cross-tenant row is 404 and does not mutate it', async () => {
    const res = await call(port, 'PUT', `/systems/${umbrellaSystemId}`, restrictedToken(), { name: 'HACKED' });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(systems.find((s) => s.id === umbrellaSystemId)?.name, 'Umbrella GIS');
  });

  it('DELETE /:id of a cross-tenant row is 404 and does not remove it', async () => {
    const res = await call(port, 'DELETE', `/systems/${umbrellaSystemId}`, restrictedToken());
    assert.strictEqual(res.status, 404);
    assert.ok(systems.some((s) => s.id === umbrellaSystemId), 'other-tenant system must survive');
  });

  it('own-tenant GET and PUT still succeed (no false positive)', async () => {
    const get = await call(port, 'GET', `/systems/${acmeSystemId}`, restrictedToken());
    assert.strictEqual(get.status, 200);
    const put = await call(port, 'PUT', `/systems/${acmeSystemId}`, restrictedToken(), { name: 'Acme ERP v2' });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(systems.find((s) => s.id === acmeSystemId)?.name, 'Acme ERP v2');
  });

  it('SUPER_ADMIN is unrestricted — sees and can read the other tenant', async () => {
    const list = await call(port, 'GET', '/systems', superToken());
    const ids = (list.body.data as Array<{ id: string }>).map((s) => s.id);
    assert.ok(ids.includes(acmeSystemId) && ids.includes(umbrellaSystemId), 'super admin sees both');
    const get = await call(port, 'GET', `/systems/${umbrellaSystemId}`, superToken());
    assert.strictEqual(get.status, 200);
  });
});
