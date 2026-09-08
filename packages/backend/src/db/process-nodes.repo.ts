// ProcessNode repository — seventh per-entity migration, and the
// heaviest by number of M2M joins. Four separate join tables get
// rewritten on update:
//
//   - orgIds via ProcessNodeOrg (cross-org visibility of a node)
//   - controlIds via ProcessNodeControl (governance controls the
//     activity implements or is subject to)
//   - requiredSkillIds via ProcessNodeSkill (skills a responsible
//     person needs to hold)
//   - systemIds via ProcessNodeSystem (systems the step runs on)
//
// Every M2M uses the same delete-all + createMany rewrite pattern
// DataDomain established. A future optimisation could diff the
// existing rows against the incoming set and issue targeted
// deletes/creates instead — worth it for large-scale rewrites,
// unnecessary for the typical activity-edit workflow.
//
// The node's canonical `orgId` (single owner) is separate from the
// M2M `orgIds` (visibility set). The schema keeps both — orgId as a
// scalar column with an FK to Organization, orgIds via the join
// table — matching what the JSON row does.

import type { ProcessNode as StoredProcessNode } from '../routes/process-catalog';
import { saveStore } from '../lib/persistence';
import { jsonRepository, Repository } from './repository';
import { getPrisma, hasDatabase } from './prisma';

// ── JSON path ──

export function jsonProcessNodesRepository(store: StoredProcessNode[]): Repository<StoredProcessNode> {
  return jsonRepository<StoredProcessNode>(store, () => saveStore('processNodes', store));
}

// ── Postgres path ──

type PrismaProcessNodeRow = {
  id: string;
  parentId: string | null;
  level: string;
  name: string;
  description: string | null;
  orgId: string;
  ownerId: string | null;
  status: string;
  orderIndex: number;
  activityId: string | null;
  responsibleRole: string | null;
  responsiblePersonId: string | null;
  purpose: string | null;
  businessOutcome: string | null;
  stakeholders: string | null;
  inputsOutputs: string | null;
  complianceTags: string[];
  statusJustification: string | null;
  frequency: string | null;
  riskLevel: string | null;
  automationLevel: string | null;
  estimatedDuration: string | null;
  criticalityTier: string | null;
  rtoHours: number | null;
  rpoHours: number | null;
  successMeasure: string | null;
  slaTarget: string | null;
  trigger: string | null;
  volume: string | null;
  nextReviewDate: string | null;
  riskMitigation: string | null;
  domain: string;
  version: number;
  submittedBy: string | null;
  submittedAt: Date | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewComment: string | null;
  createdAt: Date;
  updatedAt: Date;
  orgLinks?: Array<{ orgId: string }>;
  controls?: Array<{ controlId: string }>;
  requiredSkills?: Array<{ skillId: string }>;
  systems?: Array<{ systemId: string }>;
};

export interface PrismaProcessNodeDelegate {
  findMany(arg?: {
    where?: { orgId?: string };
    include?: {
      orgLinks?: boolean;
      controls?: boolean;
      requiredSkills?: boolean;
      systems?: boolean;
    };
  }): Promise<PrismaProcessNodeRow[]>;
  findUnique(arg: {
    where: { id: string };
    include?: {
      orgLinks?: boolean;
      controls?: boolean;
      requiredSkills?: boolean;
      systems?: boolean;
    };
  }): Promise<PrismaProcessNodeRow | null>;
  create(arg: { data: Record<string, unknown> }): Promise<PrismaProcessNodeRow>;
  update(arg: { where: { id: string }; data: Record<string, unknown> }): Promise<PrismaProcessNodeRow>;
  delete(arg: { where: { id: string } }): Promise<PrismaProcessNodeRow>;
}

function fromPrisma(r: PrismaProcessNodeRow): StoredProcessNode {
  const orgIds = (r.orgLinks ?? []).map((l) => l.orgId);
  return {
    id: r.id,
    parentId: r.parentId,
    level: r.level as StoredProcessNode['level'],
    name: r.name,
    description: r.description ?? '',
    activityId: r.activityId,
    status: r.status,
    orderIndex: r.orderIndex,
    orgId: r.orgId,
    orgIds,
    ownerId: r.ownerId,
    version: r.version,
    ...(r.purpose ? { purpose: r.purpose } : {}),
    ...(r.businessOutcome ? { businessOutcome: r.businessOutcome } : {}),
    ...(r.stakeholders ? { stakeholders: r.stakeholders } : {}),
    ...(r.complianceTags.length > 0 ? { complianceTags: r.complianceTags } : {}),
    ...(r.inputsOutputs ? { inputsOutputs: r.inputsOutputs } : {}),
    ...(r.responsibleRole ? { responsibleRole: r.responsibleRole } : {}),
    ...(r.responsiblePersonId ? { responsiblePersonId: r.responsiblePersonId } : {}),
    ...(r.statusJustification ? { statusJustification: r.statusJustification } : {}),
    ...(r.frequency ? { frequency: r.frequency } : {}),
    ...(r.riskLevel ? { riskLevel: r.riskLevel } : {}),
    ...(r.automationLevel ? { automationLevel: r.automationLevel } : {}),
    ...(r.estimatedDuration ? { estimatedDuration: r.estimatedDuration } : {}),
    ...(r.requiredSkills && r.requiredSkills.length > 0
      ? { requiredSkillIds: r.requiredSkills.map((s) => s.skillId) }
      : {}),
    ...(r.criticalityTier
      ? { criticalityTier: r.criticalityTier as StoredProcessNode['criticalityTier'] }
      : {}),
    ...(r.rtoHours != null ? { rtoHours: r.rtoHours } : {}),
    ...(r.rpoHours != null ? { rpoHours: r.rpoHours } : {}),
    ...(r.successMeasure ? { successMeasure: r.successMeasure } : {}),
    ...(r.slaTarget ? { slaTarget: r.slaTarget } : {}),
    ...(r.trigger ? { trigger: r.trigger } : {}),
    ...(r.volume ? { volume: r.volume } : {}),
    ...(r.nextReviewDate ? { nextReviewDate: r.nextReviewDate } : {}),
    ...(r.riskMitigation ? { riskMitigation: r.riskMitigation } : {}),
    ...(r.controls && r.controls.length > 0
      ? { controlIds: r.controls.map((c) => c.controlId) }
      : {}),
    ...(r.submittedBy ? { submittedBy: r.submittedBy } : {}),
    ...(r.submittedAt ? { submittedAt: r.submittedAt.toISOString() } : {}),
    ...(r.reviewedBy ? { reviewedBy: r.reviewedBy } : {}),
    ...(r.reviewedAt ? { reviewedAt: r.reviewedAt.toISOString() } : {}),
    ...(r.reviewComment ? { reviewComment: r.reviewComment } : {}),
    ...(r.systems && r.systems.length > 0
      ? { systemIds: r.systems.map((s) => s.systemId) }
      : {}),
    domain: r.domain as StoredProcessNode['domain'],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toPrismaData(row: Partial<StoredProcessNode>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (row.id !== undefined) data.id = row.id;
  if (row.parentId !== undefined) data.parentId = row.parentId;
  if (row.level !== undefined) data.level = row.level;
  if (row.name !== undefined) data.name = row.name;
  if (row.description !== undefined) data.description = row.description || null;
  if (row.activityId !== undefined) data.activityId = row.activityId;
  if (row.status !== undefined) data.status = row.status;
  if (row.orderIndex !== undefined) data.orderIndex = row.orderIndex;
  if (row.orgId !== undefined) data.orgId = row.orgId;
  if (row.ownerId !== undefined) data.ownerId = row.ownerId;
  if (row.version !== undefined) data.version = row.version;
  if (row.purpose !== undefined) data.purpose = row.purpose ?? null;
  if (row.businessOutcome !== undefined) data.businessOutcome = row.businessOutcome ?? null;
  if (row.stakeholders !== undefined) data.stakeholders = row.stakeholders ?? null;
  if (row.complianceTags !== undefined) data.complianceTags = row.complianceTags;
  if (row.inputsOutputs !== undefined) data.inputsOutputs = row.inputsOutputs ?? null;
  if (row.responsibleRole !== undefined) data.responsibleRole = row.responsibleRole ?? null;
  if (row.responsiblePersonId !== undefined) data.responsiblePersonId = row.responsiblePersonId ?? null;
  if (row.statusJustification !== undefined) data.statusJustification = row.statusJustification ?? null;
  if (row.frequency !== undefined) data.frequency = row.frequency ?? null;
  if (row.riskLevel !== undefined) data.riskLevel = row.riskLevel ?? null;
  if (row.automationLevel !== undefined) data.automationLevel = row.automationLevel ?? null;
  if (row.estimatedDuration !== undefined) data.estimatedDuration = row.estimatedDuration ?? null;
  if (row.criticalityTier !== undefined) data.criticalityTier = row.criticalityTier ?? null;
  if (row.rtoHours !== undefined) data.rtoHours = row.rtoHours ?? null;
  if (row.rpoHours !== undefined) data.rpoHours = row.rpoHours ?? null;
  if (row.successMeasure !== undefined) data.successMeasure = row.successMeasure ?? null;
  if (row.slaTarget !== undefined) data.slaTarget = row.slaTarget ?? null;
  if (row.trigger !== undefined) data.trigger = row.trigger ?? null;
  if (row.volume !== undefined) data.volume = row.volume ?? null;
  if (row.nextReviewDate !== undefined) data.nextReviewDate = row.nextReviewDate ?? null;
  if (row.riskMitigation !== undefined) data.riskMitigation = row.riskMitigation ?? null;
  if (row.domain !== undefined) data.domain = row.domain;
  if (row.submittedBy !== undefined) data.submittedBy = row.submittedBy ?? null;
  if (row.submittedAt !== undefined) {
    data.submittedAt = row.submittedAt ? new Date(row.submittedAt) : null;
  }
  if (row.reviewedBy !== undefined) data.reviewedBy = row.reviewedBy ?? null;
  if (row.reviewedAt !== undefined) {
    data.reviewedAt = row.reviewedAt ? new Date(row.reviewedAt) : null;
  }
  if (row.reviewComment !== undefined) data.reviewComment = row.reviewComment ?? null;
  if (row.createdAt !== undefined) data.createdAt = new Date(row.createdAt);
  return data;
}

const includeRelations = {
  orgLinks: true,
  controls: true,
  requiredSkills: true,
  systems: true,
} as const;

// Rewrite one of the four M2M join tables. Extracted so the update
// path stays readable — each of the four joins does the exact same
// delete-all + createMany dance with different table/column names.
async function rewriteJoin<K extends string, V extends string>(
  client: unknown,
  tableName: K,
  nodeIdColumn: string,
  valueColumn: string,
  nodeId: string,
  valueIds: string[],
  linkFactory: (nodeId: string, valueId: string) => Record<string, string>,
): Promise<void> {
  const c = client as unknown as Record<K, {
    deleteMany(arg: { where: Record<string, string> }): Promise<{ count: number }>;
    createMany(arg: { data: Array<Record<V, string>> }): Promise<{ count: number }>;
  }>;
  const table = c[tableName];
  await table.deleteMany({ where: { [nodeIdColumn]: nodeId } });
  if (valueIds.length > 0) {
    await table.createMany({
      data: valueIds.map((id) => linkFactory(nodeId, id) as Record<V, string>),
    });
  }
  // Reference: valueColumn is currently unused inside the helper —
  // it's kept in the signature so the calling site self-documents
  // which id it's rewriting into.
  void valueColumn;
}

export function prismaProcessNodesRepository(
  clientFactory: () => { processNode: PrismaProcessNodeDelegate } = getPrisma as unknown as () => { processNode: PrismaProcessNodeDelegate },
): Repository<StoredProcessNode> {
  return {
    async list(filter) {
      const client = clientFactory();
      const where = filter?.orgId ? { orgId: filter.orgId } : undefined;
      const rows = await client.processNode.findMany({
        ...(where ? { where } : {}),
        include: includeRelations,
      });
      return rows.map(fromPrisma);
    },
    async get(id) {
      const client = clientFactory();
      const row = await client.processNode.findUnique({ where: { id }, include: includeRelations });
      return row ? fromPrisma(row) : null;
    },
    async create(row) {
      const client = clientFactory();
      const created = await client.processNode.create({ data: toPrismaData(row) });
      // Write the four M2M joins after the parent row exists.
      const patch: Partial<StoredProcessNode> = {};
      if (row.orgIds) patch.orgIds = row.orgIds;
      if (row.controlIds) patch.controlIds = row.controlIds;
      if (row.requiredSkillIds) patch.requiredSkillIds = row.requiredSkillIds;
      if (row.systemIds) patch.systemIds = row.systemIds;
      if (Object.keys(patch).length > 0) {
        await this.update(created.id, patch);
      }
      const fresh = await this.get(created.id);
      return fresh ?? fromPrisma(created);
    },
    async update(id, patch) {
      const client = clientFactory();
      try {
        const scalarData = toPrismaData(patch);
        if (Object.keys(scalarData).length > 0) {
          await client.processNode.update({ where: { id }, data: scalarData });
        }
        if (patch.orgIds !== undefined) {
          await rewriteJoin(
            client, 'processNodeOrg', 'processNodeId', 'orgId', id, patch.orgIds,
            (nodeId, orgId) => ({ processNodeId: nodeId, orgId }),
          );
        }
        if (patch.controlIds !== undefined) {
          await rewriteJoin(
            client, 'processNodeControl', 'processNodeId', 'controlId', id, patch.controlIds,
            (nodeId, controlId) => ({ processNodeId: nodeId, controlId }),
          );
        }
        if (patch.requiredSkillIds !== undefined) {
          await rewriteJoin(
            client, 'processNodeSkill', 'processNodeId', 'skillId', id, patch.requiredSkillIds,
            (nodeId, skillId) => ({ processNodeId: nodeId, skillId }),
          );
        }
        if (patch.systemIds !== undefined) {
          await rewriteJoin(
            client, 'processNodeSystem', 'processNodeId', 'systemId', id, patch.systemIds,
            (nodeId, systemId) => ({ processNodeId: nodeId, systemId }),
          );
        }
        return await this.get(id);
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return null;
        throw err;
      }
    },
    async delete(id) {
      const client = clientFactory();
      try {
        await client.processNode.delete({ where: { id } });
        return true;
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return false;
        throw err;
      }
    },
  };
}

// ── Factory ──

/**
 * Pick the right ProcessNode repository for the current runtime.
 * Postgres when DATABASE_URL is set; JSON otherwise.
 */
export function getProcessNodesRepository(store: StoredProcessNode[]): Repository<StoredProcessNode> {
  return hasDatabase()
    ? prismaProcessNodesRepository()
    : jsonProcessNodesRepository(store);
}
