// Connection credentials encrypted at rest (B4 #3). Mirrors
// secrets-at-rest.test.ts: a deterministic reversible KMS is installed at
// runtime, so the test is independent of module-load order and of whether an
// encryption key happens to be set in the environment.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const crypto = require('../services/crypto.service') as typeof import('../services/crypto.service');
import { encryptCredentials, decryptCredentials } from '../services/connection-secrets';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const connectionsRouter = require('../routes/connections').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { connections } = require('../routes/connections');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { connectionSystemLinks } = require('../routes/connections');
import { useStoreIsolation } from './_helpers/store-isolation';

const PREFIX = 'enc:v1:';
const fakeKms = {
  name: 'test-fake-kms',
  async encrypt(p: string): Promise<string> { return PREFIX + Buffer.from(p, 'utf8').toString('base64'); },
  async decrypt(c: string): Promise<string> { return Buffer.from(c.slice(PREFIX.length), 'base64').toString('utf8'); },
};

function request(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(data)); }
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

describe('connection-secrets helpers', () => {
  let original: import('../services/crypto.service').KmsProvider;
  before(() => { original = crypto.getKmsProvider(); crypto.setKmsProvider(fakeKms); });
  after(() => { crypto.setKmsProvider(original); });

  it('envelopes the three secret fields, leaves username, and round-trips', async () => {
    const enc = await encryptCredentials({ username: 'u', password: 'p', apiKey: 'k', token: 't' });
    assert.strictEqual(enc.username, 'u');
    for (const f of ['password', 'apiKey', 'token'] as const) {
      assert.ok((enc[f] as string).startsWith(PREFIX), `${f} not enveloped`);
    }
    const dec = await decryptCredentials(enc);
    assert.deepStrictEqual(dec, { username: 'u', password: 'p', apiKey: 'k', token: 't' });
  });

  it('is idempotent — an already-enveloped value is not double-wrapped', async () => {
    const once = await encryptCredentials({ password: 'p' });
    const twice = await encryptCredentials(once);
    assert.strictEqual(once.password, twice.password);
    assert.strictEqual(await crypto.decryptSecret(twice.password as string), 'p');
  });

  it('passes plaintext / legacy values through decrypt unchanged', async () => {
    const dec = await decryptCredentials({ password: 'legacy-plain', username: 'u' });
    assert.deepStrictEqual(dec, { password: 'legacy-plain', username: 'u' });
  });

  it('leaves empty and missing fields alone', async () => {
    const enc = await encryptCredentials({ password: '', username: 'u' });
    assert.strictEqual(enc.password, '');
  });
});

describe('connections API — credentials encrypted at rest', () => {
  useStoreIsolation(
    { file: 'connections', memory: connections },
    { file: 'connectionSystemLinks', memory: connectionSystemLinks },
  );

  let original: import('../services/crypto.service').KmsProvider;
  let server: http.Server;
  let port: number;

  before(async () => {
    original = crypto.getKmsProvider();
    crypto.setKmsProvider(fakeKms);
    const app = express();
    app.use(express.json());
    app.use('/connections', connectionsRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  after(async () => {
    crypto.setKmsProvider(original);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('stores an envelope, masks the response, and decrypts back for use', async () => {
    const res = await request(port, 'POST', '/connections', {
      orgId: 'kms-org', name: 'PG', connectionType: 'DATABASE',
      config: { dbType: 'POSTGRESQL', host: 'db.internal', database: 'app' },
      credentials: { username: 'svc', password: 'super-secret' },
    });
    assert.strictEqual(res.status, 201);
    // Response never carries the raw secret.
    assert.notStrictEqual(res.body.data.credentials?.password, 'super-secret');

    const stored = connections.find((c: any) => c.name === 'PG');
    assert.ok(stored, 'connection persisted');
    assert.ok(String(stored.credentials.password).startsWith(PREFIX), 'password not enveloped at rest');
    assert.strictEqual(stored.credentials.username, 'svc', 'username stays plaintext');

    // The just-in-time decrypt the driver paths use returns the real secret.
    const forUse = await decryptCredentials(stored.credentials);
    assert.strictEqual(forUse.password, 'super-secret');
  });
});
