import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { loadStore, saveStore, registerStore } from '../lib/persistence';
import { requireAiEnabled } from '../middleware/ai-enabled';
import { enforceAiBudget } from '../middleware/ai-budget';
import { getCachedOrgList } from '../lib/org-scope';
import { scopeListForRequest, assertOrgAccess } from '../lib/tenant-scope';
import { auditService } from '../services/audit.service';
import logger from '../lib/logger';
import { people } from './people';
import { dataAssets } from './data-assets';
import { aiService } from '../services/ai.service';
import { getDataDomainsRepository } from '../db/data-domains.repo';
import { getPeopleRepository } from '../db/people.repo';
import { getDataAssetsRepository } from '../db/data-assets.repo';
import { hasDatabase } from '../db/prisma';

export interface StoredDataDomain {
  id: string;
  orgId: string;
  name: string;
  description: string;
  ownerId: string | null;       // personId of the Data Owner
  stewardIds: string[];          // personIds of Data Stewards
  dataAssetIds: string[];
  // Human-readable governance code (e.g. "MFG" for a domain, "MFG-02" for a
  // sub-domain) — the structured id enterprises use to reference a domain in
  // policies and reports. Auto-suggested on create; user-editable.
  code?: string;
  // Optional parent domain — turns a flat catalog into Domain → Sub-Domain.
  // A domain with a parentDomainId IS a sub-domain; nesting is one level
  // deep only (a parent must itself be top-level), so the tree never exceeds
  // Domain → Sub-Domain → Asset. null / undefined = top-level domain.
  parentDomainId?: string | null;
  scopeDefinition?: string;
  // Business-criticality tier. TIER_1 = the domains the council watches most
  // closely; drives the Council Scorecard's tier-1 coverage measure. null =
  // unclassified. Valid values mirror the CriticalityTier enum.
  criticality?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export const dataDomains: StoredDataDomain[] = loadStore<StoredDataDomain>('dataDomains');
registerStore('dataDomains', dataDomains);

const dataDomainsRepo = getDataDomainsRepository(dataDomains);

// people.ts and data-assets.ts both value-import `dataDomains` from this
// module, so this module can be evaluated as a side-effect of loading one of
// them — at which point their `people` / `dataAssets` bindings are still in
// the temporal dead zone. Reading either at module-init time (to construct a
// repo) throws mid-cycle and, under the test loader, hangs. Build these repos
// lazily instead: by the time any handler runs, both modules are fully
// initialised.
let _peopleRepo: ReturnType<typeof getPeopleRepository> | null = null;
const peopleRepo = () => (_peopleRepo ??= getPeopleRepository(people));
let _dataAssetsRepo: ReturnType<typeof getDataAssetsRepository> | null = null;
const dataAssetsRepo = () => (_dataAssetsRepo ??= getDataAssetsRepository(dataAssets));

// Migrate legacy statuses to DRAFT. JSON mode only — in Postgres mode the
// persisted rows already carry the canonical status shape.
if (!hasDatabase()) {
  const legacy = new Set(['PROPOSED', 'UNDER_REVIEW', 'APPROVED']);
  let migrated = 0;
  for (const d of dataDomains) {
    if (legacy.has(d.status)) { d.status = 'DRAFT'; migrated++; }
  }
  if (migrated > 0) saveStore('dataDomains', dataDomains);
}

const VALID_STATUSES = ['DRAFT', 'PROPOSED', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'DEPRECATED'];
const VALID_CRITICALITY = ['TIER_1', 'TIER_2', 'TIER_3', 'TIER_4'];
const SIMPLE_TRANSITIONS: Record<string, string[]> = {
  DRAFT:      ['ACTIVE'],
  ACTIVE:     ['DRAFT', 'DEPRECATED'],
  DEPRECATED: ['DRAFT'],
};
const ADVANCED_TRANSITIONS: Record<string, string[]> = {
  DRAFT:        ['PROPOSED'],
  PROPOSED:     ['UNDER_REVIEW', 'DRAFT'],
  UNDER_REVIEW: ['APPROVED', 'DRAFT'],
  APPROVED:     ['ACTIVE', 'DRAFT'],
  ACTIVE:       ['DRAFT', 'DEPRECATED'],
  DEPRECATED:   ['DRAFT'],
};
const SIMPLE_LOCKED = new Set(['ACTIVE', 'DEPRECATED']);
const ADVANCED_LOCKED = new Set(['UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'DEPRECATED']);

function enrichDomain(
  domain: StoredDataDomain,
  allPeople: typeof people,
  allAssets: typeof dataAssets,
  allDomains: StoredDataDomain[] = [],
) {
  const owner = domain.ownerId ? allPeople.find((p) => p.id === domain.ownerId) : null;
  const stewards = domain.stewardIds
    .map((sid) => allPeople.find((p) => p.id === sid))
    .filter(Boolean)
    .map((p) => ({ id: p!.id, name: p!.name }));
  const memberAssets = domain.dataAssetIds
    .map((aid) => allAssets.find((a) => a.id === aid))
    .filter(Boolean) as typeof allAssets;
  const assets = memberAssets.map((a) => ({ id: a.id, name: a.name }));

  // Master/reference governance signal. A domain that holds master data is,
  // per canonical-EDM practice, always council-critical (Tier 1) — MDM
  // duplicates and sync errors ripple across every system that reuses it.
  // Reference data needs version/change governance but not automatically
  // Tier 1. We surface a non-binding suggestedCriticality the UI can offer
  // to apply, without overwriting an explicit criticality the user has set.
  const containsMasterData = memberAssets.some((a) => a.dataType === 'MASTER');
  const containsReferenceData = memberAssets.some((a) => a.dataType === 'REFERENCE');
  const suggestedCriticality = containsMasterData && !domain.criticality ? 'TIER_1' : undefined;

  // Sub-domain relationships: resolve the parent's name (for a breadcrumb /
  // "under X" label) and count this domain's own children.
  const parent = domain.parentDomainId ? allDomains.find((d) => d.id === domain.parentDomainId) : null;
  const subDomainCount = allDomains.filter((d) => d.parentDomainId === domain.id).length;

  return {
    ...domain,
    ownerName: owner?.name || null,
    stewards,
    assets,
    containsMasterData,
    containsReferenceData,
    suggestedCriticality,
    parentDomainName: parent?.name || null,
    subDomainCount,
  };
}

// Derive a short alphabetic code from a top-level domain name — initials when
// there are ≥2 significant words (dropping "data"/filler), else the first three
// letters. Deduped against existing codes with a numeric suffix.
function suggestTopCode(name: string, existing: Set<string>): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
    .filter((w) => !['data', 'and', 'of', 'the'].includes(w.toLowerCase()));
  let base = 'DOM';
  if (words.length >= 2) base = words.map((w) => w[0]).join('').slice(0, 4).toUpperCase();
  else if (words.length === 1) base = words[0].slice(0, 3).toUpperCase();
  let code = base;
  let i = 1;
  while (existing.has(code)) { code = `${base}${i++}`; }
  return code;
}

// Suggest a structured code: top-level → an abbreviation (MFG); sub-domain →
// parentCode + a two-digit sequence among its siblings (MFG-02).
function suggestDomainCode(name: string, parent: StoredDataDomain | null, allDomains: StoredDataDomain[]): string {
  const existing = new Set(allDomains.map((d) => (d.code || '').toUpperCase()).filter(Boolean));
  if (!parent) return suggestTopCode(name, existing);
  const base = (parent.code || suggestTopCode(parent.name, existing)).toUpperCase();
  const prefix = `${base}-`;
  let n = 0;
  for (const s of allDomains.filter((d) => d.parentDomainId === parent.id)) {
    const c = (s.code || '').toUpperCase();
    if (c.startsWith(prefix)) {
      const seq = parseInt(c.slice(prefix.length), 10);
      if (Number.isFinite(seq)) n = Math.max(n, seq);
    }
  }
  let seq = n + 1;
  let code = `${prefix}${String(seq).padStart(2, '0')}`;
  while (existing.has(code)) { seq++; code = `${prefix}${String(seq).padStart(2, '0')}`; }
  return code;
}

const router = Router();

/** DELETE /api/v1/data-domains/all — delete all data domains */
/**
 * POST /api/v1/data-domains/generate
 *
 * Uses the AI service to suggest data domains for a given industry.
 * Returns the suggestions without committing them — the frontend shows
 * a preview and the user picks which to keep.
 */
router.post('/generate', requireAiEnabled, enforceAiBudget, async (req: Request, res: Response) => {
  const { industry } = req.body;
  if (!industry || typeof industry !== 'string') {
    res.status(400).json({ success: false, error: 'industry is required' });
    return;
  }
  try {
    const suggestions = await aiService.generateDataDomains(industry);
    // The shared extractJson helper always returns a parsed value; we
    // still want a friendly error when the AI returned a *valid* but
    // wrong-shaped response (e.g. `{ items: [...] }` instead of the
    // top-level array we asked for). Tolerate both shapes here so a
    // single quirky generation doesn't bubble up as "no suggestions".
    let domains: Array<unknown> = [];
    if (Array.isArray(suggestions)) {
      domains = suggestions;
    } else if (suggestions && typeof suggestions === 'object') {
      const obj = suggestions as Record<string, unknown>;
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) { domains = v; break; }
      }
    }
    if (domains.length === 0) {
      logger.warn({ industry, suggestions }, 'Domain generation returned no array');
      res.status(502).json({
        success: false,
        error: 'The AI response did not contain a list of domains. Try again — Claude occasionally returns prose; a retry usually fixes it.',
      });
      return;
    }
    res.json({ success: true, data: domains });
  } catch (err: any) {
    // Surface the raw model response when available so the UI can show
    // what came back instead of just "failed".
    const message = err?.message || 'AI generation failed';
    const raw = err?.rawResponse as string | undefined;
    logger.error({ err, industry, raw }, 'Data domain generation failed');
    res.status(500).json({
      success: false,
      error: message,
      ...(raw ? { rawSnippet: raw.slice(0, 300) } : {}),
    });
  }
});

/**
 * POST /api/v1/data-domains/generate-subdomains
 *
 * Body: { industry, parentName, parentDescription? }
 * Suggests sub-domains for one parent domain (Domain → Sub-Domain). Like
 * /generate, returns suggestions without committing — the frontend previews
 * them and the user picks which to keep, then creates them with the parent set.
 */
router.post('/generate-subdomains', requireAiEnabled, enforceAiBudget, async (req: Request, res: Response) => {
  const { industry, parentName, parentDescription } = req.body || {};
  if (!industry || typeof industry !== 'string') {
    res.status(400).json({ success: false, error: 'industry is required' });
    return;
  }
  if (!parentName || typeof parentName !== 'string') {
    res.status(400).json({ success: false, error: 'parentName is required' });
    return;
  }
  try {
    const suggestions = await aiService.generateSubDomains(
      industry,
      parentName,
      typeof parentDescription === 'string' ? parentDescription : undefined,
    );
    // Tolerate both a top-level array and a { items: [...] } wrapper, exactly
    // like /generate.
    let subs: Array<unknown> = [];
    if (Array.isArray(suggestions)) {
      subs = suggestions;
    } else if (suggestions && typeof suggestions === 'object') {
      for (const v of Object.values(suggestions as Record<string, unknown>)) {
        if (Array.isArray(v)) { subs = v; break; }
      }
    }
    if (subs.length === 0) {
      logger.warn({ industry, parentName, suggestions }, 'Sub-domain generation returned no array');
      res.status(502).json({
        success: false,
        error: 'The AI response did not contain a list of sub-domains. Try again — Claude occasionally returns prose; a retry usually fixes it.',
      });
      return;
    }
    res.json({ success: true, data: subs });
  } catch (err: any) {
    const message = err?.message || 'AI generation failed';
    const raw = err?.rawResponse as string | undefined;
    logger.error({ err, industry, parentName, raw }, 'Sub-domain generation failed');
    res.status(500).json({
      success: false,
      error: message,
      ...(raw ? { rawSnippet: raw.slice(0, 300) } : {}),
    });
  }
});

router.delete('/all', async (_req: Request, res: Response) => {
  const all = await dataDomainsRepo.list();
  const count = all.length;
  for (const d of all) {
    await dataDomainsRepo.delete(d.id);
  }
  auditService.log('system', null, 'DataDomain', '*', 'DELETE_ALL', null, { count });
  logger.info({ count }, 'Deleted all data domains');
  res.json({ success: true, deleted: count });
});

/** GET /api/v1/data-domains — list all (support ?orgId= filter) */
router.get('/', async (req: Request, res: Response) => {
  const [allDomains, allPeople, allAssets] = await Promise.all([
    dataDomainsRepo.list(),
    peopleRepo().list(),
    dataAssetsRepo().list(),
  ]);
  const filtered = scopeListForRequest(req, allDomains);
  const enriched = filtered.map((d) => enrichDomain(d, allPeople, allAssets, allDomains));
  res.json({ success: true, data: enriched });
});

/** GET /api/v1/data-domains/summary — coverage stats */
router.get('/summary', async (req: Request, res: Response) => {
  const filtered = scopeListForRequest(req, await dataDomainsRepo.list());

  const total = filtered.length;
  const governed = filtered.filter((d) => d.ownerId).length;
  const ungoverned = total - governed;
  const totalAssetsInDomains = new Set(filtered.flatMap((d) => d.dataAssetIds)).size;

  res.json({
    success: true,
    data: { total, governed, ungoverned, totalAssetsInDomains },
  });
});

/** GET /api/v1/data-domains/:id — single domain with enriched data */
router.get('/:id', async (req: Request, res: Response) => {
  const [domain, allPeople, allAssets, allDomains] = await Promise.all([
    dataDomainsRepo.get(String(req.params.id)),
    peopleRepo().list(),
    dataAssetsRepo().list(),
    dataDomainsRepo.list(),
  ]);
  if (!domain) { res.status(404).json({ success: false, error: 'Data domain not found' }); return; }
  if (!assertOrgAccess(req, res, domain.orgId, 'Data domain not found')) return;
  res.json({ success: true, data: enrichDomain(domain, allPeople, allAssets, allDomains) });
});

/**
 * Validate & resolve an inbound parentDomainId for a domain in `orgId`.
 * Enforces single-level nesting (Domain → Sub-Domain only): the parent must
 * exist in the same org, must not be the domain itself, and must itself be a
 * top-level domain. A domain that already has its own sub-domains cannot be
 * turned into a sub-domain (that would create a third level).
 * Returns { skip:true } when the field wasn't provided (leave unchanged),
 * { value } on success (null = make top-level), or { error }.
 */
function resolveParentDomainId(
  raw: unknown,
  orgId: string,
  selfId: string | null,
  allDomains: StoredDataDomain[],
): { skip?: boolean; value?: string | null; error?: string } {
  if (raw === undefined) return { skip: true };
  if (raw === null || raw === '') return { value: null };
  if (typeof raw !== 'string') return { error: 'parentDomainId must be a domain id or null' };
  if (selfId && raw === selfId) return { error: 'A domain cannot be its own parent' };
  const parent = allDomains.find((d) => d.id === raw);
  if (!parent) return { error: 'Parent domain not found' };
  if (parent.orgId !== orgId) return { error: 'Parent domain belongs to a different organization' };
  if (parent.parentDomainId) return { error: `"${parent.name}" is already a sub-domain — nesting is one level deep` };
  if (selfId && allDomains.some((d) => d.parentDomainId === selfId)) {
    return { error: 'This domain has its own sub-domains, so it cannot become a sub-domain itself' };
  }
  return { value: raw };
}

/**
 * Scope Definition was merged into Description (they overlapped — both
 * describe "what this domain is"). Fold any incoming scopeDefinition into
 * description so nothing is lost: both present → two paragraphs; one → that
 * one; neither → undefined. Callers write the result to `description` and
 * stop persisting `scopeDefinition` (the column is kept but deprecated).
 */
function combineDescription(description?: string | null, scopeDefinition?: string | null): string | undefined {
  const d = (description || '').trim();
  const s = (scopeDefinition || '').trim();
  if (d && s) return d === s ? d : `${d}\n\n${s}`;
  return d || s || undefined;
}

/** POST /api/v1/data-domains — create */
router.post('/', async (req: Request, res: Response) => {
  const { name, description, orgId, status, scopeDefinition } = req.body;
  if (!name) { res.status(400).json({ success: false, error: 'Name is required' }); return; }
  if (!orgId) { res.status(400).json({ success: false, error: 'orgId is required' }); return; }

  const allDomains = await dataDomainsRepo.list();

  // Resolve the parent first — name uniqueness is scoped to it (siblings), not
  // the whole org: "Billing" may legitimately sit under both Customer and
  // Finance. The structured `code` is the global handle instead.
  const parentResult = resolveParentDomainId(req.body?.parentDomainId, orgId, null, allDomains);
  if (parentResult.error) { res.status(400).json({ success: false, error: parentResult.error }); return; }
  const resolvedParentId = parentResult.skip ? null : (parentResult.value ?? null);

  const nameClash = allDomains.find(
    (d) => d.orgId === orgId
      && (d.parentDomainId ?? null) === resolvedParentId
      && d.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (nameClash) {
    res.status(409).json({ success: false, error: `A data domain named "${name}" already exists ${resolvedParentId ? 'under this parent domain' : 'at the top level'}.` });
    return;
  }

  const parentForCode = resolvedParentId ? allDomains.find((d) => d.id === resolvedParentId) || null : null;
  const orgDomains = allDomains.filter((d) => d.orgId === orgId);

  // Code is the global handle within an org — a user-supplied one must be
  // unique; an auto-suggested one already dedupes against existing codes.
  let code: string;
  if (typeof req.body?.code === 'string' && req.body.code.trim()) {
    code = req.body.code.trim();
    const codeClash = orgDomains.find((d) => (d.code || '').trim().toLowerCase() === code.toLowerCase());
    if (codeClash) {
      res.status(409).json({ success: false, error: `Code "${code}" is already used by "${codeClash.name}". Codes must be unique within the organization.` });
      return;
    }
  } else {
    code = suggestDomainCode(name, parentForCode, orgDomains);
  }

  const now = new Date().toISOString();
  const domain: StoredDataDomain = {
    id: uuid(),
    orgId,
    name,
    // Scope Definition merged into Description.
    description: combineDescription(description, scopeDefinition) || '',
    ownerId: null,
    stewardIds: [],
    dataAssetIds: [],
    code,
    parentDomainId: resolvedParentId,
    criticality: VALID_CRITICALITY.includes(req.body?.criticality) ? req.body.criticality : undefined,
    status: status && VALID_STATUSES.includes(status) ? status : 'DRAFT',
    createdAt: now,
    updatedAt: now,
  };
  await dataDomainsRepo.create(domain);
  const [allPeople, allAssets] = await Promise.all([peopleRepo().list(), dataAssetsRepo().list()]);
  res.status(201).json({ success: true, data: enrichDomain(domain, allPeople, allAssets, [...allDomains, domain]) });
});

/** PUT /api/v1/data-domains/:id — update fields */
router.put('/:id', async (req: Request, res: Response) => {
  const domain = await dataDomainsRepo.get(String(req.params.id));
  if (!domain) { res.status(404).json({ success: false, error: 'Data domain not found' }); return; }
  if (!assertOrgAccess(req, res, domain.orgId, 'Data domain not found')) return;

  const { name, description, ownerId, stewardIds, dataAssetIds, status, scopeDefinition } = req.body;

  const hasFieldEdits = name !== undefined || description !== undefined
    || ownerId !== undefined || stewardIds !== undefined || scopeDefinition !== undefined;
  const domainOrg = getCachedOrgList().find((o) => o.id === domain.orgId) as any;
  const isAdvanced = domainOrg?.statusMode === 'advanced';
  const lockedSet = isAdvanced ? ADVANCED_LOCKED : SIMPLE_LOCKED;
  const transitionMap = isAdvanced ? ADVANCED_TRANSITIONS : SIMPLE_TRANSITIONS;
  if (hasFieldEdits && lockedSet.has(domain.status)) {
    res.status(403).json({
      success: false,
      error: `Cannot edit "${domain.name}" — it is currently ${domain.status.replace('_', ' ')}. Change its status to Draft first.`,
    });
    return;
  }

  // Resolve the (possibly new) parent first — sibling-uniqueness is scoped to
  // it. Validate name + code conflicts before mutating anything, so a rejected
  // update leaves the stored domain untouched.
  const allDomainsForParent = await dataDomainsRepo.list();
  const parentResult = resolveParentDomainId(req.body?.parentDomainId, domain.orgId, domain.id, allDomainsForParent);
  if (parentResult.error) { res.status(400).json({ success: false, error: parentResult.error }); return; }
  const effectiveParentId = parentResult.skip ? (domain.parentDomainId ?? null) : (parentResult.value ?? null);

  // Name must be unique among siblings (same org + same parent), not globally.
  const effectiveName = name !== undefined ? name : domain.name;
  const nameClash = allDomainsForParent.find(
    (d) => d.id !== domain.id
      && d.orgId === domain.orgId
      && (d.parentDomainId ?? null) === effectiveParentId
      && d.name.trim().toLowerCase() === String(effectiveName).trim().toLowerCase(),
  );
  if (nameClash) {
    res.status(409).json({ success: false, error: `A data domain named "${effectiveName}" already exists ${effectiveParentId ? 'under this parent domain' : 'at the top level'}.` });
    return;
  }

  // Code (when being set) must be unique across the whole org — it's the handle.
  if (req.body?.code !== undefined) {
    const nextCode = typeof req.body.code === 'string' && req.body.code.trim() ? req.body.code.trim() : undefined;
    if (nextCode) {
      const codeClash = allDomainsForParent.find(
        (d) => d.id !== domain.id && d.orgId === domain.orgId
          && (d.code || '').trim().toLowerCase() === nextCode.toLowerCase(),
      );
      if (codeClash) {
        res.status(409).json({ success: false, error: `Code "${nextCode}" is already used by "${codeClash.name}". Codes must be unique within the organization.` });
        return;
      }
    }
  }

  // Validation passed — apply the field edits.
  if (name !== undefined) domain.name = name;
  if (description !== undefined) domain.description = description;
  if (ownerId !== undefined) domain.ownerId = ownerId || null;
  if (stewardIds !== undefined && Array.isArray(stewardIds)) domain.stewardIds = stewardIds;
  if (dataAssetIds !== undefined && Array.isArray(dataAssetIds)) domain.dataAssetIds = dataAssetIds;
  if (req.body?.criticality !== undefined) {
    domain.criticality = VALID_CRITICALITY.includes(req.body.criticality) ? req.body.criticality : undefined;
  }
  if (req.body?.code !== undefined) {
    domain.code = typeof req.body.code === 'string' && req.body.code.trim() ? req.body.code.trim() : undefined;
  }
  if (!parentResult.skip) domain.parentDomainId = parentResult.value ?? null;
  // Scope Definition merged into Description: fold any incoming value in.
  if (scopeDefinition !== undefined) {
    domain.description = combineDescription(domain.description, scopeDefinition) || '';
  }

  // Validate status transition
  if (status !== undefined && status !== domain.status) {
    const allowed = transitionMap[domain.status] || [];
    if (!allowed.includes(status)) {
      res.status(400).json({
        success: false,
        error: `Cannot transition from ${domain.status.replace('_', ' ')} to ${status.replace('_', ' ')}. Valid transitions: ${allowed.map((s: string) => s.replace('_', ' ')).join(', ') || 'none'}.`,
      });
      return;
    }
    domain.status = status;
  }

  domain.updatedAt = new Date().toISOString();
  await dataDomainsRepo.update(domain.id, domain);

  const [allPeople, allAssets, allDomains] = await Promise.all([peopleRepo().list(), dataAssetsRepo().list(), dataDomainsRepo.list()]);
  res.json({ success: true, data: enrichDomain(domain, allPeople, allAssets, allDomains) });
});

/** GET /api/v1/data-domains/:id/impact — preview what would be affected by deleting this domain */
router.get('/:id/impact', async (req: Request, res: Response) => {
  const domain = await dataDomainsRepo.get(String(req.params.id));
  if (!domain) { res.status(404).json({ success: false, error: 'Data domain not found' }); return; }
  if (!assertOrgAccess(req, res, domain.orgId, 'Data domain not found')) return;

  // Sub-domains are re-homed to top-level on delete (not deleted). Surface the
  // names so the confirm dialog can warn the user before they lose the nesting.
  const subDomainNames = (await dataDomainsRepo.list())
    .filter((d) => d.parentDomainId === domain.id)
    .map((d) => d.name);

  res.json({
    success: true,
    data: {
      assets: domain.dataAssetIds.length,
      stewards: domain.stewardIds.length,
      subDomains: subDomainNames.length,
      subDomainNames,
    },
  });
});

/** DELETE /api/v1/data-domains/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  const removed = await dataDomainsRepo.get(String(req.params.id));
  if (!removed) { res.status(404).json({ success: false, error: 'Data domain not found' }); return; }
  if (!assertOrgAccess(req, res, removed.orgId, 'Data domain not found')) return;
  // Re-home any sub-domains to top-level before deleting the parent so they
  // aren't orphaned onto a dangling id. In Postgres the FK's onDelete:SetNull
  // handles this, but the JSON store has no cascade — do it explicitly so both
  // backends behave the same.
  const children = (await dataDomainsRepo.list()).filter((d) => d.parentDomainId === removed.id);
  for (const child of children) {
    child.parentDomainId = null;
    child.updatedAt = new Date().toISOString();
    await dataDomainsRepo.update(child.id, child);
  }
  await dataDomainsRepo.delete(removed.id);
  res.status(204).send();
});

/**
 * PATCH /api/v1/data-domains/bulk
 *
 * Body: { ids: string[], updates: { ownerId?, status? } }
 *
 * Applies the same partial update to every domain in `ids`. Unknown ids and
 * domains where the requested status transition is not allowed are skipped
 * (per-id reasons returned in the response). Locked-status edits to other
 * fields are also skipped to mirror the single-update endpoint's rules.
 */
router.patch('/bulk', async (req: Request, res: Response) => {
  const { ids, updates } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
    return;
  }
  if (!updates || typeof updates !== 'object') {
    res.status(400).json({ success: false, error: 'updates object is required' });
    return;
  }

  const now = new Date().toISOString();
  let updated = 0;
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const id of ids) {
    const domain = await dataDomainsRepo.get(String(id));
    if (!domain) { skipped.push({ id, reason: 'not found' }); continue; }

    const domainOrg = getCachedOrgList().find((o) => o.id === domain.orgId) as any;
    const isAdvanced = domainOrg?.statusMode === 'advanced';
    const lockedSet = isAdvanced ? ADVANCED_LOCKED : SIMPLE_LOCKED;
    const transitionMap = isAdvanced ? ADVANCED_TRANSITIONS : SIMPLE_TRANSITIONS;

    const wantsFieldEdit = updates.ownerId !== undefined;
    if (wantsFieldEdit && lockedSet.has(domain.status)) {
      skipped.push({ id, reason: `locked in ${domain.status}` });
      continue;
    }

    if (updates.status !== undefined && updates.status !== domain.status) {
      const allowed = transitionMap[domain.status] || [];
      if (!allowed.includes(updates.status)) {
        skipped.push({ id, reason: `cannot transition ${domain.status} → ${updates.status}` });
        continue;
      }
      domain.status = updates.status;
    }
    if (updates.ownerId !== undefined) domain.ownerId = updates.ownerId || null;

    domain.updatedAt = now;
    await dataDomainsRepo.update(domain.id, domain);
    auditService.log('system', domain.orgId, 'DataDomain', domain.id, 'BULK_UPDATE', null, domain);
    updated++;
  }

  logger.info({ updated, skipped: skipped.length }, 'Bulk-updated data domains');
  res.json({ success: true, updated, skipped });
});

/**
 * POST /api/v1/data-domains/bulk-delete
 *
 * Body: { ids: string[] }
 */
router.post('/bulk-delete', async (req: Request, res: Response) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
    return;
  }
  const idSet = new Set(ids);
  const removed = (await dataDomainsRepo.list()).filter((d) => idSet.has(d.id));
  for (const r of removed) {
    auditService.log('system', r.orgId, 'DataDomain', r.id, 'DELETE', r, null);
    await dataDomainsRepo.delete(r.id);
  }
  logger.info({ count: removed.length }, 'Bulk-deleted data domains');
  res.json({ success: true, deleted: removed.length });
});

export default router;
