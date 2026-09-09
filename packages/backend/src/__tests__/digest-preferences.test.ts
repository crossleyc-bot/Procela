// Per-user digest preferences — the GET/PUT surface that lets a user choose
// which gap-signal categories they care about and whether the weekly digest
// is also emailed to them (opt-in). Covers:
//   • GET returns the default (weekly · all categories · email off) when unsaved
//   • PUT upserts, GET returns the saved values
//   • junk categories are normalised to the known set
//   • preferences are per-(org,user): two users are independent
//   • the mail helper's guards (unconfigured / empty items → false)

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const digestRouter = require('../routes/digest').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { digestPreferences, ALL_DIGEST_CATEGORIES } = require('../services/digest-preferences');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendDigestEmail } = require('../services/mail.service');

let actingUser: { sub: string; email: string; name: string } | null = null;

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

describe('digest preferences', () => {
  let server: http.Server;
  let port: number;
  const orgId = 'test-pref-org';
  const clean = () => {
    for (let i = digestPreferences.length - 1; i >= 0; i--) {
      if (String(digestPreferences[i].orgId).startsWith('test-pref-')) digestPreferences.splice(i, 1);
    }
  };

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).user = actingUser || undefined; next(); });
    app.use('/digest', digestRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => { clean(); await new Promise<void>((r) => server.close(() => r())); });
  beforeEach(() => { clean(); actingUser = { sub: 'user-a', email: 'a@example.com', name: 'User A' }; });

  it('returns the default preference when the user has saved none', async () => {
    const res = await request(port, 'GET', `/digest/preferences?orgId=${orgId}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.frequency, 'weekly');
    assert.strictEqual(res.body.data.emailEnabled, false);
    assert.deepStrictEqual(res.body.data.categories, ALL_DIGEST_CATEGORIES);
  });

  it('upserts on PUT and returns the saved values on GET', async () => {
    const put = await request(port, 'PUT', '/digest/preferences', {
      orgId, frequency: 'weekly', categories: ['orphans', 'coverage'], emailEnabled: true,
    });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.body.data.emailEnabled, true);
    assert.strictEqual(put.body.data.email, 'a@example.com');

    const get = await request(port, 'GET', `/digest/preferences?orgId=${orgId}`);
    assert.deepStrictEqual(get.body.data.categories, ['orphans', 'coverage']);
    assert.strictEqual(get.body.data.emailEnabled, true);
  });

  it('normalises unknown categories to the known set', async () => {
    const put = await request(port, 'PUT', '/digest/preferences', {
      orgId, frequency: 'weekly', categories: ['orphans', 'bogus', 'coverage', 'orphans'], emailEnabled: false,
    });
    // de-duped, junk dropped, canonical order preserved.
    assert.deepStrictEqual(put.body.data.categories, ['orphans', 'coverage']);
  });

  it('keeps preferences independent per user', async () => {
    await request(port, 'PUT', '/digest/preferences', { orgId, frequency: 'off', categories: [], emailEnabled: false });
    actingUser = { sub: 'user-b', email: 'b@example.com', name: 'User B' };
    const bDefault = await request(port, 'GET', `/digest/preferences?orgId=${orgId}`);
    assert.strictEqual(bDefault.body.data.frequency, 'weekly'); // b unaffected by a's 'off'

    actingUser = { sub: 'user-a', email: 'a@example.com', name: 'User A' };
    const aSaved = await request(port, 'GET', `/digest/preferences?orgId=${orgId}`);
    assert.strictEqual(aSaved.body.data.frequency, 'off');
  });

  it('requires orgId', async () => {
    assert.strictEqual((await request(port, 'GET', '/digest/preferences')).status, 400);
    assert.strictEqual((await request(port, 'PUT', '/digest/preferences', { frequency: 'weekly' })).status, 400);
  });

  it('mail helper is a safe no-op when unconfigured or given nothing to send', async () => {
    // SMTP is unconfigured in the test env → always false, never throws.
    assert.strictEqual(await sendDigestEmail({ to: 'x@example.com', name: 'X', orgName: 'Org', items: [{ title: 't', message: 'm', link: '/x' }] }), false);
    assert.strictEqual(await sendDigestEmail({ to: 'x@example.com', name: 'X', orgName: 'Org', items: [] }), false);
  });
});
