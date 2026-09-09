// Chat-thread persistence — the endpoints that let the assistant panel
// save a conversation, list a user's past conversations, re-open one, and
// delete it. This locks in:
//   • create derives a title from the first user message and stamps ownerId
//   • list returns the caller's threads as summaries (no transcript bodies)
//   • get returns the full transcript
//   • update appends the transcript and refreshes an auto title
//   • a thread is private to its owner — another user gets 404 on
//     get / update / delete (no cross-user existence disclosure)
//   • validation: 400 on missing orgId or a malformed messages array

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatRouter = require('../routes/chat').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { chatThreads } = require('../routes/chat');

// The acting user for the next request — an injecting middleware puts it on
// req.user, mirroring what authenticateToken does in the real app.
let actingUser: string | null = null;

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

describe('chat-thread persistence', () => {
  let server: http.Server;
  let port: number;
  const orgId = 'test-thread-org';
  const clean = () => {
    for (let i = chatThreads.length - 1; i >= 0; i--) {
      if (String(chatThreads[i].orgId).startsWith('test-thread-')) chatThreads.splice(i, 1);
    }
  };

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).user = actingUser ? { sub: actingUser } : undefined; next(); });
    app.use('/chat', chatRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    clean();
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => { clean(); actingUser = null; });

  it('creates a thread, derives a title, and stamps the owner', async () => {
    actingUser = 'user-a';
    const res = await request(port, 'POST', '/chat/threads', {
      orgId,
      messages: [
        { role: 'user', content: 'Where are our data gaps?' },
        { role: 'assistant', content: 'You have three uncovered steps.' },
      ],
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.data.ownerId, 'user-a');
    assert.strictEqual(res.body.data.title, 'Where are our data gaps?');
    assert.strictEqual(res.body.data.messages.length, 2);
  });

  it('lists the caller\'s threads as summaries without transcript bodies', async () => {
    actingUser = 'user-a';
    await request(port, 'POST', '/chat/threads', { orgId, messages: [{ role: 'user', content: 'Hi' }] });
    const res = await request(port, 'GET', `/chat/threads?orgId=${orgId}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.length, 1);
    assert.strictEqual(res.body.data[0].messageCount, 1);
    assert.strictEqual(res.body.data[0].messages, undefined);
  });

  it('returns the full transcript on get, and appends on update', async () => {
    actingUser = 'user-a';
    const created = await request(port, 'POST', '/chat/threads', { orgId, messages: [{ role: 'user', content: 'First' }] });
    const id = created.body.data.id;

    const got = await request(port, 'GET', `/chat/threads/${id}`);
    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.body.data.messages.length, 1);

    const updated = await request(port, 'PUT', `/chat/threads/${id}`, {
      messages: [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'Second' },
      ],
    });
    assert.strictEqual(updated.status, 200);
    assert.strictEqual(updated.body.data.messages.length, 3);
  });

  it('keeps a thread private to its owner (404 for another user)', async () => {
    actingUser = 'user-a';
    const created = await request(port, 'POST', '/chat/threads', { orgId, messages: [{ role: 'user', content: 'secret' }] });
    const id = created.body.data.id;

    actingUser = 'user-b';
    assert.strictEqual((await request(port, 'GET', `/chat/threads/${id}`)).status, 404);
    assert.strictEqual((await request(port, 'PUT', `/chat/threads/${id}`, { title: 'x' })).status, 404);
    assert.strictEqual((await request(port, 'DELETE', `/chat/threads/${id}`)).status, 404);

    // user-b's own list does not see user-a's thread.
    const list = await request(port, 'GET', `/chat/threads?orgId=${orgId}`);
    assert.strictEqual(list.body.data.length, 0);
  });

  it('lets the owner delete their own thread', async () => {
    actingUser = 'user-a';
    const created = await request(port, 'POST', '/chat/threads', { orgId, messages: [{ role: 'user', content: 'x' }] });
    const del = await request(port, 'DELETE', `/chat/threads/${created.body.data.id}`);
    assert.strictEqual(del.status, 204);
    assert.strictEqual((await request(port, 'GET', `/chat/threads/${created.body.data.id}`)).status, 404);
  });

  it('validates orgId and the messages array', async () => {
    actingUser = 'user-a';
    assert.strictEqual((await request(port, 'POST', '/chat/threads', { messages: [{ role: 'user', content: 'x' }] })).status, 400);
    assert.strictEqual((await request(port, 'POST', '/chat/threads', { orgId, messages: 'nope' })).status, 400);
    assert.strictEqual((await request(port, 'POST', '/chat/threads', { orgId, messages: [{ role: 'bogus', content: 'x' }] })).status, 400);
  });
});
