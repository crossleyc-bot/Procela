import { Router, Request, Response } from 'express';
import { digestForOrg } from '../services/digest.service';
import { processNodes } from './process-catalog';
import { dataAssets } from './data-assets';
import { mappings } from './mappings';
import { getProcessNodesRepository } from '../db/process-nodes.repo';
import { getDataAssetsRepository } from '../db/data-assets.repo';
import { getMappingsRepository } from '../db/mappings.repo';
import { getCachedOrgList } from '../lib/org-scope';
import { assertOrgAccess } from '../lib/tenant-scope';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  getPreference, upsertPreference, defaultPreference,
  normalizeCategories, type DigestFrequency,
} from '../services/digest-preferences';
import logger from '../lib/logger';

// Digest inputs are read through repositories (Postgres or JSON) — PR 6.
const processNodesRepo = getProcessNodesRepository(processNodes);
const dataAssetsRepo = getDataAssetsRepository(dataAssets);
const mappingsRepo = getMappingsRepository(mappings);

// ──────────────────────────────────────────────────────────────────────────
// Digest — proactive weekly notifications driven by gap-signal deltas.
//
// The service does the work; this route is just a thin trigger. For
// the prototype that means a manual POST; a scheduled cron caller
// can hit the same endpoint with no service changes.
// ──────────────────────────────────────────────────────────────────────────

const router = Router();

/** POST /api/v1/digest/run?orgId=... — take a fresh gap snapshot for
 *  the org, diff it against the previous one, and write notifications
 *  for every rule that fires. Returns the snapshot id, a baseline
 *  flag (true on the very first run for the org), and the list of
 *  notification rows created. */
router.post('/run', async (req: Request, res: Response) => {
  const orgId = (req.query.orgId as string | undefined)?.trim()
    || (req.body?.orgId as string | undefined)?.trim()
    || '';
  if (!orgId) {
    res.status(400).json({ success: false, error: 'orgId is required (query string or body).' });
    return;
  }
  try {
    const [pn, da, mp] = await Promise.all([
      processNodesRepo.list(), dataAssetsRepo.list(), mappingsRepo.list(),
    ]);
    const orgName = getCachedOrgList().find((o) => o.id === orgId)?.name || orgId;
    const result = await digestForOrg(orgId, { processNodes: pn, dataAssets: da, mappings: mp }, { orgName });
    res.json({
      success: true,
      data: {
        snapshotId: result.snapshot.id,
        takenAt: result.snapshot.takenAt,
        metrics: result.snapshot.metrics,
        baseline: result.baseline,
        notificationsWritten: result.notifications.length,
        emailsSent: result.emailsSent,
        notifications: result.notifications.map((n) => ({ id: n.id, title: n.title, link: n.link, type: n.type })),
      },
    });
  } catch (err: any) {
    logger.error({ err: err?.message, orgId }, 'Digest run failed');
    res.status(500).json({ success: false, error: err?.message || 'digest failed' });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Per-user digest preferences.
//
// GET  /api/v1/digest/preferences?orgId=…  → the caller's saved preference,
//        or the default (weekly · all categories · email off) if unsaved.
// PUT  /api/v1/digest/preferences          → upsert the caller's preference.
//
// Preferences are scoped to (org, user): the caller can only read/write their
// own, and only within an org they can access. Email/name are snapshotted
// from the caller's token so the digest sender can address them later.
// ──────────────────────────────────────────────────────────────────────────

/** The authenticated caller, or null in an unauthenticated harness. */
function caller(req: Request): { sub: string; email: string; name: string } | null {
  const u = (req as AuthenticatedRequest).user;
  if (!u?.sub) return null;
  return { sub: u.sub, email: u.email || '', name: u.name || '' };
}

router.get('/preferences', async (req: Request, res: Response) => {
  const orgId = String(req.query.orgId || '').trim();
  if (!orgId) { res.status(400).json({ success: false, error: 'orgId is required' }); return; }
  if (!assertOrgAccess(req as AuthenticatedRequest, res, orgId, 'Organization not found')) return;
  const me = caller(req);
  const userId = me?.sub || 'anonymous';
  const pref = (await getPreference(orgId, userId))
    || defaultPreference(orgId, userId, me?.email, me?.name);
  res.json({ success: true, data: pref });
});

router.put('/preferences', async (req: Request, res: Response) => {
  const { orgId, frequency, categories, emailEnabled } = req.body || {};
  if (!orgId) { res.status(400).json({ success: false, error: 'orgId is required' }); return; }
  if (!assertOrgAccess(req as AuthenticatedRequest, res, orgId, 'Organization not found')) return;
  const me = caller(req);
  const userId = me?.sub || 'anonymous';
  const freq: DigestFrequency = frequency === 'off' ? 'off' : 'weekly';
  const pref = await upsertPreference({
    orgId,
    userId,
    email: me?.email || '',
    name: me?.name || '',
    frequency: freq,
    categories: normalizeCategories(categories),
    emailEnabled: emailEnabled === true,
  });
  res.json({ success: true, data: pref });
});

export default router;
