import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { auditService } from '../services/audit.service';
import { loadStore, saveStore, registerStore } from '../lib/persistence';
import { scopeListForRequest, assertOrgAccess } from '../lib/tenant-scope';
import { people } from './people';
import logger from '../lib/logger';
import { getSopsRepository } from '../db/sops.repo';
import { getPeopleRepository } from '../db/people.repo';
import { AuthenticatedRequest } from '../middleware/auth';
import { enforceAssignment, ownerOnCreate } from '../lib/assignment';

// ── Types ──

const CATEGORIES = [
  'ONBOARDING',
  'QUALITY',
  'INCIDENT',
  'ACCESS',
  'REQUEST',
  'REVIEW',
  'ESCALATION',
  'OTHER',
] as const;

const STATUSES = ['DRAFT', 'ACTIVE', 'DEPRECATED'] as const;

type Category = typeof CATEGORIES[number];
type Status = typeof STATUSES[number];

export interface SopStep {
  order: number;
  title: string;
  description: string;
  estimatedMinutes: number;
}

export interface StoredSop {
  id: string;
  orgId: string;
  code: string;
  title: string;
  purpose: string;
  category: Category;
  applicableRoles: string[];
  triggerEvent: string;
  steps: SopStep[];
  status: Status;
  version: number;
  ownerPersonId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const sops: StoredSop[] = loadStore<StoredSop>('sops');
registerStore('sops', sops);

const sopsRepo = getSopsRepository(sops);

// people is a foreign store; build its repo lazily so nothing reads the
// `people` binding at module-init (cycle-safety, matching the 9b conversions).
let _peopleRepo: ReturnType<typeof getPeopleRepository> | null = null;
const peopleRepo = () => (_peopleRepo ??= getPeopleRepository(people));

// ── Helpers ──

function generateCode(allSops: StoredSop[]): string {
  // Find the highest existing SOP-### and increment, so deletes don't cause collisions.
  let max = 0;
  for (const s of allSops) {
    const m = /^SOP-(\d+)$/.exec(s.code || '');
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return `SOP-${String(max + 1).padStart(3, '0')}`;
}

function resolveOwnerName(ownerPersonId: string | null, allPeople: typeof people): string | null {
  if (!ownerPersonId) return null;
  const person = allPeople.find((p) => p.id === ownerPersonId);
  return person?.name || null;
}

function enrichSop(s: StoredSop, allPeople: typeof people): any {
  return {
    ...s,
    ownerName: resolveOwnerName(s.ownerPersonId, allPeople),
    stepCount: Array.isArray(s.steps) ? s.steps.length : 0,
  };
}

function normalizeSteps(raw: any): SopStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s, idx) => ({
      order: typeof s?.order === 'number' ? s.order : idx + 1,
      title: typeof s?.title === 'string' ? s.title : '',
      description: typeof s?.description === 'string' ? s.description : '',
      estimatedMinutes: typeof s?.estimatedMinutes === 'number' ? s.estimatedMinutes : 0,
    }))
    .sort((a, b) => a.order - b.order)
    .map((s, idx) => ({ ...s, order: idx + 1 }));
}

function stepsChanged(before: SopStep[], after: SopStep[]): boolean {
  if (before.length !== after.length) return true;
  for (let i = 0; i < before.length; i++) {
    const a = before[i];
    const b = after[i];
    if (
      a.order !== b.order ||
      a.title !== b.title ||
      a.description !== b.description ||
      a.estimatedMinutes !== b.estimatedMinutes
    ) {
      return true;
    }
  }
  return false;
}

// ── Standard seeds ──

const STANDARD_SOPS: Array<{
  title: string;
  category: Category;
  purpose: string;
  applicableRoles: string[];
  triggerEvent: string;
  steps: SopStep[];
}> = [
  {
    title: 'Onboard a new data asset',
    category: 'ONBOARDING',
    purpose:
      "Ensure every new data asset is properly classified, documented, and assigned an owner before it's used by the business.",
    applicableRoles: ['BUSINESS_DATA_STEWARD', 'TECHNICAL_DATA_STEWARD'],
    triggerEvent: 'A new data asset is introduced into a data domain.',
    steps: [
      { order: 1, title: 'Assign the asset to a domain', description: 'Identify the appropriate data domain. If no domain fits, escalate to the Governance Lead.', estimatedMinutes: 15 },
      { order: 2, title: 'Document the business definition', description: 'Write a clear plain-language description of what the asset represents, including source system and refresh frequency.', estimatedMinutes: 20 },
      { order: 3, title: 'Classify the data', description: 'Apply data classification (Public, Internal, Confidential, Restricted) based on content sensitivity.', estimatedMinutes: 10 },
      { order: 4, title: 'Assign ownership', description: 'Assign a Data Owner (accountable) and one or more Data Stewards (responsible).', estimatedMinutes: 15 },
      { order: 5, title: 'Define initial quality rules', description: 'Identify the top 3-5 quality rules that matter most for this asset. Document thresholds and measurement cadence.', estimatedMinutes: 30 },
      { order: 6, title: 'Activate governance', description: 'Change the asset status to ACTIVE. Publish to the catalog so consumers can find it.', estimatedMinutes: 5 },
    ],
  },
  {
    title: 'Respond to a data quality incident',
    category: 'INCIDENT',
    purpose:
      'Contain, investigate, and resolve data quality incidents with clear ownership and communication.',
    applicableRoles: ['BUSINESS_DATA_STEWARD', 'DATA_QUALITY_ANALYST'],
    triggerEvent: 'A quality rule fails, or a consumer reports a data issue.',
    steps: [
      { order: 1, title: 'Confirm the incident', description: 'Reproduce the issue. Classify severity (Low/Medium/High/Critical) based on business impact.', estimatedMinutes: 20 },
      { order: 2, title: 'Log the issue', description: 'Create a governance Issue record with domain, affected assets, severity, and impact summary.', estimatedMinutes: 10 },
      { order: 3, title: 'Contain the blast radius', description: 'Notify consumers. Pause dependent processes if necessary. Document who was informed and when.', estimatedMinutes: 30 },
      { order: 4, title: 'Root cause analysis', description: 'Identify the source of the failure (upstream data, logic change, system failure, user error). Document findings.', estimatedMinutes: 60 },
      { order: 5, title: 'Implement the fix', description: 'Apply corrective action. Coordinate with Technical Stewards if infrastructure changes are needed.', estimatedMinutes: 90 },
      { order: 6, title: 'Close the issue', description: 'Document the resolution, lessons learned, and any preventive measures. Close the issue record.', estimatedMinutes: 15 },
    ],
  },
  {
    title: 'Process an access request for restricted data',
    category: 'ACCESS',
    purpose:
      'Grant access to sensitive data consistently, with appropriate justification and approval.',
    applicableRoles: ['DATA_OWNER', 'BUSINESS_DATA_STEWARD'],
    triggerEvent: 'A person requests access to Confidential or Restricted data.',
    steps: [
      { order: 1, title: "Validate the requester's identity and role", description: 'Confirm the requester is authorized to handle data at this classification level.', estimatedMinutes: 10 },
      { order: 2, title: 'Review the business justification', description: 'Ensure the request has a clear, documented business reason tied to a specific outcome.', estimatedMinutes: 15 },
      { order: 3, title: 'Confirm least-privilege scope', description: 'Narrow the access to the minimum needed (specific columns, time range, row filters).', estimatedMinutes: 10 },
      { order: 4, title: "Get the Data Owner's approval", description: 'Submit the request to the Data Owner. Document their decision.', estimatedMinutes: 10 },
      { order: 5, title: 'Provision access', description: 'Work with the Technical Steward or system owner to grant access. Set an expiration date if appropriate.', estimatedMinutes: 15 },
      { order: 6, title: 'Notify and document', description: 'Notify the requester. Record the grant in the access log with scope, approver, and expiration.', estimatedMinutes: 10 },
    ],
  },
  {
    title: 'Escalate an unresolved governance issue',
    category: 'ESCALATION',
    purpose:
      "Elevate issues that can't be resolved at the steward level to the next authority.",
    applicableRoles: ['BUSINESS_DATA_STEWARD', 'TECHNICAL_DATA_STEWARD'],
    triggerEvent: 'An issue is unresolved for more than 30 days, or has cross-domain impact.',
    steps: [
      { order: 1, title: 'Confirm escalation criteria', description: 'Verify the issue meets escalation thresholds (age, severity, scope, regulatory impact).', estimatedMinutes: 10 },
      { order: 2, title: 'Prepare the escalation summary', description: "Write a one-page summary: what the issue is, what's been tried, what decision is needed, and the impact of inaction.", estimatedMinutes: 30 },
      { order: 3, title: 'Notify the Data Owner', description: 'Send the summary. Request a decision by a specific date.', estimatedMinutes: 15 },
      { order: 4, title: 'Attend the decision meeting', description: 'Present the issue, answer questions, and capture the decision.', estimatedMinutes: 60 },
      { order: 5, title: 'Document and execute', description: 'Record the decision in the issue. Implement any agreed-upon actions and communicate to affected parties.', estimatedMinutes: 30 },
    ],
  },
  {
    title: 'Conduct a quarterly domain review',
    category: 'REVIEW',
    purpose:
      'Systematically review domain health, metrics, and roadmap with the Data Owner every quarter.',
    applicableRoles: ['DATA_OWNER', 'BUSINESS_DATA_STEWARD'],
    triggerEvent: 'Quarterly cadence (automated via Governance Calendar).',
    steps: [
      { order: 1, title: 'Pull domain metrics', description: 'Gather quality scores, issue counts, coverage percentage, and policy compliance for the quarter.', estimatedMinutes: 30 },
      { order: 2, title: 'Review progress against goals', description: "Compare actual results to the prior quarter's stated goals. Document gaps and wins.", estimatedMinutes: 30 },
      { order: 3, title: 'Identify priority issues', description: 'List the top 3-5 issues that need attention in the next quarter.', estimatedMinutes: 30 },
      { order: 4, title: "Plan next quarter's initiatives", description: 'Define 2-3 specific, measurable improvements for the next quarter.', estimatedMinutes: 45 },
      { order: 5, title: 'Review steward assignments', description: 'Confirm current stewards are still appropriate. Propose changes if needed.', estimatedMinutes: 15 },
      { order: 6, title: 'Publish the review', description: 'Share the review summary with the Committee and update the domain documentation.', estimatedMinutes: 20 },
    ],
  },
];

// ── Router ──

const router = Router();

/** GET /api/v1/sops — list with filters */
router.get('/', async (req: Request, res: Response) => {
  const { category, role, status } = req.query;
  const [allSops, allPeople] = await Promise.all([sopsRepo.list(), peopleRepo().list()]);
  let filtered = scopeListForRequest(req, allSops);

  if (category) filtered = filtered.filter((s) => s.category === category);
  if (status) filtered = filtered.filter((s) => s.status === status);
  if (role) {
    filtered = filtered.filter((s) =>
      Array.isArray(s.applicableRoles) && s.applicableRoles.includes(role as string),
    );
  }

  res.json({ success: true, data: filtered.map((s) => enrichSop(s, allPeople)) });
});

/** GET /api/v1/sops/:id — single SOP */
router.get('/:id', async (req: Request, res: Response) => {
  const [sop, allPeople] = await Promise.all([sopsRepo.get(String(req.params.id)), peopleRepo().list()]);
  if (!sop) { res.status(404).json({ success: false, error: 'SOP not found' }); return; }
  if (!assertOrgAccess(req, res, sop.orgId, 'SOP not found')) return;
  res.json({ success: true, data: enrichSop(sop, allPeople) });
});

/** POST /api/v1/sops — create */
router.post('/', async (req: Request, res: Response) => {
  const {
    title, orgId, purpose, category, applicableRoles, triggerEvent,
    steps, status, ownerPersonId,
  } = req.body;

  if (!title) { res.status(400).json({ success: false, error: 'Title is required' }); return; }
  if (!orgId) { res.status(400).json({ success: false, error: 'orgId is required' }); return; }

  if (category && !CATEGORIES.includes(category)) {
    res.status(400).json({ success: false, error: `Invalid category. Must be one of: ${CATEGORIES.join(', ')}` });
    return;
  }
  if (status && !STATUSES.includes(status)) {
    res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${STATUSES.join(', ')}` });
    return;
  }

  const now = new Date().toISOString();
  const allSops = await sopsRepo.list();
  const sop: StoredSop = {
    id: uuid(),
    orgId,
    code: generateCode(allSops),
    title,
    purpose: purpose || '',
    category: (category as Category) || 'OTHER',
    applicableRoles: Array.isArray(applicableRoles) ? applicableRoles : [],
    triggerEvent: triggerEvent || '',
    steps: normalizeSteps(steps),
    status: (status as Status) || 'DRAFT',
    version: 1,
    // Layer-2: a CONTRIBUTOR who doesn't name an owner owns what they
    // create, so they can subsequently edit it.
    ownerPersonId: ownerOnCreate((req as AuthenticatedRequest).user, ownerPersonId),
    createdAt: now,
    updatedAt: now,
  };

  await sopsRepo.create(sop);
  auditService.log(sop.orgId, null, 'Sop', sop.id, 'CREATE', null, sop);
  logger.info({ sopId: sop.id, code: sop.code, title: sop.title }, 'Created SOP');
  res.status(201).json({ success: true, data: enrichSop(sop, await peopleRepo().list()) });
});

/** PUT /api/v1/sops/:id — update. Bumps version when steps change. */
router.put('/:id', async (req: Request, res: Response) => {
  const sop = await sopsRepo.get(String(req.params.id));
  if (!sop) { res.status(404).json({ success: false, error: 'SOP not found' }); return; }

  // Layer-2: a CONTRIBUTOR may only edit SOPs assigned to them.
  const putAssignErr = enforceAssignment((req as AuthenticatedRequest).user, sop);
  if (putAssignErr) { res.status(putAssignErr.statusCode).json({ success: false, error: putAssignErr.message }); return; }

  const before = { ...sop, steps: [...sop.steps] };
  const {
    title, purpose, category, applicableRoles, triggerEvent,
    steps, status, ownerPersonId,
  } = req.body;

  if (category !== undefined && !CATEGORIES.includes(category)) {
    res.status(400).json({ success: false, error: `Invalid category. Must be one of: ${CATEGORIES.join(', ')}` });
    return;
  }
  if (status !== undefined && !STATUSES.includes(status)) {
    res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${STATUSES.join(', ')}` });
    return;
  }

  if (title !== undefined) sop.title = title;
  if (purpose !== undefined) sop.purpose = purpose;
  if (category !== undefined) sop.category = category;
  if (applicableRoles !== undefined) {
    sop.applicableRoles = Array.isArray(applicableRoles) ? applicableRoles : [];
  }
  if (triggerEvent !== undefined) sop.triggerEvent = triggerEvent;
  if (ownerPersonId !== undefined) sop.ownerPersonId = ownerPersonId;
  if (status !== undefined) sop.status = status;

  if (steps !== undefined) {
    const newSteps = normalizeSteps(steps);
    if (stepsChanged(before.steps, newSteps)) {
      sop.version = (sop.version || 1) + 1;
    }
    sop.steps = newSteps;
  }

  sop.updatedAt = new Date().toISOString();
  await sopsRepo.update(sop.id, sop);
  auditService.log(sop.orgId, null, 'Sop', sop.id, 'UPDATE', before, sop);
  logger.info({ sopId: sop.id, code: sop.code, version: sop.version }, 'Updated SOP');
  res.json({ success: true, data: enrichSop(sop, await peopleRepo().list()) });
});

/** DELETE /api/v1/sops/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  const removed = await sopsRepo.get(String(req.params.id));
  if (!removed) { res.status(404).json({ success: false, error: 'SOP not found' }); return; }

  // Layer-2: a CONTRIBUTOR may only delete SOPs assigned to them.
  const delAssignErr = enforceAssignment((req as AuthenticatedRequest).user, removed);
  if (delAssignErr) { res.status(delAssignErr.statusCode).json({ success: false, error: delAssignErr.message }); return; }

  auditService.log(removed.orgId, null, 'Sop', removed.id, 'DELETE', removed, null);
  await sopsRepo.delete(removed.id);
  logger.info({ sopId: removed.id, code: removed.code }, 'Deleted SOP');
  res.status(204).send();
});

/**
 * POST /api/v1/sops/seed — create the 5 standard SOPs for an org if not
 * already present. Idempotent per-SOP by title+orgId.
 */
router.post('/seed', async (req: Request, res: Response) => {
  const { orgId } = req.body;
  if (!orgId) { res.status(400).json({ success: false, error: 'orgId is required' }); return; }

  const now = new Date().toISOString();
  const created: StoredSop[] = [];
  const skipped: string[] = [];

  // Prefetch once; append created rows so per-SOP `generateCode` and the
  // existence check both account for SOPs created earlier in this same seed.
  const allSops = await sopsRepo.list();

  for (const tmpl of STANDARD_SOPS) {
    const exists = allSops.some(
      (s) => s.orgId === orgId && s.title.toLowerCase() === tmpl.title.toLowerCase(),
    );
    if (exists) { skipped.push(tmpl.title); continue; }

    const sop: StoredSop = {
      id: uuid(),
      orgId,
      code: generateCode(allSops),
      title: tmpl.title,
      purpose: tmpl.purpose,
      category: tmpl.category,
      applicableRoles: [...tmpl.applicableRoles],
      triggerEvent: tmpl.triggerEvent,
      steps: tmpl.steps.map((s) => ({ ...s })),
      status: 'ACTIVE',
      version: 1,
      ownerPersonId: null,
      createdAt: now,
      updatedAt: now,
    };
    await sopsRepo.create(sop);
    created.push(sop);
    allSops.push(sop);
    auditService.log(sop.orgId, null, 'Sop', sop.id, 'CREATE', null, sop);
  }

  logger.info({ orgId, created: created.length, skipped: skipped.length }, 'Seeded standard SOPs');

  const allPeople = await peopleRepo().list();
  res.json({
    success: true,
    data: {
      created: created.map((s) => enrichSop(s, allPeople)),
      skipped,
    },
  });
});

export default router;
