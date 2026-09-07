import { Router, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { loadStore, saveStore, registerStore } from '../lib/persistence';
import { parseCsv } from '../lib/csv';
import logger from '../lib/logger';
import { AuthenticatedRequest } from '../middleware/auth';
import { getOrganizationsRepository } from '../db/organizations.repo';
import type { Repository } from '../db/repository';
import type { StoredPerson } from './people';
// Lazy-required inside handlers to avoid the circular import with
// `routes/people` (which imports the `organizations` array from this file).
// Using `require` at call-time ensures both modules are fully initialised
// before `getVisibleOrgIds` is invoked.
function accessHelpers(): typeof import('./people') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./people');
}

export interface StoredOrg {
  id: string;
  parentId: string | null;
  name: string;
  type: string;
  industry: string;
  description: string;
  headCount: number;
  statusMode?: 'simple' | 'review' | 'advanced';
  // ── SSO white-labeling ─────────────────────────────────────────
  // Only meaningful on company-level orgs. Populated when a
  // customer runs Procela under their own subdomain / tenant slug
  // and wants the sign-in card to read as their brand rather than
  // generic Procela.
  /** Tenant slug used to resolve branding on the login screen —
   *  either `<slug>.procela.io` as a subdomain or `?tenant=<slug>`
   *  as a query param. Lower-case ASCII + hyphens; unique across
   *  companies. */
  tenantSlug?: string;
  /** Human display name shown on the login card ("Tidewater
   *  Utilities" instead of "Procela"). Falls back to `name`. */
  brandDisplayName?: string;
  /** Emoji or single-character glyph rendered next to the display
   *  name. Kept text-only in v1 to sidestep asset upload +
   *  cache-invalidation complexity — a logo URL / SVG upload can
   *  come later without breaking existing rows. */
  brandGlyph?: string;
  /** Label on the primary SSO button — "Sign in with Corp SSO",
   *  "Sign in with Azure AD", etc. Falls back to the generic
   *  provider name when unset. */
  ssoButtonLabel?: string;
  /** Hex color (with leading #) used for the SSO button + accent.
   *  Falls back to Procela primary when unset. */
  brandPrimaryColor?: string;
  /** Which regulatory / export-control classification regimes are active for
   *  this tenant (subset of CUI / ITAR / EXPORT_CONTROLLED). Only meaningful
   *  on company-level orgs; gates the regulatory sensitivity tags in the
   *  classifier and UI. Undefined = all regimes active (back-compat with the
   *  built-in set). Universal data-sensitivity tags (PII/PHI/…) are never
   *  gated by this. */
  activeSensitivityRegimes?: string[];
  /** Which compliance frameworks (SOX / HIPAA / GDPR / …) are selectable as
   *  activity compliance tags for this tenant. Free-form — an org admin edits
   *  the list, so custom frameworks are allowed (no fixed enum). Undefined =
   *  the built-in set (back-compat with the hardcoded frontend list). Resolved
   *  by walking up to the first ancestor that sets it, so a company can set the
   *  framework list for its divisions. */
  activeComplianceFrameworks?: string[];
  /** Per-tenant Council Scorecard thresholds. Undefined = use the shipped
   *  defaults (coverage 80 / classification 70 / open issues 0 / exceptions 0
   *  / open-issue age 30 days). Resolved by walking up to the first ancestor
   *  that sets it, so a company can set the bar for its divisions. */
  scorecardTargets?: { coverage: number; classification: number; openIssues: number; exceptions: number; openIssuesDays: number } | null;
  // Data-sync tracking — set by the sync engine when this row was created or
  // updated from a SyncConnection source. Soft reference; absent when unsynced.
  syncConnectionId?: string | null;
  syncStatus?: string | null;
  createdAt: string;
  updatedAt: string;
}

const ORG_TYPES = ['company', 'division', 'department', 'team', 'unit'] as const;

const DEFAULT_ORG: StoredOrg = {
  id: '00000000-0000-0000-0000-000000000010',
  parentId: null,
  name: 'Default Organization',
  type: 'company',
  industry: '',
  description: '',
  headCount: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// Shape validator applied by loadStore — see lib/persistence.ts for
// the log-and-quarantine behaviour on drift. Every route in the app
// reads from this array, so a bad row here has a wide blast radius;
// the schema catches drift at boot rather than at the first read.
//
// The three "informational" fields (industry / description / headCount)
// carry safe defaults on parse. Older rows and every test fixture
// that predates them omit these fields, and forcing them to match
// would quarantine legitimate data — the safer behaviour is to
// backfill on load so downstream code sees the shape it expects
// while still catching genuine drift (missing id, wrong parentId
// type, etc.).
const organizationRowSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  type: z.string(),
  industry: z.string().default(''),
  description: z.string().default(''),
  headCount: z.number().default(0),
  statusMode: z.enum(['simple', 'review', 'advanced']).optional(),
  tenantSlug: z.string().optional(),
  brandDisplayName: z.string().optional(),
  brandGlyph: z.string().optional(),
  ssoButtonLabel: z.string().optional(),
  brandPrimaryColor: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // `unknown` for the input type so `z.string().default('')` (which
  // accepts `undefined` on the way in) doesn't clash with `StoredOrg`
  // where the field is a required string on the way out. Output type
  // is still pinned to StoredOrg, which is what downstream code sees.
}) satisfies z.ZodType<StoredOrg, z.ZodTypeDef, unknown>;

export const organizations: StoredOrg[] = loadStore<StoredOrg>('organizations', organizationRowSchema);
registerStore('organizations', organizations);

// Repository handle — reads/writes route through here when the
// route is on the async path. Reference conversion (GET /) below;
// remaining handlers still touch the shared `organizations` array
// directly. See docs/POSTGRES.md for the pattern used to convert
// individual handlers.
const orgRepo = getOrganizationsRepository(organizations);

// ── Repo-backed loader for the deletion-scope aggregators ──
//
// The /:id/impact and /:id/snapshot endpoints tally / export every entity
// tied to an org subtree — ~16 foreign stores. Each is fetched through its
// repository so these endpoints read Postgres in DB mode and the in-memory
// array in JSON mode (the factory wraps the same array the route exports).
// Lazy require() avoids the import cycle those route modules form with this
// one; a module that isn't loaded yet degrades to [] exactly as the prior
// defensive requires did.
const ORG_SCOPE_STORES: ReadonlyArray<{
  key: string; routePath: string; storeExport: string; repoPath: string; repoFactory: string;
}> = [
  { key: 'people',             routePath: './people',              storeExport: 'people',             repoPath: '../db/people.repo',              repoFactory: 'getPeopleRepository' },
  { key: 'processNodes',       routePath: './process-catalog',     storeExport: 'processNodes',       repoPath: '../db/process-nodes.repo',       repoFactory: 'getProcessNodesRepository' },
  { key: 'dataAssets',         routePath: './data-assets',         storeExport: 'dataAssets',         repoPath: '../db/data-assets.repo',         repoFactory: 'getDataAssetsRepository' },
  { key: 'systems',            routePath: './systems',             storeExport: 'systems',            repoPath: '../db/systems.repo',             repoFactory: 'getSystemsRepository' },
  { key: 'dataDomains',        routePath: './data-domains',        storeExport: 'dataDomains',        repoPath: '../db/data-domains.repo',        repoFactory: 'getDataDomainsRepository' },
  { key: 'mappings',           routePath: './mappings',            storeExport: 'mappings',           repoPath: '../db/mappings.repo',            repoFactory: 'getMappingsRepository' },
  { key: 'governanceGroups',   routePath: './governance-groups',   storeExport: 'governanceGroups',   repoPath: '../db/governance-groups.repo',   repoFactory: 'getGovernanceGroupsRepository' },
  { key: 'damaRoles',          routePath: './dama-roles',          storeExport: 'damaRoles',          repoPath: '../db/dama-roles.repo',          repoFactory: 'getDamaRolesRepository' },
  { key: 'governanceTasks',    routePath: './governance-tasks',    storeExport: 'governanceTasks',    repoPath: '../db/governance-tasks.repo',    repoFactory: 'getGovernanceTasksRepository' },
  { key: 'governanceIssues',   routePath: './governance-issues',   storeExport: 'governanceIssues',   repoPath: '../db/governance-issues.repo',   repoFactory: 'getGovernanceIssuesRepository' },
  { key: 'governancePolicies', routePath: './governance-policies', storeExport: 'governancePolicies', repoPath: '../db/governance-policies.repo', repoFactory: 'getGovernancePoliciesRepository' },
  { key: 'governanceControls', routePath: './governance-controls', storeExport: 'governanceControls', repoPath: '../db/governance-controls.repo', repoFactory: 'getGovernanceControlsRepository' },
  { key: 'glossaryTerms',      routePath: './business-glossary',   storeExport: 'glossaryTerms',      repoPath: '../db/glossary-terms.repo',      repoFactory: 'getGlossaryTermsRepository' },
  { key: 'sops',               routePath: './sops',                storeExport: 'sops',               repoPath: '../db/sops.repo',                repoFactory: 'getSopsRepository' },
  { key: 'calendarEvents',     routePath: './governance-calendar', storeExport: 'calendarEvents',     repoPath: '../db/calendar-events.repo',     repoFactory: 'getCalendarEventsRepository' },
  { key: 'decisionRights',     routePath: './decision-rights',     storeExport: 'decisionRights',     repoPath: '../db/decision-rights.repo',     repoFactory: 'getDecisionRightsRepository' },
];

async function loadOrgScopeStores(): Promise<Record<string, any[]>> {
  const out: Record<string, any[]> = {};
  await Promise.all(ORG_SCOPE_STORES.map(async (s) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const arr = require(s.routePath)[s.storeExport] || [];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const make = require(s.repoPath)[s.repoFactory];
      out[s.key] = await make(arr).list();
    } catch { out[s.key] = []; }
  }));
  return out;
}

// A single store's repository, keyed by the same registry. Used by the
// DELETE /:id cascade to delete/move/orphan rows through the repo (so the
// cascade actually mutates Postgres in DB mode, not stale JSON). Returns
// null if the owning module isn't loaded. Type is `Repository<any>`
// because the cascade operates uniformly on `orgId`/`orgIds` shapes.
function repoForStore(key: string): Repository<any> | null {
  const s = ORG_SCOPE_STORES.find((x) => x.key === key);
  if (!s) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const arr = require(s.routePath)[s.storeExport] || [];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const make = require(s.repoPath)[s.repoFactory];
    return make(arr) as Repository<any>;
  } catch { return null; }
}

// ── Helpers ──

function buildTree(orgs: StoredOrg[]): any[] {
  const map = new Map<string, any>();
  const roots: any[] = [];

  for (const org of orgs) {
    map.set(org.id, { ...org, children: [] });
  }

  for (const org of orgs) {
    const node = map.get(org.id);
    if (org.parentId && map.has(org.parentId)) {
      map.get(org.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

// ── Lazy repos for the two foreign stores the status-mode migration
// mutates. require() at call time (not a top-level import) preserves
// this file's documented circular-import avoidance: importing
// process-catalog eagerly would pull in people → organizations while
// this module is still mid-evaluation.
let _processNodesRepo: Repository<any> | null = null;
const processNodesRepo = (): Repository<any> =>
  (_processNodesRepo ??= require('../db/process-nodes.repo').getProcessNodesRepository(require('./process-catalog').processNodes));
let _dataDomainsRepo: Repository<any> | null = null;
const dataDomainsRepo = (): Repository<any> =>
  (_dataDomainsRepo ??= require('../db/data-domains.repo').getDataDomainsRepository(require('./data-domains').dataDomains));

const router = Router();

/** DELETE /api/v1/organizations/all — delete all organizations */
router.delete('/all', async (req: AuthenticatedRequest, res: Response) => {
  const { getVisibleOrgIds } = accessHelpers();
  if (getVisibleOrgIds(req.user) !== null) {
    res.status(403).json({ success: false, error: 'Only super admins can delete all organizations' });
    return;
  }
  const ids = (await orgRepo.list()).map((o) => o.id);
  const count = ids.length;
  for (const id of ids) {
    await orgRepo.delete(id);
  }
  await (require('../lib/org-scope').invalidateOrgScopeCache)();
  logger.info({ count }, 'Deleted all organizations');
  res.json({ success: true, deleted: count });
});

/**
 * GET /api/v1/organizations — returns flat list and tree, scoped to the
 * user's visible orgs and (optionally) narrowed to a subtree rooted at
 * `?scopeOrgId=<id>`. The frontend passes its active "Working In" context
 * as `scopeOrgId` so the user only sees the org they're currently working in
 * and its descendants.
 *
 * REFERENCE async handler for the route → repository conversion. Every
 * read that used to touch the exported `organizations` array now goes
 * through `orgRepo.list()`. On the JSON path that returns a fresh copy
 * of the same in-memory array; on the Postgres path (DATABASE_URL set)
 * the same call queries the database. Both paths satisfy the same
 * assertions.
 */
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const { getVisibleOrgIds, getDescendantOrgIds } = accessHelpers();
  const visible = getVisibleOrgIds(req.user);
  const all = await orgRepo.list();
  let scoped = visible === null
    ? all
    : all.filter((o) => visible.has(o.id));

  const scopeOrgId = typeof req.query.scopeOrgId === 'string' ? req.query.scopeOrgId : null;
  if (scopeOrgId) {
    const scopeRoot = all.find((o) => o.id === scopeOrgId);
    if (!scopeRoot) {
      res.status(404).json({ success: false, error: 'Scope organization not found' });
      return;
    }
    // Security: the scope must be in the user's visible set.
    if (visible !== null && !visible.has(scopeOrgId)) {
      res.status(403).json({ success: false, error: 'You do not have access to the specified scope organization' });
      return;
    }
    const subtreeIds = new Set<string>([scopeOrgId, ...getDescendantOrgIds(scopeOrgId)]);
    scoped = scoped.filter((o) => subtreeIds.has(o.id));
  }

  res.json({
    success: true,
    data: scoped,
    tree: buildTree(scoped),
    orgTypes: ORG_TYPES,
  });
});

/** GET /api/v1/organizations/:id */
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  const org = await orgRepo.get(req.params.id as string);
  if (!org) { res.status(404).json({ success: false, error: 'Organization not found' }); return; }
  const { canAccessOrg } = accessHelpers();
  if (!canAccessOrg(req.user, org.id)) {
    res.status(403).json({ success: false, error: 'You do not have access to this organization' });
    return;
  }
  res.json({ success: true, data: org });
});

/** POST /api/v1/organizations */
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  const { name, parentId, type, industry, description, headCount } = req.body;
  if (!name) { res.status(400).json({ success: false, error: 'Name is required' }); return; }
  if (parentId && !(await orgRepo.get(parentId))) {
    res.status(400).json({ success: false, error: 'Parent organization not found' });
    return;
  }
  const { getVisibleOrgIds } = accessHelpers();
  const visible = getVisibleOrgIds(req.user);
  if (parentId) {
    if (visible !== null && !visible.has(parentId)) {
      res.status(403).json({ success: false, error: 'You do not have access to the specified parent organization' });
      return;
    }
  } else if (visible !== null) {
    // A null parentId means creating a top-level org — reserved for unrestricted users.
    res.status(403).json({ success: false, error: 'Only super admins can create top-level organizations' });
    return;
  }
  const now = new Date().toISOString();
  const org: StoredOrg = {
    id: uuid(), parentId: parentId || null, name,
    type: type || 'department', industry: industry || '',
    description: description || '', headCount: headCount || 0,
    createdAt: now, updatedAt: now,
  };
  await orgRepo.create(org);
  // Refresh the org-scope cache so a system/asset owned by this new org can be
  // created in the same request burst (e.g. the seed scripts) without tripping
  // the "company or division level" check on a stale cache. Lazy-required to
  // avoid the org-scope ↔ organizations circular import.
  await (require('../lib/org-scope').invalidateOrgScopeCache)();

  // Bootstrap ownership: when an unrestricted user creates a *top-level* org
  // (the dev / super-admin bootstrap path), provision them as a real member of
  // it. The dev auth provider mints an org-less identity with no Person record,
  // so without this the org has no owner and the creator can't consistently
  // scope to the org they just made on later requests — the identity is a ghost
  // and getVisibleOrgIds can't anchor it (#420). No-op for child orgs (the
  // creator already sits in the tree) and for a user who is already a member.
  if (visible === null && !parentId && req.user?.email) {
    const peopleRepo = require('../db/people.repo').getPeopleRepository(require('./people').people);
    const email = req.user.email;
    const nowP = new Date().toISOString();
    const existing = (await peopleRepo.list()).find(
      (p: StoredPerson) => p.email.toLowerCase() === email.toLowerCase(),
    );
    if (!existing) {
      const knownRoles = ['SUPER_ADMIN', 'ORG_ADMIN', 'EDITOR', 'CONTRIBUTOR', 'VIEWER'];
      const person: StoredPerson = {
        id: uuid(),
        orgIds: [org.id],
        accessibleOrgIds: [org.id],
        name: req.user.name || email,
        email,
        // Preserve the caller's role so a real SUPER_ADMIN isn't downgraded to
        // ORG_ADMIN; default to ORG_ADMIN for the dev/company-creator case.
        role: (knownRoles.includes(req.user.role) ? req.user.role : 'ORG_ADMIN') as StoredPerson['role'],
        title: '',
        skillIds: [],
        createdAt: nowP,
        updatedAt: nowP,
      };
      await peopleRepo.create(person);
    } else if (!existing.orgIds.includes(org.id)) {
      await peopleRepo.update(existing.id, {
        ...existing,
        orgIds: [...existing.orgIds, org.id],
        accessibleOrgIds: [...(existing.accessibleOrgIds || []), org.id],
        updatedAt: nowP,
      });
    }
  }

  res.status(201).json({ success: true, data: org });
});

/** PUT /api/v1/organizations/:id */
router.put('/:id', async (req: AuthenticatedRequest, res: Response) => {
  const org = await orgRepo.get(req.params.id as string);
  if (!org) { res.status(404).json({ success: false, error: 'Organization not found' }); return; }
  const { canAccessOrg } = accessHelpers();
  if (!canAccessOrg(req.user, org.id)) {
    res.status(403).json({ success: false, error: 'You do not have access to this organization' });
    return;
  }
  const { name, parentId, type, industry, description, headCount } = req.body;
  // If the caller is trying to reparent, make sure the new parent is also in scope.
  if (parentId !== undefined && parentId !== org.parentId && parentId !== null) {
    if (!canAccessOrg(req.user, parentId)) {
      res.status(403).json({ success: false, error: 'You do not have access to the specified parent organization' });
      return;
    }
  }
  const { statusMode, tenantSlug, brandDisplayName, brandGlyph, ssoButtonLabel, brandPrimaryColor } = req.body;
  if (name !== undefined) org.name = name;
  if (parentId !== undefined) org.parentId = parentId;
  if (type !== undefined) org.type = type;
  if (industry !== undefined) org.industry = industry;
  if (description !== undefined) org.description = description;
  if (headCount !== undefined) org.headCount = headCount;
  if (statusMode !== undefined && (statusMode === 'simple' || statusMode === 'review' || statusMode === 'advanced')) org.statusMode = statusMode;

  // ── SSO white-labeling ──
  if (tenantSlug !== undefined) {
    const cleaned = typeof tenantSlug === 'string' ? tenantSlug.trim().toLowerCase() : '';
    if (cleaned === '') {
      org.tenantSlug = undefined;
    } else if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(cleaned)) {
      res.status(400).json({ success: false, error: 'tenantSlug must be 3-64 lowercase letters, digits, or hyphens (no leading/trailing hyphen).' });
      return;
    } else {
      const clash = (await orgRepo.list()).find((o) => o.id !== org.id && o.tenantSlug === cleaned);
      if (clash) {
        res.status(409).json({ success: false, error: `Tenant slug "${cleaned}" is already in use.` });
        return;
      }
      org.tenantSlug = cleaned;
    }
  }
  if (brandDisplayName !== undefined) org.brandDisplayName = typeof brandDisplayName === 'string' ? brandDisplayName.slice(0, 80) : undefined;
  if (brandGlyph !== undefined) org.brandGlyph = typeof brandGlyph === 'string' ? brandGlyph.slice(0, 8) : undefined;
  if (ssoButtonLabel !== undefined) org.ssoButtonLabel = typeof ssoButtonLabel === 'string' ? ssoButtonLabel.slice(0, 80) : undefined;
  if (brandPrimaryColor !== undefined) {
    if (brandPrimaryColor === '' || brandPrimaryColor === null) {
      org.brandPrimaryColor = undefined;
    } else if (typeof brandPrimaryColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(brandPrimaryColor)) {
      org.brandPrimaryColor = brandPrimaryColor;
    } else {
      res.status(400).json({ success: false, error: 'brandPrimaryColor must be a #RRGGBB hex string.' });
      return;
    }
  }
  // Active regulatory / export-control regimes for this tenant. Accepts an
  // array; invalid entries are dropped. Empty array = no regimes active.
  if (req.body?.activeSensitivityRegimes !== undefined) {
    const VALID_REGIMES = ['CUI', 'ITAR', 'EXPORT_CONTROLLED'];
    const raw = req.body.activeSensitivityRegimes;
    if (raw === null) {
      org.activeSensitivityRegimes = undefined;
    } else if (Array.isArray(raw)) {
      org.activeSensitivityRegimes = [...new Set(raw.filter((r) => VALID_REGIMES.includes(r)))];
    } else {
      res.status(400).json({ success: false, error: 'activeSensitivityRegimes must be an array of regime codes.' });
      return;
    }
  }
  // Compliance frameworks selectable as activity compliance tags. Free-form
  // (admin-edited list) so there's no fixed enum — accept any array of
  // non-empty strings, trimmed + deduped, and capped so a bad payload can't
  // balloon the row. Empty array = the tenant cleared every framework; null
  // clears back to the built-in default.
  if (req.body?.activeComplianceFrameworks !== undefined) {
    const raw = req.body.activeComplianceFrameworks;
    if (raw === null) {
      org.activeComplianceFrameworks = undefined;
    } else if (Array.isArray(raw)) {
      org.activeComplianceFrameworks = [
        ...new Set(raw.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)),
      ].slice(0, 100);
    } else {
      res.status(400).json({ success: false, error: 'activeComplianceFrameworks must be an array of framework names.' });
      return;
    }
  }
  // Per-tenant Council Scorecard thresholds. Accepts the five-number object;
  // null clears back to the shipped defaults. Percentages clamp to 0–100,
  // counts to >= 0, and the open-issue age to >= 1 day.
  if (req.body?.scorecardTargets !== undefined) {
    const raw = req.body.scorecardTargets;
    if (raw === null) {
      org.scorecardTargets = null;
    } else if (raw && typeof raw === 'object') {
      const clampPct = (v: unknown, d: number) => Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : d;
      const clampCount = (v: unknown, d: number) => Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : d;
      org.scorecardTargets = {
        coverage: clampPct(raw.coverage, 80),
        classification: clampPct(raw.classification, 70),
        openIssues: clampCount(raw.openIssues, 0),
        exceptions: clampCount(raw.exceptions, 0),
        openIssuesDays: Math.max(1, clampCount(raw.openIssuesDays, 30)),
      };
    } else {
      res.status(400).json({ success: false, error: 'scorecardTargets must be an object of threshold numbers, or null.' });
      return;
    }
  }
  org.updatedAt = new Date().toISOString();
  await orgRepo.update(org.id, org);
  // A type/parent change alters ownership-level and visibility; refresh the
  // scope cache so the change is reflected on the next request, not after the TTL.
  await (require('../lib/org-scope').invalidateOrgScopeCache)();
  res.json({ success: true, data: org });
});

/** DELETE /api/v1/organizations/:id */
/** GET /api/v1/organizations/:id/impact — preview what deleting this org would affect */
router.get('/:id/impact', async (req: AuthenticatedRequest, res: Response) => {
  const allOrgs = await orgRepo.list();
  const org = allOrgs.find((o) => o.id === req.params.id);
  if (!org) { res.status(404).json({ success: false, error: 'Organization not found' }); return; }

  // Collect this org + all descendant org IDs
  const orgIds = new Set<string>([org.id]);
  const collectDescendants = (parentId: string) => {
    for (const child of allOrgs.filter((o) => o.parentId === parentId)) {
      orgIds.add(child.id);
      collectDescendants(child.id);
    }
  };
  collectDescendants(org.id);

  // Count associated data across all stores. Each is read through its
  // repository (Postgres in DB mode, the in-memory array in JSON mode).
  const {
    people, processNodes, dataAssets, systems, dataDomains, mappings,
    governanceGroups, damaRoles, governanceTasks, governanceIssues,
    governancePolicies, governanceControls, glossaryTerms, sops,
    calendarEvents, decisionRights,
  } = await loadOrgScopeStores();

  const matchOrg = (item: any) => orgIds.has(item.orgId);
  const matchOrgIds = (item: any) => (item.orgIds || []).some((id: string) => orgIds.has(id));

  // Up to 3 sample names per category — turns "47 mappings" into
  // "47 mappings — Bills→Customer Master, Outages→SCADA, +44 more"
  // in the delete dialog so users see what they're actually about
  // to delete, not just a count.
  const SAMPLE_LIMIT = 3;
  const samplesOf = <T,>(items: T[], pick: (i: T) => string): string[] =>
    items.slice(0, SAMPLE_LIMIT).map(pick).filter(Boolean);
  const mappingLabel = (m: any) => {
    const node = processNodes.find((n: any) => n.id === m.processStepId);
    const asset = dataAssets.find((a: any) => a.id === m.dataAssetId);
    return `${node?.name || '?'} → ${asset?.name || '?'}`;
  };
  const childOrgsList = [...orgIds].filter((id) => id !== org.id)
    .map((id) => allOrgs.find((o) => o.id === id))
    .filter((o) => !!o);

  res.json({
    success: true,
    data: {
      childOrgs: orgIds.size - 1,
      people: people.filter(matchOrgIds).length,
      processes: processNodes.filter((n: any) => (n.orgIds || []).some((id: string) => orgIds.has(id)) || orgIds.has(n.orgId)).length,
      dataAssets: dataAssets.filter(matchOrg).length,
      systems: systems.filter(matchOrg).length,
      dataDomains: dataDomains.filter(matchOrg).length,
      mappings: mappings.filter(matchOrg).length,
      governanceGroups: governanceGroups.filter(matchOrg).length,
      damaRoles: damaRoles.filter((r: any) => orgIds.has(r.scopeId)).length,
      tasks: governanceTasks.filter(matchOrg).length,
      issues: governanceIssues.filter(matchOrg).length,
      policies: governancePolicies.filter(matchOrg).length,
      controls: governanceControls.filter(matchOrg).length,
      glossaryTerms: glossaryTerms.filter(matchOrg).length,
      sops: sops.filter(matchOrg).length,
      calendarEvents: calendarEvents.filter(matchOrg).length,
      decisionRights: decisionRights.filter(matchOrg).length,
      samples: {
        childOrgs:        samplesOf(childOrgsList, (o: any) => o.name),
        people:           samplesOf(people.filter(matchOrgIds), (p: any) => p.name),
        processes:        samplesOf(processNodes.filter((n: any) => (n.orgIds || []).some((id: string) => orgIds.has(id)) || orgIds.has(n.orgId)), (n: any) => n.name),
        dataAssets:       samplesOf(dataAssets.filter(matchOrg), (a: any) => a.name),
        systems:          samplesOf(systems.filter(matchOrg), (s: any) => s.name),
        dataDomains:      samplesOf(dataDomains.filter(matchOrg), (d: any) => d.name),
        mappings:         samplesOf(mappings.filter(matchOrg), mappingLabel),
        governanceGroups: samplesOf(governanceGroups.filter(matchOrg), (g: any) => g.name),
        damaRoles:        samplesOf(damaRoles.filter((r: any) => orgIds.has(r.scopeId)), (r: any) => r.roleLabel || r.roleType || r.id),
        tasks:            samplesOf(governanceTasks.filter(matchOrg), (t: any) => t.title || t.name || t.id),
        issues:           samplesOf(governanceIssues.filter(matchOrg), (i: any) => i.title || i.name || i.id),
        policies:         samplesOf(governancePolicies.filter(matchOrg), (p: any) => p.name),
        controls:         samplesOf(governanceControls.filter(matchOrg), (c: any) => c.name),
        glossaryTerms:    samplesOf(glossaryTerms.filter(matchOrg), (g: any) => g.term || g.name),
        sops:             samplesOf(sops.filter(matchOrg), (s: any) => s.title || s.name),
        calendarEvents:   samplesOf(calendarEvents.filter(matchOrg), (e: any) => e.title || e.name || e.id),
        decisionRights:   samplesOf(decisionRights.filter(matchOrg), (d: any) => d.decision || d.name || d.id),
      },
    },
  });
});

// GET /api/v1/organizations/:id/snapshot — full JSON dump of every
// entity the delete would touch. Used by the "Export org snapshot"
// button in the delete dialog so a user has a recovery archive
// before they pull the trigger.
router.get('/:id/snapshot', async (req: AuthenticatedRequest, res: Response) => {
  const allOrgs = await orgRepo.list();
  const org = allOrgs.find((o) => o.id === req.params.id);
  if (!org) { res.status(404).json({ success: false, error: 'Organization not found' }); return; }
  const { canAccessOrg } = accessHelpers();
  if (!canAccessOrg(req.user, org.id)) {
    res.status(403).json({ success: false, error: 'You do not have access to this organization' });
    return;
  }
  const orgIds = new Set<string>([org.id]);
  const walk = (parentId: string) => {
    for (const child of allOrgs.filter((o) => o.parentId === parentId)) {
      orgIds.add(child.id); walk(child.id);
    }
  };
  walk(org.id);

  // Each store is read through its repository (Postgres in DB mode, the
  // in-memory array in JSON mode) — mirrors the impact endpoint.
  const {
    people, processNodes, dataAssets, systems, dataDomains, mappings,
    governanceGroups, damaRoles, governanceTasks, governanceIssues,
    governancePolicies, governanceControls, glossaryTerms, sops,
    calendarEvents, decisionRights,
  } = await loadOrgScopeStores();

  const matchOrg = (item: any) => orgIds.has(item.orgId);
  const matchOrgIds = (item: any) => (item.orgIds || []).some((id: string) => orgIds.has(id));

  res.json({
    success: true,
    snapshot: {
      generatedAt: new Date().toISOString(),
      rootOrgId: org.id,
      rootOrgName: org.name,
      subtreeOrgIds: [...orgIds],
      // Every entity that would be touched by DELETE /:id (default
      // cascade). Re-importing this archive is not yet wired — the
      // file is a manual recovery aid for now.
      organizations: allOrgs.filter((o) => orgIds.has(o.id)),
      people: people.filter(matchOrgIds),
      processNodes: processNodes.filter((n: any) => (n.orgIds || []).some((id: string) => orgIds.has(id)) || orgIds.has(n.orgId)),
      dataAssets: dataAssets.filter(matchOrg),
      systems: systems.filter(matchOrg),
      dataDomains: dataDomains.filter(matchOrg),
      mappings: mappings.filter(matchOrg),
      governanceGroups: governanceGroups.filter(matchOrg),
      damaRoles: damaRoles.filter((r: any) => orgIds.has(r.scopeId)),
      governanceTasks: governanceTasks.filter(matchOrg),
      governanceIssues: governanceIssues.filter(matchOrg),
      governancePolicies: governancePolicies.filter(matchOrg),
      governanceControls: governanceControls.filter(matchOrg),
      glossaryTerms: glossaryTerms.filter(matchOrg),
      sops: sops.filter(matchOrg),
      calendarEvents: calendarEvents.filter(matchOrg),
      decisionRights: decisionRights.filter(matchOrg),
    },
  });
});

/**
 * DELETE /api/v1/organizations/:id
 *
 * Default behavior (empty body, or {"actions": {}}): cascade-deletes every
 * descendant org and every entity tied to the deleted subtree. This matches
 * the original cascade behavior so existing callers stay working.
 *
 * With an `actions` body, the caller can choose per-category cleanup:
 *   - "delete": drop every matching row (default for any unspecified key)
 *   - "move":   re-home every matching row to `targetOrgId`
 *   - "orphan": for multi-org entities only (people, processes), strip the
 *               removed org IDs from `orgIds[]`. If the array becomes empty
 *               the row is deleted.
 *
 * Body shape:
 *   {
 *     "actions": {
 *       "childOrgs": { "type": "move", "targetOrgId": "..." },
 *       "people":    { "type": "orphan" },
 *       "dataAssets":{ "type": "delete" },
 *       ...
 *     }
 *   }
 */
type ActionType = 'delete' | 'move' | 'orphan';
interface CategoryAction { type: ActionType; targetOrgId?: string }
type CategoryKey =
  | 'childOrgs' | 'people' | 'processes' | 'dataAssets' | 'systems'
  | 'dataDomains' | 'mappings' | 'governanceGroups' | 'damaRoles'
  | 'tasks' | 'issues' | 'policies' | 'controls'
  | 'glossaryTerms' | 'sops' | 'calendarEvents' | 'decisionRights';

const ORPHAN_ELIGIBLE: ReadonlySet<CategoryKey> = new Set<CategoryKey>(['people', 'processes']);

interface ApplyResult { deleted: number; moved: number; orphaned: number }

router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  const allOrgs = await orgRepo.list();
  const org = allOrgs.find((o) => o.id === req.params.id);
  if (!org) { res.status(404).json({ success: false, error: 'Organization not found' }); return; }
  const { canAccessOrg } = accessHelpers();
  if (!canAccessOrg(req.user, org.id)) {
    res.status(403).json({ success: false, error: 'You do not have access to this organization' });
    return;
  }

  // Compute the subtree from the repo-loaded org tree, not the stale
  // module array (people.getDescendantOrgIds reads that array, so it would
  // return [] in Postgres mode and the cascade would only touch the root).
  const descendantsOf = (parentId: string): string[] => {
    const out: string[] = [];
    for (const child of allOrgs.filter((o) => o.parentId === parentId)) {
      out.push(child.id, ...descendantsOf(child.id));
    }
    return out;
  };
  const subtreeIds = new Set<string>([org.id, ...descendantsOf(org.id)]);
  const directChildIds = new Set(allOrgs.filter((o) => o.parentId === org.id).map((o) => o.id));

  // Resolve and validate actions up front. An unspecified action defaults
  // to "delete" so callers that don't send a body get the original cascade.
  const incoming: Partial<Record<CategoryKey, CategoryAction>> = req.body?.actions || {};
  const resolved: Record<CategoryKey, CategoryAction> = {} as any;
  const KEYS: CategoryKey[] = [
    'childOrgs', 'people', 'processes', 'dataAssets', 'systems',
    'dataDomains', 'mappings', 'governanceGroups', 'damaRoles',
    'tasks', 'issues', 'policies', 'controls',
    'glossaryTerms', 'sops', 'calendarEvents', 'decisionRights',
  ];
  for (const key of KEYS) {
    const a = incoming[key] || { type: 'delete' };
    if (a.type !== 'delete' && a.type !== 'move' && a.type !== 'orphan') {
      res.status(400).json({ success: false, error: `Invalid action type for "${key}"` });
      return;
    }
    if (a.type === 'orphan' && !ORPHAN_ELIGIBLE.has(key)) {
      res.status(400).json({ success: false, error: `Orphan is only allowed for People and Processes (rejected for "${key}")` });
      return;
    }
    if (a.type === 'move') {
      if (!a.targetOrgId) {
        res.status(400).json({ success: false, error: `targetOrgId is required for move action on "${key}"` });
        return;
      }
      if (subtreeIds.has(a.targetOrgId)) {
        res.status(400).json({ success: false, error: `Move target for "${key}" cannot be inside the deleted subtree` });
        return;
      }
      if (!allOrgs.find((o) => o.id === a.targetOrgId)) {
        res.status(400).json({ success: false, error: `Move target organization for "${key}" not found` });
        return;
      }
      if (!canAccessOrg(req.user, a.targetOrgId)) {
        res.status(403).json({ success: false, error: `You do not have access to the move target for "${key}"` });
        return;
      }
    }
    resolved[key] = a;
  }

  // The set of org IDs whose entities receive the action. If child orgs are
  // being moved the descendants survive, so only the org itself is "removed."
  const removedOrgIds = resolved.childOrgs.type === 'move'
    ? new Set<string>([org.id])
    : new Set<string>(subtreeIds);

  // Apply child-org action first so subsequent entity ops see the right tree.
  let childOrgsDeleted = 0;
  let childOrgsMoved = 0;
  if (resolved.childOrgs.type === 'move') {
    // Reparent direct children only — descendants below them stay put.
    for (const o of allOrgs) {
      if (directChildIds.has(o.id)) {
        await orgRepo.update(o.id, {
          parentId: resolved.childOrgs.targetOrgId!,
          updatedAt: new Date().toISOString(),
        });
        childOrgsMoved++;
      }
    }
  } else {
    // Delete every descendant; the root org is removed at the end.
    for (const o of allOrgs) {
      if (subtreeIds.has(o.id) && o.id !== org.id) {
        await orgRepo.delete(o.id);
        childOrgsDeleted++;
      }
    }
  }

  // Track IDs that were physically removed so we can prune cross-references.
  const deletedIds = {
    people: new Set<string>(),
    processNodes: new Set<string>(),
    dataAssets: new Set<string>(),
    dataDomains: new Set<string>(),
    governanceGroups: new Set<string>(),
  };

  // ── Helpers for applying actions ────────────────────────────────────────
  // Both operate through the store's repository: read once via list(), then
  // delete()/update() each matched row. In JSON mode the repo wraps the same
  // in-memory array (so behaviour is unchanged); in Postgres mode the writes
  // land in the database. A null repo (module not loaded) is a no-op.
  const applySingleOrg = async (
    repo: Repository<any> | null,
    action: CategoryAction,
    deletedSet?: Set<string>,
    orgField: string = 'orgId',
  ): Promise<ApplyResult> => {
    let deleted = 0, moved = 0;
    if (!repo) return { deleted, moved, orphaned: 0 };
    const rows = await repo.list();
    for (const item of rows) {
      if (!removedOrgIds.has(item[orgField])) continue;
      if (action.type === 'delete') {
        if (deletedSet) deletedSet.add(item.id);
        await repo.delete(item.id); deleted++;
      } else if (action.type === 'move') {
        const patch: Record<string, any> = { [orgField]: action.targetOrgId! };
        if (item.updatedAt !== undefined) patch.updatedAt = new Date().toISOString();
        await repo.update(item.id, patch);
        moved++;
      }
    }
    return { deleted, moved, orphaned: 0 };
  };

  const applyMultiOrg = async (
    repo: Repository<any> | null,
    action: CategoryAction,
    deletedSet: Set<string>,
  ): Promise<ApplyResult> => {
    let deleted = 0, moved = 0, orphaned = 0;
    if (!repo) return { deleted, moved, orphaned };
    const rows = await repo.list();
    for (const item of rows) {
      const itemOrgIds: string[] = item.orgIds || [];
      const matched = itemOrgIds.some((id: string) => removedOrgIds.has(id))
        || (item.orgId !== undefined && removedOrgIds.has(item.orgId));
      if (!matched) continue;

      if (action.type === 'delete') {
        deletedSet.add(item.id); await repo.delete(item.id); deleted++;
        continue;
      }

      const remaining = itemOrgIds.filter((id: string) => !removedOrgIds.has(id));

      if (action.type === 'move') {
        const target = action.targetOrgId!;
        if (!remaining.includes(target)) remaining.push(target);
        const patch: Record<string, any> = { orgIds: remaining };
        if (item.orgId !== undefined && removedOrgIds.has(item.orgId)) patch.orgId = target;
        if (item.updatedAt !== undefined) patch.updatedAt = new Date().toISOString();
        await repo.update(item.id, patch);
        moved++;
      } else { // orphan
        if (remaining.length === 0) {
          // No surviving org → delete row instead of leaving it homeless.
          deletedSet.add(item.id); await repo.delete(item.id); deleted++;
        } else {
          const patch: Record<string, any> = { orgIds: remaining };
          if (item.orgId !== undefined && removedOrgIds.has(item.orgId)) patch.orgId = remaining[0];
          if (item.updatedAt !== undefined) patch.updatedAt = new Date().toISOString();
          await repo.update(item.id, patch);
          orphaned++;
        }
      }
    }
    return { deleted, moved, orphaned };
  };

  const summary: Record<string, ApplyResult> = {};

  // ── Apply actions per category ──────────────────────────────────────────
  try { summary.people           = await applyMultiOrg(repoForStore('people'),             resolved.people,            deletedIds.people); } catch {}
  try { summary.processes        = await applyMultiOrg(repoForStore('processNodes'),       resolved.processes,         deletedIds.processNodes); } catch {}
  try { summary.dataAssets       = await applySingleOrg(repoForStore('dataAssets'),        resolved.dataAssets,        deletedIds.dataAssets); } catch {}
  try { summary.systems          = await applySingleOrg(repoForStore('systems'),           resolved.systems); } catch {}
  try { summary.dataDomains      = await applySingleOrg(repoForStore('dataDomains'),       resolved.dataDomains,       deletedIds.dataDomains); } catch {}
  try { summary.mappings         = await applySingleOrg(repoForStore('mappings'),          resolved.mappings); } catch {}
  try { summary.governanceGroups = await applySingleOrg(repoForStore('governanceGroups'),  resolved.governanceGroups,  deletedIds.governanceGroups); } catch {}
  try { summary.damaRoles        = await applySingleOrg(repoForStore('damaRoles'),         resolved.damaRoles, undefined, 'scopeId'); } catch {}
  try { summary.tasks            = await applySingleOrg(repoForStore('governanceTasks'),   resolved.tasks); } catch {}
  try { summary.issues           = await applySingleOrg(repoForStore('governanceIssues'),  resolved.issues); } catch {}
  try { summary.policies         = await applySingleOrg(repoForStore('governancePolicies'), resolved.policies); } catch {}
  try { summary.controls         = await applySingleOrg(repoForStore('governanceControls'), resolved.controls); } catch {}
  try { summary.glossaryTerms    = await applySingleOrg(repoForStore('glossaryTerms'),     resolved.glossaryTerms); } catch {}
  try { summary.sops             = await applySingleOrg(repoForStore('sops'),              resolved.sops); } catch {}
  try { summary.calendarEvents   = await applySingleOrg(repoForStore('calendarEvents'),    resolved.calendarEvents); } catch {}
  try { summary.decisionRights   = await applySingleOrg(repoForStore('decisionRights'),    resolved.decisionRights); } catch {}

  // ── Cross-reference cleanup ─────────────────────────────────────────────
  // Anything physically deleted above leaves dangling IDs on surviving rows.
  // Prune them (through the repos) so we don't ship the org with stale refs.
  if (deletedIds.people.size > 0) {
    try {
      const gRepo = repoForStore('governanceGroups');
      if (gRepo) {
        for (const g of await gRepo.list()) {
          if (!Array.isArray(g.members)) continue;
          const members = g.members.filter((m: any) => !deletedIds.people.has(m.personId));
          if (members.length !== g.members.length) {
            await gRepo.update(g.id, { members, updatedAt: new Date().toISOString() });
          }
        }
      }
    } catch {}
    try {
      const dRepo = repoForStore('damaRoles');
      if (dRepo) {
        for (const r of await dRepo.list()) {
          if (r.personId && deletedIds.people.has(r.personId)) await dRepo.delete(r.id);
        }
      }
    } catch {}
  }

  if (deletedIds.dataAssets.size > 0) {
    try {
      const mRepo = repoForStore('mappings');
      if (mRepo) {
        for (const m of await mRepo.list()) {
          if (deletedIds.dataAssets.has(m.dataAssetId)) await mRepo.delete(m.id);
        }
      }
    } catch {}
    try {
      const ddRepo = repoForStore('dataDomains');
      if (ddRepo) {
        for (const d of await ddRepo.list()) {
          if (!Array.isArray(d.dataAssetIds)) continue;
          const dataAssetIds = d.dataAssetIds.filter((aid: string) => !deletedIds.dataAssets.has(aid));
          if (dataAssetIds.length !== d.dataAssetIds.length) {
            await ddRepo.update(d.id, { dataAssetIds, updatedAt: new Date().toISOString() });
          }
        }
      }
    } catch {}
  }

  if (deletedIds.processNodes.size > 0) {
    try {
      const mRepo = repoForStore('mappings');
      if (mRepo) {
        for (const m of await mRepo.list()) {
          if (deletedIds.processNodes.has(m.processStepId)) await mRepo.delete(m.id);
        }
      }
    } catch {}
  }

  // Finally, remove the root org itself.
  await orgRepo.delete(org.id);

  // Single summary audit entry — easier to scan than 16 separate lines.
  logger.info({
    orgId: org.id,
    orgName: org.name,
    actions: resolved,
    summary,
    childOrgsDeleted, childOrgsMoved,
  }, 'Deleted organization with cleanup');

  await (require('../lib/org-scope').invalidateOrgScopeCache)();
  res.json({
    success: true,
    deletedOrgId: org.id,
    childOrgs: { deleted: childOrgsDeleted, moved: childOrgsMoved },
    summary,
  });
});

/**
 * POST /api/v1/organizations/:id/status-mode
 * Switch between simple (Draft/Active/Deprecated) and advanced
 * (Draft/Proposed/Under Review/Approved/Active/Deprecated) status modes.
 * Migrates existing entity statuses when switching:
 * - advanced → simple: PROPOSED/UNDER_REVIEW/APPROVED → DRAFT
 * - simple → advanced: no migration needed (simple statuses are a subset)
 */
router.post('/:id/status-mode', async (req: AuthenticatedRequest, res: Response) => {
  const org = await orgRepo.get(req.params.id as string);
  if (!org) { res.status(404).json({ success: false, error: 'Organization not found' }); return; }

  const { mode } = req.body;
  if (mode !== 'simple' && mode !== 'review' && mode !== 'advanced') {
    res.status(400).json({ success: false, error: 'mode must be "simple", "review", or "advanced"' });
    return;
  }

  const oldMode = org.statusMode || 'simple';
  if (mode === oldMode) {
    res.json({ success: true, data: org, migrated: 0, message: `Already in ${mode} mode` });
    return;
  }

  org.statusMode = mode;
  org.updatedAt = new Date().toISOString();
  await orgRepo.update(org.id, org);

  // Migrate process nodes and data domains in this org's scope. When
  // switching *out of* a mode that carries statuses the new mode
  // doesn't recognise, park those rows back on DRAFT so the
  // transition machine on the target mode has valid ground state.
  let migrated = 0;
  const needsMigration = mode === 'simple' || mode === 'review';
  if (needsMigration) {
    // Compute the scope subtree from the repo-loaded org list, not the
    // stale module array (people.getDescendantOrgIds reads that array,
    // so it returns [] in Postgres mode and the migration would only
    // touch the root org).
    const allOrgs = await orgRepo.list();
    const descendantsOf = (parentId: string): string[] => {
      const out: string[] = [];
      for (const child of allOrgs.filter((o) => o.parentId === parentId)) {
        out.push(child.id, ...descendantsOf(child.id));
      }
      return out;
    };
    const scopeIds = new Set([org.id, ...descendantsOf(org.id)]);
    // Statuses that exist in advanced but neither simple nor review.
    // review understands PENDING_REVIEW natively, so leave those alone
    // when moving simple → review or vice versa. simple recognises
    // only DRAFT / ACTIVE / DEPRECATED and needs both bucket cleared.
    const legacyStatuses = mode === 'simple'
      ? new Set(['PROPOSED', 'UNDER_REVIEW', 'APPROVED', 'PENDING_REVIEW'])
      : new Set(['PROPOSED', 'UNDER_REVIEW', 'APPROVED']);

    // Read + write through the foreign repos so the migration lands in
    // Postgres in DB mode (a bare saveStore only rewrites the JSON store
    // and would silently drop these updates under Postgres).
    const nodes = await processNodesRepo().list();
    for (const node of nodes) {
      if ((scopeIds.has(node.orgId) || (node.orgIds || []).some((id: string) => scopeIds.has(id))) && legacyStatuses.has(node.status)) {
        await processNodesRepo().update(node.id, { status: 'DRAFT' });
        migrated++;
      }
    }

    const domains = await dataDomainsRepo().list();
    let domainsMigrated = 0;
    for (const d of domains) {
      if (scopeIds.has(d.orgId) && legacyStatuses.has(d.status)) {
        await dataDomainsRepo().update(d.id, { status: 'DRAFT' });
        domainsMigrated++;
      }
    }
    if (domainsMigrated > 0) { migrated += domainsMigrated; }
  }

  logger.info({ orgId: org.id, oldMode, newMode: mode, migrated }, 'Status mode switched');
  res.json({
    success: true,
    data: org,
    migrated,
    message: migrated > 0
      ? `Switched to ${mode} mode. ${migrated} item(s) migrated from review/approval statuses to Draft.`
      : `Switched to ${mode} mode.`,
  });
});

/**
 * POST /api/v1/organizations/import
 * Import org structure from JSON or CSV-style data.
 *
 * JSON format: { organizations: [{ name, parentName?, type?, industry?, description? }, ...] }
 * CSV format:  { csv: "Name,Parent,Type,Industry,Description\nAcme Corp,,company,..." }
 */
router.post('/import', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { organizations: orgList, csv, parentId } = req.body;
    const rootParent = parentId || null;
    const created: StoredOrg[] = [];
    const nameToId = new Map<string, string>();

    const { getVisibleOrgIds } = accessHelpers();
    const visible = getVisibleOrgIds(req.user);

    // Restricted users must import under an org they have access to. They can
    // never import rootless (top-level) orgs, and any explicit parentId has
    // to resolve to an accessible org.
    if (visible !== null) {
      if (!rootParent) {
        res.status(403).json({ success: false, error: 'Only super admins can import top-level organizations' });
        return;
      }
      if (!visible.has(rootParent)) {
        res.status(403).json({ success: false, error: 'You do not have access to the specified parent organization' });
        return;
      }
    }

    // Snapshot existing orgs once; reused for the name map, the
    // pre-existing-id set, and the dedup scan below.
    const allOrgs = await orgRepo.list();
    // Build map of existing orgs by name
    for (const existing of allOrgs) {
      nameToId.set(existing.name.toLowerCase(), existing.id);
    }

    let rows: Array<{ name: string; parentName?: string; type?: string; industry?: string; description?: string }> = [];

    if (csv && typeof csv === 'string') {
      const parsed = parseCsv(csv);
      if (parsed.length === 0) {
        res.status(400).json({ success: false, error: 'CSV appears to be empty' });
        return;
      }
      const header = parsed[0].map((h) => h.trim().toLowerCase());
      const nameIdx = header.indexOf('name');
      const parentIdx = header.indexOf('parent');
      const typeIdx = header.indexOf('type');
      const industryIdx = header.indexOf('industry');
      const descIdx = header.indexOf('description');

      if (nameIdx === -1) {
        res.status(400).json({ success: false, error: 'CSV must have a "Name" column' });
        return;
      }

      for (let i = 1; i < parsed.length; i++) {
        const cols = parsed[i].map((c) => c.trim());
        if (!cols[nameIdx]) continue;
        rows.push({
          name: cols[nameIdx],
          parentName: parentIdx >= 0 ? cols[parentIdx] : undefined,
          type: typeIdx >= 0 ? cols[typeIdx] : undefined,
          industry: industryIdx >= 0 ? cols[industryIdx] : undefined,
          description: descIdx >= 0 ? cols[descIdx] : undefined,
        });
      }
    } else if (Array.isArray(orgList)) {
      rows = orgList;
    } else {
      res.status(400).json({ success: false, error: 'Provide "organizations" array or "csv" string' });
      return;
    }

    if (rows.length === 0) {
      res.status(400).json({ success: false, error: 'No organizations to import' });
      return;
    }

    // Process in order — parents should come before children
    const now = new Date().toISOString();

    // Track which orgs existed before this import so dedup only checks
    // pre-existing records, not ones created in this batch.
    const preExistingIds = new Set(allOrgs.map((o) => o.id));
    const newlyCreated = new Set<string>();
    const skipped: string[] = [];

    for (const row of rows) {
      let pid = rootParent;
      if (row.parentName) {
        const parentKey = row.parentName.toLowerCase();
        if (nameToId.has(parentKey)) {
          pid = nameToId.get(parentKey)!;
        }
      }

      // Skip duplicates — same name + same parent, but only check
      // orgs that existed BEFORE this import (not ones created in this batch)
      const existingDup = allOrgs.find(
        (o) => preExistingIds.has(o.id) && o.name.toLowerCase() === row.name.toLowerCase() && o.parentId === pid,
      );
      if (existingDup) {
        skipped.push(row.name);
        continue;
      }

      // For restricted users, the resolved parent must be an accessible org
      // (or an org created earlier in this same import, which by construction
      // sits under an accessible root).
      if (visible !== null && pid && !visible.has(pid) && !newlyCreated.has(pid)) {
        res.status(403).json({
          success: false,
          error: `Row "${row.name}" resolves to a parent outside your accessible scope`,
        });
        return;
      }

      const org: StoredOrg = {
        id: uuid(), parentId: pid, name: row.name,
        type: row.type || 'department', industry: row.industry || '',
        description: row.description || '', headCount: 0,
        createdAt: now, updatedAt: now,
      };
      await orgRepo.create(org);
      created.push(org);
      newlyCreated.add(org.id);
      nameToId.set(org.name.toLowerCase(), org.id);
    }

    // Reflect the imported orgs in the scope cache so a follow-up systems /
    // data-assets CSV import (or seed step) sees them as valid owners.
    await (require('../lib/org-scope').invalidateOrgScopeCache)();
    logger.info({ created: created.length, skipped: skipped.length }, 'Imported organizations');
    res.status(201).json({
      success: true,
      data: created,
      tree: buildTree([...allOrgs, ...created]),
      skipped: skipped.length,
      skippedNames: skipped,
      message: skipped.length > 0
        ? `Imported ${created.length}, skipped ${skipped.length} duplicate(s): ${skipped.join(', ')}`
        : `Imported ${created.length} organization(s)`,
    });
  } catch (err) {
    logger.error({ err }, 'Organization import failed');
    res.status(500).json({ success: false, error: 'Import failed' });
  }
});

export default router;
