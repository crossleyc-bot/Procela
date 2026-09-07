import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { auditService } from '../services/audit.service';
import { loadStore, saveStore, registerStore } from '../lib/persistence';
import { filterByOrgScope } from '../lib/org-scope';
import { people } from './people';
import { dataDomains } from './data-domains';
import { dataAssets } from './data-assets';
import { createNotification } from './notifications';
import logger from '../lib/logger';
import { getGovernanceIssuesRepository } from '../db/governance-issues.repo';
import { getPeopleRepository } from '../db/people.repo';
import { getDataDomainsRepository } from '../db/data-domains.repo';
import { getDataAssetsRepository } from '../db/data-assets.repo';

const ISSUE_TYPES = [
  'METADATA',
  'DATA_QUALITY',
  'CLASSIFICATION',
  'OWNERSHIP',
  'POLICY',
  'ACCESS',
  'LINEAGE',
  'COMPLIANCE',
  'WORKFLOW',
  // Auto-raised by the connector scan ingest when a discovered asset's column
  // set changes between scans (a column added / removed / retyped).
  'SCHEMA_DRIFT',
] as const;

const ISSUE_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

const ISSUE_STATUSES = [
  'OPEN',
  'INVESTIGATING',
  'IN_PROGRESS',
  'RESOLVED',
  'CLOSED',
  'WONT_FIX',
] as const;

const TERMINAL_STATUSES = new Set(['RESOLVED', 'CLOSED', 'WONT_FIX']);

// ── Auto-issue sync (called by other subsystems on state change) ──

/**
 * Rule → issue sync. Called by the DQ engine after a rule run so a
 * governance issue tracks the failure through to resolution —
 * closing itself when the rule recovers instead of leaving orphaned
 * tickets.
 *
 * Behaviour:
 *   - Rule now FAILING or WARNING → ensure an OPEN issue exists
 *     linked to the rule. Idempotent: a second run doesn't
 *     duplicate. Assignee is the domain steward → domain owner →
 *     asset owner, in that order. A notification is fired on first
 *     creation.
 *   - Rule now PASSING → close any OPEN linked issue with a
 *     "rule recovered" resolution note. Notifies the assignee.
 *   - NOT_MEASURED / no ruleType / no dataAssetId → no-op.
 *
 * Kept as a plain function (not a router) so the DQ scheduler can
 * import it directly without pulling the whole router graph.
 */
export async function syncDataQualityIssueForRule(rule: {
  id: string;
  orgId: string;
  dataAssetId?: string;
  name?: string;
  currentScore?: number;
  threshold?: number;
  status?: string;
  dimension?: string;
}): Promise<void> {
  if (!rule.dataAssetId) return;
  const status = rule.status;
  const asset = await dataAssetsRepo().get(rule.dataAssetId);
  if (!asset) return;

  // Find an existing open issue linked to this rule (Postgres or JSON).
  const allIssues = await governanceIssuesRepo.list();
  const existing = allIssues.find(
    (i) => i.linkedRuleId === rule.id && !TERMINAL_STATUSES.has(i.status),
  );

  const now = new Date().toISOString();

  if (status === 'PASSING') {
    if (!existing) return;
    existing.status = 'RESOLVED';
    existing.resolutionSummary = `DQ rule recovered — score ${rule.currentScore ?? '?'} meets threshold ${rule.threshold ?? '?'}.`;
    existing.closedAt = now;
    existing.updatedAt = now;
    await governanceIssuesRepo.update(existing.id, {
      status: existing.status,
      resolutionSummary: existing.resolutionSummary,
      closedAt: existing.closedAt,
      updatedAt: existing.updatedAt,
    });
    auditService.log(rule.orgId, null, 'GovernanceIssue', existing.id, 'AUTO_RESOLVED', null, { linkedRuleId: rule.id });
    if (existing.assignedTo) {
      createNotification({
        orgId: rule.orgId,
        userId: existing.assignedTo,
        type: 'INFO',
        title: 'DQ issue auto-resolved',
        message: `${rule.name || 'A DQ rule'} on ${asset.name} recovered.`,
        link: `/governance-issues?id=${existing.id}`,
      });
    }
    return;
  }

  if (status !== 'FAILING' && status !== 'WARNING') return;

  if (existing) {
    // Bump the description with the latest score so the issue detail
    // shows current state without duplicating.
    existing.description = `${rule.name || 'DQ rule'} is ${status.toLowerCase()} on ${asset.name} — score ${rule.currentScore ?? '?'} against threshold ${rule.threshold ?? '?'}.`;
    existing.severity = status === 'FAILING' ? 'HIGH' : 'MEDIUM';
    existing.updatedAt = now;
    await governanceIssuesRepo.update(existing.id, {
      description: existing.description,
      severity: existing.severity,
      updatedAt: existing.updatedAt,
    });
    return;
  }

  // Pick the assignee. Domain steward > domain owner > asset owner.
  // (Domain-level accountability matches DAMA: steward executes,
  // owner is accountable; asset owner is the operational fallback.)
  const allDomains = await dataDomainsRepo().list();
  const domain = allDomains.find((d) => d.dataAssetIds?.includes(asset.id));
  let assignedTo: string | null = null;
  if (domain?.stewardIds && domain.stewardIds.length > 0) assignedTo = domain.stewardIds[0];
  else if (domain?.ownerId) assignedTo = domain.ownerId;
  else if (asset.ownerPersonId) assignedTo = asset.ownerPersonId;

  const newIssue: StoredGovernanceIssue = {
    id: uuid(),
    orgId: rule.orgId,
    title: `DQ ${status.toLowerCase()}: ${rule.name || 'rule'} on ${asset.name}`,
    description: `${rule.name || 'DQ rule'} is ${status.toLowerCase()} on ${asset.name} — score ${rule.currentScore ?? '?'} against threshold ${rule.threshold ?? '?'}.`,
    issueType: 'DATA_QUALITY',
    severity: status === 'FAILING' ? 'HIGH' : 'MEDIUM',
    status: 'OPEN',
    domainId: domain?.id || null,
    dataAssetId: asset.id,
    systemId: asset.systemId || null,
    reportedBy: null,
    assignedTo,
    resolutionSummary: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    linkedRuleId: rule.id,
  };
  await governanceIssuesRepo.create(newIssue);
  auditService.log(rule.orgId, null, 'GovernanceIssue', newIssue.id, 'AUTO_CREATED', null, { linkedRuleId: rule.id, severity: newIssue.severity });
  logger.info({ ruleId: rule.id, issueId: newIssue.id, severity: newIssue.severity }, 'DQ auto-issue created');

  if (assignedTo) {
    createNotification({
      orgId: rule.orgId,
      userId: assignedTo,
      type: 'ACTION',
      title: `DQ ${status.toLowerCase()}: ${asset.name}`,
      message: `${rule.name || 'A DQ rule'} needs attention on ${asset.name}. Score ${rule.currentScore ?? '?'} against threshold ${rule.threshold ?? '?'}.`,
      link: `/governance-issues?id=${newIssue.id}`,
    });
  }
}

/** One scanned asset's drift verdict, from the connector report ingest. */
export interface SchemaDriftEvent {
  asset: { id: string; name: string; systemId?: string | null; ownerPersonId?: string | null };
  /** True when this scan's column set differs from the previously fingerprinted one. */
  drifted: boolean;
  /** Column count reported by this scan, for the issue description. */
  columnCount?: number;
}

/**
 * Reconcile schema-drift governance issues for a batch of scanned assets.
 * Called by the connector report ingest after it computes drift per asset:
 *   - drifted → ensure one OPEN SCHEMA_DRIFT issue exists (create + notify on
 *     first sighting; refresh the description otherwise).
 *   - not drifted → auto-resolve any OPEN SCHEMA_DRIFT issue for the asset
 *     ("schema stabilized").
 *
 * Batched: one issues snapshot (+ at most one domains snapshot) for the whole
 * report, so it adds no per-asset round-trips to the hot ingest path. Dedup is
 * on (dataAssetId, issueType=SCHEMA_DRIFT) rather than linkedRuleId, since the
 * finding is asset-level, not rule-level.
 */
export async function reconcileSchemaDriftIssues(orgId: string, events: SchemaDriftEvent[]): Promise<void> {
  if (!events.length) return;
  const allIssues = await governanceIssuesRepo.list();
  const openByAsset = new Map<string, StoredGovernanceIssue>();
  for (const i of allIssues) {
    if (i.issueType === 'SCHEMA_DRIFT' && i.dataAssetId && !TERMINAL_STATUSES.has(i.status)) {
      openByAsset.set(i.dataAssetId, i);
    }
  }
  // Only resolve the domain steward/owner when we actually need to create an
  // issue (drift on an asset with no open one).
  const needsAssignee = events.some((e) => e.drifted && !openByAsset.has(e.asset.id));
  const allDomains = needsAssignee ? await dataDomainsRepo().list() : [];
  const now = new Date().toISOString();

  for (const ev of events) {
    const open = openByAsset.get(ev.asset.id);
    const colNote = typeof ev.columnCount === 'number' ? ` (now ${ev.columnCount} columns)` : '';
    if (ev.drifted) {
      if (open) {
        await governanceIssuesRepo.update(open.id, {
          description: `The scanned column set for ${ev.asset.name} changed since the last scan${colNote}.`,
          updatedAt: now,
        });
        continue;
      }
      // Assignee: domain steward > domain owner > asset owner (matches the DQ
      // auto-issue precedence).
      const domain = allDomains.find((d) => d.dataAssetIds?.includes(ev.asset.id));
      let assignedTo: string | null = null;
      if (domain?.stewardIds && domain.stewardIds.length > 0) assignedTo = domain.stewardIds[0];
      else if (domain?.ownerId) assignedTo = domain.ownerId;
      else if (ev.asset.ownerPersonId) assignedTo = ev.asset.ownerPersonId;

      const newIssue: StoredGovernanceIssue = {
        id: uuid(),
        orgId,
        title: `Schema drift: ${ev.asset.name}`,
        description: `The scanned column set for ${ev.asset.name} changed since the last scan${colNote} — a column was added, removed, or retyped. Verify downstream consumers still work.`,
        issueType: 'SCHEMA_DRIFT',
        severity: 'MEDIUM',
        status: 'OPEN',
        domainId: domain?.id || null,
        dataAssetId: ev.asset.id,
        systemId: ev.asset.systemId || null,
        reportedBy: null,
        assignedTo,
        resolutionSummary: null,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        linkedRuleId: null,
      };
      await governanceIssuesRepo.create(newIssue);
      auditService.log(orgId, null, 'GovernanceIssue', newIssue.id, 'AUTO_CREATED', null, { dataAssetId: ev.asset.id, issueType: 'SCHEMA_DRIFT' });
      logger.info({ assetId: ev.asset.id, issueId: newIssue.id }, 'Schema-drift auto-issue created');
      if (assignedTo) {
        createNotification({
          orgId,
          userId: assignedTo,
          type: 'ACTION',
          title: `Schema drift: ${ev.asset.name}`,
          message: `${ev.asset.name}'s column set changed since the last scan. Verify downstream consumers still work.`,
          link: `/governance-issues?id=${newIssue.id}`,
        });
      }
    } else if (open) {
      await governanceIssuesRepo.update(open.id, {
        status: 'RESOLVED',
        resolutionSummary: 'Schema stabilized — the column set matched the previous scan.',
        closedAt: now,
        updatedAt: now,
      });
      auditService.log(orgId, null, 'GovernanceIssue', open.id, 'AUTO_RESOLVED', null, { dataAssetId: ev.asset.id, issueType: 'SCHEMA_DRIFT' });
      if (open.assignedTo) {
        createNotification({
          orgId,
          userId: open.assignedTo,
          type: 'INFO',
          title: 'Schema drift resolved',
          message: `${ev.asset.name}'s schema matched the previous scan again.`,
          link: `/governance-issues?id=${open.id}`,
        });
      }
    }
  }
}

export interface StoredGovernanceIssue {
  id: string;
  orgId: string;
  title: string;
  description: string;
  issueType: typeof ISSUE_TYPES[number];
  severity: typeof ISSUE_SEVERITIES[number];
  status: typeof ISSUE_STATUSES[number];
  domainId: string | null;
  dataAssetId: string | null;
  systemId: string | null;
  reportedBy: string | null;
  assignedTo: string | null;
  resolutionSummary: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** For issues that were auto-created by another system (DQ engine,
   *  policy-review reminder, etc.), the id of the originating record.
   *  Lets the sync helper reopen or close the same issue on later
   *  status changes rather than piling up duplicates. Null for
   *  manually-authored issues. */
  linkedRuleId?: string | null;
  /** Agent id when an auto-issue tracks an ownership problem on an
   *  agent (owner cleared, owner deleted / deactivated). Same purpose
   *  as linkedRuleId — dedup + navigation back to the source record. */
  linkedAgentId?: string | null;
}

/**
 * Agent-ownership auto-issue. Called by the agents route when the
 * responsible person is removed on an ACTIVE agent (edit-clear,
 * person delete, person deactivate). Opens a HIGH-severity OWNERSHIP
 * issue with no assignee — nobody obvious to route it to — so it lands
 * in the org's Open Issues queue for a governance lead to pick up.
 *
 * Returns the created issue id (or null if the agent's org is missing).
 * Idempotent per (agentId, still-open) — a duplicate open ownership
 * issue for the same agent is a bug we don't want.
 */
export async function openAgentOwnershipIssue(input: {
  agent: { id: string; name: string; orgIds: string[] };
  reason: string;
}): Promise<string | null> {
  const { agent, reason } = input;
  const orgId = agent.orgIds[0];
  if (!orgId) return null;

  const allIssues = await governanceIssuesRepo.list();
  const existing = allIssues.find(
    (i) => i.linkedAgentId === agent.id && !TERMINAL_STATUSES.has(i.status),
  );
  if (existing) return existing.id;

  const now = new Date().toISOString();
  const newIssue: StoredGovernanceIssue = {
    id: uuid(),
    orgId,
    title: `Agent paused — no responsible person: ${agent.name}`,
    description: `${reason}. Agent is now PAUSED and cannot run activities until a responsible person is assigned and the status is set back to ACTIVE.`,
    issueType: 'OWNERSHIP',
    severity: 'HIGH',
    status: 'OPEN',
    domainId: null,
    dataAssetId: null,
    systemId: null,
    reportedBy: null,
    assignedTo: null,
    resolutionSummary: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    linkedRuleId: null,
    linkedAgentId: agent.id,
  };
  await governanceIssuesRepo.create(newIssue);
  auditService.log(orgId, null, 'GovernanceIssue', newIssue.id, 'AUTO_CREATED', null, {
    linkedAgentId: agent.id,
    reason,
  });
  logger.info({ agentId: agent.id, issueId: newIssue.id }, 'Agent ownership auto-issue created');
  return newIssue.id;
}

export const governanceIssues: StoredGovernanceIssue[] = loadStore<StoredGovernanceIssue>('governanceIssues');
registerStore('governanceIssues', governanceIssues);

const governanceIssuesRepo = getGovernanceIssuesRepository(governanceIssues);

// Foreign stores for enrichment — lazy repos (cycle-safe).
let _peopleRepo: ReturnType<typeof getPeopleRepository> | null = null;
const peopleRepo = () => (_peopleRepo ??= getPeopleRepository(people));
let _dataDomainsRepo: ReturnType<typeof getDataDomainsRepository> | null = null;
const dataDomainsRepo = () => (_dataDomainsRepo ??= getDataDomainsRepository(dataDomains));
let _dataAssetsRepo: ReturnType<typeof getDataAssetsRepository> | null = null;
const dataAssetsRepo = () => (_dataAssetsRepo ??= getDataAssetsRepository(dataAssets));

// Request-body schemas at the API boundary. See governance-tasks
// for the rationale.
const createIssueBodySchema = z.object({
  title: z.string().min(1, 'title is required'),
  orgId: z.string().min(1, 'orgId is required'),
  description: z.string().optional(),
  issueType: z.enum(ISSUE_TYPES).optional(),
  severity: z.enum(ISSUE_SEVERITIES).optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  domainId: z.string().nullable().optional(),
  dataAssetId: z.string().nullable().optional(),
  systemId: z.string().nullable().optional(),
  reportedBy: z.string().nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  resolutionSummary: z.string().nullable().optional(),
});
const updateIssueBodySchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  issueType: z.enum(ISSUE_TYPES).optional(),
  severity: z.enum(ISSUE_SEVERITIES).optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  domainId: z.string().nullable().optional(),
  dataAssetId: z.string().nullable().optional(),
  systemId: z.string().nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  resolutionSummary: z.string().nullable().optional(),
});

function enrichIssue(
  issue: StoredGovernanceIssue,
  allPeople: typeof people,
  allDomains: typeof dataDomains,
  allAssets: typeof dataAssets,
): StoredGovernanceIssue & { reporterName: string | null; assigneeName: string | null; domainName: string | null; dataAssetName: string | null } {
  const reporter = issue.reportedBy ? allPeople.find((p) => p.id === issue.reportedBy) : null;
  const assignee = issue.assignedTo ? allPeople.find((p) => p.id === issue.assignedTo) : null;
  const domain = issue.domainId ? allDomains.find((d) => d.id === issue.domainId) : null;
  const asset = issue.dataAssetId ? allAssets.find((a) => a.id === issue.dataAssetId) : null;
  return {
    ...issue,
    reporterName: reporter?.name || null,
    assigneeName: assignee?.name || null,
    domainName: domain?.name || null,
    dataAssetName: asset?.name || null,
  };
}

const router = Router();

/** GET /api/v1/governance-issues/summary */
router.get('/summary', async (req: Request, res: Response) => {
  const { orgId } = req.query;
  const filtered = filterByOrgScope(await governanceIssuesRepo.list(), orgId as string | undefined);

  const byStatus: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byIssueType: Record<string, number> = {};

  for (const s of ISSUE_STATUSES) byStatus[s] = 0;
  for (const s of ISSUE_SEVERITIES) bySeverity[s] = 0;
  for (const t of ISSUE_TYPES) byIssueType[t] = 0;

  for (const issue of filtered) {
    byStatus[issue.status] = (byStatus[issue.status] || 0) + 1;
    bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
    byIssueType[issue.issueType] = (byIssueType[issue.issueType] || 0) + 1;
  }

  res.json({
    success: true,
    data: { total: filtered.length, byStatus, bySeverity, byIssueType },
  });
});

/** GET /api/v1/governance-issues */
router.get('/', async (req: Request, res: Response) => {
  const { orgId, status, severity, issueType, assignedTo, domainId } = req.query;
  let filtered = filterByOrgScope(await governanceIssuesRepo.list(), orgId as string | undefined);

  if (status) filtered = filtered.filter((i) => i.status === status);
  if (severity) filtered = filtered.filter((i) => i.severity === severity);
  if (issueType) filtered = filtered.filter((i) => i.issueType === issueType);
  if (assignedTo) filtered = filtered.filter((i) => i.assignedTo === assignedTo);
  if (domainId) filtered = filtered.filter((i) => i.domainId === domainId);

  const [allPeople, allDomains, allAssets] = await Promise.all([peopleRepo().list(), dataDomainsRepo().list(), dataAssetsRepo().list()]);
  res.json({ success: true, data: filtered.map((i) => enrichIssue(i, allPeople, allDomains, allAssets)) });
});

/** GET /api/v1/governance-issues/:id */
router.get('/:id', async (req: Request, res: Response) => {
  const issue = await governanceIssuesRepo.get(String(req.params.id));
  if (!issue) { res.status(404).json({ success: false, error: 'Governance issue not found' }); return; }
  const [allPeople, allDomains, allAssets] = await Promise.all([peopleRepo().list(), dataDomainsRepo().list(), dataAssetsRepo().list()]);
  res.json({ success: true, data: enrichIssue(issue, allPeople, allDomains, allAssets) });
});

/** POST /api/v1/governance-issues */
router.post('/', async (req: Request, res: Response) => {
  const parsed = createIssueBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const body = parsed.data;

  const now = new Date().toISOString();
  const resolvedStatus = body.status || 'OPEN';
  const issue: StoredGovernanceIssue = {
    id: uuid(),
    orgId: body.orgId,
    title: body.title,
    description: body.description || '',
    issueType: body.issueType || 'METADATA',
    severity: body.severity || 'MEDIUM',
    status: resolvedStatus,
    domainId: body.domainId || null,
    dataAssetId: body.dataAssetId || null,
    systemId: body.systemId || null,
    reportedBy: body.reportedBy || null,
    assignedTo: body.assignedTo || null,
    resolutionSummary: body.resolutionSummary || null,
    createdAt: now,
    updatedAt: now,
    closedAt: TERMINAL_STATUSES.has(resolvedStatus) ? now : null,
  };

  await governanceIssuesRepo.create(issue);
  auditService.log(issue.orgId, null, 'GovernanceIssue', issue.id, 'CREATE', null, issue);
  logger.info({ issueId: issue.id, title: issue.title, issueType: issue.issueType }, 'Created governance issue');
  const [allPeople, allDomains, allAssets] = await Promise.all([peopleRepo().list(), dataDomainsRepo().list(), dataAssetsRepo().list()]);
  res.status(201).json({ success: true, data: enrichIssue(issue, allPeople, allDomains, allAssets) });
});

/** PUT /api/v1/governance-issues/:id */
router.put('/:id', async (req: Request, res: Response) => {
  const issue = await governanceIssuesRepo.get(String(req.params.id));
  if (!issue) { res.status(404).json({ success: false, error: 'Governance issue not found' }); return; }

  const parsed = updateIssueBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const body = parsed.data;

  const before = { ...issue };
  const {
    title, description, issueType, severity, status,
    domainId, dataAssetId, systemId, assignedTo,
    resolutionSummary,
  } = body;

  if (issueType !== undefined) issue.issueType = issueType;
  if (severity !== undefined) issue.severity = severity;
  if (title !== undefined) issue.title = title;
  if (description !== undefined) issue.description = description;
  if (domainId !== undefined) issue.domainId = domainId;
  if (dataAssetId !== undefined) issue.dataAssetId = dataAssetId;
  if (systemId !== undefined) issue.systemId = systemId;
  if (assignedTo !== undefined) issue.assignedTo = assignedTo;
  if (resolutionSummary !== undefined) issue.resolutionSummary = resolutionSummary;

  // Apply status last so closedAt logic runs correctly
  if (status !== undefined) {
    issue.status = status;
    if (TERMINAL_STATUSES.has(status) && !issue.closedAt) {
      issue.closedAt = new Date().toISOString();
    }
  }

  issue.updatedAt = new Date().toISOString();
  await governanceIssuesRepo.update(issue.id, issue);
  auditService.log(issue.orgId, null, 'GovernanceIssue', issue.id, 'UPDATE', before, issue);
  logger.info({ issueId: issue.id, title: issue.title }, 'Updated governance issue');
  const [allPeople, allDomains, allAssets] = await Promise.all([peopleRepo().list(), dataDomainsRepo().list(), dataAssetsRepo().list()]);
  res.json({ success: true, data: enrichIssue(issue, allPeople, allDomains, allAssets) });
});

/** DELETE /api/v1/governance-issues/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  const removed = await governanceIssuesRepo.get(String(req.params.id));
  if (!removed) { res.status(404).json({ success: false, error: 'Governance issue not found' }); return; }
  auditService.log(removed.orgId, null, 'GovernanceIssue', removed.id, 'DELETE', removed, null);
  await governanceIssuesRepo.delete(removed.id);
  logger.info({ issueId: removed.id, title: removed.title }, 'Deleted governance issue');
  res.status(204).send();
});

export default router;
