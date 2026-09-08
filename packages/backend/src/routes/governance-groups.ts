import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { auditService } from '../services/audit.service';
import { loadStore, saveStore, registerStore } from '../lib/persistence';
import { scopeListForRequest, assertOrgAccess } from '../lib/tenant-scope';
import { dataDomains } from './data-domains';
import { people } from './people';
import { agents } from './agents';
import logger from '../lib/logger';
import { getGovernanceGroupsRepository } from '../db/governance-groups.repo';
import { getPeopleRepository } from '../db/people.repo';
import { getAgentsRepository } from '../db/agents.repo';
import { getDataDomainsRepository } from '../db/data-domains.repo';
import { hasDatabase } from '../db/prisma';

// Governance Hierarchy Tiers (aligned with data governance best practices)
const GROUP_TYPES = [
  'COUNCIL',              // Executive steering — sets strategy, policy, funding
  'OFFICE',               // Data Governance Office — day-to-day program management
  'COMMITTEE',            // Cross-functional implementation, standards
  'STEWARDSHIP_TEAM',     // Domain-specific data quality and standards
  'WORKING_GROUP',        // Temporary, initiative-focused
  'COMMUNITY_OF_PRACTICE', // Knowledge sharing, informal
] as const;

// Valid parent-child relationships (governance hierarchy)
const VALID_CHILDREN: Record<string, string[]> = {
  COUNCIL:               ['OFFICE', 'COMMITTEE', 'WORKING_GROUP'],
  OFFICE:                ['COMMITTEE', 'STEWARDSHIP_TEAM', 'WORKING_GROUP'],
  COMMITTEE:             ['STEWARDSHIP_TEAM', 'WORKING_GROUP', 'COMMUNITY_OF_PRACTICE'],
  STEWARDSHIP_TEAM:      ['WORKING_GROUP', 'COMMUNITY_OF_PRACTICE'],
  WORKING_GROUP:         ['COMMUNITY_OF_PRACTICE'],
  COMMUNITY_OF_PRACTICE: [],
};

const GROUP_TYPE_LABELS: Record<string, string> = {
  COUNCIL: 'Data Governance Council',
  OFFICE: 'Data Governance Office',
  COMMITTEE: 'Data Governance Committee',
  STEWARDSHIP_TEAM: 'Data Stewardship Team',
  WORKING_GROUP: 'Working Group',
  COMMUNITY_OF_PRACTICE: 'Community of Practice',
};

const GROUP_ROLES = ['CHAIR', 'VICE_CHAIR', 'MEMBER', 'SECRETARY', 'ADVISOR'] as const;

// Agent membership is restricted to the ADVISOR slot. The voting /
// chairing / signing roles stay people-only so accountability for any
// decision the group makes — policy approvals, escalations, RACI sign-
// off — lands on a human name. AI agents can still contribute (drafts,
// quality monitoring, policy-gap surfacing) in the advisor capacity.
const AGENT_ALLOWED_GROUP_ROLES = new Set<string>(['ADVISOR']);

export interface GroupMember {
  // Exactly one of (personId, agentId) is set on any membership row.
  // Older records only have personId; the migration below backfills
  // agentId: null so the discriminator is always present.
  personId: string | null;
  agentId: string | null;
  groupRole: string;
  since: string;
}

export interface StoredGovernanceGroup {
  id: string;
  orgId: string;
  parentId: string | null;
  name: string;
  type: string;
  description: string;
  charter: string;
  status: 'ACTIVE' | 'INACTIVE';
  members: GroupMember[];
  createdAt: string;
  updatedAt: string;
}

export const governanceGroups: StoredGovernanceGroup[] = loadStore<StoredGovernanceGroup>('governanceGroups');
registerStore('governanceGroups', governanceGroups);

const governanceGroupsRepo = getGovernanceGroupsRepository(governanceGroups);
const DEV_ORG_ID = '00000000-0000-0000-0000-000000000010';

// Foreign stores for member/recommendation enrichment — lazy repos (cycle-safe).
let _peopleRepo: ReturnType<typeof getPeopleRepository> | null = null;
const peopleRepo = () => (_peopleRepo ??= getPeopleRepository(people));
let _agentsRepo: ReturnType<typeof getAgentsRepository> | null = null;
const agentsRepo = () => (_agentsRepo ??= getAgentsRepository(agents));
let _dataDomainsRepo: ReturnType<typeof getDataDomainsRepository> | null = null;
const dataDomainsRepo = () => (_dataDomainsRepo ??= getDataDomainsRepository(dataDomains));

// Request-body schemas — Zod at the API boundary. Enum checks + type
// guarantees fall out of the parse so downstream code can drop the
// `.includes(x as any)` runtime checks and use the typed body directly.
const createGroupBodySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.enum(GROUP_TYPES),
  description: z.string().optional(),
  charter: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  orgId: z.string().optional(),
  parentId: z.string().nullable().optional(),
});
const updateGroupBodySchema = z.object({
  name: z.string().optional(),
  type: z.enum(GROUP_TYPES).optional(),
  description: z.string().optional(),
  charter: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  parentId: z.string().nullable().optional(),
});
const generateTemplateBodySchema = z.object({
  orgId: z.string().optional(),
});
const addMemberBodySchema = z.object({
  personId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  groupRole: z.enum(GROUP_ROLES),
});

// Deduplicate on startup: keep the first occurrence of each name+orgId+type
// combo. JSON mode only — Postgres rows are managed through the repo.
if (!hasDatabase()) {
  const seen = new Set<string>();
  const dupeIds: string[] = [];
  for (const g of governanceGroups) {
    const key = `${g.orgId}|${g.name.toLowerCase()}|${g.type}`;
    if (seen.has(key)) { dupeIds.push(g.id); } else { seen.add(key); }
  }
  if (dupeIds.length > 0) {
    const dupeSet = new Set(dupeIds);
    for (let i = governanceGroups.length - 1; i >= 0; i--) {
      if (dupeSet.has(governanceGroups[i].id)) governanceGroups.splice(i, 1);
    }
    saveStore('governanceGroups', governanceGroups);
    logger.info({ removed: dupeIds.length }, 'Removed duplicate governance groups');
  }
}

// Backfill: ensure every membership row has the (personId, agentId)
// discriminator pair so downstream code can branch on type without
// undefined checks. Legacy rows only stored personId. JSON mode only.
if (!hasDatabase()) {
  let backfilled = 0;
  for (const g of governanceGroups) {
    for (const m of g.members) {
      if ((m as any).agentId === undefined) { (m as any).agentId = null; backfilled++; }
      if ((m as any).personId === undefined) { (m as any).personId = null; }
    }
  }
  if (backfilled > 0) {
    saveStore('governanceGroups', governanceGroups);
    logger.info({ backfilled }, 'Backfilled agentId on existing governance group members');
  }
}

// ── Tree builder ──

type GroupTreeNode = StoredGovernanceGroup & { children: GroupTreeNode[] };

function buildTree(groups: StoredGovernanceGroup[]): GroupTreeNode[] {
  const map = new Map<string, GroupTreeNode>();
  const roots: GroupTreeNode[] = [];

  for (const g of groups) {
    map.set(g.id, { ...g, children: [] });
  }
  for (const g of groups) {
    const node = map.get(g.id);
    if (!node) continue;
    if (g.parentId && map.has(g.parentId)) {
      map.get(g.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

const router = Router();

/** DELETE /api/v1/governance-groups/all — delete all governance groups */
router.delete('/all', async (_req: Request, res: Response) => {
  const all = await governanceGroupsRepo.list();
  const count = all.length;
  for (const g of all) await governanceGroupsRepo.delete(g.id);
  auditService.log(DEV_ORG_ID, null, 'GovernanceGroup', '*', 'DELETE_ALL', null, { count });
  logger.info({ count }, 'Deleted all governance groups');
  res.json({ success: true, deleted: count });
});

/** GET /api/v1/governance-groups */
router.get('/', async (req: Request, res: Response) => {
  let filtered = scopeListForRequest(req, await governanceGroupsRepo.list());
  // Deduplicate by name+type within the result set
  const seen = new Set<string>();
  filtered = filtered.filter((g) => {
    const key = `${g.name.toLowerCase()}|${g.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  res.json({
    success: true,
    data: filtered,
    tree: buildTree(filtered),
    groupTypes: GROUP_TYPES,
    groupTypeLabels: GROUP_TYPE_LABELS,
    validChildren: VALID_CHILDREN,
    groupRoles: GROUP_ROLES,
  });
});

/**
 * POST /api/v1/governance-groups/generate-template
 * Generate a standard governance structure as a starting point.
 * Must be registered BEFORE /:id to avoid route conflict.
 */
router.post('/generate-template', async (req: Request, res: Response) => {
  const parsed = generateTemplateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const { orgId } = parsed.data;
  const targetOrgId = orgId || DEV_ORG_ID;
  const now = new Date().toISOString();
  const created: StoredGovernanceGroup[] = [];

  const template = [
    { type: 'COUNCIL', name: 'Data Governance Council', description: 'Executive steering committee that sets data governance strategy, policy, and priorities.', charter: 'Define data governance vision, approve policies, allocate resources, resolve escalations.' },
    { type: 'OFFICE', name: 'Data Governance Office', description: 'Day-to-day program management and coordination of governance activities.', charter: 'Coordinate governance initiatives, track compliance, manage governance tools, support stewardship teams.', parentType: 'COUNCIL' },
    { type: 'COMMITTEE', name: 'Enterprise Data Committee', description: 'Cross-functional working group that implements governance standards and practices.', charter: 'Develop data standards, review data issues, coordinate across domains, report to the Council.', parentType: 'OFFICE' },
  ];

  // Skip items that already exist in this org (prevents duplicates on re-run)
  const orgGroups = (await governanceGroupsRepo.list()).filter((g) => g.orgId === targetOrgId);
  const existingNames = new Set(orgGroups.map((g) => g.name.toLowerCase()));

  const typeToId: Record<string, string> = {};
  // Seed typeToId from existing groups so parent lookups work even when skipping
  for (const g of orgGroups) {
    if (!typeToId[g.type]) typeToId[g.type] = g.id;
  }

  for (const t of template) {
    if (existingNames.has(t.name.toLowerCase())) continue;
    const parentId = t.parentType ? typeToId[t.parentType] || null : null;
    const group: StoredGovernanceGroup = {
      id: uuid(), orgId: targetOrgId, parentId,
      name: t.name, type: t.type, description: t.description, charter: t.charter,
      status: 'ACTIVE', members: [], createdAt: now, updatedAt: now,
    };
    await governanceGroupsRepo.create(group);
    created.push(group);
    orgGroups.push(group);
    if (!typeToId[t.type]) typeToId[t.type] = group.id;
  }

  logger.info({ count: created.length, orgId: targetOrgId }, 'Generated governance template');
  res.status(201).json({ success: true, data: created, tree: buildTree(orgGroups) });
});

/** GET /api/v1/governance-groups/:id */
router.get('/:id', async (req: Request, res: Response) => {
  const group = await governanceGroupsRepo.get(String(req.params.id));
  if (!group) { res.status(404).json({ success: false, error: 'Governance group not found' }); return; }
  if (!assertOrgAccess(req, res, group.orgId, 'Governance group not found')) return;

  const [allPeople, allAgents, allGroups] = await Promise.all([
    peopleRepo().list(), agentsRepo().list(), governanceGroupsRepo.list(),
  ]);
  const enrichedMembers = group.members.map((m) => {
    if (m.agentId) {
      const agent = allAgents.find((a) => a.id === m.agentId);
      return { ...m, personName: null, agentName: agent?.name || 'Unknown' };
    }
    const person = allPeople.find((p) => p.id === m.personId);
    return { ...m, personName: person?.name || 'Unknown', agentName: null };
  });

  const parent = group.parentId ? allGroups.find((g) => g.id === group.parentId) : null;
  const children = allGroups.filter((g) => g.parentId === group.id);

  res.json({
    success: true,
    data: {
      ...group,
      members: enrichedMembers,
      parentName: parent?.name || null,
      children: children.map((c) => ({ id: c.id, name: c.name, type: c.type })),
      validChildTypes: VALID_CHILDREN[group.type] || [],
    },
  });
});

/** GET /api/v1/governance-groups/:id/recommendations */
router.get('/:id/recommendations', async (req: Request, res: Response) => {
  const group = await governanceGroupsRepo.get(String(req.params.id));
  if (!group) { res.status(404).json({ success: false, error: 'Group not found' }); return; }
  if (!assertOrgAccess(req, res, group.orgId, 'Group not found')) return;

  const validChildTypes = VALID_CHILDREN[group.type] || [];
  const orgGroups = (await governanceGroupsRepo.list()).filter((g) => g.orgId === group.orgId);
  const allOrgGroupNames = new Set(orgGroups.map((g) => g.name.toLowerCase()));

  interface Recommendation {
    name: string;
    type: string;
    typeLabel: string;
    description: string;
    charter: string;
    reason: string;
    exists: boolean;
  }

  const recommendations: Recommendation[] = [];

  if (group.type === 'COMMITTEE' || group.type === 'OFFICE') {
    // Recommend a stewardship team for each data domain
    const orgDomains = (await dataDomainsRepo().list()).filter((d) => d.orgId === group.orgId);
    for (const domain of orgDomains) {
      const teamName = `${domain.name} Stewardship Team`;
      recommendations.push({
        name: teamName,
        type: 'STEWARDSHIP_TEAM',
        typeLabel: GROUP_TYPE_LABELS['STEWARDSHIP_TEAM'],
        description: `Data stewardship team responsible for the ${domain.name} domain. Ensures data quality, standards compliance, and issue resolution.`,
        charter: `Define ${domain.name.toLowerCase()} data standards, resolve data quality issues, manage master data definitions.`,
        reason: `Recommended for the "${domain.name}" data domain`,
        exists: allOrgGroupNames.has(teamName.toLowerCase()),
      });
    }

    // Recommend a working group for data quality
    if (validChildTypes.includes('WORKING_GROUP')) {
      const dqName = 'Data Quality Improvement';
      recommendations.push({
        name: dqName,
        type: 'WORKING_GROUP',
        typeLabel: GROUP_TYPE_LABELS['WORKING_GROUP'],
        description: 'Initiative-focused group driving data quality improvements across the organization.',
        charter: 'Identify data quality issues, implement fixes, measure improvement, report progress.',
        reason: 'DAMA best practice — temporary group for quality initiatives',
        exists: allOrgGroupNames.has(dqName.toLowerCase()),
      });
    }
  }

  if (group.type === 'COUNCIL') {
    // Recommend Office and Committee if not present
    if (!orgGroups.some((c) => c.type === 'OFFICE')) {
      recommendations.push({
        name: 'Data Governance Office',
        type: 'OFFICE',
        typeLabel: GROUP_TYPE_LABELS['OFFICE'],
        description: 'Day-to-day program management and coordination of governance activities.',
        charter: 'Coordinate governance initiatives, track compliance, manage governance tools, support stewardship teams.',
        reason: 'DAMA best practice — manages the governance program day-to-day',
        exists: false,
      });
    }
    if (!orgGroups.some((c) => c.type === 'COMMITTEE')) {
      recommendations.push({
        name: 'Enterprise Data Committee',
        type: 'COMMITTEE',
        typeLabel: GROUP_TYPE_LABELS['COMMITTEE'],
        description: 'Cross-functional working group that implements governance standards and practices.',
        charter: 'Develop data standards, review data issues, coordinate across domains, report to the Council.',
        reason: 'DAMA best practice — implements standards across domains',
        exists: false,
      });
    }
  }

  res.json({ success: true, data: recommendations.filter((r) => !r.exists) });
});

/** POST /api/v1/governance-groups */
router.post('/', async (req: Request, res: Response) => {
  const parsed = createGroupBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const { name, type, description, charter, status, orgId, parentId } = parsed.data;
  const allGroups = await governanceGroupsRepo.list();

  // Check parent-child relationship (soft warning, not a block)
  let warning: string | null = null;
  if (parentId) {
    const parent = allGroups.find((g) => g.id === parentId);
    if (!parent) { res.status(400).json({ success: false, error: 'Parent group not found' }); return; }
    const recommended = VALID_CHILDREN[parent.type] || [];
    if (!recommended.includes(type)) {
      warning = `Governance best practices suggest ${GROUP_TYPE_LABELS[type] || type} typically reports to ${recommended.map((t: string) => GROUP_TYPE_LABELS[t] || t).join(' or ') || 'a higher-level body'}, not ${GROUP_TYPE_LABELS[parent.type] || parent.type}. Saved anyway.`;
    }
  } else if (type !== 'COUNCIL' && type !== 'OFFICE' && !parentId) {
    warning = `Governance best practices suggest ${GROUP_TYPE_LABELS[type] || type} be placed under a higher-level governance body.`;
  }

  // Check if no top-level council exists
  if (type !== 'COUNCIL' && !parentId) {
    const hasCouncil = allGroups.some((g) => g.type === 'COUNCIL');
    if (!hasCouncil && !warning) {
      warning = 'Governance best practices suggest establishing a Data Governance Council as the top-level governing body first.';
    }
  }

  const now = new Date().toISOString();
  const group: StoredGovernanceGroup = {
    id: uuid(), orgId: orgId || DEV_ORG_ID, parentId: parentId || null,
    name, type, description: description || '', charter: charter || '',
    status: status || 'ACTIVE', members: [], createdAt: now, updatedAt: now,
  };
  await governanceGroupsRepo.create(group);
  auditService.log(group.orgId, null, 'GovernanceGroup', group.id, 'CREATE', null, group);
  logger.info({ groupId: group.id, name: group.name, type: group.type, parentId }, 'Created governance group');
  res.status(201).json({ success: true, data: group, warning, validChildTypes: VALID_CHILDREN[group.type] || [] });
});

/** PUT /api/v1/governance-groups/:id */
router.put('/:id', async (req: Request, res: Response) => {
  const group = await governanceGroupsRepo.get(String(req.params.id));
  if (!group) { res.status(404).json({ success: false, error: 'Governance group not found' }); return; }

  const parsed = updateGroupBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const before = { ...group };
  const { name, type, description, charter, status, parentId } = parsed.data;
  if (name !== undefined) group.name = name;
  if (type !== undefined) group.type = type;
  if (description !== undefined) group.description = description;
  if (charter !== undefined) group.charter = charter;
  if (status !== undefined) group.status = status;
  if (parentId !== undefined) group.parentId = parentId;
  group.updatedAt = new Date().toISOString();
  await governanceGroupsRepo.update(group.id, group);
  auditService.log(group.orgId, null, 'GovernanceGroup', group.id, 'UPDATE', before, group);
  res.json({ success: true, data: group });
});

/** DELETE /api/v1/governance-groups/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  const removed = await governanceGroupsRepo.get(String(req.params.id));
  if (!removed) { res.status(404).json({ success: false, error: 'Governance group not found' }); return; }
  // Re-parent children onto the removed group's parent.
  const children = (await governanceGroupsRepo.list()).filter((g) => g.parentId === removed.id);
  for (const child of children) {
    await governanceGroupsRepo.update(child.id, { parentId: removed.parentId });
  }
  auditService.log(removed.orgId, null, 'GovernanceGroup', removed.id, 'DELETE', removed, null);
  await governanceGroupsRepo.delete(removed.id);
  res.status(204).send();
});

/** POST /api/v1/governance-groups/:id/members */
router.post('/:id/members', async (req: Request, res: Response) => {
  const group = await governanceGroupsRepo.get(String(req.params.id));
  if (!group) { res.status(404).json({ success: false, error: 'Governance group not found' }); return; }

  const parsed = addMemberBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const { personId, agentId, groupRole } = parsed.data;

  if (!personId && !agentId) { res.status(400).json({ success: false, error: 'Either personId or agentId is required' }); return; }
  if (personId && agentId) { res.status(400).json({ success: false, error: 'Provide either personId or agentId, not both' }); return; }

  // Accountability rule: agents can only sit in the advisor slot. The
  // voting / chairing / signing roles stay with humans (see
  // AGENT_ALLOWED_GROUP_ROLES). Reject up front so the UI can surface
  // the error rather than the row landing in a state a regulator
  // would later flag.
  if (agentId && !AGENT_ALLOWED_GROUP_ROLES.has(groupRole)) {
    res.status(400).json({
      success: false,
      error: `Agents may only be added as ADVISOR. The ${groupRole} role requires a person for accountability.`,
    });
    return;
  }

  if (personId) {
    if (group.members.find((m) => m.personId === personId)) {
      res.status(409).json({ success: false, error: 'This person is already a member' });
      return;
    }
    const person = await peopleRepo().get(personId);
    if (!person) { res.status(400).json({ success: false, error: 'Person not found' }); return; }
    const now = new Date().toISOString();
    group.members.push({ personId, agentId: null, groupRole, since: now });
    group.updatedAt = now;
    await governanceGroupsRepo.update(group.id, group);
    auditService.log(group.orgId, null, 'GovernanceGroup', group.id, 'ADD_MEMBER', null, { personId, groupRole });
    res.status(201).json({ success: true, data: { personId, agentId: null, groupRole, personName: person.name, agentName: null, since: now } });
    return;
  }

  // Agent membership.
  if (group.members.find((m) => m.agentId === agentId)) {
    res.status(409).json({ success: false, error: 'This agent is already a member' });
    return;
  }
  const agent = await agentsRepo().get(String(agentId));
  if (!agent) { res.status(400).json({ success: false, error: 'Agent not found' }); return; }
  const now = new Date().toISOString();
  group.members.push({ personId: null, agentId: agentId!, groupRole, since: now });
  group.updatedAt = now;
  await governanceGroupsRepo.update(group.id, group);
  auditService.log(group.orgId, null, 'GovernanceGroup', group.id, 'ADD_MEMBER', null, { agentId, groupRole });
  res.status(201).json({ success: true, data: { personId: null, agentId, groupRole, personName: null, agentName: agent.name, since: now } });
});

/** DELETE /api/v1/governance-groups/:id/members/:memberId — :memberId
 *  resolves to either a personId or an agentId on the membership row.
 *  We look it up across both so the frontend can use the same delete
 *  call for either holder kind. */
router.delete('/:id/members/:memberId', async (req: Request, res: Response) => {
  const group = await governanceGroupsRepo.get(String(req.params.id));
  if (!group) { res.status(404).json({ success: false, error: 'Governance group not found' }); return; }
  const { memberId } = req.params;
  const idx = group.members.findIndex((m) => m.personId === memberId || m.agentId === memberId);
  if (idx === -1) { res.status(404).json({ success: false, error: 'Member not found' }); return; }
  group.members.splice(idx, 1);
  group.updatedAt = new Date().toISOString();
  await governanceGroupsRepo.update(group.id, group);
  res.status(204).send();
});

export default router;
