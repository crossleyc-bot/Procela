// GET /api/v1/docs/roadmap.html — served rendered live from docs/STATUS.md (the
// consolidated status / roadmap / open-work register), the same way /help.html
// serves HELP.md. Verifies the render, the same-origin framing headers, and that
// the output actually reflects the markdown file's content.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const docsRouter = require('../routes/docs').default;

function get(port: number, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: chunks }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('docs — roadmap.html', () => {
  let server: http.Server;
  let port: number;

  before(async () => {
    const app = express();
    app.use('/docs', docsRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('renders the roadmap markdown to a self-contained HTML page', async () => {
    const res = await get(port, '/docs/roadmap.html');
    assert.strictEqual(res.status, 200);
    assert.match(String(res.headers['content-type'] || ''), /text\/html/);
    // Content is rendered from docs/STATUS.md — spot-check headings/wording
    // that live in that file so the test fails if the source stops flowing through.
    assert.match(res.body, /Status, Roadmap/i);
    assert.match(res.body, /Track A/);
    assert.match(res.body, /discovery loop/i);
    // Rendered as HTML, not raw markdown.
    assert.match(res.body, /<h1|<h2/);
  });

  it('sets same-origin framing headers so the in-app /roadmap page can embed it', async () => {
    const res = await get(port, '/docs/roadmap.html');
    assert.strictEqual(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.match(String(res.headers['content-security-policy'] || ''), /frame-ancestors 'self'/);
  });
});
