// Regression guard for the "add input hangs / never shows" bug.
//
// The mappings.createdBy column is a Postgres `uuid`. The POST handler
// used to hard-code `createdBy: 'dev-user'`, which is fine for the JSON
// store but makes the Postgres INSERT reject with "invalid input syntax
// for type uuid". Because the route was an un-wrapped async handler, that
// rejection was swallowed by the global unhandledRejection net and the
// response was never sent — the request hung until the gateway 504'd.
//
// These tests lock in the value-level fix: createdBy is the authenticated
// user's id when it's a real uuid, and '' (→ NULL in Postgres) otherwise —
// never the non-uuid 'dev-user' literal.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mappingsRouter = require('../routes/mappings').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mappings } = require('../routes/mappings');

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

describe('POST /mappings — createdBy is a uuid or empty, never a literal', () => {
  const P = 'test-createdby-';
  const userUuid = '11111111-1111-4111-8111-111111111111';
  const stepId = '22222222-2222-4222-8222-222222222222';
  const assetId = '33333333-3333-4333-8333-333333333333';

  const clean = () => {
    for (let i = mappings.length - 1; i >= 0; i--) {
      if (String(mappings[i].processStepId) === stepId) mappings.splice(i, 1);
    }
  };

  // Two servers: one that injects an authenticated user, one that does not.
  let authServer: http.Server; let authPort: number;
  let anonServer: http.Server; let anonPort: number;

  before(async () => {
    clean();
    const authApp = express();
    authApp.use(express.json());
    authApp.use((req, _res, next) => { (req as any).user = { sub: userUuid, email: 'u@t.test', orgId: P + 'org', role: 'VIEWER' }; next(); });
    authApp.use('/mappings', mappingsRouter);
    authServer = http.createServer(authApp);
    await new Promise<void>((r) => authServer.listen(0, '127.0.0.1', r));
    authPort = (authServer.address() as AddressInfo).port;

    const anonApp = express();
    anonApp.use(express.json());
    anonApp.use('/mappings', mappingsRouter);
    anonServer = http.createServer(anonApp);
    await new Promise<void>((r) => anonServer.listen(0, '127.0.0.1', r));
    anonPort = (anonServer.address() as AddressInfo).port;
  });

  after(async () => {
    clean();
    await new Promise<void>((r) => authServer.close(() => r()));
    await new Promise<void>((r) => anonServer.close(() => r()));
  });

  it('persists the authenticated user uuid as createdBy (201)', async () => {
    const res = await request(authPort, 'POST', '/mappings', { processStepId: stepId, dataAssetId: assetId, linkType: 'consumes' });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.data.createdBy, userUuid);
  });

  it('falls back to empty createdBy (never the "dev-user" literal) when unauthenticated (201)', async () => {
    const res = await request(anonPort, 'POST', '/mappings', { processStepId: stepId, dataAssetId: assetId, linkType: 'consumes' });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.data.createdBy, '');
    assert.notStrictEqual(res.body.data.createdBy, 'dev-user');
  });
});
