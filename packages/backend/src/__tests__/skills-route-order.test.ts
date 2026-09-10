// Route-ordering regression for routes/skills.
//
// The literal-path GET routes (/coverage, /recommend-for-role, /gap-report)
// must be registered BEFORE the catch-all GET /:id — otherwise Express matches
// `/:id` with id="coverage" first, the skill lookup misses, and the real
// handler 404s. That exact bug silently blanked out the Skill Gaps / coverage
// features (the frontend swallows the 404). These tests mount the real router
// and assert each literal path RESOLVES (400 for a missing orgId — its own
// handler — rather than 404 from the /:id fallthrough), and that /:id still
// 404s an unknown id.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const skillsRouter = require('../routes/skills').default;

function request(port: number, method: string, path: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode || 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('skills routes — literal paths resolve before /:id', () => {
  let server: http.Server;
  let port: number;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/skills', skillsRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('GET /skills/coverage resolves to its own handler (400, not 404 from /:id)', async () => {
    assert.strictEqual((await request(port, 'GET', '/skills/coverage')).status, 400);
  });

  it('GET /skills/recommend-for-role resolves to its own handler', async () => {
    assert.strictEqual((await request(port, 'GET', '/skills/recommend-for-role')).status, 400);
  });

  it('GET /skills/gap-report resolves to its own handler', async () => {
    assert.strictEqual((await request(port, 'GET', '/skills/gap-report')).status, 400);
  });

  it('GET /skills/:id still 404s an unknown id (fallback intact)', async () => {
    assert.strictEqual((await request(port, 'GET', '/skills/no-such-skill-id')).status, 404);
  });
});
