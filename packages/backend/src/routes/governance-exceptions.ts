// Governance Exceptions register.
//
// A governance exception is a time-boxed waiver: a policy or control is
// knowingly not met for a named reason, granted with an expiry date. The
// council cares about exceptions that have run PAST their expiry without being
// renewed or closed — that's the Council Scorecard's "exceptions past expiry"
// measure. Reads are open to viewers; writes require governance write (the
// router is mounted under requireResource('governance')).

import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { loadStore, registerStore } from '../lib/persistence';
import { getGovernanceExceptionsRepository } from '../db/governance-exceptions.repo';
import { auditService } from '../services/audit.service';
import { scopeListForRequest } from '../lib/tenant-scope';

export interface StoredGovernanceException {
  id: string;
  orgId: string;
  title: string;
  description?: string;
  policyId?: string;   // optional soft link to a GovernancePolicy
  ownerId?: string;    // person accountable for the exception
  reason?: string;
  status: 'ACTIVE' | 'CLOSED';
  grantedAt: string;   // ISO date the exception was granted
  expiresAt: string;   // ISO date the exception lapses
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export const governanceExceptions: StoredGovernanceException[] =
  loadStore<StoredGovernanceException>('governanceExceptions');
registerStore('governanceExceptions', governanceExceptions);

const repo = getGovernanceExceptionsRepository(governanceExceptions);

/**
 * Is this exception past its expiry and still open? This is the predicate the
 * Council Scorecard counts. Shared so the scorecard and the register agree.
 */
export function isPastExpiry(e: StoredGovernanceException, now = Date.now()): boolean {
  if (e.status !== 'ACTIVE') return false;
  const t = Date.parse(e.expiresAt);
  return Number.isFinite(t) && t < now;
}

const VALID_STATUS = ['ACTIVE', 'CLOSED'];

const router = Router();

/** GET /api/v1/governance-exceptions?orgId= — list, org-scoped. */
router.get('/', async (req: Request, res: Response) => {
  const all = await repo.list();
  const scoped = scopeListForRequest(req, all);
  // Newest-granted first; surface past-expiry with a derived flag for the UI.
  const now = Date.now();
  const data = [...scoped]
    .sort((a, b) => (b.grantedAt || '').localeCompare(a.grantedAt || ''))
    .map((e) => ({ ...e, pastExpiry: isPastExpiry(e, now) }));
  res.json({ success: true, data });
});

/** POST /api/v1/governance-exceptions — grant an exception. */
router.post('/', async (req: Request, res: Response) => {
  const { orgId, title, description, policyId, ownerId, reason, grantedAt, expiresAt, status } = req.body || {};
  if (!orgId) { res.status(400).json({ success: false, error: 'orgId is required' }); return; }
  if (!title || !String(title).trim()) { res.status(400).json({ success: false, error: 'title is required' }); return; }
  if (!expiresAt) { res.status(400).json({ success: false, error: 'expiresAt is required' }); return; }
  const now = new Date().toISOString();
  const userId = (req as Request & { user?: { id?: string } }).user?.id || null;
  const entity: StoredGovernanceException = {
    id: uuid(),
    orgId,
    title: String(title).trim(),
    description: description || undefined,
    policyId: policyId || undefined,
    ownerId: ownerId || undefined,
    reason: reason || undefined,
    status: VALID_STATUS.includes(status) ? status : 'ACTIVE',
    grantedAt: grantedAt || now,
    expiresAt,
    createdBy: userId || undefined,
    updatedBy: userId || undefined,
    createdAt: now,
    updatedAt: now,
  };
  await repo.create(entity);
  auditService.log(orgId, userId, 'GovernanceException', entity.id, 'CREATE', null, entity);
  res.status(201).json({ success: true, data: { ...entity, pastExpiry: isPastExpiry(entity) } });
});

/** PUT /api/v1/governance-exceptions/:id — edit / renew / close. */
router.put('/:id', async (req: Request, res: Response) => {
  const entity = await repo.get(String(req.params.id));
  if (!entity) { res.status(404).json({ success: false, error: 'Exception not found' }); return; }
  const before = { ...entity };
  const { title, description, policyId, ownerId, reason, grantedAt, expiresAt, status } = req.body || {};
  if (title !== undefined) entity.title = String(title).trim() || entity.title;
  if (description !== undefined) entity.description = description || undefined;
  if (policyId !== undefined) entity.policyId = policyId || undefined;
  if (ownerId !== undefined) entity.ownerId = ownerId || undefined;
  if (reason !== undefined) entity.reason = reason || undefined;
  if (grantedAt !== undefined) entity.grantedAt = grantedAt || entity.grantedAt;
  if (expiresAt !== undefined) entity.expiresAt = expiresAt || entity.expiresAt;
  if (status !== undefined && VALID_STATUS.includes(status)) entity.status = status;
  entity.updatedBy = (req as Request & { user?: { id?: string } }).user?.id || entity.updatedBy;
  entity.updatedAt = new Date().toISOString();
  await repo.update(entity.id, entity);
  auditService.log(entity.orgId, entity.updatedBy || null, 'GovernanceException', entity.id, 'UPDATE', before, entity);
  res.json({ success: true, data: { ...entity, pastExpiry: isPastExpiry(entity) } });
});

/** DELETE /api/v1/governance-exceptions/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  const entity = await repo.get(String(req.params.id));
  if (!entity) { res.status(404).json({ success: false, error: 'Exception not found' }); return; }
  await repo.delete(entity.id);
  auditService.log(entity.orgId, (req as Request & { user?: { id?: string } }).user?.id || null, 'GovernanceException', entity.id, 'DELETE', entity, null);
  res.status(204).send();
});

export default router;
