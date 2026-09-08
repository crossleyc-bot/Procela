import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { auditService } from '../services/audit.service';
import { loadStore, registerStore } from '../lib/persistence';
import { scopeListForRequest, assertOrgAccess } from '../lib/tenant-scope';
import { hasDatabase } from '../db/prisma';
import { people } from './people';
import logger from '../lib/logger';
import { getGovernancePoliciesRepository } from '../db/governance-policies.repo';
import { getPeopleRepository } from '../db/people.repo';
import { getGovernanceControlsRepository } from '../db/governance-controls.repo';

export interface StoredGovernancePolicy {
  id: string;
  orgId: string;
  code: string;
  name: string;
  description: string;
  // The "Policies" surface in the app is actually the home for the
  // full family of governance documents — charters, frameworks,
  // standards, and policies — since they share lifecycle, owner,
  // review cadence and audit needs. documentType decides which
  // form variant + code prefix the row uses; existing rows
  // default to POLICY.
  documentType: 'CHARTER' | 'FRAMEWORK' | 'STANDARD' | 'POLICY';
  status: 'DRAFT' | 'ACTIVE' | 'UNDER_REVIEW' | 'DEPRECATED';
  ownerAssignmentId: string | null;
  category: 'DATA_QUALITY' | 'SECURITY' | 'PRIVACY' | 'RETENTION' | 'ACCESS' | 'CLASSIFICATION' | 'GOVERNANCE' | 'GENERAL';
  reviewFrequency: 'QUARTERLY' | 'SEMI_ANNUAL' | 'ANNUAL' | 'BIENNIAL' | 'NONE';
  nextReviewDate: string | null;
  effectiveDate: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export const VALID_DOCUMENT_TYPES: StoredGovernancePolicy['documentType'][] = ['CHARTER', 'FRAMEWORK', 'STANDARD', 'POLICY'];

// Back-fill documentType on stored rows that pre-date the field so
// the migration can run idempotently and the API always returns a
// consistent shape. Charters and standards seeded by the old
// governance template land under names that include those words —
// pattern-match on the name for the back-fill, fall back to POLICY.
function inferDocumentType(name: string): StoredGovernancePolicy['documentType'] {
  const n = (name || '').toLowerCase();
  if (n.includes('charter')) return 'CHARTER';
  if (n.includes('framework')) return 'FRAMEWORK';
  if (n.includes('standard')) return 'STANDARD';
  return 'POLICY';
}

// The documentType backfill is a JSON-mode load-time migration for legacy
// rows. In Postgres mode the array is retired (loadStore returns []), so the
// `.map` is skipped — mapping the instrumented empty array would trip a
// stale-read warning, and documentType comes from the DB column there.
const _loadedPolicies = loadStore<StoredGovernancePolicy>('governancePolicies');
export const governancePolicies: StoredGovernancePolicy[] = hasDatabase()
  ? _loadedPolicies
  : _loadedPolicies.map((p) => ({
      ...p,
      documentType: p.documentType || inferDocumentType(p.name),
    }));
registerStore('governancePolicies', governancePolicies);

const governancePoliciesRepo = getGovernancePoliciesRepository(governancePolicies);

// Foreign stores — lazy repos (cycle-safe; governance-controls value-imports
// this module, so its array is fetched via require at call time).
let _peopleRepo: ReturnType<typeof getPeopleRepository> | null = null;
const peopleRepo = () => (_peopleRepo ??= getPeopleRepository(people));
let _controlsRepo: ReturnType<typeof getGovernanceControlsRepository> | null = null;
const controlsRepo = () =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  (_controlsRepo ??= getGovernanceControlsRepository(require('./governance-controls').governanceControls));

// Code prefix per documentType so a charter coded "POL-001" stops
// reading as a misnamed policy. Sequence is per-type: CHA-001,
// CHA-002, STD-001, etc. — counts existing rows of the same type
// so re-importing doesn't collide across types.
const CODE_PREFIX: Record<StoredGovernancePolicy['documentType'], string> = {
  CHARTER: 'CHA',
  FRAMEWORK: 'FRW',
  STANDARD: 'STD',
  POLICY: 'POL',
};
export async function generateCode(documentType: StoredGovernancePolicy['documentType']): Promise<string> {
  const prefix = CODE_PREFIX[documentType];
  const seq = (await governancePoliciesRepo.list()).filter((p) => p.documentType === documentType).length + 1;
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

function resolveOwnerName(ownerAssignmentId: string | null, allPeople: typeof people): string | null {
  if (!ownerAssignmentId) return null;
  const person = allPeople.find((p) => p.id === ownerAssignmentId);
  return person?.name || null;
}

const router = Router();

/** GET /api/v1/governance-policies — list policies / charters / frameworks / standards */
router.get('/', async (req: Request, res: Response) => {
  const { status, category, documentType } = req.query;
  let filtered = await governancePoliciesRepo.list();
  filtered = scopeListForRequest(req, filtered);
  if (status) filtered = filtered.filter((p) => p.status === status);
  if (category) filtered = filtered.filter((p) => p.category === category);
  if (documentType) filtered = filtered.filter((p) => p.documentType === documentType);

  const allPeople = await peopleRepo().list();
  const enriched = filtered.map((p) => ({
    ...p,
    ownerName: resolveOwnerName(p.ownerAssignmentId, allPeople),
  }));

  res.json({ success: true, data: enriched });
});

/** GET /api/v1/governance-policies/summary — aggregate counts */
router.get('/summary', async (req: Request, res: Response) => {
  let filtered = await governancePoliciesRepo.list();
  filtered = scopeListForRequest(req, filtered);

  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const today = new Date().toISOString().slice(0, 10);
  let overdueReviews = 0;

  for (const p of filtered) {
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    byCategory[p.category] = (byCategory[p.category] || 0) + 1;
    if (p.nextReviewDate && p.nextReviewDate < today) {
      overdueReviews++;
    }
  }

  res.json({ success: true, data: { total: filtered.length, byStatus, byCategory, overdueReviews } });
});

/** GET /api/v1/governance-policies/:id — single policy */
router.get('/:id', async (req: Request, res: Response) => {
  const policy = await governancePoliciesRepo.get(String(req.params.id));
  if (!policy) { res.status(404).json({ success: false, error: 'Governance policy not found' }); return; }
  if (!assertOrgAccess(req, res, policy.orgId, 'Governance policy not found')) return;

  const [allPeople, allControls] = await Promise.all([peopleRepo().list(), controlsRepo().list()]);
  const linkedControlsCount = allControls.filter((c) => c.policyId === policy.id).length;

  res.json({
    success: true,
    data: {
      ...policy,
      ownerName: resolveOwnerName(policy.ownerAssignmentId, allPeople),
      linkedControlsCount,
    },
  });
});

/** POST /api/v1/governance-policies — create policy */
router.post('/', async (req: Request, res: Response) => {
  const { name, orgId, description, status, ownerAssignmentId, category, reviewFrequency,
          nextReviewDate, effectiveDate, content, documentType } = req.body;
  if (!name) { res.status(400).json({ success: false, error: 'Name is required' }); return; }
  if (!orgId) { res.status(400).json({ success: false, error: 'Organization (orgId) is required' }); return; }
  const finalDocumentType: StoredGovernancePolicy['documentType'] = VALID_DOCUMENT_TYPES.includes(documentType) ? documentType : 'POLICY';

  const now = new Date().toISOString();
  const policy: StoredGovernancePolicy = {
    id: uuid(),
    orgId,
    code: await generateCode(finalDocumentType),
    name,
    description: description || '',
    documentType: finalDocumentType,
    status: status || 'DRAFT',
    ownerAssignmentId: ownerAssignmentId || null,
    category: category || 'GENERAL',
    reviewFrequency: reviewFrequency || 'ANNUAL',
    nextReviewDate: nextReviewDate || null,
    effectiveDate: effectiveDate || null,
    content: content || '',
    createdAt: now,
    updatedAt: now,
  };

  await governancePoliciesRepo.create(policy);
  auditService.log(policy.orgId, null, 'GovernancePolicy', policy.id, 'CREATE', null, policy);
  logger.info({ policyId: policy.id, code: policy.code, name: policy.name }, 'Created governance policy');
  res.status(201).json({ success: true, data: policy });
});

/** PUT /api/v1/governance-policies/:id — update policy */
router.put('/:id', async (req: Request, res: Response) => {
  const policy = await governancePoliciesRepo.get(String(req.params.id));
  if (!policy) { res.status(404).json({ success: false, error: 'Governance policy not found' }); return; }
  if (!assertOrgAccess(req, res, policy.orgId, 'Governance policy not found')) return;

  const before = { ...policy };
  const { name, description, status, ownerAssignmentId, category, reviewFrequency,
          nextReviewDate, effectiveDate, content } = req.body;

  const patch: Partial<StoredGovernancePolicy> = {};
  if (name !== undefined) patch.name = name;
  if (description !== undefined) patch.description = description;
  if (ownerAssignmentId !== undefined) patch.ownerAssignmentId = ownerAssignmentId;
  if (category !== undefined) patch.category = category;
  if (reviewFrequency !== undefined) patch.reviewFrequency = reviewFrequency;
  if (nextReviewDate !== undefined) patch.nextReviewDate = nextReviewDate;
  if (effectiveDate !== undefined) patch.effectiveDate = effectiveDate;
  if (content !== undefined) patch.content = content;

  // When status changes to ACTIVE, set effectiveDate if not already set
  if (status !== undefined) {
    if (status === 'ACTIVE' && policy.status !== 'ACTIVE' && !policy.effectiveDate && patch.effectiveDate === undefined) {
      patch.effectiveDate = new Date().toISOString().slice(0, 10);
    }
    patch.status = status;
  }

  patch.updatedAt = new Date().toISOString();
  const updated = await governancePoliciesRepo.update(policy.id, patch);
  auditService.log(policy.orgId, null, 'GovernancePolicy', policy.id, 'UPDATE', before, updated);
  res.json({ success: true, data: updated });
});

/** DELETE /api/v1/governance-policies/:id — delete policy and orphan its controls */
router.delete('/:id', async (req: Request, res: Response) => {
  const removed = await governancePoliciesRepo.get(String(req.params.id));
  if (!removed) { res.status(404).json({ success: false, error: 'Governance policy not found' }); return; }
  if (!assertOrgAccess(req, res, removed.orgId, 'Governance policy not found')) return;

  // Orphan controls linked to this policy (set policyId to empty string).
  try {
    const repo = controlsRepo();
    const linked = (await repo.list()).filter((c) => c.policyId === removed.id);
    for (const ctrl of linked) {
      await repo.update(ctrl.id, { policyId: '' });
    }
  } catch (err) { logger.warn({ err, policyId: removed.id }, 'Failed to orphan linked controls'); }

  auditService.log(removed.orgId, null, 'GovernancePolicy', removed.id, 'DELETE', removed, null);
  await governancePoliciesRepo.delete(removed.id);
  logger.info({ policyId: removed.id, code: removed.code }, 'Deleted governance policy');
  res.status(204).send();
});

export default router;
