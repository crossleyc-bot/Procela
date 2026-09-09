import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  jsonReportsRepository,
  prismaReportsRepository,
  type PrismaReportDelegate,
} from '../db/reports.repo';
import type { StoredReport } from '../routes/reports';
import type { ReportDefinition } from '../services/report-engine';

const defaultDefinition: ReportDefinition = {
  entity: 'processNodes',
  columns: [],
  filters: [],
};

const make = (over: Partial<StoredReport> = {}): StoredReport => ({
  id: `id-${Math.random().toString(36).slice(2, 10)}`,
  orgId: 'o1',
  name: 'r',
  description: '',
  ownerId: null,
  visibility: 'org',
  definition: defaultDefinition,
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:00:00.000Z',
  ...over,
});

describe('jsonReportsRepository', () => {
  let store: StoredReport[];
  beforeEach(() => { store = []; });

  it('list filters by orgId', async () => {
    const repo = jsonReportsRepository(store);
    store.push(make({ id: 'a', orgId: 'o1' }), make({ id: 'b', orgId: 'o2' }));
    const rows = await repo.list({ orgId: 'o1' });
    assert.deepStrictEqual(rows.map((r) => r.id), ['a']);
  });

  it('update returns null when row missing', async () => {
    const repo = jsonReportsRepository(store);
    assert.strictEqual(await repo.update('gone', { name: 'x' }), null);
  });
});

describe('prismaReportsRepository', () => {
  function delegate(over: Partial<PrismaReportDelegate> = {}): PrismaReportDelegate {
    return {
      findMany: async () => [],
      findUnique: async () => null,
      create: async () => { throw new Error('stub'); },
      update: async () => { throw new Error('stub'); },
      delete: async () => { throw new Error('stub'); },
      ...over,
    };
  }

  it('list round-trips JSON definition and null ownerId', async () => {
    const d = delegate({
      findMany: async () => [{
        id: 'a1', orgId: 'o1', name: 'n', description: '', ownerId: null,
        visibility: 'private',
        definition: defaultDefinition,
        lastRunAt: null, runLog: [], schedule: null,
        createdAt: new Date('2026-07-15T00:00:00.000Z'),
        updatedAt: new Date('2026-07-15T00:00:00.000Z'),
      }],
    });
    const repo = prismaReportsRepository(() => ({ report: d }));
    const rows = await repo.list();
    assert.strictEqual(rows[0].ownerId, null);
    assert.strictEqual(rows[0].visibility, 'private');
    assert.deepStrictEqual(rows[0].definition, defaultDefinition);
  });

  it('update returns null on P2025', async () => {
    const d = delegate({
      update: async () => {
        const e: Error & { code?: string } = new Error('nf'); e.code = 'P2025'; throw e;
      },
    });
    const repo = prismaReportsRepository(() => ({ report: d }));
    assert.strictEqual(await repo.update('gone', { name: 'x' }), null);
  });
});
