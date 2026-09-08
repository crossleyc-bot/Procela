import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { processNodes, flowRelationshipsRepo, NODE_LEVELS, isGovernanceNode as isGovernanceProcess, type ProcessNode } from './process-catalog';
import { dataAssets } from './data-assets';
import { mappings } from './mappings';
import { systems } from './systems';
import { organizations } from './organizations';
import { people } from './people';
import { dataDomains } from './data-domains';
import { governanceGroups } from './governance-groups';
import { damaRoles } from './dama-roles';
import { governanceTasks, type StoredGovernanceTask } from './governance-tasks';
import { governanceIssues, type StoredGovernanceIssue } from './governance-issues';
import { calendarEvents, type StoredCalendarEvent } from './governance-calendar';
import { governancePolicies, type StoredGovernancePolicy } from './governance-policies';
import { loadStore, registerStore } from '../lib/persistence';
import { getRaciOverridesRepository } from '../db/raci-overrides.repo';
import { AuthenticatedRequest } from '../middleware/auth';
import { OWNERSHIP_LEVELS, filterByOrgScope } from '../lib/org-scope';
import { scopeListForRequest } from '../lib/tenant-scope';
// Dashboard is a read aggregator: every handler tallies data across many
// stores. Each store is read through its repository so the endpoints read
// Postgres in DB mode and the in-memory array in JSON mode (the factory
// wraps the same array these modules export). PR 9b.6.
import { getProcessNodesRepository } from '../db/process-nodes.repo';
import { getDataAssetsRepository } from '../db/data-assets.repo';
import { getMappingsRepository } from '../db/mappings.repo';
import { getSystemsRepository } from '../db/systems.repo';
import { getOrganizationsRepository } from '../db/organizations.repo';
import { getPeopleRepository } from '../db/people.repo';
import { getDataDomainsRepository } from '../db/data-domains.repo';
import { getGovernanceGroupsRepository } from '../db/governance-groups.repo';
import { getDamaRolesRepository } from '../db/dama-roles.repo';
import { getGovernanceTasksRepository } from '../db/governance-tasks.repo';
import { getGovernanceIssuesRepository } from '../db/governance-issues.repo';
import { getCalendarEventsRepository } from '../db/calendar-events.repo';
import { getGovernancePoliciesRepository } from '../db/governance-policies.repo';
import { getStatsSnapshotsRepository } from '../db/stats-snapshots.repo';
import { effectiveHealthScore } from '../lib/asset-health';

const processNodesRepo = getProcessNodesRepository(processNodes);
const dataAssetsRepo = getDataAssetsRepository(dataAssets);
const mappingsRepo = getMappingsRepository(mappings);
const systemsRepo = getSystemsRepository(systems);
const organizationsRepo = getOrganizationsRepository(organizations);
const peopleRepo = getPeopleRepository(people);
const dataDomainsRepo = getDataDomainsRepository(dataDomains);
const governanceGroupsRepo = getGovernanceGroupsRepository(governanceGroups);
const damaRolesRepo = getDamaRolesRepository(damaRoles);
const governanceTasksRepo = getGovernanceTasksRepository(governanceTasks);
const governanceIssuesRepo = getGovernanceIssuesRepository(governanceIssues);
const calendarEventsRepo = getCalendarEventsRepository(calendarEvents);
const governancePoliciesRepo = getGovernancePoliciesRepository(governancePolicies);

// ── RACI Overrides ──
interface RaciOverride {
  nodeId: string;
  personId: string;
  value: string; // R, A, C, I
  reason?: string;
}
export const raciOverrides: RaciOverride[] = loadStore<RaciOverride>('raciOverrides');
registerStore('raciOverrides', raciOverrides);
// RACI overrides read/write through the repository (Postgres or JSON) — PR 7c.
const raciRepo = getRaciOverridesRepository(raciOverrides);

// ── Dashboard stats snapshots ──
//
// A weekly time-series of the same headline numbers /stats computes,
// captured one row per org per calendar day. Feeds the Dashboard
// sparkline widgets (coverage %, average health, gap count over time).
// Persisted like every other JSON-backed store (loadStore +
// registerStore + saveStore via the repository) so it survives in JSON
// mode and reads Postgres when DATABASE_URL is set.
export interface StatsSnapshot {
  id: string;
  orgId: string;
  /** Calendar day of capture, 'YYYY-MM-DD' (ISO date). One row per org per day. */
  capturedAt: string;
  /** Mapping coverage %, 0–100 int — matches /stats coverage.percentage. */
  coverage: number;
  /** Average data-asset health, 0–100 int — matches /stats averageHealth. */
  avgHealth: number;
  /** Total open gaps (unmapped activities + ungoverned/orphan assets +
   *  ownerless items + ungoverned domains) — sum of the /stats gap signals. */
  gaps: number;
  /** Data-asset count in scope. */
  dataAssets: number;
  /** Mapping-row count in scope. */
  mappings: number;
}

export const statsSnapshots: StatsSnapshot[] = loadStore<StatsSnapshot>('statsSnapshots');
registerStore('statsSnapshots', statsSnapshots);
const statsSnapshotsRepo = getStatsSnapshotsRepository(statsSnapshots);

/**
 * Compute the current headline stats for one org, reusing the exact
 * formulas from GET /stats so a captured snapshot matches the live
 * tiles. Returns just the five numbers the sparklines draw.
 */
async function computeCoreStats(oid: string | undefined): Promise<Pick<StatsSnapshot, 'coverage' | 'avgHealth' | 'gaps' | 'dataAssets' | 'mappings'>> {
  const [pn, da, mp, dd] = await Promise.all([
    processNodesRepo.list(), dataAssetsRepo.list(), mappingsRepo.list(), dataDomainsRepo.list(),
  ]);

  const filteredNodes = filterByOrgScope(pn, oid);
  const filteredAssets = filterByOrgScope(da, oid);
  const filteredMappings = filterByOrgScope(mp, oid);
  const filteredDomains = filterByOrgScope(dd, oid);

  // Coverage: activities with at least one mapping.
  const activityIds = filteredNodes.filter((n) => n.level === 'ACTIVITY').map((n) => n.id);
  const mappedActivityIds = new Set(filteredMappings.map((m) => m.processStepId));
  const mappedCount = activityIds.filter((id) => mappedActivityIds.has(id)).length;
  const unmappedCount = activityIds.length - mappedCount;
  const coverage = activityIds.length > 0 ? Math.round((mappedCount / activityIds.length) * 100) : 0;

  // Average health across in-scope assets. Health is measured DQ or 0 — an
  // asset with no measured rule contributes 0, not a connector/manual stand-in.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const measuredCounts = await (require('./data-quality') as typeof import('./data-quality')).measuredRuleCountsByAsset();
  const effHealth = (a: { id: string; healthScore: number }) => effectiveHealthScore(a.healthScore, measuredCounts.get(a.id) || 0);
  const avgHealth = filteredAssets.length > 0
    ? Math.round(filteredAssets.reduce((sum, a) => sum + effHealth(a), 0) / filteredAssets.length)
    : 0;

  // Gap signals — same definitions as /stats.
  const linkedAssetIds = new Set(filteredMappings.filter((m) => !!m.dataAssetId).map((m) => m.dataAssetId!));
  const ungovernedAssets = filteredAssets.filter((a) => a.governanceTier === 'BRONZE' && linkedAssetIds.has(a.id)).length;
  const ownerlessItems = filteredNodes.filter((n) => ['VALUE_STREAM', 'PROCESS'].includes(n.level) && !n.ownerId).length;
  const orphanAssets = filteredAssets.filter((a) => !linkedAssetIds.has(a.id)).length;
  const ungovernedDomains = filteredDomains.filter((d) => !d.ownerId).length;
  const gaps = unmappedCount + ungovernedAssets + ownerlessItems + orphanAssets + ungovernedDomains;

  return { coverage, avgHealth, gaps, dataAssets: filteredAssets.length, mappings: filteredMappings.length };
}

// Deterministic seed derived from a string — FNV-1a, stable across
// runs (no Math.random / no wall-clock in the value path).
function hashSeed(s: string): number {
  let h = 2166136261;
  // Bound the loop by a constant — `s` is built from the caller-supplied
  // orgId, and an org identifier is never long; capping avoids iterating an
  // unbounded, user-influenced length.
  const n = Math.min(s.length, 256);
  for (let i = 0; i < n; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stable integer jitter in [-range, +range] for (orgId, index, salt). */
function seededJitter(orgId: string, index: number, salt: string, range: number): number {
  return (hashSeed(`${orgId}:${index}:${salt}`) % (2 * range + 1)) - range;
}

/**
 * Build a deterministic trailing weekly series (~10 points, oldest→newest)
 * that ENDS at the org's current live stats and drifts gently upward
 * toward them (governance improves over time: coverage + health rise,
 * gaps fall). Used as a fallback so the sparklines always have something
 * to draw when the org has fewer than 2 real snapshots. Values are seeded
 * from orgId so the same org renders an identical series every call; only
 * the date axis uses the wall clock (a trailing-week window).
 */
function synthesizeSeries(
  orgId: string,
  current: Pick<StatsSnapshot, 'coverage' | 'avgHealth' | 'gaps' | 'dataAssets' | 'mappings'>,
): Array<Pick<StatsSnapshot, 'capturedAt' | 'coverage' | 'avgHealth' | 'gaps' | 'dataAssets' | 'mappings'>> {
  const N = 10;
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const out: Array<Pick<StatsSnapshot, 'capturedAt' | 'coverage' | 'avgHealth' | 'gaps' | 'dataAssets' | 'mappings'>> = [];
  for (let i = 0; i < N; i++) {
    const progress = i / (N - 1); // 0 (oldest) → 1 (newest)
    const d = new Date();
    d.setDate(d.getDate() - (N - 1 - i) * 7);
    const capturedAt = d.toISOString().slice(0, 10);
    if (i === N - 1) {
      // Newest point lands exactly on the live stats.
      out.push({ capturedAt, ...current });
      continue;
    }
    out.push({
      capturedAt,
      coverage: clamp(Math.round(current.coverage - (1 - progress) * 22 + seededJitter(orgId, i, 'cov', 2)), 0, 100),
      avgHealth: clamp(Math.round(current.avgHealth - (1 - progress) * 16 + seededJitter(orgId, i, 'hea', 2)), 0, 100),
      gaps: Math.max(0, Math.round(current.gaps + (1 - progress) * 7 + seededJitter(orgId, i, 'gap', 1))),
      dataAssets: Math.max(0, Math.round(current.dataAssets - (1 - progress) * 3)),
      mappings: Math.max(0, Math.round(current.mappings - (1 - progress) * 3)),
    });
  }
  return out;
}

const router = Router();

/** GET /api/v1/dashboard/stats
 *
 * Accepts an optional `domain` query parameter ("OPERATIONAL" or
 * "GOVERNANCE") that narrows the process-side counts (value streams,
 * processes, activities, flows, coverage) to one domain. Data assets,
 * systems and people are not domain-tagged so they remain unfiltered
 * — the dashboard treats those as cross-cutting.
 */
router.get('/stats', async (req: Request, res: Response) => {
  const { orgId, domain } = req.query;
  const oid = orgId as string | undefined;
  const dom = domain === 'OPERATIONAL' || domain === 'GOVERNANCE' ? domain : undefined;

  // Missing domain on a node is treated as OPERATIONAL (matches the
  // backfill and frontend `passesLens` convention) so legacy rows
  // never silently disappear when the user picks the Operational lens.
  const nodeMatchesDomain = (n: ProcessNode) => !dom || (n.domain || 'OPERATIONAL') === dom;

  // Read each store through its repository (Postgres in DB mode, the
  // in-memory array in JSON mode). Local consts shadow the module-level
  // array imports so the tallying logic below is unchanged.
  const [processNodes, dataAssets, mappings, systems, people, dataDomains, organizations] = await Promise.all([
    processNodesRepo.list(), dataAssetsRepo.list(), mappingsRepo.list(),
    systemsRepo.list(), peopleRepo.list(), dataDomainsRepo.list(), organizationsRepo.list(),
  ]);

  // filterByOrgScope walks both ancestors and descendants so a
  // division-scope dashboard includes company-level items rolled down
  // AND team-level items rolled up — matching the rest of the app.
  const filteredNodes = scopeListForRequest(req, processNodes).filter(nodeMatchesDomain);
  const filteredAssets = scopeListForRequest(req, dataAssets);
  const filteredMappings = scopeListForRequest(req, mappings);
  const filteredSystems = scopeListForRequest(req, systems);
  const filteredPeople = scopeListForRequest(req, people);
  // Flows don't carry orgId — walk them via the (already-scoped) node
  // set so scope + domain filtering fall out naturally.
  const inScopeNodeIds = new Set(filteredNodes.map((n) => n.id));
  const filteredFlows = (await flowRelationshipsRepo.list()).filter((f) => inScopeNodeIds.has(f.fromNodeId));

  // Count by level
  const byLevel = Object.fromEntries(
    NODE_LEVELS.map((l) => [l, filteredNodes.filter((n) => n.level === l).length])
  );

  const activityIds = filteredNodes.filter((n) => n.level === 'ACTIVITY').map((n) => n.id);

  // Coverage: which activities have at least one mapping
  const mappedActivityIds = new Set(filteredMappings.map((m) => m.processStepId));
  const mappedCount = activityIds.filter((id) => mappedActivityIds.has(id)).length;
  const unmappedCount = activityIds.length - mappedCount;
  const coveragePercentage = activityIds.length > 0 ? Math.round((mappedCount / activityIds.length) * 100) : 0;

  // Governance tiers
  const bronze = filteredAssets.filter((a) => a.governanceTier === 'BRONZE').length;
  const silver = filteredAssets.filter((a) => a.governanceTier === 'SILVER').length;
  const gold = filteredAssets.filter((a) => a.governanceTier === 'GOLD').length;

  // Average health. Health is measured DQ or 0 — an asset with no measured
  // rule contributes 0, never a connector-freshness or manual stand-in.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const measuredCounts = await (require('./data-quality') as typeof import('./data-quality')).measuredRuleCountsByAsset();
  const effHealth = (a: { id: string; healthScore: number }) => effectiveHealthScore(a.healthScore, measuredCounts.get(a.id) || 0);
  const averageHealth =
    filteredAssets.length > 0
      ? Math.round(filteredAssets.reduce((sum, a) => sum + effHealth(a), 0) / filteredAssets.length)
      : 0;

  // Gaps. Only data-asset-shaped mapping rows count here; policy
  // and attachment rows aren't "assets that have been linked".
  const linkedAssetIds = new Set(filteredMappings.filter((m) => !!m.dataAssetId).map((m) => m.dataAssetId!));
  const ungovernedAssets = filteredAssets.filter(
    (a) => a.governanceTier === 'BRONZE' && linkedAssetIds.has(a.id),
  ).length;

  const ownerlessItems = filteredNodes.filter(
    (n) => ['VALUE_STREAM', 'PROCESS'].includes(n.level) && !n.ownerId
  ).length;
  // Ownership gaps for systems and data assets, matching the Assign-owners
  // page's filters (an entity's OWN ownerPersonId, not a domain-inherited one)
  // so the Get Started board and that page agree row-for-row.
  const ownerlessSystems = filteredSystems.filter((s) => !(s as { ownerPersonId?: string | null }).ownerPersonId).length;
  const ownerlessAssets = filteredAssets.filter((a) => !(a as { ownerPersonId?: string | null }).ownerPersonId).length;

  // Orphan assets — present in the catalog but no mapping row points
  // at them. Pairs with the new /data-assets/orphans page.
  const mappedAssetIdsAll = new Set(
    filteredMappings.filter((m) => !!m.dataAssetId).map((m) => m.dataAssetId!),
  );
  const orphanAssets = filteredAssets.filter((a) => !mappedAssetIdsAll.has(a.id)).length;

  const filteredDomains = scopeListForRequest(req, dataDomains);
  const ungovernedDomains = filteredDomains.filter((d) => !d.ownerId).length;

  // ── Descendant roll-up for the setup-complete banner ──
  //
  // The per-scope counters above are strict-equality: at parent-org
  // scope they only see records owned directly by the parent. That's
  // right for KPIs (mixing parent + child would double-count), but the
  // "setup complete" banner needs to know whether *the tree below* is
  // set up too — otherwise a company sees "all in place" when its
  // divisions are still empty catalogs. Walk descendants once and
  // return their aggregated process count + a flag saying whether any
  // ownership-level descendants exist at all.
  let descendantProcesses = 0;
  let hasChildOwnershipOrgs = false;
  if (oid) {
    const descendants = new Set<string>();
    const queue = [oid];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const child of organizations) {
        if (child.parentId === id && !descendants.has(child.id)) {
          descendants.add(child.id);
          queue.push(child.id);
          if (OWNERSHIP_LEVELS.includes(child.type)) hasChildOwnershipOrgs = true;
        }
      }
    }
    if (descendants.size > 0) {
      descendantProcesses = processNodes.filter((n) => {
        const ids = n.orgIds && n.orgIds.length > 0 ? n.orgIds : (n.orgId ? [n.orgId] : []);
        return ids.some((id) => descendants.has(id)) && n.level === 'PROCESS';
      }).length;
    }
  }

  res.json({
    success: true,
    data: {
      totalNodes: filteredNodes.length,
      byLevel,
      valueStreams: byLevel.VALUE_STREAM || 0,
      processes: byLevel.PROCESS || 0,
      activities: byLevel.ACTIVITY || 0,
      flows: filteredFlows.length,
      systems: filteredSystems.length,
      dataAssets: filteredAssets.length,
      dataDomains: filteredDomains.length,
      mappings: filteredMappings.length,
      organizations: organizations.length,
      people: filteredPeople.length,
      hasChildOwnershipOrgs,
      descendantProcesses,
      coverage: {
        mapped: mappedCount,
        unmapped: unmappedCount,
        percentage: coveragePercentage,
      },
      governance: { bronze, silver, gold },
      averageHealth,
      gaps: {
        unmappedActivities: unmappedCount,
        ungovernedAssets,
        ownerlessItems,
        ownerlessSystems,
        ownerlessAssets,
        ungovernedDomains,
        orphanAssets,
      },
    },
  });
});


/** GET /api/v1/dashboard/raci — Auto-generated RACI matrix */
router.get('/raci', async (req: Request, res: Response) => {
  const { orgId } = req.query;
  const oid = orgId as string | undefined;

  // Manual RACI overrides, fetched once for the whole matrix build.
  const raciList = await raciRepo.list();

  // Each store read through its repository (Postgres in DB mode, the
  // in-memory array in JSON mode); local consts shadow the imports.
  const [processNodes, people, damaRoles, governanceGroups, mappings, dataAssets, dataDomains, organizations] = await Promise.all([
    processNodesRepo.list(), peopleRepo.list(), damaRolesRepo.list(),
    governanceGroupsRepo.list(), mappingsRepo.list(), dataAssetsRepo.list(),
    dataDomainsRepo.list(), organizationsRepo.list(),
  ]);

  // Filter data by org. damaRoles keeps its bespoke filter — it uses
  // scopeType/scopeId rather than orgId/orgIds so filterByOrgScope
  // doesn't apply.
  const filteredNodes = scopeListForRequest(req, processNodes);
  const filteredPeople = scopeListForRequest(req, people);
  const filteredRoles = oid
    ? damaRoles.filter((r) => r.scopeType === 'ORG' && r.scopeId === oid)
    : damaRoles;
  const filteredGroups = scopeListForRequest(req, governanceGroups);

  // Rows: every planning-level node in the hierarchy. EXECUTION is a
  // run-time logging level (instances of a TASK), not something you
  // assign responsibility for, so it's the only level intentionally
  // dropped here. DOMAIN, CAPABILITY, and TASK were previously
  // silently filtered out as well; bring them back so processes with
  // task-level detail aren't invisible in the matrix.
  const rows = filteredNodes
    .filter((n) => n.level !== 'EXECUTION')
    .map((n) => ({
      id: n.id,
      name: n.name,
      level: n.level,
      parentId: n.parentId,
      parentName: n.parentId ? filteredNodes.find((p) => p.id === n.parentId)?.name || null : null,
      ownerId: n.ownerId || null,
    }));

  // Build lookup sets for DAMA role types -> person IDs
  const rolePersonMap: Record<string, Set<string>> = {};
  for (const r of filteredRoles) {
    if (!r.personId) continue;  // agent-held roles have null personId and don't belong in a *person* map
    if (!rolePersonMap[r.roleType]) rolePersonMap[r.roleType] = new Set();
    rolePersonMap[r.roleType].add(r.personId);
  }

  // Governance group members -> person IDs (for Informed). Agent
  // advisors don't appear in person-keyed sets.
  const groupMemberIds = new Set<string>();
  for (const g of filteredGroups) {
    for (const m of g.members) {
      if (m.personId) groupMemberIds.add(m.personId);
    }
  }

  // ── Per-process RACI derivation ──
  //
  // Instead of assigning global roles (CDO=A everywhere), derive
  // R/A/C/I for each process row based on actual ownership data:
  //
  // R (Responsible): The process/activity OWNER (ownerId on the node).
  //   If the node has no owner, inherit from the nearest parent that does.
  //
  // A (Accountable): The domain OWNER of data assets mapped to this
  //   process. If multiple domains, the first match wins.
  //   Falls back to CDO for rows with no mapped assets.
  //
  // C (Consulted): Stewards of data assets mapped to this process,
  //   plus Data Architects and Technical Data Stewards assigned to the org.
  //
  // I (Informed): Governance group members whose groups govern the
  //   relevant domains, plus the Data Governance Lead and DQ Analysts.

  // Build lookup: processNodeId -> mapped data asset IDs
  const filteredMappings = scopeListForRequest(req, mappings);
  const assetsByNode: Record<string, string[]> = {};
  for (const m of filteredMappings) {
    if (!m.dataAssetId) continue; // policy / attachment rows aren't assets
    if (!assetsByNode[m.processStepId]) assetsByNode[m.processStepId] = [];
    assetsByNode[m.processStepId].push(m.dataAssetId);
  }

  // Get mapped assets for a node, including inherited from children
  function getAssetsForNode(nodeId: string): string[] {
    const direct = assetsByNode[nodeId] || [];
    const childNodes = filteredNodes.filter((n) => n.parentId === nodeId);
    const childAssets = childNodes.flatMap((c) => getAssetsForNode(c.id));
    return [...new Set([...direct, ...childAssets])];
  }

  // Get owner for a node, inheriting from parent if not set
  function getOwner(nodeId: string): string | null {
    const node = rows.find((r) => r.id === nodeId);
    if (!node) return null;
    if (node.ownerId) return node.ownerId;
    if (node.parentId) return getOwner(node.parentId);
    return null;
  }

  // Build per-row RACI and collect all relevant people
  const matrix: Record<string, Record<string, string>> = {};
  const reasons: Record<string, Record<string, string>> = {};
  const allRelevantIds = new Set<string>();

  // Global fallback roles
  const cdoIds = rolePersonMap['CDO'] || new Set<string>();
  const govLeadIds = rolePersonMap['DATA_GOVERNANCE_LEAD'] || new Set<string>();
  const dqAnalystIds = rolePersonMap['DATA_QUALITY_ANALYST'] || new Set<string>();
  const architectIds = rolePersonMap['DATA_ARCHITECT'] || new Set<string>();
  const techStewardIds = rolePersonMap['TECHNICAL_DATA_STEWARD'] || new Set<string>();

  // ── Governance Group → Process mapping ──
  // For governance rows only, RACI is derived from governance group
  // membership and group roles instead of individual assignments.
  const GOV_GROUP_PROCESS_MAP: Record<string, string[]> = {
    'COUNCIL': ['Data Strategy & Policy'],
    'OFFICE': ['Data Strategy & Policy', 'Data Quality Management', 'Data Domain Management', 'Metadata & Catalog Management', 'Data Access & Security', 'Issue & Change Management'],
    'COMMITTEE': ['Data Domain Management', 'Metadata & Catalog Management'],
    'STEWARDSHIP_TEAM': ['Data Quality Management', 'Data Domain Management'],
    'WORKING_GROUP': ['Issue & Change Management', 'Data Access & Security'],
  };

  // Group role → RACI letter
  const GROUP_ROLE_TO_RACI: Record<string, string> = {
    CHAIR: 'A',
    VICE_CHAIR: 'R',
    MEMBER: 'R',
    SECRETARY: 'I',
    ADVISOR: 'C',
  };

  // Check if a row is under the governance value stream
  const govVsIds = new Set(filteredNodes.filter((n) =>
    n.level === 'VALUE_STREAM' && isGovernanceProcess(n),
  ).map((n) => n.id));

  function isGovernanceNode(nodeId: string): boolean {
    if (govVsIds.has(nodeId)) return true;
    const node = filteredNodes.find((n) => n.id === nodeId);
    if (!node?.parentId) return false;
    return isGovernanceNode(node.parentId);
  }

  // Find the process name for a governance node (walk up to PROCESS level)
  function getGovProcessName(nodeId: string): string | null {
    const node = filteredNodes.find((n) => n.id === nodeId);
    if (!node) return null;
    if (node.level === 'PROCESS') return node.name;
    if (node.level === 'VALUE_STREAM') return null;
    if (node.parentId) return getGovProcessName(node.parentId);
    return null;
  }

  for (const row of rows) {
    const cellMap: Record<string, string> = {};
    const reasonMap: Record<string, string> = {};

    // For governance rows, derive RACI from governance group membership
    if (isGovernanceNode(row.id)) {
      const processName = row.level === 'VALUE_STREAM' ? null : (getGovProcessName(row.id) || row.name);

      for (const group of filteredGroups) {
        // Check if this group type maps to this governance process.
        // Previously this used substring match (.includes), so e.g.
        // "Data Domain Management" matched any process containing the
        // phrase - including unrelated names with that substring.
        // Switch to case-insensitive equality on a trimmed name so a
        // typo in the process name cleanly breaks the mapping rather
        // than silently pulling in wrong members.
        const mappedProcesses = GOV_GROUP_PROCESS_MAP[group.type] || [];
        const isVs = row.level === 'VALUE_STREAM';
        const normalizedProcess = processName?.trim().toLowerCase() || '';
        const matches = isVs
          ? mappedProcesses.length > 0
          : mappedProcesses.some((p) => p.trim().toLowerCase() === normalizedProcess);

        if (matches) {
          for (const member of group.members) {
            // The RACI matrix is keyed by personId. Agent advisors
            // (member.personId === null) don't appear here — they're
            // surfaced on the group's own page instead, not in the
            // person-name matrix.
            if (!member.personId) continue;
            // Some legacy group-member rows only carried `role`, not
            // `groupRole`. Fall back to the legacy field.
            const legacyRole = (member as { role?: string }).role;
            const raciLetter = GROUP_ROLE_TO_RACI[member.groupRole] || (legacyRole ? GROUP_ROLE_TO_RACI[legacyRole] : undefined) || 'I';
            const personName = people.find((p) => p.id === member.personId)?.name || '';
            // Higher priority wins: A > R > C > I
            const priority: Record<string, number> = { A: 4, R: 3, C: 2, I: 1 };
            const existing = cellMap[member.personId];
            if (!existing || (priority[raciLetter] || 0) > (priority[existing] || 0)) {
              cellMap[member.personId] = raciLetter;
              reasonMap[member.personId] = `${raciLetter === 'A' ? 'Chair' : raciLetter === 'R' ? 'Member' : raciLetter === 'C' ? 'Advisor' : 'Secretary'} of ${group.name}`;
            }
            allRelevantIds.add(member.personId);
          }
        }
      }

      // Also add the node owner as R if set
      const nodeOwner = getOwner(row.id);
      if (nodeOwner && !cellMap[nodeOwner]) {
        cellMap[nodeOwner] = 'R';
        reasonMap[nodeOwner] = `Owns "${row.name}"`;
        allRelevantIds.add(nodeOwner);
      }

      // Apply overrides
      const nodeOverrides = raciList.filter((o) => o.nodeId === row.id);
      for (const ov of nodeOverrides) {
        cellMap[ov.personId] = ov.value;
        reasonMap[ov.personId] = ov.reason || 'Manual override';
        allRelevantIds.add(ov.personId);
      }

      matrix[row.id] = cellMap;
      reasons[row.id] = reasonMap;
      continue;
    }

    // ── Business process RACI (existing logic) ──
    const nodeAssets = getAssetsForNode(row.id);
    const nodeOwner = getOwner(row.id);

    // R: process/activity owner
    if (nodeOwner) {
      cellMap[nodeOwner] = 'R';
      const ownerPerson = people.find((p) => p.id === nodeOwner);
      reasonMap[nodeOwner] = `Owns "${row.name}"${ownerPerson ? ` (${ownerPerson.name})` : ''}`;
      allRelevantIds.add(nodeOwner);
    }

    // A: domain owner(s) of mapped data assets
    const accountableForRow = new Set<string>();
    const accountableReasons: Record<string, string> = {};
    for (const aid of nodeAssets) {
      const asset = dataAssets.find((a) => a.id === aid);
      const domain = dataDomains.find((d) => d.dataAssetIds.includes(aid));
      if (domain?.ownerId) {
        accountableForRow.add(domain.ownerId);
        accountableReasons[domain.ownerId] = `Owns domain "${domain.name}" containing "${asset?.name || aid}"`;
      }
      if (asset?.owner && !accountableForRow.has(asset.owner)) {
        accountableForRow.add(asset.owner);
        accountableReasons[asset.owner] = `Owns data asset "${asset.name}"`;
      }
    }
    if (accountableForRow.size === 0) {
      for (const id of cdoIds) { accountableForRow.add(id); accountableReasons[id] = 'CDO (fallback — no domain owner for mapped assets)'; }
    }
    for (const pid of accountableForRow) {
      if (!cellMap[pid]) { cellMap[pid] = 'A'; reasonMap[pid] = accountableReasons[pid] || 'Domain/asset owner'; }
      allRelevantIds.add(pid);
    }

    // C: stewards of mapped assets + architects + tech stewards
    const consultedForRow = new Set<string>();
    for (const aid of nodeAssets) {
      const asset = dataAssets.find((a) => a.id === aid);
      if (asset?.stewardIds) {
        for (const sid of asset.stewardIds) consultedForRow.add(sid);
      }
      const domain = dataDomains.find((d) => d.dataAssetIds.includes(aid));
      if (domain?.stewardIds) {
        for (const sid of domain.stewardIds) consultedForRow.add(sid);
      }
    }
    for (const id of architectIds) consultedForRow.add(id);
    for (const id of techStewardIds) consultedForRow.add(id);
    for (const pid of consultedForRow) {
      if (!cellMap[pid]) { cellMap[pid] = 'C'; reasonMap[pid] = architectIds.has(pid) ? 'Data Architect' : techStewardIds.has(pid) ? 'Technical Data Steward' : 'Steward of mapped data asset'; }
      allRelevantIds.add(pid);
    }

    // I: governance group members for relevant domains + gov leads + DQ analysts
    const informedForRow = new Set<string>();
    for (const aid of nodeAssets) {
      const domain = dataDomains.find((d) => d.dataAssetIds.includes(aid));
      if (domain) {
        // Find governance groups that might govern this domain
        for (const g of filteredGroups) {
          for (const m of g.members) {
            if (m.personId) informedForRow.add(m.personId);
          }
        }
      }
    }
    for (const id of govLeadIds) informedForRow.add(id);
    for (const id of dqAnalystIds) informedForRow.add(id);
    for (const pid of informedForRow) {
      if (!cellMap[pid]) { cellMap[pid] = 'I'; reasonMap[pid] = govLeadIds.has(pid) ? 'Data Governance Lead' : dqAnalystIds.has(pid) ? 'Data Quality Analyst' : 'Governance group member'; }
      allRelevantIds.add(pid);
    }

    // Apply manual overrides — they take precedence over derived values
    const nodeOverrides = raciList.filter((o) => o.nodeId === row.id);
    for (const ov of nodeOverrides) {
      cellMap[ov.personId] = ov.value;
      reasonMap[ov.personId] = ov.reason || 'Manual override';
      allRelevantIds.add(ov.personId);
    }

    // ── Enforce one A per row ────────────────────────────────────────
    // RACI's first rule is exactly one Accountable. Auto-derivation can
    // produce multiple (e.g. domain owner + asset owner are different
    // people; multiple CDOs with no domain owner; the governance branch
    // matching two groups whose chairs are different people). Without
    // demotion the matrix violates RACI on every row that does.
    //
    // Manual overrides are sacrosanct: if a user explicitly set someone
    // to A we keep that. Otherwise we pick a deterministic winner
    // (lexicographic by name) and demote the rest to R - they were the
    // next-tightest relationship in the auto-derived chain and stay
    // visible in the cell.
    const aPersons = Object.keys(cellMap).filter((id) => cellMap[id] === 'A');
    if (aPersons.length > 1) {
      const overrideA = aPersons.find((pid) =>
        nodeOverrides.some((o) => o.personId === pid && o.value === 'A'),
      );
      const sortByName = (a: string, b: string) =>
        (filteredPeople.find((p) => p.id === a)?.name || a)
          .localeCompare(filteredPeople.find((p) => p.id === b)?.name || b);
      const winner = overrideA || aPersons.sort(sortByName)[0];
      for (const pid of aPersons) {
        if (pid === winner) continue;
        cellMap[pid] = 'R';
        reasonMap[pid] = (reasonMap[pid] || 'Accountable candidate')
          + ' (demoted to Responsible — RACI allows only one Accountable per row)';
      }
    }

    matrix[row.id] = cellMap;
    reasons[row.id] = reasonMap;
  }

  // Build columns from people who appear in at least one cell
  const columns = filteredPeople
    .filter((p) => allRelevantIds.has(p.id))
    .map((p) => {
      const personRoles = filteredRoles.filter((r) => r.personId === p.id);
      const primaryRole = personRoles.length > 0 ? personRoles[0].roleType : p.role || '';
      const orgNames = (p.orgIds || [])
        .map((oid2) => organizations.find((o) => o.id === oid2)?.name)
        .filter(Boolean);
      return {
        personId: p.id,
        name: p.name,
        role: primaryRole,
        title: p.title || '',
        jobRole: p.jobRole || '',
        orgUnit: orgNames[0] || '',
      };
    });

  res.json({
    success: true,
    data: {
      rows: rows.map(({ ownerId, ...rest }) => rest),
      columns,
      matrix,
      reasons,
    },
  });
});

/** POST /api/v1/dashboard/raci/override — set or clear a manual RACI override */
router.post('/raci/override', async (req: Request, res: Response) => {
  const { nodeId, personId, value } = req.body;
  if (!nodeId || !personId) {
    res.status(400).json({ success: false, error: 'nodeId and personId are required' });
    return;
  }
  // Set the override, or clear it when no valid value is supplied.
  if (value && ['R', 'A', 'C', 'I'].includes(value)) {
    await raciRepo.upsert({ nodeId, personId, value, reason: 'Manual override' });
  } else {
    await raciRepo.remove(nodeId, personId);
  }
  res.json({ success: true });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v1/dashboard/my-items
//
// Returns ownership-based data for the person whose email matches the
// logged-in JWT. Feeds the "My Items" widget on the Dashboard so a user
// instantly sees what they own, steward, belong to, and need to act on.
// ──────────────────────────────────────────────────────────────────────────

function flattenNodes(nodes: ProcessNode[]): ProcessNode[] {
  const out: ProcessNode[] = [];
  function walk(n: ProcessNode & { children?: ProcessNode[] }) {
    out.push(n);
    if (n.children) n.children.forEach(walk);
  }
  nodes.forEach(walk);
  return out;
}

router.get('/my-items', async (req: AuthenticatedRequest, res: Response) => {
  const email = (req.user?.email || '').toLowerCase();
  if (!email) {
    res.json({ success: true, data: { person: null } });
    return;
  }

  const [people, processNodes, dataAssets, dataDomains, governanceGroups, damaRoles, organizations] = await Promise.all([
    peopleRepo.list(), processNodesRepo.list(), dataAssetsRepo.list(), dataDomainsRepo.list(),
    governanceGroupsRepo.list(), damaRolesRepo.list(), organizationsRepo.list(),
  ]);

  const person = people.find((p) => p.email?.toLowerCase() === email);
  if (!person) {
    res.json({ success: true, data: { person: null } });
    return;
  }

  // Flatten nested process tree to a flat list for ownership lookups.
  const allNodes = flattenNodes(processNodes);

  // Owned process nodes.
  const ownedProcesses = allNodes
    .filter((n) => n.ownerId === person.id)
    .map((n) => ({ id: n.id, name: n.name, level: n.level, status: n.status }));

  // Effective health for the assets on this view — measured DQ or 0.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const measuredCounts = await (require('./data-quality') as typeof import('./data-quality')).measuredRuleCountsByAsset();
  const effHealth = (a: { id: string; healthScore: number }) => effectiveHealthScore(a.healthScore, measuredCounts.get(a.id) || 0);

  // Owned / stewarded data assets.
  const myAssets = dataAssets
    .filter((a) => a.owner === person.id || a.owner === person.name || (a.stewardIds || []).includes(person.id))
    .map((a) => ({
      id: a.id, name: a.name, governanceTier: a.governanceTier, healthScore: effHealth(a),
      relation: (a.owner === person.id || a.owner === person.name) ? 'owner' : 'steward',
    }));

  // DAMA governance roles.
  const myRoles = damaRoles
    .filter((r) => r.personId === person.id)
    .map((r) => {
      let scopeName = r.scopeId;
      if (r.scopeType === 'ORG') {
        scopeName = organizations.find((o) => o.id === r.scopeId)?.name || r.scopeId;
      } else {
        scopeName = dataDomains.find((d) => d.id === r.scopeId)?.name || r.scopeId;
      }
      return { id: r.id, roleType: r.roleType, scopeType: r.scopeType, scopeName };
    });

  // Governance group memberships.
  const myGroups = governanceGroups
    .filter((g) => g.members?.some((m) => m.personId === person.id))
    .map((g) => {
      const membership = g.members?.find((m) => m.personId === person.id);
      return { id: g.id, name: g.name, type: g.type, groupRole: membership?.groupRole || 'MEMBER' };
    });

  // Domain owner / steward.
  const myDomains = dataDomains
    .filter((d) => d.ownerId === person.id || (d.stewardIds || []).includes(person.id))
    .map((d) => ({
      id: d.id,
      name: d.name,
      relation: d.ownerId === person.id ? 'owner' : 'steward',
    }));

  // Action items — things that may need attention.
  const actionItems: Array<{ type: string; message: string; link: string }> = [];
  // Owned processes in DRAFT status.
  for (const p of ownedProcesses) {
    if (p.status === 'DRAFT') {
      actionItems.push({
        type: 'review',
        message: `"${p.name}" is still in DRAFT.`,
        link: '/processes',
      });
    }
  }
  // Low-health assets I own/steward.
  for (const a of myAssets) {
    if (a.healthScore > 0 && a.healthScore < 50) {
      actionItems.push({
        type: 'health',
        message: `"${a.name}" health is ${a.healthScore}% — needs attention.`,
        link: '/data-quality',
      });
    }
  }
  // Domains I own without stewards.
  for (const d of myDomains) {
    if (d.relation === 'owner') {
      const domain = dataDomains.find((dd) => dd.id === d.id);
      if (domain && (!domain.stewardIds || domain.stewardIds.length === 0)) {
        actionItems.push({
          type: 'gap',
          message: `Domain "${d.name}" has no stewards assigned.`,
          link: '/governance?tab=domains',
        });
      }
    }
  }
  // Governance groups where person is CHAIR.
  for (const g of myGroups) {
    if (g.groupRole === 'CHAIR') {
      actionItems.push({
        type: 'governance',
        message: `You chair "${g.name}".`,
        link: '/governance?tab=groups',
      });
    }
  }

  res.json({
    success: true,
    data: {
      person: { id: person.id, name: person.name, email: person.email, role: person.role, title: person.title || '' },
      ownedProcesses,
      myAssets,
      myRoles,
      myGroups,
      myDomains,
      actionItems,
    },
  });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v1/dashboard/my-dashboard
//
// Personalized dashboard for the logged-in user. Aggregates tasks, issues,
// domains, upcoming events, and pending policy reviews into a single call
// so the frontend can render a "My Dashboard" page in one fetch.
// ──────────────────────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

router.get('/my-dashboard', async (req: AuthenticatedRequest, res: Response) => {
  const email = (req.user?.email || '').toLowerCase();
  if (!email) {
    res.json({
      success: true,
      data: {
        person: null,
        myTasks: [],
        myIssues: [],
        myDomains: [],
        upcomingEvents: [],
        pendingReviews: [],
        summary: {
          openTasks: 0, overdueTasks: 0, openIssues: 0, criticalIssues: 0,
          domainsOwned: 0, domainsSteward: 0, upcomingEventsCount: 0, pendingReviewsCount: 0,
        },
      },
    });
    return;
  }

  const [people, governanceTasks, governanceIssues, calendarEvents, governancePolicies, dataAssets, dataDomains] = await Promise.all([
    peopleRepo.list(), governanceTasksRepo.list(), governanceIssuesRepo.list(),
    calendarEventsRepo.list(), governancePoliciesRepo.list(), dataAssetsRepo.list(), dataDomainsRepo.list(),
  ]);

  const person = people.find((p) => p.email?.toLowerCase() === email);
  if (!person) {
    res.json({
      success: true,
      data: {
        person: null,
        myTasks: [],
        myIssues: [],
        myDomains: [],
        upcomingEvents: [],
        pendingReviews: [],
        summary: {
          openTasks: 0, overdueTasks: 0, openIssues: 0, criticalIssues: 0,
          domainsOwned: 0, domainsSteward: 0, upcomingEventsCount: 0, pendingReviewsCount: 0,
        },
      },
    });
    return;
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  // ── Tasks assigned to me (not completed/cancelled) ──
  const CLOSED_TASK_STATUSES = new Set(['COMPLETED', 'CANCELLED']);
  const myTasks = governanceTasks
    .filter((t: StoredGovernanceTask) => t.assigneeId === person.id && !CLOSED_TASK_STATUSES.has(t.status))
    .map((t: StoredGovernanceTask) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      taskType: t.taskType,
      dueDate: t.dueDate || null,
      isOverdue: t.dueDate ? t.dueDate < todayStr : false,
    }))
    .sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 99;
      const pb = PRIORITY_ORDER[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      // Nulls sort last
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    });

  // ── Issues assigned to me (not closed/resolved/wont_fix) ──
  const CLOSED_ISSUE_STATUSES = new Set(['CLOSED', 'RESOLVED', 'WONT_FIX']);
  const myIssues = governanceIssues
    .filter((i: StoredGovernanceIssue) => i.assignedTo === person.id && !CLOSED_ISSUE_STATUSES.has(i.status))
    .map((i: StoredGovernanceIssue) => {
      const domain = i.domainId ? dataDomains.find((d) => d.id === i.domainId) : null;
      return {
        id: i.id,
        title: i.title,
        status: i.status,
        severity: i.severity,
        issueType: i.issueType,
        domainName: domain?.name || null,
      };
    })
    .sort((a, b) => {
      const sa = SEVERITY_ORDER[a.severity] ?? 99;
      const sb = SEVERITY_ORDER[b.severity] ?? 99;
      return sa - sb;
    });

  // ── Domains I own or steward ──
  // Effective health: measured DQ score, or 0 when no measured rule backs it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const measuredCounts = await (require('./data-quality') as typeof import('./data-quality')).measuredRuleCountsByAsset();
  const effHealth = (a: { id: string; healthScore: number }) => effectiveHealthScore(a.healthScore, measuredCounts.get(a.id) || 0);
  const myDomains = dataDomains
    .filter((d) => d.ownerId === person.id || (d.stewardIds || []).includes(person.id))
    .map((d) => {
      const domainAssets = dataAssets.filter((a) => d.dataAssetIds.includes(a.id));
      const healthyAssets = domainAssets.filter((a) => effHealth(a) >= 80).length;
      return {
        id: d.id,
        name: d.name,
        relation: (d.ownerId === person.id ? 'owner' : 'steward') as 'owner' | 'steward',
        assetCount: d.dataAssetIds.length,
        healthyAssets,
        totalAssets: domainAssets.length,
      };
    });

  // ── Upcoming calendar events (within 14 days, status ACTIVE) ──
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  const upcomingEvents = calendarEvents
    .filter((e: StoredCalendarEvent) => {
      if (e.status !== 'ACTIVE') return false;
      if (!e.attendees || !e.attendees.includes(person.id)) return false;
      if (!e.nextOccurrence) return false;
      const occDate = new Date(e.nextOccurrence);
      const diffMs = occDate.getTime() - now.getTime();
      return diffMs >= 0 && diffMs <= fourteenDaysMs;
    })
    .map((e: StoredCalendarEvent) => {
      const occDate = new Date(e.nextOccurrence!);
      const daysAway = Math.ceil((occDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      return {
        name: e.name,
        eventType: e.eventType,
        nextOccurrence: e.nextOccurrence,
        daysAway: Math.max(0, daysAway),
      };
    })
    .sort((a, b) => a.daysAway - b.daysAway);

  // ── Policies pending my review (I own them and nextReviewDate is within 30 days or overdue) ──
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const pendingReviews = governancePolicies
    .filter((p: StoredGovernancePolicy) => {
      if (p.ownerAssignmentId !== person.id) return false;
      if (!p.nextReviewDate) return false;
      const reviewDate = new Date(p.nextReviewDate);
      const diffMs = reviewDate.getTime() - now.getTime();
      // Overdue (past) or within 30 days (future)
      return diffMs <= thirtyDaysMs;
    })
    .map((p: StoredGovernancePolicy) => ({
      id: p.id,
      name: p.name,
      code: p.code,
      nextReviewDate: p.nextReviewDate || null,
      isOverdue: p.nextReviewDate ? p.nextReviewDate < todayStr : false,
    }));

  // ── Summary counts ──
  const overdueTasks = myTasks.filter((t) => t.isOverdue).length;
  const criticalIssues = myIssues.filter((i) => i.severity === 'CRITICAL').length;
  const domainsOwned = myDomains.filter((d) => d.relation === 'owner').length;
  const domainsSteward = myDomains.filter((d) => d.relation === 'steward').length;

  const summary = {
    openTasks: myTasks.length,
    overdueTasks,
    openIssues: myIssues.length,
    criticalIssues,
    domainsOwned,
    domainsSteward,
    upcomingEventsCount: upcomingEvents.length,
    pendingReviewsCount: pendingReviews.length,
  };

  res.json({
    success: true,
    data: {
      person: {
        id: person.id,
        name: person.name,
        email: person.email,
        role: person.role,
        title: person.title || '',
      },
      myTasks,
      myIssues,
      myDomains,
      upcomingEvents,
      pendingReviews,
      summary,
    },
  });
});

/**
 * GET /api/v1/dashboard/governance-status — check if governance framework
 * has been set up for the current org (processes, groups, domains).
 */
router.get('/governance-status', async (req: Request, res: Response) => {
  const [processNodes, governanceGroups, dataDomains] = await Promise.all([
    processNodesRepo.list(), governanceGroupsRepo.list(), dataDomainsRepo.list(),
  ]);

  // Check each component. scopeListForRequest handles the "no orgId set →
  // don't filter" case as well as the ancestor/descendant roll-up.
  const hasGovProcesses = scopeListForRequest(req, processNodes)
    .some((n) => n.level === 'VALUE_STREAM' && isGovernanceProcess(n));
  const hasGovGroups = scopeListForRequest(req, governanceGroups).length > 0;
  const hasDomains = scopeListForRequest(req, dataDomains).length > 0;

  res.json({
    success: true,
    data: {
      hasGovProcesses,
      hasGovGroups,
      hasDomains,
      isComplete: hasGovProcesses && hasGovGroups && hasDomains,
    },
  });
});

/**
 * Capture the CURRENT computed stats for an org into the snapshot store
 * as one dated row. Idempotent per calendar day — if today's snapshot
 * for the org already exists it is overwritten in place rather than
 * duplicated. Returns the captured snapshot.
 *
 * Shared by POST /snapshot and the scheduler's daily capture sweep, which
 * is what actually builds up real trend history so the sparklines stop
 * falling back to the synthesized series (>= 2 real snapshots ⇒ real).
 */
export async function captureStatsSnapshot(oid: string): Promise<StatsSnapshot> {
  const stats = await computeCoreStats(oid);
  const today = new Date().toISOString().slice(0, 10);
  const existing = (await statsSnapshotsRepo.list()).find((s) => s.orgId === oid && s.capturedAt === today);
  if (existing) {
    // Same calendar day → overwrite rather than append a duplicate.
    return (await statsSnapshotsRepo.update(existing.id, stats)) ?? { ...existing, ...stats };
  }
  const snapshot: StatsSnapshot = { id: uuid(), orgId: oid, capturedAt: today, ...stats };
  await statsSnapshotsRepo.create(snapshot);
  return snapshot;
}

/**
 * POST /api/v1/dashboard/snapshot?orgId=<id>
 *
 * Capture the current computed stats for an org as one dated row.
 * Idempotent per calendar day. The scheduler calls captureStatsSnapshot
 * directly on a daily cadence; this endpoint exposes the same for manual
 * / on-demand capture.
 */
router.post('/snapshot', async (req: Request, res: Response) => {
  const oid = req.query.orgId as string | undefined;
  if (!oid) {
    res.status(400).json({ success: false, error: 'orgId is required' });
    return;
  }
  const snapshot = await captureStatsSnapshot(oid);
  res.json({ success: true, data: snapshot });
});

/**
 * GET /api/v1/dashboard/trends?orgId=<id>
 *
 * Time series for the Dashboard sparklines. Returns the org's snapshots
 * oldest→newest, capped to the most recent ~12. When the org has fewer
 * than 2 real snapshots we synthesize a deterministic trailing weekly
 * series that ends at the org's current live stats, so the UI always has
 * something to draw; those responses carry `synthesized: true`.
 */
router.get('/trends', async (req: Request, res: Response) => {
  const oid = req.query.orgId as string | undefined;
  if (!oid) {
    res.status(400).json({ success: false, error: 'orgId is required' });
    return;
  }

  const MAX_POINTS = 12;
  const mine = (await statsSnapshotsRepo.list())
    .filter((s) => s.orgId === oid)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

  if (mine.length >= 2) {
    const points = mine.slice(-MAX_POINTS).map((s) => ({
      date: s.capturedAt,
      coverage: s.coverage,
      avgHealth: s.avgHealth,
      gaps: s.gaps,
      dataAssets: s.dataAssets,
      mappings: s.mappings,
    }));
    res.json({ success: true, data: { points, synthesized: false } });
    return;
  }

  // Fewer than 2 real snapshots — synthesize a deterministic series.
  const current = await computeCoreStats(oid);
  const points = synthesizeSeries(oid, current).map((p) => ({
    date: p.capturedAt,
    coverage: p.coverage,
    avgHealth: p.avgHealth,
    gaps: p.gaps,
    dataAssets: p.dataAssets,
    mappings: p.mappings,
  }));
  res.json({ success: true, data: { points, synthesized: true } });
});

export default router;
