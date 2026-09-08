import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { auditService } from '../services/audit.service';
import { loadStore, saveStore, registerStore } from '../lib/persistence';
import { hasDatabase } from '../db/prisma';
import { filterByOrgScope, isOwnershipLevel } from '../lib/org-scope';
import { scopeListForRequest, assertOrgAccess } from '../lib/tenant-scope';
import { effectiveHealthScore } from '../lib/asset-health';
import { parseCsv } from '../lib/csv';
import logger from '../lib/logger';
import { dataAssets } from './data-assets';
import { connections, connectionSystemLinks } from './connections';
import { mappings } from './mappings';
import { getSystemsRepository } from '../db/systems.repo';
import { getConnectionsRepository } from '../db/connections.repo';
import { getConnectionSystemLinksRepository } from '../db/connection-system-links.repo';
import { getDataAssetsRepository } from '../db/data-assets.repo';
import { getMappingsRepository } from '../db/mappings.repo';
import { getPeopleRepository } from '../db/people.repo';
import { getProcessNodesRepository } from '../db/process-nodes.repo';

// Foreign-store repos, lazily bound — the systems route is imported by
// most of the catalog graph, so eager binding of a value-imported store
// would read it in the circular-import TDZ at boot. Each accessor defers
// construction to first call, after the cycle has settled. people /
// processNodes are require()d here (never top-imported) for the same
// reason the rest of this file lazy-requires them.
let _connsRepo: ReturnType<typeof getConnectionsRepository> | null = null;
const connsRepo = () => (_connsRepo ??= getConnectionsRepository(connections));
let _linksRepo: ReturnType<typeof getConnectionSystemLinksRepository> | null = null;
const linksRepo = () => (_linksRepo ??= getConnectionSystemLinksRepository(connectionSystemLinks));
let _dataAssetsRepo: ReturnType<typeof getDataAssetsRepository> | null = null;
const dataAssetsRepo = () => (_dataAssetsRepo ??= getDataAssetsRepository(dataAssets));
let _mappingsRepo: ReturnType<typeof getMappingsRepository> | null = null;
const mappingsRepo = () => (_mappingsRepo ??= getMappingsRepository(mappings));
let _peopleRepo: ReturnType<typeof getPeopleRepository> | null = null;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const peopleRepo = () => (_peopleRepo ??= getPeopleRepository(require('./people').people));
let _processNodesRepo: ReturnType<typeof getProcessNodesRepository> | null = null;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const processNodesRepo = () => (_processNodesRepo ??= getProcessNodesRepository(require('./process-catalog').processNodes));

export interface SystemIntegration {
  id: string;
  /** Target System in the catalog this integration points at. Empty
   *  string only on rows migrated from the legacy flat fields, until
   *  the user assigns a target. New rows always carry a real id. */
  targetSystemId: string;
  /** Interface used for this specific integration (REST_API, FILE_DROP,
   *  …). Empty only on legacy-migrated rows that had a frequency but no
   *  mechanism. */
  interfaceType: string;
  /** Optional cadence for this one integration. */
  frequency?: string;
  /** Data-flow direction relative to THIS system. */
  direction: 'INBOUND' | 'OUTBOUND' | 'BIDIRECTIONAL';
}

export interface StoredSystem {
  id: string;
  orgId: string;
  name: string;
  description: string;
  systemType: string;
  businessCriticality?: 'HIGH' | 'MEDIUM' | 'LOW';
  vendor?: string;
  /** Free-text notes about how this system integrates with others.
   *  Originally was the only place to capture integration info; now
   *  paired with the structured mechanism/frequency fields below. */
  integrationPoints?: string;
  /** Integration patterns this system uses. Multi-select so a system
   *  that exposes a REST API and also drops batch files can record
   *  both. Queryable for impact analysis ("which systems still rely
   *  on FILE_DROP?").
   *  @deprecated Superseded by `integrations` — a structured, directed
   *  edge to a specific target System with its own interface type and
   *  cadence. A one-time load migration folds any value here into
   *  `integrations` rows and then strips this field. Do not write it. */
  integrationMechanisms?: string[];
  /** How often the integration runs. Optional — many systems don't
   *  have a single canonical answer.
   *  @deprecated Superseded by per-integration `frequency`. Migrated and
   *  stripped on load alongside `integrationMechanisms`. */
  integrationFrequency?:
    | 'REAL_TIME'
    | 'EVENT_DRIVEN'
    | 'HOURLY'
    | 'DAILY'
    | 'WEEKLY'
    | 'MONTHLY'
    | 'ON_DEMAND';
  /** Directed integrations to other Systems in the catalog. Each row is
   *  one interface to one target system, with its own type, cadence and
   *  direction — so "feeds Billing via REST hourly" and "drops a nightly
   *  file to the Data Lake" are two distinct, individually-governable
   *  rows rather than two disconnected flat lists. */
  integrations?: SystemIntegration[];
  /** Single accountable business owner. Required for INTEGRATED
   *  systems (surfaced as a gap when missing); optional for
   *  MANUAL/EXTERNAL systems where the lifecycle sits outside Procela. */
  ownerPersonId?: string | null;
  /** Designated backup owner — same authority when the primary is
   *  unavailable, never both at once. Captures coverage / succession
   *  without breaking the "one accountable person" property the gap
   *  report and audit log rely on. */
  deputyOwnerId?: string | null;
  /** Technical caretakers — SREs, app admins, DBAs. Multiple is the
   *  norm for shared infrastructure. */
  custodianIds?: string[];
  /** How this system is intended to be reached. INTEGRATED expects one or
   *  more Connection profiles; MANUAL is a paper/spreadsheet/handoff
   *  process; EXTERNAL is vendor-managed with no API. Used by gap
   *  detection so a missing connection on a MANUAL system isn't a gap. */
  connectivity?: 'INTEGRATED' | 'MANUAL' | 'EXTERNAL';
  // Data-sync tracking — set by the sync engine when this row was created or
  // updated from a SyncConnection source. Soft reference; absent when unsynced.
  syncConnectionId?: string | null;
  syncStatus?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const systems: StoredSystem[] = loadStore<StoredSystem>('systems');
registerStore('systems', systems);

const systemsRepo = getSystemsRepository(systems);
const DEV_ORG_ID = '00000000-0000-0000-0000-000000000010';

const VALID_CONNECTIVITY = ['INTEGRATED', 'MANUAL', 'EXTERNAL'] as const;
const VALID_INTEGRATION_MECHANISMS = [
  'REST_API', 'SOAP', 'GRAPHQL', 'MESSAGE_QUEUE', 'EVENT_STREAM',
  'FILE_DROP', 'ETL_BATCH', 'DATABASE_REPLICATION', 'MANUAL_EXPORT',
] as const;
const VALID_INTEGRATION_FREQUENCY = [
  'REAL_TIME', 'EVENT_DRIVEN', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'ON_DEMAND',
] as const;
const VALID_INTEGRATION_DIRECTION = ['INBOUND', 'OUTBOUND', 'BIDIRECTIONAL'] as const;

// JSON mode only — these one-time boot migrations rewrite legacy rows in
// the in-memory array. Postgres rows carry the canonical shape (create
// sets it, schema defaults it), and reading the boot array in PG mode
// would just be a stale-store read.
if (!hasDatabase()) {
let connectivityMigrated = false;
for (const s of systems) {
  if (!s.connectivity) {
    s.connectivity = 'INTEGRATED';
    connectivityMigrated = true;
  }
}
// One-time strip of the legacy 'NONE' mechanism. NONE conflicted with
// the connectivity field (an INTEGRATED system declared "no mechanism")
// and is redundant with an empty array. Drop it everywhere — if the
// resulting array is empty, remove the field entirely so unrelated
// readers see the canonical "not specified" shape.
let mechanismsMigrated = false;
for (const s of systems) {
  if (!Array.isArray(s.integrationMechanisms)) continue;
  const cleaned = s.integrationMechanisms.filter((m) => m !== 'NONE');
  if (cleaned.length !== s.integrationMechanisms.length) {
    s.integrationMechanisms = cleaned.length > 0 ? cleaned : undefined;
    mechanismsMigrated = true;
  }
}
// One-time fold of the flat integrationMechanisms[] + single
// integrationFrequency into structured `integrations` rows. The flat
// fields could only ever say "this system uses REST and FILE_DROP,
// daily" with no target, so we can't infer the other end — each
// migrated row keeps targetSystemId empty for the user to fill in.
// One row per mechanism (lossless); a frequency-only system with no
// mechanism still gets one row so its cadence isn't dropped. After
// folding, the legacy fields are stripped so they have a single home.
let integrationsMigrated = false;
for (const s of systems) {
  if (Array.isArray(s.integrations)) {
    // Already migrated; just drop any straggler legacy fields.
    if (s.integrationMechanisms !== undefined || s.integrationFrequency !== undefined) {
      delete s.integrationMechanisms;
      delete s.integrationFrequency;
      integrationsMigrated = true;
    }
    continue;
  }
  const mechanisms = Array.isArray(s.integrationMechanisms) ? s.integrationMechanisms : [];
  const freq = s.integrationFrequency;
  if (mechanisms.length === 0 && !freq) continue;
  const rows: SystemIntegration[] = (mechanisms.length > 0 ? mechanisms : ['']).map((m) => ({
    id: uuid(),
    targetSystemId: '',
    interfaceType: m,
    ...(freq ? { frequency: freq } : {}),
    direction: 'BIDIRECTIONAL' as const,
  }));
  s.integrations = rows;
  delete s.integrationMechanisms;
  delete s.integrationFrequency;
  integrationsMigrated = true;
}
if (connectivityMigrated || mechanismsMigrated || integrationsMigrated) saveStore('systems', systems);
}

// One-time prune of dangling system references on entities outside the
// systems store. The system-delete handler clears these going forward,
// but stores written before that cascade existed (or by an import that
// bypassed the cascade) can still hold ids that no longer resolve to
// any system. Surfaces in the Analysis pivot as "(unknown system)"
// rows. Idempotent: each subsequent boot is a no-op once the store is
// clean.
// Deferred to the next tick so it runs AFTER all the circularly-imported
// stores (data-assets, process-catalog) have finished their own module
// bodies. Touching them during systems.ts init hits the TDZ on the
// other side's `export const`. By the next tick every module is fully
// loaded and the references are valid.
process.nextTick(() => {
  // JSON mode only — this prunes dangling cross-store references left in
  // legacy JSON files. In Postgres mode referential integrity is enforced
  // by FK constraints, and reading these boot arrays would be stale reads.
  if (hasDatabase()) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { dataAssets } = require('./data-assets') as typeof import('./data-assets');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { processNodes } = require('./process-catalog') as typeof import('./process-catalog');
  const validSystemIds = new Set(systems.map((s) => s.id));
  let assetsTouched = 0;
  for (const a of dataAssets) {
    if (a.systemId && !validSystemIds.has(a.systemId)) {
      a.systemId = '';
      assetsTouched++;
    }
  }
  if (assetsTouched > 0) {
    saveStore('dataAssets', dataAssets);
    logger.info({ assetsTouched }, 'Pruned dangling dataAssets.systemId references');
  }
  let nodesTouched = 0;
  for (const n of processNodes) {
    if (!n.systemIds || n.systemIds.length === 0) continue;
    const kept = n.systemIds.filter((sid) => validSystemIds.has(sid));
    if (kept.length !== n.systemIds.length) {
      n.systemIds = kept.length > 0 ? kept : undefined;
      nodesTouched++;
    }
  }
  if (nodesTouched > 0) {
    saveStore('processNodes', processNodes);
    logger.info({ nodesTouched }, 'Pruned dangling processNodes.systemIds references');
  }
  // connectionSystemLinks rows whose `systemId` no longer resolves to a
  // real system. The DELETE handler cascades these going forward; this
  // catches links from stores written before that cascade existed (or
  // from imports / direct edits that bypassed it). Each surviving link
  // becomes a sys-conn fact in the analysis cube — a dangling one
  // shows up as an "(unknown system)" row.
  let linksTouched = 0;
  for (let i = connectionSystemLinks.length - 1; i >= 0; i--) {
    if (!validSystemIds.has(connectionSystemLinks[i].systemId)) {
      connectionSystemLinks.splice(i, 1);
      linksTouched++;
    }
  }
  if (linksTouched > 0) {
    saveStore('connectionSystemLinks', connectionSystemLinks);
    logger.info({ linksTouched }, 'Pruned dangling connectionSystemLinks rows');
  }
});

const SYSTEM_TYPES = [
  'ERP', 'CRM', 'GIS', 'SCADA', 'Data Warehouse', 'Data Lake',
  'Business Intelligence', 'Document Management', 'HRIS', 'Financial',
  'Asset Management', 'Customer Portal', 'Billing', 'Spreadsheet', 'Other',
];

const router = Router();

/**
 * Roll connection-profile statuses up to a single system-level pill the UI
 * can render without doing its own join. INTEGRATED systems with zero
 * profiles are flagged so they show up in coverage gaps; MANUAL/EXTERNAL
 * systems return their connectivity verbatim so the absent connection
 * isn't treated as missing.
 */
function profilesForSystem(
  systemId: string,
  allConns: typeof connections,
  allLinks: typeof connectionSystemLinks,
) {
  // Connection↔system is many-to-many via the join table — the sole
  // source of truth now that the legacy single `systemId` is retired.
  const linkedIds = new Set(
    allLinks.filter((l) => l.systemId === systemId).map((l) => l.connectionId),
  );
  return allConns.filter((c) => linkedIds.has(c.id));
}

function rollupConnectionStatus(
  sys: StoredSystem,
  allConns: typeof connections,
  allLinks: typeof connectionSystemLinks,
): 'CONNECTED' | 'ERROR' | 'UNTESTED' | 'NOT_CONNECTED' | 'MANUAL' | 'EXTERNAL' {
  const profiles = profilesForSystem(sys.id, allConns, allLinks);
  if (profiles.length === 0) {
    if (sys.connectivity === 'MANUAL') return 'MANUAL';
    if (sys.connectivity === 'EXTERNAL') return 'EXTERNAL';
    return 'NOT_CONNECTED';
  }
  if (profiles.some((p) => p.status === 'ERROR')) return 'ERROR';
  if (profiles.some((p) => p.status === 'CONNECTED')) return 'CONNECTED';
  return 'UNTESTED';
}

/** Resolve owner + custodian person ids to display names off a
 *  pre-loaded people snapshot (Postgres or JSON). The caller loads
 *  people once per request and passes it in so a list of N systems
 *  doesn't fan out into N store reads. */
function resolveOwnership(
  sys: StoredSystem,
  allPeople: Array<{ id: string; name: string }>,
): {
  ownerName: string | null;
  deputyOwnerName: string | null;
  custodianNames: string[];
} {
  const ownerName = sys.ownerPersonId
    ? allPeople.find((p) => p.id === sys.ownerPersonId)?.name || null
    : null;
  const deputyOwnerName = sys.deputyOwnerId
    ? allPeople.find((p) => p.id === sys.deputyOwnerId)?.name || null
    : null;
  const custodianNames = (sys.custodianIds || [])
    .map((id) => allPeople.find((p) => p.id === id)?.name)
    .filter((n): n is string => !!n);
  return { ownerName, deputyOwnerName, custodianNames };
}

/** Resolve a stored integration's target into a display name so the UI
 *  can render the edge without its own per-row join. */
function enrichIntegrations(sys: StoredSystem, allSystems: StoredSystem[]) {
  return (sys.integrations || []).map((i) => ({
    ...i,
    targetSystemName: i.targetSystemId
      ? allSystems.find((s) => s.id === i.targetSystemId)?.name || null
      : null,
  }));
}

/** The inverse view: integrations OTHER systems declared pointing at
 *  this one. Derived, never stored — so a user only has to declare an
 *  edge from one side and both systems show the connection. */
function referencedByIntegrations(sysId: string, allSystems: StoredSystem[]) {
  const out: Array<{
    systemId: string; systemName: string;
    interfaceType: string; frequency?: string; direction: string;
  }> = [];
  for (const s of allSystems) {
    if (s.id === sysId) continue;
    for (const i of s.integrations || []) {
      if (i.targetSystemId !== sysId) continue;
      out.push({
        systemId: s.id, systemName: s.name,
        interfaceType: i.interfaceType,
        ...(i.frequency ? { frequency: i.frequency } : {}),
        direction: i.direction,
      });
    }
  }
  return out;
}

function decorate(
  sys: StoredSystem,
  allSystems: StoredSystem[],
  allPeople: Array<{ id: string; name: string }>,
  allConns: typeof connections,
  allLinks: typeof connectionSystemLinks,
) {
  const { ownerName, deputyOwnerName, custodianNames } = resolveOwnership(sys, allPeople);
  return {
    ...sys,
    connectivity: sys.connectivity || 'INTEGRATED',
    connectionCount: profilesForSystem(sys.id, allConns, allLinks).length,
    connectionStatus: rollupConnectionStatus(sys, allConns, allLinks),
    integrations: enrichIntegrations(sys, allSystems),
    integrationCount: (sys.integrations || []).length,
    ownerName,
    deputyOwnerName,
    custodianNames,
  };
}

/** DELETE /api/v1/systems/all — delete all systems */
router.delete('/all', async (_req: Request, res: Response) => {
  const all = await systemsRepo.list();
  const count = all.length;
  const ids = all.map((s) => s.id);
  for (const id of ids) await systemsRepo.delete(id);
  auditService.log(DEV_ORG_ID, null, 'System', '*', 'DELETE_ALL', null, { count });
  logger.info({ count }, 'Deleted all systems');
  res.json({ success: true, deleted: count });
});

/** GET /api/v1/systems */
router.get('/', async (req: Request, res: Response) => {
  const [all, allPeople, allConns, allLinks] = await Promise.all([
    systemsRepo.list(), peopleRepo().list(), connsRepo().list(), linksRepo().list(),
  ]);
  const filtered = scopeListForRequest(req, all);
  res.json({
    success: true,
    data: filtered.map((s) => decorate(s, all, allPeople, allConns, allLinks)),
    systemTypes: SYSTEM_TYPES,
    connectivityOptions: VALID_CONNECTIVITY,
    integrationMechanismOptions: VALID_INTEGRATION_MECHANISMS,
    integrationFrequencyOptions: VALID_INTEGRATION_FREQUENCY,
    integrationDirectionOptions: VALID_INTEGRATION_DIRECTION,
  });
});

/** GET /api/v1/systems/:id */
router.get('/:id', async (req: Request, res: Response) => {
  const [all, allPeople, allConns, allLinks] = await Promise.all([
    systemsRepo.list(), peopleRepo().list(), connsRepo().list(), linksRepo().list(),
  ]);
  const sys = all.find((s) => s.id === req.params.id);
  if (!sys) { res.status(404).json({ success: false, error: 'System not found' }); return; }
  if (!assertOrgAccess(req, res, sys.orgId, 'System not found')) return;
  res.json({
    success: true,
    data: {
      ...decorate(sys, all, allPeople, allConns, allLinks),
      referencedByIntegrations: referencedByIntegrations(sys.id, all),
    },
  });
});

/** GET /api/v1/systems/:id/360 — full cross-layer view of a System.
 *
 *  Resolves the connections that serve this system, the data assets
 *  that live here, the activities that depend on those assets (one
 *  more join through the mappings table), and the people accountable
 *  (owner, deputy, custodians). Used by the System detail modal's
 *  WhereUsed panel so all three layers are visible from one page. */
router.get('/:id/360', async (req: Request, res: Response) => {
  const [all, allPeople, allConns, allLinks, allAssets, allMappings, allNodes] = await Promise.all([
    systemsRepo.list(), peopleRepo().list(), connsRepo().list(), linksRepo().list(),
    dataAssetsRepo().list(), mappingsRepo().list(), processNodesRepo().list(),
  ]);
  const sys = all.find((s) => s.id === req.params.id);
  if (!sys) { res.status(404).json({ success: false, error: 'System not found' }); return; }
  if (!assertOrgAccess(req, res, sys.orgId, 'System not found')) return;

  const linkedConnections = profilesForSystem(sys.id, allConns, allLinks).map((c) => ({
    id: c.id,
    name: c.name,
    connectionType: c.connectionType,
    status: c.status,
  }));

  // Effective health: measured DQ score, or 0 when no measured rule backs
  // the asset — health is earned from measured quality, not a stand-in.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const measuredCounts = await (require('./data-quality') as typeof import('./data-quality')).measuredRuleCountsByAsset();
  const assetsHere = allAssets
    .filter((a) => a.systemId === sys.id)
    .map((a) => ({
      id: a.id,
      name: a.name,
      governanceTier: a.governanceTier,
      healthScore: effectiveHealthScore(a.healthScore, measuredCounts.get(a.id) || 0),
    }));

  // Activities that depend on any of the assets here — one hop through
  // mappings. Dedup by activity id since multiple assets may share one.
  const assetIdSet = new Set(assetsHere.map((a) => a.id));
  const seenActivity = new Set<string>();
  const dependentActivities: Array<{ id: string; name: string; path: string }> = [];
  for (const m of allMappings) {
    if (!m.dataAssetId || !assetIdSet.has(m.dataAssetId)) continue;
    if (seenActivity.has(m.processStepId)) continue;
    seenActivity.add(m.processStepId);
    const node = allNodes.find((n) => n.id === m.processStepId);
    if (!node) continue;
    const parts: string[] = [node.name];
    let current = node;
    while (current.parentId) {
      const parent = allNodes.find((n) => n.id === current.parentId);
      if (!parent) break;
      parts.unshift(parent.name);
      current = parent;
    }
    dependentActivities.push({ id: node.id, name: node.name, path: parts.join(' > ') });
  }

  const ownerName = sys.ownerPersonId
    ? allPeople.find((p) => p.id === sys.ownerPersonId)?.name || null
    : null;
  const deputyOwnerName = sys.deputyOwnerId
    ? allPeople.find((p) => p.id === sys.deputyOwnerId)?.name || null
    : null;
  const custodianRefs = (sys.custodianIds || [])
    .map((id) => allPeople.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => ({ id: p.id, name: p.name, title: (p as { title?: string }).title || null }));

  res.json({
    success: true,
    data: {
      system: {
        ...decorate(sys, all, allPeople, allConns, allLinks),
        referencedByIntegrations: referencedByIntegrations(sys.id, all),
      },
      linkedConnections,
      assetsHere,
      dependentActivities,
      ownership: {
        owner: sys.ownerPersonId ? { id: sys.ownerPersonId, name: ownerName } : null,
        deputy: sys.deputyOwnerId ? { id: sys.deputyOwnerId, name: deputyOwnerName } : null,
        custodians: custodianRefs,
      },
    },
  });
});

/** Validate the structured integrations array. `selfId` is the system
 *  being saved so a system can't declare an integration with itself.
 *  Empty interfaceType/targetSystemId are tolerated (legacy-migrated
 *  rows the user hasn't completed yet); non-empty values are checked.
 *  Exact (target, interface, direction) triples are de-duped. */
function validateIntegrations(
  value: unknown,
  selfId: string,
  allSystems: StoredSystem[],
): { ok: true; value: SystemIntegration[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: 'integrations must be an array' };
  const out: SystemIntegration[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'each integration must be an object' };
    }
    const r = raw as Record<string, unknown>;
    const targetSystemId = typeof r.targetSystemId === 'string' ? r.targetSystemId.trim() : '';
    if (targetSystemId) {
      if (targetSystemId === selfId) {
        return { ok: false, error: 'a system cannot integrate with itself' };
      }
      if (!allSystems.some((s) => s.id === targetSystemId)) {
        return { ok: false, error: `integration target "${targetSystemId}" is not a known system` };
      }
    }
    const interfaceType = typeof r.interfaceType === 'string' ? r.interfaceType.trim() : '';
    if (interfaceType && !VALID_INTEGRATION_MECHANISMS.includes(interfaceType as any)) {
      return { ok: false, error: `interfaceType "${interfaceType}" must be one of ${VALID_INTEGRATION_MECHANISMS.join(', ')}` };
    }
    const freqRaw = typeof r.frequency === 'string' ? r.frequency.trim() : '';
    if (freqRaw && !VALID_INTEGRATION_FREQUENCY.includes(freqRaw as any)) {
      return { ok: false, error: `frequency "${freqRaw}" must be one of ${VALID_INTEGRATION_FREQUENCY.join(', ')}` };
    }
    const direction = typeof r.direction === 'string' && VALID_INTEGRATION_DIRECTION.includes(r.direction as any)
      ? (r.direction as SystemIntegration['direction'])
      : 'BIDIRECTIONAL';
    const key = `${targetSystemId}|${interfaceType}|${direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : uuid(),
      targetSystemId,
      interfaceType,
      ...(freqRaw ? { frequency: freqRaw } : {}),
      direction,
    });
  }
  return { ok: true, value: out };
}

/** POST /api/v1/systems */
router.post('/', async (req: Request, res: Response) => {
  const { name, description, systemType, orgId, businessCriticality, vendor, integrationPoints, connectivity, integrations, ownerPersonId, deputyOwnerId, custodianIds } = req.body;
  if (!name) { res.status(400).json({ success: false, error: 'Name is required' }); return; }
  if (connectivity && !VALID_CONNECTIVITY.includes(connectivity)) {
    res.status(400).json({ success: false, error: `connectivity must be one of ${VALID_CONNECTIVITY.join(', ')}` });
    return;
  }
  // Ownership-level guard: systems attach to one org, but only at
  // the company or division level. Skip when no orgId was supplied
  // so the DEV_ORG_ID fallback path keeps working unchanged.
  if (orgId && !isOwnershipLevel(orgId)) {
    res.status(400).json({ success: false, error: 'Systems can only be owned at the company or division level. Pick a different org from "Working in...".' });
    return;
  }
  const newId = uuid();
  const integ = validateIntegrations(integrations, newId, await systemsRepo.list());
  if (!integ.ok) { res.status(400).json({ success: false, error: integ.error }); return; }
  const cleanedCustodians = Array.isArray(custodianIds)
    ? Array.from(new Set(custodianIds.filter((c) => typeof c === 'string' && c.trim())))
    : [];
  // Deputy must be a different person from the primary; otherwise the
  // backup-coverage semantics break and audit logs see two identical
  // accountabilities.
  if (typeof ownerPersonId === 'string' && ownerPersonId
      && typeof deputyOwnerId === 'string' && deputyOwnerId
      && ownerPersonId === deputyOwnerId) {
    res.status(400).json({ success: false, error: 'deputyOwnerId must be a different person from ownerPersonId' });
    return;
  }
  const now = new Date().toISOString();
  const sys: StoredSystem = {
    id: newId, orgId: orgId || DEV_ORG_ID, name,
    description: description || '', systemType: systemType || '',
    connectivity: connectivity || 'INTEGRATED',
    ...(businessCriticality ? { businessCriticality } : {}),
    ...(vendor ? { vendor } : {}),
    ...(integrationPoints ? { integrationPoints } : {}),
    ...(integ.value.length > 0 ? { integrations: integ.value } : {}),
    ...(typeof ownerPersonId === 'string' && ownerPersonId ? { ownerPersonId } : {}),
    ...(typeof deputyOwnerId === 'string' && deputyOwnerId ? { deputyOwnerId } : {}),
    ...(cleanedCustodians.length > 0 ? { custodianIds: cleanedCustodians } : {}),
    createdAt: now, updatedAt: now,
  };
  await systemsRepo.create(sys);
  auditService.log(sys.orgId, null, 'System', sys.id, 'CREATE', null, sys);
  res.status(201).json({ success: true, data: sys });
});

/** PUT /api/v1/systems/:id */
router.put('/:id', async (req: Request, res: Response) => {
  const all = await systemsRepo.list();
  const sys = all.find((s) => s.id === req.params.id);
  if (!sys) { res.status(404).json({ success: false, error: 'System not found' }); return; }
  if (!assertOrgAccess(req, res, sys.orgId, 'System not found')) return;
  const { name, description, systemType, businessCriticality, vendor, integrationPoints, connectivity, integrations, ownerPersonId, deputyOwnerId, custodianIds } = req.body;
  if (connectivity !== undefined && !VALID_CONNECTIVITY.includes(connectivity)) {
    res.status(400).json({ success: false, error: `connectivity must be one of ${VALID_CONNECTIVITY.join(', ')}` });
    return;
  }
  if (integrations !== undefined) {
    const integ = validateIntegrations(integrations, sys.id, all);
    if (!integ.ok) { res.status(400).json({ success: false, error: integ.error }); return; }
    sys.integrations = integ.value.length > 0 ? integ.value : undefined;
  }
  if (name !== undefined) sys.name = name;
  if (description !== undefined) sys.description = description;
  if (systemType !== undefined) sys.systemType = systemType;
  if (businessCriticality !== undefined) sys.businessCriticality = businessCriticality || undefined;
  if (vendor !== undefined) sys.vendor = vendor || undefined;
  if (integrationPoints !== undefined) sys.integrationPoints = integrationPoints || undefined;
  if (connectivity !== undefined) sys.connectivity = connectivity;
  if (ownerPersonId !== undefined) {
    // Empty string clears the assignment so the system shows as
    // ownerless (and surfaces in the gap report).
    sys.ownerPersonId = ownerPersonId === '' || ownerPersonId === null ? null : String(ownerPersonId);
  }
  if (deputyOwnerId !== undefined) {
    sys.deputyOwnerId = deputyOwnerId === '' || deputyOwnerId === null ? null : String(deputyOwnerId);
  }
  // After applying the patches above, re-check the same-person rule
  // so a partial PUT (just deputy, owner already set) is still caught.
  if (sys.ownerPersonId && sys.deputyOwnerId && sys.ownerPersonId === sys.deputyOwnerId) {
    res.status(400).json({ success: false, error: 'deputyOwnerId must be a different person from ownerPersonId' });
    return;
  }
  if (custodianIds !== undefined) {
    if (!Array.isArray(custodianIds)) {
      res.status(400).json({ success: false, error: 'custodianIds must be an array of person ids' });
      return;
    }
    const cleaned = Array.from(new Set(custodianIds.filter((c) => typeof c === 'string' && c.trim())));
    sys.custodianIds = cleaned.length > 0 ? cleaned : undefined;
  }
  sys.updatedAt = new Date().toISOString();
  await systemsRepo.update(sys.id, {
    name: sys.name,
    description: sys.description,
    systemType: sys.systemType,
    businessCriticality: sys.businessCriticality,
    vendor: sys.vendor,
    integrationPoints: sys.integrationPoints,
    connectivity: sys.connectivity,
    integrations: sys.integrations,
    ownerPersonId: sys.ownerPersonId,
    deputyOwnerId: sys.deputyOwnerId,
    custodianIds: sys.custodianIds,
    updatedAt: sys.updatedAt,
  });
  auditService.log(sys.orgId, null, 'System', sys.id, 'UPDATE', null, sys);
  res.json({ success: true, data: sys });
});

/** GET /api/v1/systems/:id/impact — preview what would be affected by deleting this system */
router.get('/:id/impact', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const sys = await systemsRepo.get(id);
  if (!sys) { res.status(404).json({ success: false, error: 'System not found' }); return; }
  if (!assertOrgAccess(req, res, sys.orgId, 'System not found')) return;

  const [allAssets, allConns, allLinks, allMappings] = await Promise.all([
    dataAssetsRepo().list(), connsRepo().list(), linksRepo().list(), mappingsRepo().list(),
  ]);
  const assetsCount = allAssets.filter((a) => a.systemId === id).length;
  const connectionsCount = profilesForSystem(id, allConns, allLinks).length;
  const assetIds = new Set(allAssets.filter((a) => a.systemId === id).map((a) => a.id));
  const mappingsCount = allMappings.filter((m) => !!m.dataAssetId && assetIds.has(m.dataAssetId)).length;

  res.json({ success: true, data: { assets: assetsCount, connections: connectionsCount, mappings: mappingsCount } });
});

/** DELETE /api/v1/systems/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  const removed = await systemsRepo.get(String(req.params.id));
  if (!removed) { res.status(404).json({ success: false, error: 'System not found' }); return; }
  if (!assertOrgAccess(req, res, removed.orgId, 'System not found')) return;
  auditService.log(removed.orgId, null, 'System', removed.id, 'DELETE', removed, null);
  await systemsRepo.delete(removed.id);
  // Cascade: remove every connection→system link that pointed at this
  // system. The connections themselves keep existing — they may still
  // serve other systems, and a connection with zero links is a valid
  // "unassigned" state captured by gap detection. Cross-store (owned by
  // connections route) — routed through the join-table repo.
  const allLinks = await linksRepo().list();
  const victims = allLinks.filter((l) => l.systemId === removed.id);
  for (const l of victims) await linksRepo().delete(l.id);
  const removedLinks = victims.length;
  // Cascade: drop any integration edge on a surviving system that
  // pointed at the deleted one, so the catalog has no dangling targets.
  for (const s of await systemsRepo.list()) {
    if (!s.integrations || s.integrations.length === 0) continue;
    const kept = s.integrations.filter((i) => i.targetSystemId !== removed.id);
    if (kept.length !== s.integrations.length) {
      await systemsRepo.update(s.id, { integrations: kept.length > 0 ? kept : undefined });
    }
  }
  // Cascade: clear `systemId` on any data asset that pointed at the
  // removed system. The asset itself stays (it may still be useful
  // catalogued, e.g. as an orphan to reassign) but the dangling ref is
  // gone — otherwise analysis pivots and gap reports keep counting a
  // ghost system through the asset's stale id.
  const allAssetsForCascade = await dataAssetsRepo().list();
  for (const a of allAssetsForCascade) {
    if (a.systemId === removed.id) {
      a.systemId = '';
      await dataAssetsRepo().update(a.id, a);
    }
  }
  // Cascade: drop the removed system from any process node's systemIds
  // list. Routed through the process-nodes repo (source of truth in
  // Postgres mode); the accessor lazy-requires to avoid the
  // systems ↔ process-catalog cycle.
  const allNodesForCascade = await processNodesRepo().list();
  for (const n of allNodesForCascade) {
    if (!n.systemIds || n.systemIds.length === 0) continue;
    const kept = n.systemIds.filter((sid) => sid !== removed.id);
    if (kept.length !== n.systemIds.length) {
      n.systemIds = kept.length > 0 ? kept : undefined;
      await processNodesRepo().update(n.id, n);
    }
  }
  res.status(204).send();
});

/**
 * POST /api/v1/systems/import
 * Import systems from CSV or JSON. orgId is required.
 *
 * JSON: { orgId, systems: [{ name, description?, systemType? }, ...] }
 * CSV:  { orgId, csv: "Name,Description,Type\nSAP ERP,Enterprise resource planning,ERP" }
 */
router.post('/import', async (req: Request, res: Response) => {
  try {
    const { orgId, systems: systemList, csv } = req.body;

    if (!orgId) {
      res.status(400).json({ success: false, error: 'Organization is required for import' });
      return;
    }

    let rows: Array<{ name: string; description?: string; systemType?: string }> = [];

    if (csv && typeof csv === 'string') {
      const parsed = parseCsv(csv);
      if (parsed.length === 0) {
        res.status(400).json({ success: false, error: 'CSV appears to be empty' });
        return;
      }
      const header = parsed[0].map((h) => h.trim().toLowerCase());
      const nameIdx = header.indexOf('name');
      const descIdx = header.indexOf('description');
      const typeIdx = header.findIndex((h) => h === 'type' || h === 'systemtype' || h === 'system type');

      if (nameIdx === -1) {
        res.status(400).json({ success: false, error: 'CSV must have a "Name" column' });
        return;
      }

      for (let i = 1; i < parsed.length; i++) {
        const cols = parsed[i].map((c) => c.trim());
        if (!cols[nameIdx]) continue;
        rows.push({
          name: cols[nameIdx],
          description: descIdx >= 0 ? cols[descIdx] : undefined,
          systemType: typeIdx >= 0 ? cols[typeIdx] : undefined,
        });
      }
    } else if (Array.isArray(systemList)) {
      rows = systemList;
    } else {
      res.status(400).json({ success: false, error: 'Provide "systems" array or "csv" string' });
      return;
    }

    if (rows.length === 0) {
      res.status(400).json({ success: false, error: 'No systems to import' });
      return;
    }

    const created: StoredSystem[] = [];
    const skipped: string[] = [];
    const now = new Date().toISOString();

    // Fetch existing systems once; append each created row so an
    // intra-import duplicate (two CSV rows with the same name) is caught
    // just as the prior per-row array scan did.
    const existing = await systemsRepo.list();

    for (const row of rows) {
      if (!row.name) continue;
      // Skip duplicates — same name in same org
      const existingDup = existing.find(
        (s) => s.name.toLowerCase() === row.name.toLowerCase() && s.orgId === orgId,
      );
      if (existingDup) {
        skipped.push(row.name);
        continue;
      }
      const sys: StoredSystem = {
        id: uuid(), orgId, name: row.name,
        description: row.description || '',
        systemType: row.systemType && SYSTEM_TYPES.includes(row.systemType) ? row.systemType : row.systemType || '',
        createdAt: now, updatedAt: now,
      };
      await systemsRepo.create(sys);
      existing.push(sys);
      created.push(sys);
    }

    logger.info({ created: created.length, skipped: skipped.length, orgId }, 'Imported systems');
    res.status(201).json({
      success: true,
      data: created,
      skipped: skipped.length,
      skippedNames: skipped,
      message: skipped.length > 0
        ? `Imported ${created.length}, skipped ${skipped.length} duplicate(s): ${skipped.join(', ')}`
        : `Imported ${created.length} system(s)`,
    });
  } catch (err) {
    logger.error({ err }, 'Systems import failed');
    res.status(500).json({ success: false, error: 'Import failed' });
  }
});

export default router;
