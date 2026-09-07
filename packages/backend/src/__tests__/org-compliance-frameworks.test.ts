// Org-configurable compliance frameworks:
//   - PUT /organizations/:id accepts activeComplianceFrameworks as a free-form
//     string array (no fixed enum — admins add their own), trimmed + deduped.
//   - a non-array payload is rejected with 400.
//   - the stored value round-trips back out on GET.
// Exercised end-to-end against the JSON store with a stubbed SUPER_ADMIN user.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const orgRouter = require('../routes/organizations').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { organizations } = require('../routes/organizations');

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

describe('org compliance frameworks', () => {
  let server: http.Server;
  let port: number;
  const orgId = 'test-cframeworks-org';

  const sweep = (arr: any[], pred: (r: any) => boolean) => { for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) arr.splice(i, 1); };

  before(async () => {
    sweep(organizations, (o: any) => o.id === orgId);
    organizations.push({
      id: orgId, parentId: null, name: 'Compliance Test Co', type: 'company',
      industry: '', description: '', headCount: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const app = express();
    app.use(express.json());
    // Stub auth — a SUPER_ADMIN sees every org (getVisibleOrgIds → null).
    app.use((req: any, _res, next) => { req.user = { email: 'admin@test.com', role: 'SUPER_ADMIN' }; next(); });
    app.use('/organizations', orgRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    sweep(organizations, (o: any) => o.id === orgId);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('stores a curated framework list (trimmed + deduped) and echoes it back', async () => {
    const res = await request(port, 'PUT', `/organizations/${orgId}`, {
      activeComplianceFrameworks: ['SOX', '  HIPAA  ', 'SOX', 'FedRAMP', '', '   '],
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.data.activeComplianceFrameworks, ['SOX', 'HIPAA', 'FedRAMP']);

    const get = await request(port, 'GET', `/organizations/${orgId}`);
    assert.strictEqual(get.status, 200);
    assert.deepStrictEqual(get.body.data.activeComplianceFrameworks, ['SOX', 'HIPAA', 'FedRAMP']);
  });

  it('accepts an empty array (tenant cleared every framework)', async () => {
    const res = await request(port, 'PUT', `/organizations/${orgId}`, { activeComplianceFrameworks: [] });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.data.activeComplianceFrameworks, []);
  });

  it('rejects a non-array payload with 400', async () => {
    const res = await request(port, 'PUT', `/organizations/${orgId}`, { activeComplianceFrameworks: 'SOX' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
  });

  it('leaves the field untouched when the key is absent from the patch', async () => {
    await request(port, 'PUT', `/organizations/${orgId}`, { activeComplianceFrameworks: ['NIST'] });
    const res = await request(port, 'PUT', `/organizations/${orgId}`, { description: 'unrelated edit' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.data.activeComplianceFrameworks, ['NIST']);
  });
});
