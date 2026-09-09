// Reporting polish (D3): run history + scheduled-delivery config on saved
// reports. Covers:
//   • POST /:id/run records a run (newest-first, capped) and stamps lastRunAt
//   • the run log is capped at RUN_LOG_LIMIT
//   • PUT /:id normalises a schedule payload (junk dropped, frequency clamped)
//   • the list projection surfaces lastRunAt / runCount / scheduleFrequency
//   • appendRun / normalizeSchedule unit behaviour

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const reportsRouter = require('../routes/reports').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { reports, appendRun, normalizeSchedule, RUN_LOG_LIMIT } = require('../routes/reports');

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

describe('reports — run history + schedule', () => {
  let server: http.Server;
  let port: number;
  const PREFIX = 'test-runhist-';
  const orgId = PREFIX + 'org';
  const reportId = PREFIX + 'r';

  const seed = () => {
    const now = new Date().toISOString();
    reports.push({
      id: reportId, orgId, name: 'R', description: '', ownerId: 'user-a',
      visibility: 'org', definition: { entity: 'processNodes', columns: [{ field: 'name' }], filters: [] },
      createdAt: now, updatedAt: now,
    });
  };
  const clean = () => {
    for (let i = reports.length - 1; i >= 0; i--) if (String(reports[i].id).startsWith(PREFIX)) reports.splice(i, 1);
  };

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).user = actingUser ? { sub: actingUser } : undefined; next(); });
    app.use('/reports', reportsRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => { clean(); await new Promise<void>((r) => server.close(() => r())); });
  beforeEach(() => { clean(); seed(); actingUser = 'user-a'; });

  it('records a run and stamps lastRunAt on POST /:id/run', async () => {
    const run = await request(port, 'POST', `/reports/${reportId}/run`);
    assert.strictEqual(run.status, 200);
    assert.ok(run.body.data.run, 'response carries the recorded run');
    assert.strictEqual(run.body.data.run.kind, 'manual');
    assert.strictEqual(run.body.data.run.byUserId, 'user-a');

    const detail = await request(port, 'GET', `/reports/${reportId}`);
    assert.strictEqual(detail.body.data.runLog.length, 1);
    assert.ok(detail.body.data.lastRunAt, 'lastRunAt is set');
  });

  it('surfaces run + schedule summary in the list projection', async () => {
    await request(port, 'POST', `/reports/${reportId}/run`);
    await request(port, 'PUT', `/reports/${reportId}`, { schedule: { frequency: 'weekly', recipients: ['a@x.com'] } });
    const list = await request(port, 'GET', `/reports?orgId=${orgId}`);
    const row = list.body.data.find((r: any) => r.id === reportId);
    assert.strictEqual(row.runCount, 1);
    assert.strictEqual(row.scheduleFrequency, 'weekly');
    assert.ok(row.lastRunAt);
    assert.strictEqual(row.runLog, undefined, 'list projection omits the full runLog');
  });

  it('normalises a schedule on PUT (junk dropped, frequency clamped)', async () => {
    const put = await request(port, 'PUT', `/reports/${reportId}`, {
      schedule: { frequency: 'nonsense', recipients: ['ok@x.com', '', 42, '  spaced@x.com  '] },
    });
    assert.strictEqual(put.body.data.schedule.frequency, 'off');
    assert.deepStrictEqual(put.body.data.schedule.recipients, ['ok@x.com', 'spaced@x.com']);
  });

  it('appendRun caps the log at RUN_LOG_LIMIT, newest first', () => {
    let report: any = { runLog: [] };
    for (let i = 0; i < RUN_LOG_LIMIT + 5; i++) {
      const patch = appendRun(report, { ranAt: `t${i}`, rowCount: i, byUserId: null, kind: 'manual' });
      report = { ...report, ...patch };
    }
    assert.strictEqual(report.runLog.length, RUN_LOG_LIMIT);
    assert.strictEqual(report.runLog[0].ranAt, `t${RUN_LOG_LIMIT + 4}`); // newest first
  });

  it('normalizeSchedule returns null for an empty/off schedule', () => {
    assert.strictEqual(normalizeSchedule({ frequency: 'off', recipients: [] }), null);
    assert.strictEqual(normalizeSchedule(null), null);
    assert.deepStrictEqual(normalizeSchedule({ frequency: 'weekly', recipients: ['a@x.com'] }), { frequency: 'weekly', recipients: ['a@x.com'] });
  });
});
