// ProcessNode repository — JSON adapter + stubbed Prisma path.
// Heaviest M2M coverage yet: four join tables (orgIds, controlIds,
// requiredSkillIds, systemIds) all rewritten via delete-all +
// createMany on update. Tests assert each rewrite calls into the
// correct join-table delegate with the correct column names.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  jsonProcessNodesRepository,
  prismaProcessNodesRepository,
  type PrismaProcessNodeDelegate,
} from '../db/process-nodes.repo';
import type { ProcessNode as StoredProcessNode } from '../routes/process-catalog';

const makeNode = (over: Partial<StoredProcessNode> = {}): StoredProcessNode => ({
  id: `id-${Math.random().toString(36).slice(2, 10)}`,
  parentId: null,
  level: 'ACTIVITY',
  name: 'Outage triage',
  description: '',
  activityId: null,
  status: 'DRAFT',
  orderIndex: 0,
  orgId: 'o1',
  orgIds: ['o1'],
  ownerId: null,
  version: 1,
  domain: 'OPERATIONAL',
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:00:00.000Z',
  ...over,
});

describe('jsonProcessNodesRepository', () => {
  let store: StoredProcessNode[];

  beforeEach(() => { store = []; });

  it('list filters by orgId (shallow field, matches JSON row.orgId)', async () => {
    const repo = jsonProcessNodesRepository(store);
    store.push(
      makeNode({ id: 'a', orgId: 'o1' }),
      makeNode({ id: 'b', orgId: 'o2' }),
    );
    const rows = await repo.list({ orgId: 'o1' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, 'a');
  });

  it('round-trips complianceTags + controlIds + requiredSkillIds on JSON', async () => {
    const repo = jsonProcessNodesRepository(store);
    await repo.create(makeNode({
      id: 'n1',
      complianceTags: ['NERC-CIP-007', 'SOC2'],
      controlIds: ['c-1', 'c-2'],
      requiredSkillIds: ['s-1'],
      systemIds: ['sys-1', 'sys-2'],
    }));
    const round = await repo.get('n1');
    assert.deepStrictEqual(round?.complianceTags, ['NERC-CIP-007', 'SOC2']);
    assert.deepStrictEqual(round?.controlIds, ['c-1', 'c-2']);
    assert.deepStrictEqual(round?.requiredSkillIds, ['s-1']);
    assert.deepStrictEqual(round?.systemIds, ['sys-1', 'sys-2']);
  });
});

describe('prismaProcessNodesRepository (stubbed Prisma)', () => {
  function makeDelegate(overrides: Partial<PrismaProcessNodeDelegate> = {}): PrismaProcessNodeDelegate {
    return {
      findMany: async () => [],
      findUnique: async () => null,
      create: async () => { throw new Error('stub'); },
      update: async () => { throw new Error('stub'); },
      delete: async () => { throw new Error('stub'); },
      ...overrides,
    };
  }

  it('list maps Prisma row → ProcessNode (four M2M sets flattened, dates → ISO, rich docs pass through)', async () => {
    const delegate = makeDelegate({
      findMany: async () => [{
        id: 'n1',
        parentId: null,
        level: 'ACTIVITY',
        name: 'Outage triage',
        description: 'first responder',
        orgId: 'o1',
        ownerId: 'p-owner',
        status: 'ACTIVE',
        orderIndex: 3,
        activityId: null,
        responsibleRole: 'System Operator Lead',
        responsiblePersonId: 'p-melissa',
        purpose: 'Restore service quickly',
        businessOutcome: 'SAIDI/SAIFI targets met',
        stakeholders: 'DCC + Field Ops',
        inputsOutputs: 'In: SCADA alarms. Out: crew dispatch.',
        complianceTags: ['NERC-CIP-007'],
        statusJustification: null,
        frequency: 'On event',
        riskLevel: 'HIGH',
        automationLevel: 'PARTIAL',
        estimatedDuration: '30 min',
        criticalityTier: 'TIER_1',
        rtoHours: 4,
        rpoHours: 1,
        successMeasure: 'Field crew on site within 30 min',
        slaTarget: 'P95 30 min',
        trigger: 'EVENT',
        volume: '~200 outages/yr',
        nextReviewDate: '2026-12-31',
        riskMitigation: 'Redundant SCADA feed + manual dispatch fallback',
        domain: 'OPERATIONAL',
        version: 2,
        submittedBy: null,
        submittedAt: null,
        reviewedBy: null,
        reviewedAt: null,
        reviewComment: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-15T00:00:00.000Z'),
        orgLinks: [{ orgId: 'o1' }, { orgId: 'o2' }],
        controls: [{ controlId: 'c-1' }],
        requiredSkills: [{ skillId: 's-1' }, { skillId: 's-2' }],
        systems: [{ systemId: 'sys-scada' }],
      }],
    });
    const repo = prismaProcessNodesRepository(() => ({ processNode: delegate }));
    const rows = await repo.list({ orgId: 'o1' });
    assert.strictEqual(rows.length, 1);
    const r = rows[0];
    // Rich-doc scalars.
    assert.strictEqual(r.purpose, 'Restore service quickly');
    assert.strictEqual(r.stakeholders, 'DCC + Field Ops');
    assert.strictEqual(r.responsibleRole, 'System Operator Lead');
    assert.strictEqual(r.responsiblePersonId, 'p-melissa');
    assert.deepStrictEqual(r.complianceTags, ['NERC-CIP-007']);
    // BCM.
    assert.strictEqual(r.criticalityTier, 'TIER_1');
    assert.strictEqual(r.rtoHours, 4);
    assert.strictEqual(r.rpoHours, 1);
    assert.strictEqual(r.trigger, 'EVENT');
    assert.strictEqual(r.volume, '~200 outages/yr');
    assert.strictEqual(r.nextReviewDate, '2026-12-31');
    assert.strictEqual(r.riskMitigation, 'Redundant SCADA feed + manual dispatch fallback');
    // Four M2M joins flattened.
    assert.deepStrictEqual(r.orgIds, ['o1', 'o2']);
    assert.deepStrictEqual(r.controlIds, ['c-1']);
    assert.deepStrictEqual(r.requiredSkillIds, ['s-1', 's-2']);
    assert.deepStrictEqual(r.systemIds, ['sys-scada']);
    assert.strictEqual(r.createdAt, '2026-01-01T00:00:00.000Z');
  });

  it('update rewrites all four M2M sets via delete-all + createMany on each join table', async () => {
    const calls: Record<string, unknown> = {};
    const delegate = makeDelegate({
      update: async () => ({
        id: 'n1', parentId: null, level: 'ACTIVITY', name: 'x',
        description: null, orgId: 'o1', ownerId: null, status: 'DRAFT',
        orderIndex: 0, activityId: null, responsibleRole: null,
        responsiblePersonId: null, purpose: null, businessOutcome: null,
        stakeholders: null, inputsOutputs: null, complianceTags: [],
        statusJustification: null, frequency: null, riskLevel: null,
        automationLevel: null, estimatedDuration: null, criticalityTier: null,
        rtoHours: null, rpoHours: null, successMeasure: null, slaTarget: null,
        trigger: null, volume: null, nextReviewDate: null, riskMitigation: null,
        domain: 'OPERATIONAL', version: 1, submittedBy: null,
        submittedAt: null, reviewedBy: null, reviewedAt: null,
        reviewComment: null,
        createdAt: new Date(), updatedAt: new Date(),
      }),
      findUnique: async () => ({
        id: 'n1', parentId: null, level: 'ACTIVITY', name: 'x',
        description: null, orgId: 'o1', ownerId: null, status: 'DRAFT',
        orderIndex: 0, activityId: null, responsibleRole: null,
        responsiblePersonId: null, purpose: null, businessOutcome: null,
        stakeholders: null, inputsOutputs: null, complianceTags: [],
        statusJustification: null, frequency: null, riskLevel: null,
        automationLevel: null, estimatedDuration: null, criticalityTier: null,
        rtoHours: null, rpoHours: null, successMeasure: null, slaTarget: null,
        trigger: null, volume: null, nextReviewDate: null, riskMitigation: null,
        domain: 'OPERATIONAL', version: 1, submittedBy: null,
        submittedAt: null, reviewedBy: null, reviewedAt: null,
        reviewComment: null,
        createdAt: new Date(), updatedAt: new Date(),
        orgLinks: [{ orgId: 'o1' }, { orgId: 'o3' }],
        controls: [{ controlId: 'c-new' }],
        requiredSkills: [{ skillId: 's-new' }],
        systems: [{ systemId: 'sys-new' }],
      }),
    });
    const makeJoinDelegate = (key: string) => ({
      deleteMany: async (arg: unknown) => { calls[key + 'Delete'] = arg; return { count: 0 }; },
      createMany: async (arg: unknown) => { calls[key + 'Create'] = arg; return { count: 1 }; },
    });
    const client = {
      processNode: delegate,
      processNodeOrg: makeJoinDelegate('org'),
      processNodeControl: makeJoinDelegate('control'),
      processNodeSkill: makeJoinDelegate('skill'),
      processNodeSystem: makeJoinDelegate('system'),
    };
    const repo = prismaProcessNodesRepository(() => client as unknown as { processNode: PrismaProcessNodeDelegate });
    const updated = await repo.update('n1', {
      orgIds: ['o1', 'o3'],
      controlIds: ['c-new'],
      requiredSkillIds: ['s-new'],
      systemIds: ['sys-new'],
    });
    assert.ok(updated);
    assert.deepStrictEqual(updated!.orgIds, ['o1', 'o3']);
    assert.deepStrictEqual(updated!.controlIds, ['c-new']);
    assert.deepStrictEqual(updated!.requiredSkillIds, ['s-new']);
    assert.deepStrictEqual(updated!.systemIds, ['sys-new']);
    // All four joins rewritten with the correct column names.
    assert.deepStrictEqual(calls.orgDelete, { where: { processNodeId: 'n1' } });
    assert.deepStrictEqual(calls.orgCreate, { data: [{ processNodeId: 'n1', orgId: 'o1' }, { processNodeId: 'n1', orgId: 'o3' }] });
    assert.deepStrictEqual(calls.controlDelete, { where: { processNodeId: 'n1' } });
    assert.deepStrictEqual(calls.controlCreate, { data: [{ processNodeId: 'n1', controlId: 'c-new' }] });
    assert.deepStrictEqual(calls.skillDelete, { where: { processNodeId: 'n1' } });
    assert.deepStrictEqual(calls.skillCreate, { data: [{ processNodeId: 'n1', skillId: 's-new' }] });
    assert.deepStrictEqual(calls.systemDelete, { where: { processNodeId: 'n1' } });
    assert.deepStrictEqual(calls.systemCreate, { data: [{ processNodeId: 'n1', systemId: 'sys-new' }] });
  });

  it('update returns null on P2025', async () => {
    const delegate = makeDelegate({
      update: async () => {
        const err: Error & { code?: string } = new Error('Not found.');
        err.code = 'P2025';
        throw err;
      },
    });
    const repo = prismaProcessNodesRepository(() => ({ processNode: delegate }));
    assert.strictEqual(await repo.update('gone', { name: 'x' }), null);
  });
});
