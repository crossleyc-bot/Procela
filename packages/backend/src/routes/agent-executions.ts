import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { loadStore, saveStore, registerStore } from '../lib/persistence';
import { config } from '../config';
import logger from '../lib/logger';
import { aiService, GovernanceActivityRun } from '../services/ai.service';
import { enforceAiBudget } from '../middleware/ai-budget';
import { agents } from './agents';
import { processNodes, isGovernanceNode } from './process-catalog';
import { mappings } from './mappings';
import { dataAssets } from './data-assets';
import { governancePolicies, generateCode as generateDocCode, StoredGovernancePolicy, VALID_DOCUMENT_TYPES } from './governance-policies';
import { attachments } from './attachments';
import { systems } from './systems';
import { skills } from './skills';
import { organizations } from './organizations';
import { damaRoles } from './dama-roles';
import { people } from './people';
import { auditService } from '../services/audit.service';
import { createNotification } from './notifications';
import { getAgentExecutionsRepository } from '../db/agent-executions.repo';
import { getDataAssetsRepository } from '../db/data-assets.repo';
import { getGovernancePoliciesRepository } from '../db/governance-policies.repo';
import { getAttachmentsRepository } from '../db/attachments.repo';
import { getPeopleRepository } from '../db/people.repo';
import { getDamaRolesRepository } from '../db/dama-roles.repo';
import { getAgentsRepository } from '../db/agents.repo';
import { getProcessNodesRepository } from '../db/process-nodes.repo';
import { getMappingsRepository } from '../db/mappings.repo';
import { getSystemsRepository } from '../db/systems.repo';
import { getSkillsRepository } from '../db/skills.repo';
import { getOrganizationsRepository } from '../db/organizations.repo';
import { hasDatabase } from '../db/prisma';

// ──────────────────────────────────────────────────────────────────────────
// Agent Executions — an AI agent actually PERFORMING a governance activity.
// The POST endpoint assembles the activity's business context, runs it
// through the agent's operating instructions via a real Claude call, and
// stores the produced draft for human review. Scoped to ACTIVITY nodes inside
// the GOVERNANCE domain (the Data Governance Management value stream).
// ──────────────────────────────────────────────────────────────────────────

const EXECUTION_STATUSES = ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED'] as const;
type ExecutionStatus = typeof EXECUTION_STATUSES[number];

const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
type ReviewStatus = typeof REVIEW_STATUSES[number];

export interface StoredAgentExecution {
  id: string;
  orgId: string;
  agentId: string;
  agentName: string;
  activityId: string;        // process node id
  activityName: string;
  roleType: string;          // which DAMA role the agent acted as
  status: ExecutionStatus;
  startedAt: string;
  completedAt: string | null;
  output: string;            // the agent's draft deliverable (Markdown)
  error: string | null;
  durationMs: number | null;
  // Human review of the AI-produced draft. AI output is never authoritative
  // until a person approves it (per the platform's AI behaviour guidelines).
  reviewStatus: ReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  // Back-link to the Governance Document this draft was promoted to, set
  // by /promote. Null/undefined means the approved draft hasn't yet been
  // turned into an authoritative output — the activity's Inputs / Outputs
  // panel surfaces it as an unpromoted draft chip in that case.
  promotedDocumentId?: string | null;
  createdAt: string;
}

// Pre-built id→row maps for describeMapping, listed once per run.
interface DescribeMappingMaps {
  dataAssets: Map<string, (typeof dataAssets)[number]>;
  policies: Map<string, (typeof governancePolicies)[number]>;
  attachments: Map<string, (typeof attachments)[number]>;
}

// Resolve one mapping row to a human-readable line for the prompt.
function describeMapping(m: { dataAssetId?: string; policyId?: string; attachmentId?: string; criticality?: string }, maps: DescribeMappingMaps): string {
  let label = 'Linked item (no longer exists)';
  if (m.dataAssetId) {
    const a = maps.dataAssets.get(m.dataAssetId);
    label = a ? `Data asset "${a.name}" (${a.governanceTier} tier)` : 'Data asset (deleted)';
  } else if (m.policyId) {
    const p = maps.policies.get(m.policyId);
    label = p ? `Governance document "${p.code} ${p.name}" (${p.documentType})` : 'Governance document (deleted)';
  } else if (m.attachmentId) {
    const at = maps.attachments.get(m.attachmentId);
    label = at ? `Reference "${at.name}"${at.url ? ` (${at.url})` : ''}` : 'Attachment (deleted)';
  }
  return m.criticality ? `${label} [${m.criticality}]` : label;
}

export const agentExecutions: StoredAgentExecution[] = loadStore<StoredAgentExecution>('agentExecutions');
registerStore('agentExecutions', agentExecutions);

const agentExecutionsRepo = getAgentExecutionsRepository(agentExecutions);

// Foreign stores — lazy repos (cycle-safe). Each sibling module's in-memory
// array is empty in Postgres mode, so reads must go through the repo, which
// is the real source of truth.
let _dataAssetsRepo: ReturnType<typeof getDataAssetsRepository> | null = null;
const dataAssetsRepo = () => (_dataAssetsRepo ??= getDataAssetsRepository(dataAssets));
let _governancePoliciesRepo: ReturnType<typeof getGovernancePoliciesRepository> | null = null;
const governancePoliciesRepo = () => (_governancePoliciesRepo ??= getGovernancePoliciesRepository(governancePolicies));
let _attachmentsRepo: ReturnType<typeof getAttachmentsRepository> | null = null;
const attachmentsRepo = () => (_attachmentsRepo ??= getAttachmentsRepository(attachments));
let _peopleRepo: ReturnType<typeof getPeopleRepository> | null = null;
const peopleRepo = () => (_peopleRepo ??= getPeopleRepository(people));
let _damaRolesRepo: ReturnType<typeof getDamaRolesRepository> | null = null;
const damaRolesRepo = () => (_damaRolesRepo ??= getDamaRolesRepository(damaRoles));
let _agentsRepo: ReturnType<typeof getAgentsRepository> | null = null;
const agentsRepo = () => (_agentsRepo ??= getAgentsRepository(agents));
let _processNodesRepo: ReturnType<typeof getProcessNodesRepository> | null = null;
const processNodesRepo = () => (_processNodesRepo ??= getProcessNodesRepository(processNodes));
let _mappingsRepo: ReturnType<typeof getMappingsRepository> | null = null;
const mappingsRepo = () => (_mappingsRepo ??= getMappingsRepository(mappings));
let _systemsRepo: ReturnType<typeof getSystemsRepository> | null = null;
const systemsRepo = () => (_systemsRepo ??= getSystemsRepository(systems));
let _skillsRepo: ReturnType<typeof getSkillsRepository> | null = null;
const skillsRepo = () => (_skillsRepo ??= getSkillsRepository(skills));
let _organizationsRepo: ReturnType<typeof getOrganizationsRepository> | null = null;
const organizationsRepo = () => (_organizationsRepo ??= getOrganizationsRepository(organizations));

// One-time normalisation: existing records pre-date the promotedDocumentId
// field. Treat undefined as null so the rest of the code can rely on the
// field being present. JSON mode only — Postgres rows always carry the
// column (create() sets it, and the schema defaults it), and reading the
// boot-time array in Postgres mode would just be a stale-store read.
if (!hasDatabase()) {
  let backfilled = 0;
  for (const e of agentExecutions) {
    if (!('promotedDocumentId' in e)) { (e as StoredAgentExecution).promotedDocumentId = null; backfilled++; }
  }
  if (backfilled > 0) {
    saveStore('agentExecutions', agentExecutions);
    logger.info({ backfilled }, 'Backfilled promotedDocumentId on existing agent executions');
  }
}

const router = Router();

/** GET /api/v1/agent-executions — list executions with optional filters */
router.get('/', async (req: Request, res: Response) => {
  const { orgId, agentId, activityId } = req.query;
  let filtered = await agentExecutionsRepo.list(
    typeof orgId === 'string' && orgId ? { orgId } : undefined,
  );

  if (agentId) {
    filtered = filtered.filter((e) => e.agentId === agentId);
  }
  if (activityId) {
    filtered = filtered.filter((e) => e.activityId === activityId);
  }

  // Most recent first
  filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  res.json({ success: true, data: filtered });
});

/** GET /api/v1/agent-executions/:id — get single execution */
router.get('/:id', async (req: Request, res: Response) => {
  const exec = await agentExecutionsRepo.get(String(req.params.id));
  if (!exec) { res.status(404).json({ success: false, error: 'Execution not found' }); return; }
  res.json({ success: true, data: exec });
});

/**
 * Resolve "the person to notify" for an activity completion. Prefer the
 * explicitly-set responsiblePersonId on the node; fall back to the first
 * person holding the role the agent acted as. Returns null if no human
 * is reachable (in which case the notification is skipped — we don't
 * notify the agent itself).
 */
async function resolveResponsiblePerson(node: { responsiblePersonId?: string | null }, orgId: string, roleType: string | undefined): Promise<string | null> {
  if (node.responsiblePersonId) {
    const allPeople = await peopleRepo().list();
    if (allPeople.find((p) => p.id === node.responsiblePersonId)) {
      return node.responsiblePersonId;
    }
  }
  if (roleType) {
    const allRoles = await damaRolesRepo().list();
    const r = allRoles.find((d) => d.scopeId === orgId && d.roleType === roleType && d.personId);
    if (r?.personId) return r.personId;
  }
  return null;
}

/**
 * Shared run helper used by both the ad-hoc POST endpoint and the
 * schedule ticker. Returns the persisted StoredAgentExecution. On
 * validation errors it throws an Error carrying a `status` field used
 * by the HTTP wrapper to translate to a 4xx.
 *
 * Side effects: writes the execution row, emits two audit-log entries
 * (one on start, one on finish), and creates a notification for the
 * activity's responsible person on completion (success or failure).
 */
export async function runAgentExecution(params: {
  orgId: string;
  agentId: string;
  activityId: string;
  roleType?: string;
  /** Where the run was kicked off from — affects audit + notification copy. */
  triggeredBy?: 'user' | 'schedule';
  /** When triggered by a schedule, the schedule id for cross-linking. */
  scheduleId?: string | null;
  /** Authenticated user that initiated the run, when known. */
  userId?: string | null;
}): Promise<StoredAgentExecution> {
  const { orgId, agentId, activityId, roleType, triggeredBy = 'user', scheduleId = null, userId = null } = params;
  // AI agents are an AI integration feature — refuse to run when AI is off,
  // covering both the ad-hoc route and the scheduler which call this helper.
  if (!config.aiFeaturesEnabled) {
    throw Object.assign(new Error('AI features are turned off for this deployment.'), { status: 403, code: 'AI_DISABLED' });
  }
  if (!orgId) throw Object.assign(new Error('orgId is required'), { status: 400 });
  if (!agentId) throw Object.assign(new Error('agentId is required'), { status: 400 });
  if (!activityId) throw Object.assign(new Error('activityId is required'), { status: 400 });

  // List every sibling store once; the in-memory arrays are empty in
  // Postgres mode, so all lookups go through the repos.
  const [allAgents, allNodes, allMappings, allSystems, allSkills, allOrgs, allDataAssets, allPolicies, allAttachments] = await Promise.all([
    agentsRepo().list(),
    processNodesRepo().list(),
    mappingsRepo().list(),
    systemsRepo().list(),
    skillsRepo().list(),
    organizationsRepo().list(),
    dataAssetsRepo().list(),
    governancePoliciesRepo().list(),
    attachmentsRepo().list(),
  ]);

  const agent = allAgents.find((a) => a.id === agentId);
  if (!agent) throw Object.assign(new Error('Agent not found'), { status: 404 });

  const node = allNodes.find((n) => n.id === activityId);
  if (!node) throw Object.assign(new Error('Activity not found'), { status: 404 });
  if (node.level !== 'ACTIVITY') throw Object.assign(new Error('Agents can only perform Activity-level work.'), { status: 400 });
  if (!isGovernanceNode(node)) throw Object.assign(new Error('Agents can only perform activities in the Data Governance Management value stream.'), { status: 400 });

  // Assemble business context from linked items.
  const describeMaps: DescribeMappingMaps = {
    dataAssets: new Map(allDataAssets.map((a) => [a.id, a])),
    policies: new Map(allPolicies.map((p) => [p.id, p])),
    attachments: new Map(allAttachments.map((at) => [at.id, at])),
  };
  const systemsById = new Map(allSystems.map((s) => [s.id, s]));
  const skillsById = new Map(allSkills.map((s) => [s.id, s]));
  const nodeMappings = allMappings.filter((m) => m.processStepId === node.id);
  const inputs = nodeMappings.filter((m) => m.linkType !== 'produces').map((m) => describeMapping(m, describeMaps));
  const outputs = nodeMappings.filter((m) => m.linkType === 'produces').map((m) => describeMapping(m, describeMaps));
  const systemNames = (node.systemIds || [])
    .map((id) => systemsById.get(id)?.name)
    .filter((n): n is string => !!n);
  const requiredSkills = (node.requiredSkillIds || [])
    .map((id) => skillsById.get(id)?.name)
    .filter((n): n is string => !!n);
  const orgName = allOrgs.find((o) => o.id === orgId)?.name;

  const run: GovernanceActivityRun = {
    agent: { name: agent.name, instructions: agent.instructions || '', description: agent.description, agentType: agent.agentType },
    activity: { name: node.name, description: node.description, inputsOutputs: node.inputsOutputs, responsibleRole: node.responsibleRole },
    inputs, outputs, systems: systemNames, requiredSkills, orgName,
  };

  const startedAt = new Date();
  const execution: StoredAgentExecution = {
    id: uuid(),
    orgId,
    agentId,
    agentName: agent.name,
    activityId: node.id,
    activityName: node.name,
    roleType: roleType || '',
    status: 'RUNNING',
    startedAt: startedAt.toISOString(),
    completedAt: null,
    output: '',
    error: null,
    durationMs: null,
    reviewStatus: 'PENDING',
    reviewedBy: null,
    reviewedAt: null,
    promotedDocumentId: null,
    createdAt: startedAt.toISOString(),
  };

  // Audit the start of the run so it's traceable even if the AI call
  // hangs or the process dies before it returns.
  auditService.log(orgId, userId, 'AgentExecution', execution.id, 'AGENT_RUN_STARTED', null, {
    agentId, agentName: agent.name, activityId: node.id, activityName: node.name,
    roleType: roleType || null, triggeredBy, scheduleId,
  });

  try {
    const output = await aiService.performGovernanceActivity(run);
    const completedAt = new Date();
    execution.status = 'SUCCESS';
    execution.output = output;
    execution.completedAt = completedAt.toISOString();
    execution.durationMs = completedAt.getTime() - startedAt.getTime();
    logger.info({ executionId: execution.id, agentId, activityId: node.id, triggeredBy }, 'Agent performed governance activity');
  } catch (err) {
    const completedAt = new Date();
    execution.status = 'FAILED';
    execution.error = err instanceof Error ? err.message : 'Agent run failed';
    execution.completedAt = completedAt.toISOString();
    execution.durationMs = completedAt.getTime() - startedAt.getTime();
    logger.error({ executionId: execution.id, agentId, activityId: node.id, err, triggeredBy }, 'Agent execution failed');
  }

  await agentExecutionsRepo.create(execution);

  // Audit the finish with the outcome.
  auditService.log(orgId, userId, 'AgentExecution', execution.id, `AGENT_RUN_${execution.status}`, null, {
    durationMs: execution.durationMs, triggeredBy, scheduleId,
    ...(execution.status === 'FAILED' ? { error: execution.error } : {}),
  });

  // Notify the responsible person — they need to know an AI-produced
  // draft is waiting for them to review (or that a scheduled run failed).
  // Deep-link the notification to the specific activity so a click on
  // the bell row scrolls them straight to it instead of dumping them on
  // the catalog root.
  const recipientId = await resolveResponsiblePerson(node, orgId, roleType);
  if (recipientId) {
    const triggerCopy = triggeredBy === 'schedule' ? 'A scheduled agent run' : 'An agent run';
    const activityLink = `/processes?node=${encodeURIComponent(node.id)}`;
    if (execution.status === 'SUCCESS') {
      createNotification({
        orgId, userId: recipientId, type: 'ACTION',
        title: `Agent draft ready for review: ${node.name}`,
        message: `${triggerCopy} by ${agent.name} for "${node.name}" finished. Open the activity to review the draft and approve or promote it.`,
        link: activityLink,
      });
    } else {
      createNotification({
        orgId, userId: recipientId, type: 'WARNING',
        title: `Agent run failed: ${node.name}`,
        message: `${triggerCopy} by ${agent.name} for "${node.name}" failed: ${execution.error || 'unknown error'}.`,
        link: activityLink,
      });
    }
  } else {
    logger.info({ activityId: node.id, roleType }, 'No responsible person to notify for completed agent run');
  }

  return execution;
}

/** POST /api/v1/agent-executions — ad-hoc, user-triggered run. */
router.post('/', enforceAiBudget, async (req: Request, res: Response) => {
  try {
    const { orgId, agentId, roleType, activityId } = req.body;
    const userId = (req as Request & { user?: { id?: string } }).user?.id || null;
    const execution = await runAgentExecution({ orgId, agentId, activityId, roleType, triggeredBy: 'user', userId });
    res.status(201).json({ success: true, data: execution });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    res.status(e.status || 500).json({ success: false, error: e.message || 'Agent run failed' });
  }
});

/** PATCH /api/v1/agent-executions/:id/review — approve or reject a draft. */
router.patch('/:id/review', async (req: Request, res: Response) => {
  const exec = await agentExecutionsRepo.get(String(req.params.id));
  if (!exec) { res.status(404).json({ success: false, error: 'Execution not found' }); return; }
  const { reviewStatus, reviewedBy } = req.body;
  if (!REVIEW_STATUSES.includes(reviewStatus)) {
    res.status(400).json({ success: false, error: `reviewStatus must be one of ${REVIEW_STATUSES.join(', ')}` });
    return;
  }
  const before = { reviewStatus: exec.reviewStatus, reviewedBy: exec.reviewedBy };
  exec.reviewStatus = reviewStatus;
  exec.reviewedBy = reviewStatus === 'PENDING' ? null : (typeof reviewedBy === 'string' && reviewedBy ? reviewedBy : 'Unknown');
  exec.reviewedAt = reviewStatus === 'PENDING' ? null : new Date().toISOString();
  await agentExecutionsRepo.update(exec.id, exec);
  const userId = (req as Request & { user?: { id?: string } }).user?.id || null;
  auditService.log(exec.orgId, userId, 'AgentExecution', exec.id, `AGENT_REVIEW_${reviewStatus}`, before, {
    reviewStatus, reviewedBy: exec.reviewedBy,
  });
  res.json({ success: true, data: exec });
});

/** POST /api/v1/agent-executions/:id/promote — turn the approved draft into
 * a real Governance Document and attach it as an OUTPUT mapping of the
 * activity in one atomic step. Stamps the execution as APPROVED and
 * records the back-link via promotedDocumentId so the UI can show the
 * chip as "promoted" instead of "needs promotion".
 *
 * Body: { name, documentType?, category?, description?, reviewedBy? }
 *   - name (required) — the document's display name; defaults to the
 *     activity name on the frontend if the user doesn't edit it.
 *   - documentType — POLICY by default; CHARTER / FRAMEWORK / STANDARD also valid.
 *   - category — defaults to GOVERNANCE.
 *   - reviewedBy — stamped on the execution if provided.
 */
router.post('/:id/promote', async (req: Request, res: Response) => {
  const exec = await agentExecutionsRepo.get(String(req.params.id));
  if (!exec) { res.status(404).json({ success: false, error: 'Execution not found' }); return; }
  if (exec.status !== 'SUCCESS') {
    res.status(400).json({ success: false, error: `Cannot promote a draft from a ${exec.status} execution — only SUCCESS drafts can be promoted.` });
    return;
  }
  if (exec.reviewStatus === 'REJECTED') {
    res.status(400).json({ success: false, error: 'This draft was rejected — reset the review before promoting.' });
    return;
  }
  if (exec.promotedDocumentId) {
    res.status(400).json({ success: false, error: 'This draft has already been promoted to a Governance Document.' });
    return;
  }

  const { name, documentType, category, description, reviewedBy } = req.body || {};
  const docName = (typeof name === 'string' && name.trim()) ? name.trim() : exec.activityName;
  if (!docName) { res.status(400).json({ success: false, error: 'Name is required.' }); return; }
  const finalDocumentType: StoredGovernancePolicy['documentType'] = VALID_DOCUMENT_TYPES.includes(documentType) ? documentType : 'POLICY';

  // Capture the source activity's status at promotion time so any later
  // reviewer of the document can see whether the underlying activity was
  // still in design when the draft was produced.
  const activityNode = await processNodesRepo().get(exec.activityId);
  const activityStatusAtPromote = activityNode?.status || 'unknown';
  const provenanceLine = `Promoted from agent draft for "${exec.activityName}" by ${exec.agentName}. Source activity status at promotion: ${activityStatusAtPromote}.`;

  const now = new Date().toISOString();

  // 1) Create the Governance Document with the execution's Markdown as content.
  const doc: StoredGovernancePolicy = {
    id: uuid(),
    orgId: exec.orgId,
    code: await generateDocCode(finalDocumentType),
    name: docName,
    description: (typeof description === 'string' && description.trim()) ? `${description.trim()}\n\n${provenanceLine}` : provenanceLine,
    documentType: finalDocumentType,
    status: 'DRAFT',
    ownerAssignmentId: null,
    category: (typeof category === 'string' && category ? category : 'GOVERNANCE') as StoredGovernancePolicy['category'],
    reviewFrequency: 'ANNUAL',
    nextReviewDate: null,
    effectiveDate: null,
    content: exec.output || '',
    createdAt: now,
    updatedAt: now,
  };
  await governancePoliciesRepo().create(doc);

  // 2) Link it to the activity as an OUTPUT mapping (linkType 'produces').
  const mapping = {
    id: uuid(),
    orgId: exec.orgId,
    processStepId: exec.activityId,
    policyId: doc.id,
    linkType: 'produces' as const,
    notes: `Promoted from agent draft (execution ${exec.id}) by ${exec.agentName}.`,
    aiSuggested: true,
    userOverridden: false,
    createdBy: (typeof reviewedBy === 'string' && reviewedBy) || exec.reviewedBy || 'system',
    createdAt: now,
    updatedAt: now,
  };
  await mappingsRepo().create(mapping as unknown as typeof mappings[number]);

  // 3) Stamp the execution as APPROVED + record the back-link.
  exec.reviewStatus = 'APPROVED';
  exec.reviewedBy = (typeof reviewedBy === 'string' && reviewedBy) || exec.reviewedBy || 'Unknown';
  exec.reviewedAt = now;
  exec.promotedDocumentId = doc.id;
  await agentExecutionsRepo.update(exec.id, exec);

  logger.info({ executionId: exec.id, documentId: doc.id, documentCode: doc.code, activityId: exec.activityId }, 'Promoted agent draft to governance document');
  const userIdHeader = (req as Request & { user?: { id?: string } }).user?.id || null;
  auditService.log(exec.orgId, userIdHeader, 'AgentExecution', exec.id, 'AGENT_DRAFT_PROMOTED', null, {
    documentId: doc.id, documentCode: doc.code, documentName: doc.name, documentType: doc.documentType,
    activityId: exec.activityId, agentId: exec.agentId,
  });
  res.status(201).json({ success: true, data: { execution: exec, document: doc, mapping } });
});

/** DELETE /api/v1/agent-executions/all — delete all executions */
router.delete('/all', async (_req: Request, res: Response) => {
  // Repository-backed so it clears Postgres in DB mode (and the JSON
  // array in file mode). No bulk-delete on the shared Repository
  // interface, so list-then-delete each — this endpoint is a rare admin
  // "clear all" action, not a hot path.
  const all = await agentExecutionsRepo.list();
  for (const e of all) {
    await agentExecutionsRepo.delete(e.id);
  }
  logger.info({ count: all.length }, 'Deleted all agent executions');
  res.json({ success: true, deleted: all.length });
});

export default router;
