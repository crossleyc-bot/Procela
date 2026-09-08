import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import logger from '../lib/logger';
import { AuthenticatedRequest } from '../middleware/auth';
import { enforceAssignment, ownerOnCreate } from '../lib/assignment';
import { loadStore, saveStore, registerStore } from '../lib/persistence';
import { getProcessNodesRepository } from '../db/process-nodes.repo';
import { getFlowRelationshipsRepository } from '../db/flow-relationships.repo';
import { getProcessVersionsRepository } from '../db/process-versions.repo';
import { getGovernancePoliciesRepository } from '../db/governance-policies.repo';
import { getPeopleRepository } from '../db/people.repo';
import { getSystemsRepository } from '../db/systems.repo';
import { getDataAssetsRepository } from '../db/data-assets.repo';
import { getMappingsRepository } from '../db/mappings.repo';
import { getGovernanceControlsRepository } from '../db/governance-controls.repo';
import { getDataDomainsRepository } from '../db/data-domains.repo';
import { hasDatabase } from '../db/prisma';
import { getVisibleOrgScope, getAncestorOrgIds, getCachedOrgList } from '../lib/org-scope';
import { scopeListForRequest, assertOrgAccessAny } from '../lib/tenant-scope';
import { auditService } from '../services/audit.service';
// data-assets and mappings both import from this file, so adding the
// matching imports here creates a circular dep. Resolve the
// arrays lazily via require() at request time — by then the cycle
// has resolved and the exports are populated.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { people } from './people';
import { dataDomains } from './data-domains';
import { createNotification } from './notifications';

const VALUE_STREAM_ORG_LEVELS = ['company', 'division'];

// ── Status state machine ────────────────────────────────────────────────
// Maps each status to the set of statuses it can transition to.
const SIMPLE_TRANSITIONS: Record<string, string[]> = {
  DRAFT:      ['ACTIVE'],
  ACTIVE:     ['DRAFT', 'DEPRECATED'],
  DEPRECATED: ['DRAFT'],
};
// Review mode — one review gate between DRAFT and ACTIVE, sized for
// enterprise change control that wants an approver check without the
// four-state ceremony of `advanced`. Segregation of duties (submitter
// ≠ reviewer) enforced separately at the PUT layer.
const REVIEW_TRANSITIONS: Record<string, string[]> = {
  DRAFT:          ['PENDING_REVIEW'],
  PENDING_REVIEW: ['ACTIVE', 'DRAFT'],
  ACTIVE:         ['DRAFT', 'DEPRECATED'],
  DEPRECATED:     ['DRAFT'],
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
const REVIEW_LOCKED = new Set(['PENDING_REVIEW', 'ACTIVE', 'DEPRECATED']);
const ADVANCED_LOCKED = new Set(['UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'DEPRECATED']);

// ═══════════════════════════════════════════════════════════════════════════════
// UNIVERSAL PROCESS HIERARCHY
//
// Levels (in order):
//   VALUE_STREAM > DOMAIN > CAPABILITY > PROCESS > SUBPROCESS > ACTIVITY > TASK > EXECUTION
//
// Required for a valid process path:
//   VALUE_STREAM -> PROCESS -> ACTIVITY
//
// Optional levels:
//   DOMAIN, CAPABILITY, SUBPROCESS, TASK, EXECUTION
//
// Hierarchy = parent-child tree (structural containment)
// Flow = sequence relationships between activities (separate construct)
// ═══════════════════════════════════════════════════════════════════════════════

export const NODE_LEVELS = [
  'VALUE_STREAM',
  'DOMAIN',
  'CAPABILITY',
  'PROCESS',
  'SUBPROCESS',
  'ACTIVITY',
  'TASK',
  'EXECUTION',
] as const;

export type NodeLevel = typeof NODE_LEVELS[number];

// Valid parent -> child relationships
const VALID_CHILDREN: Record<NodeLevel, NodeLevel[]> = {
  VALUE_STREAM: ['DOMAIN', 'CAPABILITY', 'PROCESS'],  // can skip Domain/Capability
  DOMAIN:       ['CAPABILITY', 'PROCESS'],             // can skip Capability
  CAPABILITY:   ['PROCESS'],
  PROCESS:      ['SUBPROCESS', 'ACTIVITY'],            // can skip Subprocess
  SUBPROCESS:   ['ACTIVITY'],
  ACTIVITY:     ['TASK', 'EXECUTION'],                 // can skip Task
  TASK:         ['EXECUTION'],
  EXECUTION:    [],                                     // leaf
};

// Required levels
const REQUIRED_LEVELS: NodeLevel[] = ['VALUE_STREAM', 'PROCESS', 'ACTIVITY'];

export interface ProcessNode {
  id: string;
  parentId: string | null;
  level: NodeLevel;
  name: string;
  description: string;
  activityId: string | null;
  status: string;
  orderIndex: number;
  orgId: string;
  orgIds: string[];
  ownerId: string | null;
  version: number;
  // Documentation fields
  purpose?: string;
  businessOutcome?: string;
  stakeholders?: string;
  complianceTags?: string[];
  inputsOutputs?: string;
  responsibleRole?: string;
  /** Specific person carrying the responsible role on this node, when
   *  it's one. Always paired with `responsibleRole`; the UI only allows
   *  picking a person who actually holds that role on the Governance
   *  Roles page, but the backend doesn't enforce that — it only checks
   *  the id resolves to a real person, so role-holder reshuffles don't
   *  retroactively invalidate this row. */
  responsiblePersonId?: string | null;
  statusJustification?: string;
  frequency?: string;
  riskLevel?: string;
  automationLevel?: string;
  estimatedDuration?: string;
  requiredSkillIds?: string[];
  /** Business-continuity classification — TIER_1 (mission-critical),
   *  TIER_2 (business-critical), TIER_3 (standard), TIER_4 (non-
   *  critical). Utilities use this for BCM planning; a regulator
   *  asking "what's the RTO for outage triage?" needs an answer
   *  the platform can produce. Undefined = "Not rated". */
  criticalityTier?: 'TIER_1' | 'TIER_2' | 'TIER_3' | 'TIER_4';
  /** Recovery Time Objective in hours — how long can this process be
   *  down before it materially affects the business? Paired with
   *  criticalityTier for BCM reports. Zero means "must never fail";
   *  undefined means "not set". */
  rtoHours?: number;
  /** Recovery Point Objective in hours — how much data loss (measured
   *  in time) is tolerable if this activity fails? The BCM pair to
   *  `rtoHours`: RTO is "how fast to recover", RPO is "how much can we
   *  lose". Zero means "no data loss tolerable"; undefined = not set. */
  rpoHours?: number;
  /** Measurable success criterion — free-text, e.g. "Field crew on
   *  site within 30 minutes for Tier 1 outages". Complements the
   *  narrative `businessOutcome` with a target you can build a
   *  dashboard against. */
  successMeasure?: string;
  /** SLA target — free-text so operators can express "P95 4h" or
   *  "99.9% monthly" or "Same business day" without a schema war.
   *  Rendered next to `successMeasure` on the activity detail. */
  slaTarget?: string;
  /** What initiates this activity — SCHEDULED / EVENT / UPSTREAM /
   *  MANUAL / EXTERNAL_REQUEST. Complements the flow edges (which give
   *  ordering) with the *kind* of trigger. Stored as a plain string
   *  (like frequency/riskLevel) so the option set can grow without a
   *  DB enum migration. */
  trigger?: string;
  /** Processing volume / throughput — free-text, e.g. "~10k invoices/
   *  day". `frequency` captures cadence; this captures scale, which is
   *  what actually drives criticality and sizing. */
  volume?: string;
  /** Next scheduled governance review date (ISO "YYYY-MM-DD"), forward-
   *  looking — distinct from `reviewedAt` (the last review's timestamp).
   *  Free-text date string so a review cadence can be tracked without a
   *  dedicated scheduler. Undefined = not set. */
  nextReviewDate?: string;
  /** How the activity's risk is mitigated — free-text notes complementing
   *  `riskLevel` (High/Medium/Low) with the controls or compensations that
   *  bring it down. Undefined = not set. */
  riskMitigation?: string;
  /** Governance controls this activity implements or is subject to.
   *  IDs point at StoredGovernanceControl rows. Cascade: when a
   *  control is deleted, its id is swept from every activity's
   *  controlIds so nothing dangles. */
  controlIds?: string[];
  // ── Change-management review workflow ─────────────────────────
  // Populated when the org's status mode is `review` and the node
  // transits DRAFT → PENDING_REVIEW → ACTIVE. All five fields are
  // reset when the node returns to DRAFT (a new submission starts
  // its own review cycle) so a rejected item doesn't carry stale
  // approval metadata.
  /** Person id of who submitted the current change for review. Set
   *  on DRAFT → PENDING_REVIEW; unset when the node returns to
   *  DRAFT. */
  submittedBy?: string;
  submittedAt?: string;
  /** Person id of the reviewer who approved / requested changes. Set
   *  on PENDING_REVIEW → (ACTIVE | DRAFT); unset when the node
   *  returns to DRAFT after a new submission. */
  reviewedBy?: string;
  reviewedAt?: string;
  /** Free-text justification from either the submitter (on submit)
   *  or the reviewer (on approve / reject). Kept on the row so the
   *  audit trail travels with the node, not just the version
   *  history log. */
  reviewComment?: string;
  /** Systems the step (or higher-level node) runs on. First-class link
   *  — independent of any data-asset mapping — so a step that runs on a
   *  system without (yet) a mapped data asset is still captured.
   *  Cascaded on system delete by the systems route. */
  systemIds?: string[];
  // Governance vs operational classifier. Replaces the brittle
  // `name.includes('Governance')` runtime checks. Set at creation
  // (governance template → GOVERNANCE; business wizard / manual →
  // OPERATIONAL, inherited from parent), backfilled once on load for
  // pre-existing rows. Optional in the type only so the one-time
  // backfill can run; treat a missing value as OPERATIONAL.
  domain?: 'GOVERNANCE' | 'OPERATIONAL';
  createdAt: string;
  updatedAt: string;
}

// Single source of truth for "is this a governance node?". Prefers the
// persisted `domain` field; falls back to the legacy name heuristic for
// any row not yet backfilled (defensive — the load-time backfill below
// normally fills every row first).
export function isGovernanceNode(n: { domain?: string; name?: string }): boolean {
  if (n.domain) return n.domain === 'GOVERNANCE';
  const name = n.name || '';
  return /governance|data management/i.test(name);
}

/**
 * Purpose and the former Business Outcome were merged into a single
 * "Purpose" field. This folds any incoming/stored businessOutcome into
 * purpose so no content is lost: both present → two paragraphs; only one
 * present → that one; neither → undefined. Callers write the result to
 * `purpose` and stop persisting `businessOutcome` (the column is kept but
 * deprecated).
 */
export function combinePurpose(
  purpose?: string | null,
  businessOutcome?: string | null,
): string | undefined {
  const p = (purpose || '').trim();
  const b = (businessOutcome || '').trim();
  if (p && b) return p === b ? p : `${p}\n\n${b}`;
  return p || b || undefined;
}

/**
 * successMeasure absorbed the former slaTarget (the merged "Target / SLA"
 * activity field). Folds any incoming/stored slaTarget into successMeasure
 * with the same semantics as combinePurpose, so no content is lost. Callers
 * write the result to `successMeasure` and stop persisting `slaTarget` (the
 * column is kept but deprecated).
 */
export function combineTargetSla(
  successMeasure?: string | null,
  slaTarget?: string | null,
): string | undefined {
  return combinePurpose(successMeasure, slaTarget);
}

export interface FlowRelationship {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: 'SEQUENCE' | 'PARALLEL' | 'CONDITIONAL' | 'LOOP';
  label: string | null;
  createdAt: string;
}

export interface ProcessVersion {
  id: string;
  nodeId: string;
  version: number;
  snapshot: ProcessNode;
  changedBy: string | null;
  changedAt: string;
  status: string;
  note: string;
}

// ── Persistent stores ──

export { SIMPLE_TRANSITIONS, REVIEW_TRANSITIONS, ADVANCED_TRANSITIONS, SIMPLE_LOCKED, REVIEW_LOCKED, ADVANCED_LOCKED };
export const processNodes: ProcessNode[] = loadStore<ProcessNode>('processNodes');
registerStore('processNodes', processNodes);
export const flowRelationships: FlowRelationship[] = loadStore<FlowRelationship>('flowRelationships');
registerStore('flowRelationships', flowRelationships);
export const processVersions: ProcessVersion[] = loadStore<ProcessVersion>('processVersions');
registerStore('processVersions', processVersions);

const processNodesRepo = getProcessNodesRepository(processNodes);
export const flowRelationshipsRepo = getFlowRelationshipsRepository(flowRelationships);
const processVersionsRepo = getProcessVersionsRepository(processVersions);

// Foreign stores read here for reference-validation / enrichment. Lazy repos
// so nothing reads their bindings at module-init (cycle-safety). `systems` is
// lazy-required to avoid the process-catalog ↔ systems import cycle.
let _peopleRepo: ReturnType<typeof getPeopleRepository> | null = null;
const peopleRepo = () => (_peopleRepo ??= getPeopleRepository(people));
let _systemsRepo: ReturnType<typeof getSystemsRepository> | null = null;
const systemsRepo = () =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  (_systemsRepo ??= getSystemsRepository(require('./systems').systems));
let _dataAssetsRepo: ReturnType<typeof getDataAssetsRepository> | null = null;
const dataAssetsRepo = () =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  (_dataAssetsRepo ??= getDataAssetsRepository(require('./data-assets').dataAssets));
let _mappingsRepo: ReturnType<typeof getMappingsRepository> | null = null;
const mappingsRepo = () =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  (_mappingsRepo ??= getMappingsRepository(require('./mappings').mappings));
let _governanceControlsRepo: ReturnType<typeof getGovernanceControlsRepository> | null = null;
const governanceControlsRepo = () =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  (_governanceControlsRepo ??= getGovernanceControlsRepository(require('./governance-controls').governanceControls));
let _dataDomainsRepo: ReturnType<typeof getDataDomainsRepository> | null = null;
const dataDomainsRepo = () => (_dataDomainsRepo ??= getDataDomainsRepository(dataDomains));

// ── processNodes source cache (Postgres cutover) ──
// process-catalog reads processNodes synchronously through findNode /
// getChildren / getDescendants at ~35 sites. In JSON mode those read the live
// array; in Postgres mode they read a repo-hydrated snapshot — hydrated at
// boot via initProcessCatalog() and refreshed after every write in this file,
// with a short TTL as a backstop. Because this module both reads and writes
// the store, each mutating handler calls refreshProcessNodesCache() after its
// writes so a write-then-read in the same flow stays consistent.
let processNodesCache: ProcessNode[] | null = null;
let processNodesCacheAt = 0;
const PROCESS_NODES_TTL_MS = 5000;
export async function refreshProcessNodesCache(): Promise<void> {
  processNodesCache = await processNodesRepo.list();
  processNodesCacheAt = Date.now();
}
export async function initProcessCatalog(): Promise<void> {
  if (!hasDatabase()) return;
  await refreshProcessNodesCache();
  reseedLevelCounters(processNodesCache ?? []);
}
function nodeSource(): ProcessNode[] {
  if (!hasDatabase()) return processNodes;
  if (processNodesCache && Date.now() - processNodesCacheAt <= PROCESS_NODES_TTL_MS) return processNodesCache;
  void refreshProcessNodesCache();
  return processNodesCache ?? processNodes;
}

// Cached lazily so we don't have to import the governance-policies
// route eagerly (that would drag its own module-load side effects into
// this file's boot). Used only by /apply-governance-template.
function getGovernancePoliciesRepo() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { governancePolicies } = require('./governance-policies');
  return getGovernancePoliciesRepository(governancePolicies);
}

// ── One-time backfill of the `domain` classifier ──
// Pre-existing nodes have no `domain`. Resolve it once from the
// value-stream-ancestor name (the old heuristic), persist, and from
// then on every detection reads the field instead of matching strings.
// JSON mode only — Postgres rows already carry the canonical `domain`.
if (!hasDatabase()) {
  const byId = new Map(processNodes.map((n) => [n.id, n]));
  const rootDomain = (n: ProcessNode): 'GOVERNANCE' | 'OPERATIONAL' => {
    let cur: ProcessNode | undefined = n;
    const seen = new Set<string>();
    while (cur?.parentId && byId.has(cur.parentId) && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      cur = byId.get(cur.parentId);
    }
    return /governance|data management/i.test(cur?.name || '') ? 'GOVERNANCE' : 'OPERATIONAL';
  };
  let backfilled = 0;
  for (const n of processNodes) {
    if (n.domain) continue;
    n.domain = rootDomain(n);
    backfilled++;
  }
  if (backfilled > 0) {
    saveStore('processNodes', processNodes);
    logger.info({ backfilled }, 'Backfilled process node domain classifier');
  }
}

const DEV_ORG_ID = '00000000-0000-0000-0000-000000000010';

// Human-readable ID generators per level.
// Counters are initialized from existing data on startup so IDs
// never duplicate after a restart.
const ID_PREFIXES: Record<string, string> = {
  VALUE_STREAM: 'VS',
  PROCESS: 'PRO',
  SUBPROCESS: 'SP',
  ACTIVITY: 'ACT',
  TASK: 'TSK',
  DOMAIN: 'DOM',
  CAPABILITY: 'CAP',
  EXECUTION: 'EXE',
};

const levelCounters: Record<string, number> = {};
// Seed the per-level ID counters from the current node set. Called at module
// load with the boot array (JSON mode) and again from initProcessCatalog with
// the hydrated cache (Postgres mode), so generated activityIds never collide
// with rows already in the database.
function reseedLevelCounters(nodes: ProcessNode[]): void {
  for (const [level, prefix] of Object.entries(ID_PREFIXES)) {
    const existing = nodes
      .filter((n) => n.level === level && n.activityId)
      .map((n) => {
        const m = n.activityId?.match(new RegExp(`^${prefix}-(\\d+)$`));
        return m ? parseInt(m[1], 10) : 0;
      });
    levelCounters[level] = existing.length > 0 ? Math.max(...existing) : 0;
  }
}
// JSON mode seeds the ID counters from the loaded array at boot; Postgres
// mode leaves them until initProcessCatalog() reseeds from the repo cache
// (reading the retired `processNodes` array in PG mode would be a stale read).
if (!hasDatabase()) reseedLevelCounters(processNodes);

function generateNodeId(level: string): string {
  const prefix = ID_PREFIXES[level];
  if (!prefix) return '';
  levelCounters[level] = (levelCounters[level] || 0) + 1;
  return `${prefix}-${String(levelCounters[level]).padStart(4, '0')}`;
}

// Backfill existing nodes that lack a readable ID. JSON mode only.
if (!hasDatabase()) {
  let backfilled = 0;
  for (const node of processNodes) {
    if (!node.activityId && ID_PREFIXES[node.level]) {
      node.activityId = generateNodeId(node.level);
      backfilled++;
    }
  }
  if (backfilled > 0) {
    saveStore('processNodes', processNodes);
    logger.info({ backfilled }, 'Backfilled readable IDs on existing process nodes');
  }
}

// Migrate legacy statuses (PROPOSED, UNDER_REVIEW, APPROVED) to DRAFT. JSON mode only.
if (!hasDatabase()) {
  const legacyStatuses = new Set(['PROPOSED', 'UNDER_REVIEW', 'APPROVED']);
  let migrated = 0;
  for (const node of processNodes) {
    if (legacyStatuses.has(node.status)) {
      node.status = 'DRAFT';
      migrated++;
    }
  }
  if (migrated > 0) {
    saveStore('processNodes', processNodes);
    logger.info({ migrated }, 'Migrated legacy statuses to DRAFT');
  }
}

// ── Helpers ──

function param(val: string | string[]): string {
  return Array.isArray(val) ? val[0] : val;
}

function findNode(id: string): ProcessNode | undefined {
  return nodeSource().find((n) => n.id === id);
}

// Business-continuity tiers, exported so the frontend picker and the
// tests can enumerate them without magic strings.
export const CRITICALITY_TIERS = ['TIER_1', 'TIER_2', 'TIER_3', 'TIER_4'] as const;

// Drop any controlIds pointing at controls that don't exist. Silent
// filter so a stale reference lingering on an activity gets pruned on
// the next save instead of surfacing as a dangling id in the UI.
async function cleanControlIds(ids: unknown): Promise<string[]> {
  if (!Array.isArray(ids)) return [];
  const known = new Set((await governanceControlsRepo().list()).map((c) => c.id));
  return Array.from(new Set(ids.filter((id): id is string => typeof id === 'string' && known.has(id))));
}

function getChildren(parentId: string): ProcessNode[] {
  return nodeSource()
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

function getDescendants(nodeId: string): ProcessNode[] {
  const children = getChildren(nodeId);
  const result: ProcessNode[] = [...children];
  for (const child of children) {
    result.push(...getDescendants(child.id));
  }
  return result;
}

function isValidChild(parentLevel: NodeLevel, childLevel: NodeLevel): boolean {
  return VALID_CHILDREN[parentLevel].includes(childLevel);
}

function buildTree(nodes: ProcessNode[]): any[] {
  const map = new Map<string, any>();
  const roots: any[] = [];

  for (const node of nodes) {
    map.set(node.id, { ...node, children: [] });
  }

  for (const node of nodes) {
    const treeNode = map.get(node.id);
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId).children.push(treeNode);
    } else if (!node.parentId) {
      roots.push(treeNode);
    }
  }

  // Sort children by orderIndex
  function sortChildren(node: any) {
    node.children.sort((a: any, b: any) => a.orderIndex - b.orderIndex);
    node.children.forEach(sortChildren);
  }
  roots.sort((a, b) => a.orderIndex - b.orderIndex);
  roots.forEach(sortChildren);

  return roots;
}

function validateProcessIntegrity(vsId: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const vs = findNode(vsId);
  if (!vs || vs.level !== 'VALUE_STREAM') {
    return { valid: false, errors: ['Not a valid value stream'] };
  }

  const descendants = getDescendants(vsId);
  const processes = descendants.filter((n) => n.level === 'PROCESS');
  const activities = descendants.filter((n) => n.level === 'ACTIVITY');

  if (processes.length === 0) {
    errors.push(`Value stream "${vs.name}" has no processes`);
  }

  for (const proc of processes) {
    const procDescendants = getDescendants(proc.id);
    const procActivities = procDescendants.filter((n) => n.level === 'ACTIVITY');
    if (procActivities.length === 0) {
      errors.push(`Process "${proc.name}" has no activities`);
    }
  }

  // Check for orphan nodes (nodes whose parent doesn't exist)
  for (const node of descendants) {
    if (node.parentId && !findNode(node.parentId)) {
      errors.push(`Node "${node.name}" (${node.level}) has orphan parent reference`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ═══════════════════════════════════════════════════════════════════════════════

// Cascade-delete the process↔data mappings (ProcessDataLink rows) that
// point at deleted step ids. mappings.ts imports from this module, so a
// top-level import here would be circular — use the lazy-require pattern
// the rest of the codebase uses for the same situation. Without this,
// deleting a value stream leaves orphaned mappings that still show up on
// the Process Data Mappings page with a null step.
async function cascadeDeleteMappings(stepIds: Set<string>): Promise<number> {
  try {
    // Route through the mappings repo (source of truth in Postgres mode);
    // the accessor lazy-requires to avoid the process-catalog ↔ mappings
    // import cycle.
    const all = await mappingsRepo().list();
    const victims = all.filter((m) => stepIds.has(m.processStepId));
    for (const m of victims) await mappingsRepo().delete(m.id);
    return victims.length;
  } catch {
    return 0;
  }
}

const router = Router();

/** Validate a systemIds payload — must be an array of strings, each
 *  referencing an existing system. Returns the cleaned/deduped list,
 *  or null after writing a 400 response (caller should return). Uses
 *  lazy-require so this module doesn't pull systems at import time. */
/** Validate a personId — must reference a real person, or be empty /
 *  null to clear. Returns { ok: true, value: id | null } where null
 *  means "clear", or { ok: false } after writing a 400. Lazy-required
 *  to avoid the process-catalog ↔ people cycle. */
async function validatePersonId(
  value: unknown,
  res: Response,
): Promise<{ ok: true; value: string | null } | { ok: false }> {
  if (value === '' || value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || !value.trim()) {
    res.status(400).json({ success: false, error: 'personId must be a string id (or empty to clear)' });
    return { ok: false };
  }
  if (!(await peopleRepo().get(value))) {
    res.status(400).json({ success: false, error: `Unknown person id "${value}"` });
    return { ok: false };
  }
  return { ok: true, value };
}

async function validateSystemIds(value: unknown, res: Response): Promise<string[] | null> {
  if (!Array.isArray(value)) {
    res.status(400).json({ success: false, error: 'systemIds must be an array' });
    return null;
  }
  const known = new Set((await systemsRepo().list()).map((s) => s.id));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== 'string' || !id.trim()) {
      res.status(400).json({ success: false, error: 'systemIds entries must be non-empty strings' });
      return null;
    }
    if (!known.has(id)) {
      res.status(400).json({ success: false, error: `Unknown system id "${id}"` });
      return null;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// ── HIERARCHY NODES ──

/** DELETE /all — delete all process nodes and flow relationships */
router.delete('/all', async (_req: Request, res: Response) => {
  const nodeIds = (await processNodesRepo.list()).map((n) => n.id);
  const flowIds = (await flowRelationshipsRepo.list()).map((f) => f.id);
  const count = nodeIds.length;
  const flowCount = flowIds.length;
  // Every step is going away, so every mapping is now orphaned.
  const allStepIds = new Set(nodeIds);
  for (const id of flowIds) {
    await flowRelationshipsRepo.delete(id);
  }
  for (const id of nodeIds) {
    await processNodesRepo.delete(id);
  }
  if (hasDatabase()) await refreshProcessNodesCache();
  const mappingsRemoved = await cascadeDeleteMappings(allStepIds);
  auditService.log(DEV_ORG_ID, null, 'ProcessNode', '*', 'DELETE_ALL', null, { count, flowCount, mappingsRemoved });
  logger.info({ count, flowCount, mappingsRemoved }, 'Deleted all process nodes and flow relationships');
  res.json({ success: true, deleted: count + flowCount });
});

/** GET / — list all nodes as flat list + tree + metadata */
router.get('/', async (req: Request, res: Response) => {
  const { orgId } = req.query;
  const allNodes = nodeSource();
  const allPeople = await peopleRepo().list();
  // Governance content is defined once at the top of the org tree
  // (company / enterprise level) and applies everywhere below it —
  // divisions are subject to it but don't own it. Before this
  // filter, `filterByOrgScope`'s ancestor walk pulled enterprise
  // governance value streams down into every division's Process
  // Catalog, inflating counts and showing a locked row a division
  // user can't act on. Default behaviour is now: hide governance
  // nodes whose orgId is a strict ancestor of the active scope.
  // Governance defined AT the active scope or BELOW it still shows,
  // and the query param below lets a user opt back in when they
  // deliberately want to see what enterprise governance applies to
  // them from their division seat.
  const includeAncestorGovernance = req.query.includeAncestorGovernance === 'true';
  const filtered = orgId
    ? (() => {
        const scope = getVisibleOrgScope(orgId as string)!;
        const ancestors = getAncestorOrgIds(orgId as string) ?? new Set<string>();
        return allNodes.filter((n) => {
          const inScope = scope.has(n.orgId) || n.orgIds.some((id) => scope.has(id));
          if (!inScope) return false;
          if (!includeAncestorGovernance && n.domain === 'GOVERNANCE' && ancestors.has(n.orgId)) {
            return false;
          }
          return true;
        });
      })()
    // No explicit orgId: still enforce the caller's own visible-org set so a
    // restricted user can't read every tenant's nodes by omitting the param.
    : scopeListForRequest(req, allNodes);
  const valueStreams = filtered.filter((n) => n.level === 'VALUE_STREAM');
  // Enrich with owner names so the frontend can display them inline
  const enriched = filtered.map((n) => {
    const ownerName = n.ownerId ? allPeople.find((p) => p.id === n.ownerId)?.name || null : null;
    return { ...n, ownerName };
  });
  res.json({
    success: true,
    data: enriched,
    tree: buildTree(enriched),
    levels: NODE_LEVELS,
    validChildren: VALID_CHILDREN,
    requiredLevels: REQUIRED_LEVELS,
    stats: {
      total: filtered.length,
      byLevel: Object.fromEntries(
        NODE_LEVELS.map((l) => [l, filtered.filter((n) => n.level === l).length])
      ),
      valueStreams: valueStreams.length,
    },
  });
});

/** GET /value-streams — backward-compatible: return value streams with nested tree */
router.get('/value-streams', (_req: Request, res: Response) => {
  const vsNodes = nodeSource().filter((n) => n.level === 'VALUE_STREAM');
  const result = vsNodes.map((vs) => ({
    ...vs,
    children: buildTree(getDescendants(vs.id).concat()),
  }));
  res.json({ success: true, data: result });
});

/** GET /nodes/:id — get a single node with children and ancestry */
router.get('/nodes/:id', (req: Request, res: Response) => {
  const node = findNode(param(req.params.id));
  if (!node) { res.status(404).json({ success: false, error: 'Node not found' }); return; }
  if (!assertOrgAccessAny(req, res, [node.orgId, ...(node.orgIds || [])], 'Node not found')) return;

  // Build ancestry path
  const ancestry: ProcessNode[] = [];
  let current = node;
  while (current.parentId) {
    const parent = findNode(current.parentId);
    if (!parent) break;
    ancestry.unshift(parent);
    current = parent;
  }

  res.json({
    success: true,
    data: node,
    children: getChildren(node.id),
    ancestry,
    validChildLevels: VALID_CHILDREN[node.level],
  });
});

/** POST /nodes — create a node */
router.post('/nodes', async (req: Request, res: Response) => {
  const { parentId, level, name, description, status, orgIds, ownerId,
    purpose, businessOutcome, stakeholders, complianceTags, inputsOutputs,
    responsibleRole, responsiblePersonId, statusJustification, frequency, riskLevel, automationLevel, estimatedDuration, requiredSkillIds, systemIds,
    criticalityTier, rtoHours, rpoHours, successMeasure, slaTarget, trigger, volume, nextReviewDate, riskMitigation, controlIds } = req.body;

  if (!name) {
    res.status(400).json({ success: false, error: 'Name is required' });
    return;
  }
  if (!level || !NODE_LEVELS.includes(level)) {
    res.status(400).json({ success: false, error: `Invalid level. Must be one of: ${NODE_LEVELS.join(', ')}` });
    return;
  }

  // Validate parent-child relationship
  if (level === 'VALUE_STREAM') {
    if (parentId) {
      res.status(400).json({ success: false, error: 'Value streams cannot have a parent' });
      return;
    }
    // Validate org level — value streams only at company/division
    const orgIds = req.body.orgIds || [DEV_ORG_ID];
    const knownOrgs = getCachedOrgList();
    for (const oid of orgIds) {
      const org = knownOrgs.find((o) => o.id === oid);
      if (org && !VALUE_STREAM_ORG_LEVELS.includes(org.type)) {
        res.status(400).json({
          success: false,
          error: `Value streams can only be created at the company or division level. "${org.name}" is a ${org.type}.`,
        });
        return;
      }
    }
  } else {
    if (!parentId) {
      res.status(400).json({ success: false, error: `${level} requires a parent node` });
      return;
    }
    const parent = findNode(parentId);
    if (!parent) {
      res.status(400).json({ success: false, error: 'Parent node not found' });
      return;
    }
    if (!isValidChild(parent.level, level as NodeLevel)) {
      res.status(400).json({
        success: false,
        error: `Cannot add ${level} under ${parent.level}. Valid children: ${VALID_CHILDREN[parent.level].join(', ')}`,
      });
      return;
    }
  }

  // Lazy-require to avoid a process-catalog ↔ systems import cycle.
  // Returns the cleaned, deduped, validated list or null if the request
  // referenced an unknown system id.
  const cleanedSystemIds = systemIds === undefined
    ? undefined
    : await validateSystemIds(systemIds, res);
  if (cleanedSystemIds === null) return;

  // Responsible Person — only allowed at the activity / task level
  // (other levels use Owner). The picker enforces "must hold the role";
  // the backend just verifies the id resolves to a real person.
  let cleanedResponsiblePersonId: string | null | undefined = undefined;
  if (responsiblePersonId !== undefined) {
    const v = await validatePersonId(responsiblePersonId, res);
    if (!v.ok) return;
    cleanedResponsiblePersonId = v.value;
  }

  const allNodes = nodeSource();
  const siblings = parentId
    ? allNodes.filter((n) => n.parentId === parentId)
    : allNodes.filter((n) => n.level === 'VALUE_STREAM');

  const cleanedControlIds = Array.isArray(controlIds) && controlIds.length
    ? await cleanControlIds(controlIds)
    : [];

  const now = new Date().toISOString();
  // A child node belongs to whatever domain its parent does; a new
  // top-level value stream created by hand is operational (the
  // governance hierarchy only comes from the governance template).
  const parentForDomain = parentId ? findNode(parentId) : null;
  const nodeDomain: 'GOVERNANCE' | 'OPERATIONAL' =
    parentForDomain?.domain === 'GOVERNANCE' ? 'GOVERNANCE' : 'OPERATIONAL';
  const node: ProcessNode = {
    id: uuid(),
    parentId: parentId || null,
    level: level as NodeLevel,
    name,
    description: description || '',
    activityId: generateNodeId(level as string) || null,
    status: status || 'DRAFT',
    orderIndex: siblings.length,
    orgId: (orgIds && orgIds.length > 0) ? orgIds[0] : DEV_ORG_ID,
    orgIds: orgIds || [DEV_ORG_ID],
    // Layer-2: a CONTRIBUTOR who doesn't name an owner owns what they
    // create, so they can subsequently edit it.
    ownerId: ownerOnCreate((req as AuthenticatedRequest).user, ownerId),
    version: 1,
    // Purpose + former Business Outcome are merged into one field.
    ...(combinePurpose(purpose, businessOutcome) ? { purpose: combinePurpose(purpose, businessOutcome) } : {}),
    ...(stakeholders ? { stakeholders } : {}),
    ...(complianceTags?.length ? { complianceTags } : {}),
    ...(inputsOutputs ? { inputsOutputs } : {}),
    ...(responsibleRole ? { responsibleRole } : {}),
    ...(cleanedResponsiblePersonId ? { responsiblePersonId: cleanedResponsiblePersonId } : {}),
    ...(statusJustification ? { statusJustification } : {}),
    ...(Array.isArray(requiredSkillIds) && requiredSkillIds.length ? { requiredSkillIds } : {}),
    ...(cleanedSystemIds && cleanedSystemIds.length ? { systemIds: cleanedSystemIds } : {}),
    // New attributes — only persist when supplied so existing rows
    // don't grow "" placeholders and pickers stay clean.
    ...(criticalityTier && CRITICALITY_TIERS.includes(criticalityTier) ? { criticalityTier } : {}),
    ...(typeof rtoHours === 'number' && rtoHours >= 0 ? { rtoHours } : {}),
    ...(typeof rpoHours === 'number' && rpoHours >= 0 ? { rpoHours } : {}),
    // Success Measure + former SLA Target are merged into one field.
    ...(combineTargetSla(successMeasure, slaTarget) ? { successMeasure: combineTargetSla(successMeasure, slaTarget) } : {}),
    ...(typeof trigger === 'string' && trigger.trim() ? { trigger: trigger.trim() } : {}),
    ...(typeof volume === 'string' && volume.trim() ? { volume: volume.trim() } : {}),
    ...(typeof nextReviewDate === 'string' && nextReviewDate.trim() ? { nextReviewDate: nextReviewDate.trim() } : {}),
    ...(typeof riskMitigation === 'string' && riskMitigation.trim() ? { riskMitigation: riskMitigation.trim() } : {}),
    ...(cleanedControlIds.length ? { controlIds: cleanedControlIds } : {}),
    domain: nodeDomain,
    createdAt: now,
    updatedAt: now,
  };

  await processNodesRepo.create(node);
  if (hasDatabase()) await refreshProcessNodesCache();
  auditService.log(DEV_ORG_ID, null, 'ProcessNode', node.id, 'CREATE', null, node);
  logger.info({ level, name, parentId }, 'Created process node');

  res.status(201).json({
    success: true,
    data: node,
    validChildLevels: VALID_CHILDREN[node.level],
  });
});

/** PUT /nodes/:id — update a node */
router.put('/nodes/:id', async (req: Request, res: Response) => {
  const node = (await processNodesRepo.get(param(req.params.id))) ?? undefined;
  if (!node) { res.status(404).json({ success: false, error: 'Node not found' }); return; }

  // Layer-2: a CONTRIBUTOR may only edit nodes assigned to them.
  const putAssignErr = enforceAssignment((req as AuthenticatedRequest).user, node);
  if (putAssignErr) { res.status(putAssignErr.statusCode).json({ success: false, error: putAssignErr.message }); return; }

  const { name, description, status, orderIndex, orgIds, ownerId, parentId, version,
    purpose, businessOutcome, stakeholders, complianceTags, inputsOutputs,
    responsibleRole, responsiblePersonId, statusJustification, frequency, riskLevel, automationLevel, estimatedDuration, requiredSkillIds, systemIds,
    criticalityTier, rtoHours, rpoHours, successMeasure, slaTarget, trigger, volume, nextReviewDate, riskMitigation, controlIds,
    reviewComment } = req.body;

  // Optimistic locking: if version is provided and doesn't match, reject the update
  if (version !== undefined && version !== (node.version ?? 1)) {
    res.status(409).json({
      success: false,
      error: 'This item has been modified by another user. Please refresh and try again.',
    });
    return;
  }

  // If moving to a new parent, validate
  if (parentId !== undefined && parentId !== node.parentId) {
    if (parentId === null && node.level !== 'VALUE_STREAM') {
      res.status(400).json({ success: false, error: 'Only value streams can be root nodes' });
      return;
    }
    if (parentId) {
      const newParent = findNode(parentId);
      if (!newParent) {
        res.status(400).json({ success: false, error: 'New parent not found' });
        return;
      }
      if (!isValidChild(newParent.level, node.level)) {
        res.status(400).json({
          success: false,
          error: `Cannot move ${node.level} under ${newParent.level}`,
        });
        return;
      }
      // Prevent circular references
      const descendants = getDescendants(node.id);
      if (descendants.some((d) => d.id === parentId)) {
        res.status(400).json({ success: false, error: 'Cannot move a node under its own descendant' });
        return;
      }
    }
    node.parentId = parentId;
  }

  // Block field edits when the node is in a locked status.
  // Status-only updates are still allowed (handled below).
  const hasFieldEdits = name !== undefined || description !== undefined
    || orderIndex !== undefined || orgIds !== undefined || ownerId !== undefined
    || purpose !== undefined || businessOutcome !== undefined || stakeholders !== undefined
    || complianceTags !== undefined || inputsOutputs !== undefined || responsibleRole !== undefined
    || frequency !== undefined || riskLevel !== undefined || automationLevel !== undefined || estimatedDuration !== undefined
    || requiredSkillIds !== undefined || systemIds !== undefined
    || responsiblePersonId !== undefined
    || criticalityTier !== undefined || rtoHours !== undefined || rpoHours !== undefined
    || successMeasure !== undefined || slaTarget !== undefined
    || trigger !== undefined || volume !== undefined
    || nextReviewDate !== undefined || riskMitigation !== undefined
    || controlIds !== undefined;
  // Resolve org's status mode to determine which transitions/locks apply
  const nodeOrg = getCachedOrgList().find((o) => o.id === node.orgId) as any;
  const mode = nodeOrg?.statusMode || 'simple';
  const lockedSet = mode === 'advanced' ? ADVANCED_LOCKED : mode === 'review' ? REVIEW_LOCKED : SIMPLE_LOCKED;
  const transitionMap = mode === 'advanced' ? ADVANCED_TRANSITIONS : mode === 'review' ? REVIEW_TRANSITIONS : SIMPLE_TRANSITIONS;

  if (hasFieldEdits && lockedSet.has(node.status)) {
    res.status(403).json({
      success: false,
      error: `Cannot edit "${node.name}" — it is currently ${node.status.replace('_', ' ')}. Change its status to Draft first.`,
    });
    return;
  }

  if (name !== undefined) node.name = name;
  if (description !== undefined) node.description = description;
  if (orderIndex !== undefined) node.orderIndex = orderIndex;
  if (orgIds !== undefined) node.orgIds = orgIds;
  if (ownerId !== undefined) node.ownerId = ownerId;
  if (purpose !== undefined) node.purpose = purpose;
  // Business Outcome merged into Purpose: fold any incoming value into
  // purpose. The deprecated field is never written back (existing rows
  // were cleared by the merge_business_outcome_into_purpose migration).
  if (businessOutcome !== undefined) {
    node.purpose = combinePurpose(node.purpose, businessOutcome);
  }
  if (stakeholders !== undefined) node.stakeholders = stakeholders;
  if (complianceTags !== undefined) node.complianceTags = complianceTags;
  if (inputsOutputs !== undefined) node.inputsOutputs = inputsOutputs;
  if (responsibleRole !== undefined) node.responsibleRole = responsibleRole;
  if (responsiblePersonId !== undefined) {
    const v = await validatePersonId(responsiblePersonId, res);
    if (!v.ok) return;
    node.responsiblePersonId = v.value;
  }
  if (statusJustification !== undefined) node.statusJustification = statusJustification;
  if (frequency !== undefined) node.frequency = frequency;
  if (riskLevel !== undefined) node.riskLevel = riskLevel;
  if (automationLevel !== undefined) node.automationLevel = automationLevel;
  if (estimatedDuration !== undefined) node.estimatedDuration = estimatedDuration;
  if (requiredSkillIds !== undefined) node.requiredSkillIds = Array.isArray(requiredSkillIds) ? requiredSkillIds : [];
  if (systemIds !== undefined) {
    const cleaned = await validateSystemIds(systemIds, res);
    if (cleaned === null) return;
    node.systemIds = cleaned.length > 0 ? cleaned : undefined;
  }
  // BCM + governance attributes — accept undefined (leave unchanged),
  // null / empty (clear), or the new value. Enum + range checks so
  // malformed callers see a 400 rather than a silent no-op.
  if (criticalityTier !== undefined) {
    if (criticalityTier === null || criticalityTier === '') {
      node.criticalityTier = undefined;
    } else if (CRITICALITY_TIERS.includes(criticalityTier)) {
      node.criticalityTier = criticalityTier;
    } else {
      res.status(400).json({ success: false, error: `Unknown criticalityTier "${criticalityTier}". Expected one of: ${CRITICALITY_TIERS.join(', ')}.` });
      return;
    }
  }
  if (rtoHours !== undefined) {
    if (rtoHours === null || rtoHours === '') {
      node.rtoHours = undefined;
    } else if (typeof rtoHours === 'number' && rtoHours >= 0) {
      node.rtoHours = rtoHours;
    } else {
      res.status(400).json({ success: false, error: 'rtoHours must be a non-negative number.' });
      return;
    }
  }
  if (rpoHours !== undefined) {
    if (rpoHours === null || rpoHours === '') {
      node.rpoHours = undefined;
    } else if (typeof rpoHours === 'number' && rpoHours >= 0) {
      node.rpoHours = rpoHours;
    } else {
      res.status(400).json({ success: false, error: 'rpoHours must be a non-negative number.' });
      return;
    }
  }
  if (successMeasure !== undefined) node.successMeasure = successMeasure || undefined;
  // SLA Target merged into Success Measure (the "Target / SLA" field): fold
  // any incoming slaTarget into successMeasure. The deprecated field is never
  // written back (existing rows cleared by the merge migration).
  if (slaTarget !== undefined) {
    node.successMeasure = combineTargetSla(node.successMeasure, slaTarget);
  }
  if (trigger !== undefined) node.trigger = (typeof trigger === 'string' && trigger.trim()) ? trigger.trim() : undefined;
  if (volume !== undefined) node.volume = (typeof volume === 'string' && volume.trim()) ? volume.trim() : undefined;
  if (nextReviewDate !== undefined) node.nextReviewDate = (typeof nextReviewDate === 'string' && nextReviewDate.trim()) ? nextReviewDate.trim() : undefined;
  if (riskMitigation !== undefined) node.riskMitigation = (typeof riskMitigation === 'string' && riskMitigation.trim()) ? riskMitigation.trim() : undefined;
  if (controlIds !== undefined) {
    node.controlIds = Array.isArray(controlIds) && controlIds.length > 0
      ? await cleanControlIds(controlIds)
      : undefined;
  }

  // Validate status transition against the state machine
  if (status !== undefined && status !== node.status) {
    const allowed = transitionMap[node.status] || [];
    if (!allowed.includes(status)) {
      res.status(400).json({
        success: false,
        error: `Cannot transition from ${node.status.replace('_', ' ')} to ${status.replace('_', ' ')}. Valid transitions: ${allowed.map((s: string) => s.replace('_', ' ')).join(', ') || 'none'}.`,
      });
      return;
    }
    // Status is changing — create a version snapshot before applying the change
    const existingVersions = (await processVersionsRepo.list()).filter((v) => v.nodeId === node.id);
    const nextVersion = existingVersions.length > 0
      ? Math.max(...existingVersions.map((v) => v.version)) + 1
      : 1;
    const versionSnapshot: ProcessVersion = {
      id: uuid(),
      nodeId: node.id,
      version: nextVersion,
      snapshot: { ...node },
      changedBy: (req as any).user?.sub || null,
      changedAt: new Date().toISOString(),
      status: node.status,
      note: `Status changed from ${node.status} to ${status}`,
    };
    await processVersionsRepo.create(versionSnapshot);
  }

  if (status !== undefined) {
    if (status === 'ACTIVE') {
      if (node.level === 'VALUE_STREAM') {
        const descendants = getDescendants(node.id);
        const hasProcess = descendants.some((d) => d.level === 'PROCESS');
        const hasActivity = descendants.some((d) => d.level === 'ACTIVITY');
        if (!hasProcess || !hasActivity) {
          res.status(400).json({
            success: false,
            error: `Cannot set to ${status}. Value stream "${node.name}" requires at least one Process and one Activity.`,
          });
          return;
        }
      }
      if (node.level === 'PROCESS') {
        const descendants = getDescendants(node.id);
        const hasActivity = descendants.some((d) => d.level === 'ACTIVITY');
        if (!hasActivity) {
          res.status(400).json({
            success: false,
            error: `Cannot set to ${status}. Process "${node.name}" requires at least one Activity.`,
          });
          return;
        }
      }
    }
    const oldStatus = node.status;

    // ── Change-management review workflow (statusMode === 'review') ──
    // Track who submitted / who approved on the row itself so the
    // audit trail travels with the node and the UI can render the
    // Pending-review chip without walking the version log.
    const actingPersonId: string | null = (req as any).user?.sub || null;
    if (mode === 'review') {
      if (oldStatus === 'DRAFT' && status === 'PENDING_REVIEW') {
        if (!actingPersonId) {
          res.status(401).json({ success: false, error: 'Sign in required to submit for review.' });
          return;
        }
        node.submittedBy = actingPersonId;
        node.submittedAt = new Date().toISOString();
        // A fresh submission clears the prior reviewer decision so the
        // node doesn't carry stale approval metadata from a rejected
        // earlier cycle.
        node.reviewedBy = undefined;
        node.reviewedAt = undefined;
        if (typeof reviewComment === 'string') node.reviewComment = reviewComment;
      } else if (oldStatus === 'PENDING_REVIEW' && (status === 'ACTIVE' || status === 'DRAFT')) {
        // Segregation of duties — the submitter is not allowed to
        // approve their own submission. Rejection (→ DRAFT) is
        // allowed because self-withdrawal must always be possible.
        if (status === 'ACTIVE' && actingPersonId && node.submittedBy && actingPersonId === node.submittedBy) {
          res.status(403).json({
            success: false,
            error: 'The submitter cannot approve their own change. A different reviewer must sign off.',
          });
          return;
        }
        if (actingPersonId) {
          node.reviewedBy = actingPersonId;
          node.reviewedAt = new Date().toISOString();
        }
        if (typeof reviewComment === 'string') node.reviewComment = reviewComment;
      } else if (status === 'DRAFT') {
        // Any other transition back to DRAFT (e.g. from ACTIVE) clears
        // the review metadata — a new draft starts its own cycle.
        node.submittedBy = undefined;
        node.submittedAt = undefined;
        node.reviewedBy = undefined;
        node.reviewedAt = undefined;
        node.reviewComment = undefined;
      }
    }

    node.status = status;

    // Workflow notifications on status transitions
    if (status !== oldStatus) {
      const levelLabel = node.level.toLowerCase().replace('_', ' ');
      if (status === 'PENDING_REVIEW') {
        // Notify the org — the org admins pick it up from the
        // "Pending review" tile on the Dashboard. Directed to a
        // specific reviewer would need a reviewer-assignment model;
        // v1 fans out to the org so any authorised approver can act.
        createNotification({
          orgId: node.orgId,
          type: 'ACTION',
          title: `Change submitted for review: ${node.name}`,
          message: `A change to the ${levelLabel} "${node.name}" has been submitted for review.`,
          link: `/processes?node=${node.id}`,
        });
      } else if (status === 'ACTIVE') {
        // Notify the original submitter that their change was
        // approved, when we know who they were.
        if (node.submittedBy) {
          createNotification({
            orgId: node.orgId,
            userId: node.submittedBy,
            type: 'INFO',
            title: `Change approved: ${node.name}`,
            message: `Your change to the ${levelLabel} "${node.name}" was approved and is now Active.`,
            link: `/processes?node=${node.id}`,
          });
        }
        createNotification({
          orgId: node.orgId,
          type: 'INFO',
          title: `Process '${node.name}' is now active`,
          message: `The ${levelLabel} "${node.name}" is now active in the process catalog.`,
          link: '/processes',
        });
      } else if (status === 'DRAFT' && oldStatus === 'PENDING_REVIEW') {
        // Rejection — tell the submitter what the reviewer said.
        if (node.submittedBy) {
          createNotification({
            orgId: node.orgId,
            userId: node.submittedBy,
            type: 'WARNING',
            title: `Changes requested: ${node.name}`,
            message: node.reviewComment
              ? `The reviewer requested changes on "${node.name}": "${node.reviewComment}".`
              : `The reviewer requested changes on "${node.name}". Update and resubmit.`,
            link: `/processes?node=${node.id}`,
          });
        }
      } else if (status === 'DEPRECATED') {
        createNotification({
          orgId: node.orgId,
          type: 'WARNING',
          title: `Process '${node.name}' has been deprecated`,
          message: `The ${levelLabel} "${node.name}" has been marked as deprecated. Review any dependent data assets and mappings.`,
          link: '/processes',
        });
      }
    }
  }

  node.updatedAt = new Date().toISOString();
  node.version = (node.version ?? 1) + 1;

  await processNodesRepo.update(node.id, node);
  if (hasDatabase()) await refreshProcessNodesCache();
  auditService.log(DEV_ORG_ID, null, 'ProcessNode', node.id, 'UPDATE', null, node);
  res.json({ success: true, data: node });
});

/** DELETE /nodes/:id — delete a node and all descendants */
router.delete('/nodes/:id', async (req: Request, res: Response) => {
  const nodeId = param(req.params.id);
  const node = findNode(nodeId);
  if (!node) { res.status(404).json({ success: false, error: 'Node not found' }); return; }

  // Layer-2: a CONTRIBUTOR may only delete nodes assigned to them.
  const delAssignErr = enforceAssignment((req as AuthenticatedRequest).user, node);
  if (delAssignErr) { res.status(delAssignErr.statusCode).json({ success: false, error: delAssignErr.message }); return; }

  // Collect all descendants
  const descendants = getDescendants(nodeId);
  const idsToRemove = new Set([nodeId, ...descendants.map((d) => d.id)]);

  // Remove all nodes
  for (const id of idsToRemove) {
    await processNodesRepo.delete(id);
  }
  if (hasDatabase()) await refreshProcessNodesCache();

  // Remove flow relationships involving deleted nodes
  const flowsToRemove = (await flowRelationshipsRepo.list()).filter(
    (f) => idsToRemove.has(f.fromNodeId) || idsToRemove.has(f.toNodeId),
  );
  for (const f of flowsToRemove) {
    await flowRelationshipsRepo.delete(f.id);
  }

  // Cascade: drop data mappings that referenced any deleted step.
  const mappingsRemoved = await cascadeDeleteMappings(idsToRemove);

  auditService.log(DEV_ORG_ID, null, 'ProcessNode', nodeId, 'DELETE', node, null);
  logger.info({ id: nodeId, level: node.level, descendantsRemoved: descendants.length, mappingsRemoved }, 'Deleted process node');

  res.status(204).send();
});

/** POST /nodes/:id/clone — deep-clone a node and all its descendants */
router.post('/nodes/:id/clone', async (req: Request, res: Response) => {
  const source = findNode(param(req.params.id));
  if (!source) { res.status(404).json({ success: false, error: 'Node not found' }); return; }

  // Layer-2: a CONTRIBUTOR may only clone a node assigned to them.
  const cloneAssignErr = enforceAssignment((req as AuthenticatedRequest).user, source);
  if (cloneAssignErr) { res.status(cloneAssignErr.statusCode).json({ success: false, error: cloneAssignErr.message }); return; }

  const { name } = req.body;
  const now = new Date().toISOString();
  const idMap = new Map<string, string>(); // old ID -> new ID

  // Collect source node and all descendants
  const allNodes = [source, ...getDescendants(source.id)];

  // Generate new IDs for every node
  for (const node of allNodes) {
    idMap.set(node.id, uuid());
  }

  // Clone nodes with new IDs and updated parent references
  const cloned: ProcessNode[] = allNodes.map((node, idx) => ({
    ...node,
    id: idMap.get(node.id)!,
    parentId: idx === 0 ? source.parentId : idMap.get(node.parentId!) || null,
    name: idx === 0 ? (name || `${node.name} (copy)`) : node.name,
    activityId: generateNodeId(node.level),
    status: 'DRAFT',
    ownerId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }));

  for (const c of cloned) await processNodesRepo.create(c);
  if (hasDatabase()) await refreshProcessNodesCache();
  auditService.log(DEV_ORG_ID, null, 'ProcessNode', cloned[0].id, 'CLONE', null, { sourceId: source.id, count: cloned.length });
  logger.info({ sourceId: source.id, clonedRoot: cloned[0].id, count: cloned.length }, 'Cloned process node tree');

  res.status(201).json({ success: true, data: cloned, message: `Cloned ${cloned.length} nodes` });
});

/** GET /nodes/:id/validate — validate a value stream's integrity */
router.get('/nodes/:id/validate', (req: Request, res: Response) => {
  const vNode = findNode(param(req.params.id));
  if (vNode && !assertOrgAccessAny(req, res, [vNode.orgId, ...(vNode.orgIds || [])], 'Node not found')) return;
  const result = validateProcessIntegrity(param(req.params.id));
  res.json({ success: true, data: result });
});

/** GET /data-graph — Phase 3 visualization. Returns the bipartite
 *  process↔data graph as three flat arrays so the frontend can draw
 *  it without N round-trips: every activity in the (optionally
 *  org-scoped) tree, every data asset in scope, and every mapping
 *  edge between them. Each activity carries its parent-process name
 *  for grouping; each asset carries its system + tier for grouping
 *  and badge rendering. Edges carry the linkType so the visualization
 *  can colour or weight them. Excludes governance-domain activities
 *  by default since the data map is an operational view; pass
 *  ?includeGovernance=1 to opt them in. */
router.get('/data-graph', async (req: Request, res: Response) => {
  const { orgId } = req.query;
  const includeGov = req.query.includeGovernance === '1' || req.query.includeGovernance === 'true';
  const scope = orgId ? getVisibleOrgScope(orgId as string) : null;
  const [dataAssets, mappings, systems] = await Promise.all([
    dataAssetsRepo().list(), mappingsRepo().list(), systemsRepo().list(),
  ]);

  const inScope = (n: { orgId: string; orgIds: string[] }) =>
    !scope || scope.has(n.orgId) || (n.orgIds || []).some((id) => scope.has(id));

  const allNodes = nodeSource();
  const parentNameById = new Map<string, string>();
  const nodeById = new Map<string, typeof allNodes[number]>();
  for (const n of allNodes) { parentNameById.set(n.id, n.name); nodeById.set(n.id, n); }

  // Walk the parent chain to the root, returning the ancestors root-first
  // (Value Stream → Process → Sub-process) so the Process ↔ Data map can
  // group activities under the levels above them. Guarded against cycles.
  const ancestorPath = (n: typeof allNodes[number]): Array<{ id: string; name: string; level: string }> => {
    const path: Array<{ id: string; name: string; level: string }> = [];
    let cur = n.parentId ? nodeById.get(n.parentId) : undefined;
    let guard = 0;
    while (cur && guard++ < 20) {
      path.unshift({ id: cur.id, name: cur.name, level: cur.level });
      cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
    }
    return path;
  };

  const activities = allNodes
    .filter((n) => n.level === 'ACTIVITY' && inScope(n))
    .filter((n) => includeGov || !isGovernanceNode(n))
    .map((n) => ({
      id: n.id,
      name: n.name,
      parentProcessId: n.parentId,
      parentProcessName: n.parentId ? parentNameById.get(n.parentId) || null : null,
      // Full ancestor chain (root-first) so the map can nest activities
      // under Value Stream → Process → Sub-process headers.
      path: ancestorPath(n),
      systemIds: n.systemIds || [],
    }));
  const activityIdSet = new Set(activities.map((a) => a.id));

  // Which data domain each asset rolls up to (a domain lists its member
  // asset ids). First domain wins if an asset is somehow in more than one.
  const domainByAssetId = new Map<string, { id: string; name: string }>();
  const allDomains = await dataDomainsRepo().list();
  for (const d of allDomains) {
    for (const aid of (d.dataAssetIds || [])) {
      if (!domainByAssetId.has(aid)) domainByAssetId.set(aid, { id: d.id, name: d.name });
    }
  }

  const orgAssetIds = new Set<string>();
  const assetsOut = dataAssets
    .filter((a: any) => !scope || scope.has(a.orgId))
    .map((a: any) => {
      orgAssetIds.add(a.id);
      const sysName = a.systemId
        ? systems.find((s: any) => s.id === a.systemId)?.name || null
        : null;
      const dom = domainByAssetId.get(a.id) || null;
      return {
        id: a.id,
        name: a.name,
        systemId: a.systemId,
        systemName: sysName,
        governanceTier: a.governanceTier,
        // Data domain the asset belongs to (null when ungrouped) so the
        // map can roll assets up under domain headers like activities roll
        // up under processes.
        domainId: dom?.id || null,
        domainName: dom?.name || null,
      };
    });

  const edges = mappings
    .filter((m: any) => m.dataAssetId && activityIdSet.has(m.processStepId) && orgAssetIds.has(m.dataAssetId))
    .map((m: any) => ({
      mappingId: m.id,
      activityId: m.processStepId,
      assetId: m.dataAssetId,
      linkType: m.linkType,
    }));

  // Keep only assets that actually participate in an edge — the
  // visualization showing every orphan asset on the right column
  // crushes the layout and orphans have their own dedicated page.
  const referencedAssetIds = new Set(edges.map((e: any) => e.assetId));
  const visibleAssets = assetsOut.filter((a: any) => referencedAssetIds.has(a.id));

  res.json({
    success: true,
    data: {
      activities,
      assets: visibleAssets,
      edges,
      stats: {
        activityCount: activities.length,
        assetCount: visibleAssets.length,
        edgeCount: edges.length,
        mappedActivityCount: new Set(edges.map((e: any) => e.activityId)).size,
      },
    },
  });
});

// ── VERSION HISTORY ──

/** GET /nodes/:id/history — returns all versions for a node, newest first */
router.get('/nodes/:id/history', async (req: Request, res: Response) => {
  const nodeId = param(req.params.id);
  const node = findNode(nodeId);
  if (!node) { res.status(404).json({ success: false, error: 'Node not found' }); return; }
  if (!assertOrgAccessAny(req, res, [node.orgId, ...(node.orgIds || [])], 'Node not found')) return;

  const versions = (await processVersionsRepo.list())
    .filter((v) => v.nodeId === nodeId)
    .sort((a, b) => b.version - a.version);

  res.json({ success: true, data: versions });
});

/** GET /nodes/:id/history/:versionId — returns a specific version */
router.get('/nodes/:id/history/:versionId', async (req: Request, res: Response) => {
  const nodeId = param(req.params.id);
  const versionId = param(req.params.versionId);
  const histNode = findNode(nodeId);
  if (histNode && !assertOrgAccessAny(req, res, [histNode.orgId, ...(histNode.orgIds || [])], 'Version not found')) return;

  const version = (await processVersionsRepo.list()).find((v) => v.id === versionId && v.nodeId === nodeId);
  if (!version) { res.status(404).json({ success: false, error: 'Version not found' }); return; }

  res.json({ success: true, data: version });
});

// ── FLOW RELATIONSHIPS ──

/** GET /flows — list all flows */
router.get('/flows', async (_req: Request, res: Response) => {
  const enriched = (await flowRelationshipsRepo.list()).map((f) => ({
    ...f,
    fromNode: findNode(f.fromNodeId),
    toNode: findNode(f.toNodeId),
  }));
  res.json({ success: true, data: enriched });
});

/** GET /flows/by-node/:nodeId — get flows for a specific node.
 *
 *  Enriches each flow row with the "other end" node's name, level,
 *  status, and its ancestor breadcrumb (`Value Stream > Process >
 *  Sub-Process > Activity`), so the Dependencies panel on the
 *  Activity detail doesn't need to run a second lookup and doesn't
 *  need the full node list in local state to render.
 */
router.get('/flows/by-node/:nodeId', async (req: Request, res: Response) => {
  const nodeId = param(req.params.nodeId);
  const allFlows = await flowRelationshipsRepo.list();
  const outgoing = allFlows
    .filter((f) => f.fromNodeId === nodeId)
    .map((f) => ({ ...f, other: nodeSummary(f.toNodeId) }));
  const incoming = allFlows
    .filter((f) => f.toNodeId === nodeId)
    .map((f) => ({ ...f, other: nodeSummary(f.fromNodeId) }));
  res.json({
    success: true,
    data: { outgoing, incoming },
  });
});

// Build a compact "other end" summary for a flow. Walk up the tree to
// build the breadcrumb so the caller can render "Outage Management >
// Response > Outage triage" without shipping the whole catalog. Also
// carry the node's own description so the Dependencies panel can show
// identifier + description without a second lookup. Null when the
// referenced node is missing — the row still renders as dangling so
// the user can delete it.
function nodeSummary(id: string): { id: string; name: string; description: string; level: string; status: string; breadcrumb: string } | null {
  const node = findNode(id);
  if (!node) return null;
  const crumbs: string[] = [];
  let current: ProcessNode | undefined = node;
  while (current) {
    crumbs.unshift(current.name);
    current = current.parentId ? findNode(current.parentId) : undefined;
  }
  return {
    id: node.id,
    name: node.name,
    description: node.description || '',
    level: node.level,
    status: node.status,
    breadcrumb: crumbs.join(' > '),
  };
}

/** POST /flows — create a flow relationship */
router.post('/flows', async (req: Request, res: Response) => {
  const { fromNodeId, toNodeId, type, label } = req.body;

  if (!fromNodeId || !toNodeId) {
    res.status(400).json({ success: false, error: 'fromNodeId and toNodeId are required' });
    return;
  }

  const fromNode = findNode(fromNodeId);
  const toNode = findNode(toNodeId);
  if (!fromNode) { res.status(400).json({ success: false, error: 'From node not found' }); return; }
  if (!toNode) { res.status(400).json({ success: false, error: 'To node not found' }); return; }

  // Flows should primarily be between activities (but allow others for flexibility)
  const validFlowTypes = ['SEQUENCE', 'PARALLEL', 'CONDITIONAL', 'LOOP'];
  if (type && !validFlowTypes.includes(type)) {
    res.status(400).json({ success: false, error: `Invalid flow type. Must be one of: ${validFlowTypes.join(', ')}` });
    return;
  }

  // Fetch the flow set once; reused for the duplicate check and the
  // cycle-detection BFS below.
  const allFlows = await flowRelationshipsRepo.list();

  // Prevent duplicate flows
  const existing = allFlows.find(
    (f) => f.fromNodeId === fromNodeId && f.toNodeId === toNodeId && f.type === (type || 'SEQUENCE')
  );
  if (existing) {
    res.status(409).json({ success: false, error: 'This flow relationship already exists' });
    return;
  }

  // Prevent self-referencing flows
  if (fromNodeId === toNodeId) {
    res.status(400).json({ success: false, error: 'Cannot create a flow from a node to itself' });
    return;
  }

  // Cycle detection — reject if adding this edge would make toNode
  // reachable from itself via any path of SEQUENCE/PARALLEL/CONDITIONAL
  // flows. Walk from `toNodeId` forward; if we hit `fromNodeId` before
  // exhausting the graph, adding the new edge would close a loop.
  // LOOP-type flows are the one edge type where a cycle is intentional
  // — skip the check when the caller is explicitly declaring a LOOP.
  if ((type || 'SEQUENCE') !== 'LOOP') {
    const visited = new Set<string>();
    const queue = [toNodeId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === fromNodeId) {
        res.status(400).json({
          success: false,
          error: `Adding this flow would create a cycle back to ${fromNode.name}. Use a LOOP-type flow if the cycle is intentional.`,
        });
        return;
      }
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const f of allFlows) {
        if (f.fromNodeId === cur && f.type !== 'LOOP') queue.push(f.toNodeId);
      }
    }
  }

  const flow: FlowRelationship = {
    id: uuid(),
    fromNodeId,
    toNodeId,
    type: (type || 'SEQUENCE') as FlowRelationship['type'],
    label: label || null,
    createdAt: new Date().toISOString(),
  };

  await flowRelationshipsRepo.create(flow);
  logger.info({ from: fromNode.name, to: toNode.name, type: flow.type }, 'Created flow relationship');

  res.status(201).json({ success: true, data: flow });
});

/** DELETE /flows/:id — delete a flow relationship */
router.delete('/flows/:id', async (req: Request, res: Response) => {
  const flow = (await flowRelationshipsRepo.list()).find((f) => f.id === param(req.params.id));
  if (!flow) { res.status(404).json({ success: false, error: 'Flow not found' }); return; }
  await flowRelationshipsRepo.delete(flow.id);
  res.status(204).send();
});

// ── TEMPLATE APPLICATION ──

/** POST /apply-template — create hierarchy from AI-generated template */
router.post('/apply-template', async (req: Request, res: Response) => {
  try {
    const { industry, valueStreams: templateStreams, orgId: requestOrgId } = req.body;
    const templateOrgId = requestOrgId || DEV_ORG_ID;
    if (!templateStreams || !Array.isArray(templateStreams) || templateStreams.length === 0) {
      res.status(400).json({ success: false, error: 'No value streams provided' });
      return;
    }

    const created: ProcessNode[] = [];
    const now = new Date().toISOString();
    // Base order index for new value streams; increments per VS in this batch
    // (the store/cache isn't refreshed mid-loop, so derive it locally).
    let vsOrderIndex = nodeSource().filter((n) => n.level === 'VALUE_STREAM').length;

    for (const tvs of templateStreams) {
      // Create Value Stream node
      const vsNode: ProcessNode = {
        id: uuid(), parentId: null, level: 'VALUE_STREAM',
        name: tvs.name, description: tvs.description || `Generated from ${industry} template`,
        activityId: generateNodeId('VALUE_STREAM'), status: 'DRAFT',
        orderIndex: vsOrderIndex++,
        orgId: templateOrgId, orgIds: [templateOrgId], ownerId: null,
        version: 1, domain: 'OPERATIONAL',
        ...(combinePurpose(tvs.purpose, tvs.businessOutcome) ? { purpose: combinePurpose(tvs.purpose, tvs.businessOutcome) } : {}),
        createdAt: now, updatedAt: now,
      };
      await processNodesRepo.create(vsNode);
      created.push(vsNode);

      // Create Process nodes with Activities
      for (let pIdx = 0; pIdx < (tvs.processes || []).length; pIdx++) {
        const proc = tvs.processes[pIdx];
        const procNode: ProcessNode = {
          id: uuid(), parentId: vsNode.id, level: 'PROCESS',
          name: proc.name, description: proc.description || '',
          activityId: generateNodeId('PROCESS'), status: 'DRAFT', orderIndex: pIdx,
          orgId: templateOrgId, orgIds: [templateOrgId], ownerId: null,
          version: 1, domain: 'OPERATIONAL',
          ...(proc.purpose ? { purpose: proc.purpose } : {}),
          createdAt: now, updatedAt: now,
        };
        await processNodesRepo.create(procNode);
        created.push(procNode);

        // Handle both formats: new (activities) and legacy (subProcesses > steps)
        const activities = proc.activities || [];
        const legacyActivities: any[] = [];
        if (activities.length === 0 && proc.subProcesses) {
          // Legacy format: create subprocesses and extract steps as activities
          for (let spIdx = 0; spIdx < proc.subProcesses.length; spIdx++) {
            const sp = proc.subProcesses[spIdx];
            const spNode: ProcessNode = {
              id: uuid(), parentId: procNode.id, level: 'SUBPROCESS',
              name: sp.name, description: sp.description || '',
              activityId: generateNodeId('SUBPROCESS'), status: 'DRAFT', orderIndex: spIdx,
              orgId: templateOrgId, orgIds: [templateOrgId], ownerId: null,
              version: 1, domain: 'OPERATIONAL',
              createdAt: now, updatedAt: now,
            };
            await processNodesRepo.create(spNode);
            created.push(spNode);

            for (const st of (sp.steps || sp.activities || [])) {
              legacyActivities.push({ ...st, _parentId: spNode.id });
            }
          }
        }

        // Create Activity nodes (either from new format or legacy)
        const activityList = activities.length > 0
          ? activities.map((a: any) => ({ ...a, _parentId: procNode.id }))
          : legacyActivities.length > 0
            ? legacyActivities
            : [];

        const prevActivities: ProcessNode[] = [];
        for (let aIdx = 0; aIdx < activityList.length; aIdx++) {
          const act = activityList[aIdx];
          const actNode: ProcessNode = {
            id: uuid(), parentId: act._parentId || procNode.id, level: 'ACTIVITY',
            name: act.name, description: act.description || '',
            activityId: generateNodeId('ACTIVITY'), status: 'DRAFT', orderIndex: aIdx,
            orgId: templateOrgId, orgIds: [templateOrgId], ownerId: null,
            version: 1, domain: 'OPERATIONAL',
            createdAt: now, updatedAt: now,
          };
          await processNodesRepo.create(actNode);
          created.push(actNode);

          // Create sequence flow from previous activity within same parent
          if (prevActivities.length > 0) {
            const prevAct = prevActivities[prevActivities.length - 1];
            if (prevAct.parentId === actNode.parentId) {
              await flowRelationshipsRepo.create({
                id: uuid(), fromNodeId: prevAct.id, toNodeId: actNode.id,
                type: 'SEQUENCE', label: null, createdAt: now,
              });
            }
          }
          prevActivities.push(actNode);
        }
      }
    }

    if (hasDatabase()) await refreshProcessNodesCache();
    logger.info({ count: created.length, industry }, 'Applied template with universal hierarchy');
    res.status(201).json({ success: true, data: created, tree: buildTree(nodeSource()) });
  } catch (err) {
    logger.error({ err }, 'Apply template failed');
    res.status(500).json({ success: false, error: 'Failed to apply template' });
  }
});

// The standard, DAMA-aligned data-governance process hierarchy. Unlike
// operational value streams (which are industry-specific and AI-generated),
// the governance program is universal, so it's a static template rather
// than a Claude call. Kept at module scope as the SINGLE source of truth
// for both the preview (GET /governance-template, which feeds the wizard's
// Review screen) and the apply (POST /apply-governance-template) — so the
// hierarchy a user reviews is exactly the hierarchy that gets created.
const GOVERNANCE_TEMPLATE = [
    {
      name: 'Data Governance Management',
      description: 'Enterprise-wide data governance strategy, policies, standards, and oversight',
      purpose: 'Establish and maintain the organizational framework for managing data as a strategic asset',
      businessOutcome: 'Trusted, well-governed data that supports business decisions and regulatory compliance',
      processes: [
        {
          name: 'Data Strategy & Policy',
          description: 'Define and maintain data governance charter, policies, and standards',
          purpose: 'Set the rules and guidelines for how data is managed across the organization',
          activities: [
            { name: 'Define Data Governance Charter', description: 'Establish governance mission, vision, principles, and decision rights', responsibleRole: 'Chief Data Officer', inputsOutputs: 'In: business strategy, regulatory requirements, industry benchmarks. Out: governance charter, decision rights matrix, guiding principles.' },
            { name: 'Establish Data Policies', description: 'Create policies for data quality, security, privacy, retention, and sharing', responsibleRole: 'Data Governance Lead', inputsOutputs: 'In: governance charter, regulatory requirements, risk assessments. Out: data policies, compliance guidelines, policy approval records.' },
            { name: 'Define Data Standards', description: 'Set naming conventions, data definitions, and formatting rules', responsibleRole: 'Data Architect', inputsOutputs: 'In: data policies, existing data models, business glossary. Out: naming conventions, data type standards, formatting rules.' },
            { name: 'Review and Update Policies', description: 'Periodic review of policies against regulatory changes and business needs', responsibleRole: 'Data Governance Lead', inputsOutputs: 'In: current policies, regulatory updates, audit findings, stakeholder feedback. Out: updated policies, change log, stakeholder notifications.' },
            { name: 'Communicate Policy Changes', description: 'Distribute updates to stakeholders and ensure awareness', responsibleRole: 'Data Governance Lead', inputsOutputs: 'In: approved policy changes, stakeholder list. Out: communication records, training materials, acknowledgment receipts.' },
          ],
        },
        {
          name: 'Data Quality Management',
          description: 'Monitor, measure, and improve data quality across the organization',
          purpose: 'Ensure data meets defined quality standards for accuracy, completeness, and timeliness',
          activities: [
            { name: 'Define Quality Rules & Thresholds', description: 'Establish measurable quality criteria per data asset and domain', responsibleRole: 'Data Quality Analyst', inputsOutputs: 'In: data asset catalog, domain definitions, business requirements. Out: quality rule definitions, threshold standards, measurement criteria.' },
            { name: 'Execute Quality Assessments', description: 'Run quality rules against data assets on schedule or on-demand', responsibleRole: 'Data Quality Analyst', inputsOutputs: 'In: quality rules, data assets, schedule configuration. Out: quality scores, pass/fail results, execution logs.' },
            { name: 'Analyze Quality Results', description: 'Review scores, identify trends, and flag critical failures', responsibleRole: 'Data Quality Analyst', inputsOutputs: 'In: quality scores, historical trends, threshold definitions. Out: analysis report, trend charts, critical failure alerts.' },
            { name: 'Investigate Root Causes', description: 'Trace quality issues to source systems, processes, or manual errors', responsibleRole: 'Business Data Steward', inputsOutputs: 'In: failure alerts, data lineage, system logs. Out: root cause analysis, source system identification, remediation recommendations.' },
            { name: 'Implement Remediation', description: 'Fix data issues and update processes to prevent recurrence', responsibleRole: 'Technical Data Steward', inputsOutputs: 'In: root cause analysis, remediation plan. Out: corrected data, updated processes, prevention controls.' },
            { name: 'Report Quality Metrics', description: 'Publish quality dashboards and scorecards for stakeholders', responsibleRole: 'Data Quality Analyst', inputsOutputs: 'In: quality scores, trend data, SLA definitions. Out: quality dashboards, scorecards, executive summaries.' },
          ],
        },
        {
          name: 'Data Domain Management',
          description: 'Organize data into governed domains with clear ownership and stewardship',
          purpose: 'Ensure every data asset has an accountable owner and active steward',
          activities: [
            { name: 'Define Data Domains', description: 'Identify and scope data domains (Customer, Financial, Operational, etc.)', responsibleRole: 'Data Governance Lead', inputsOutputs: 'In: business capabilities, data asset inventory, organizational structure. Out: domain definitions, scope boundaries, domain catalog.' },
            { name: 'Assign Domain Owners', description: 'Designate accountable business owners for each domain', responsibleRole: 'Chief Data Officer', inputsOutputs: 'In: domain definitions, organizational chart, executive sponsorship. Out: owner assignments, accountability matrix, communication to owners.' },
            { name: 'Assign Data Stewards', description: 'Designate day-to-day stewards responsible for data quality within domains', responsibleRole: 'Data Owner', inputsOutputs: 'In: domain scope, team structure, skill requirements. Out: steward assignments, role descriptions, onboarding materials.' },
            { name: 'Map Assets to Domains', description: 'Link data assets to their governing domains', responsibleRole: 'Business Data Steward', inputsOutputs: 'In: data asset catalog, domain definitions. Out: asset-to-domain mappings, coverage report, orphan asset list.' },
            { name: 'Review Domain Coverage', description: 'Identify orphaned assets and gaps in domain assignment', responsibleRole: 'Data Governance Lead', inputsOutputs: 'In: asset-to-domain mappings, data asset catalog. Out: coverage report, gap analysis, remediation plan.' },
            { name: 'Resolve Cross-Domain Issues', description: 'Arbitrate conflicts where data spans multiple domains', responsibleRole: 'Data Governance Lead', inputsOutputs: 'In: conflict reports, domain boundaries, stakeholder positions. Out: resolution decisions, updated boundaries, stakeholder communication.' },
          ],
        },
        {
          name: 'Metadata & Catalog Management',
          description: 'Maintain the enterprise data catalog, business glossary, and lineage',
          purpose: 'Make data discoverable, understandable, and traceable across the organization',
          activities: [
            { name: 'Maintain Data Catalog', description: 'Register and update data asset definitions, owners, and classifications', responsibleRole: 'Business Data Steward', inputsOutputs: 'In: data asset discoveries, system inventories, owner assignments. Out: updated catalog entries, asset metadata, classification tags.' },
            { name: 'Define Business Glossary Terms', description: 'Create agreed-upon definitions for key business terms', responsibleRole: 'Business Data Steward', inputsOutputs: 'In: business terminology, stakeholder input, existing definitions. Out: glossary entries, approved definitions, synonym mappings.' },
            { name: 'Map Data Lineage', description: 'Document how data flows from source systems through transformations to consumption', responsibleRole: 'Data Architect', inputsOutputs: 'In: system architecture, ETL documentation, data flow diagrams. Out: lineage maps, transformation documentation, impact analysis capability.' },
            { name: 'Review Catalog Completeness', description: 'Audit the catalog for missing assets, stale entries, and undocumented sources', responsibleRole: 'Data Governance Lead', inputsOutputs: 'In: data catalog, system inventory, discovery scan results. Out: completeness report, stale entry list, action items for gaps.' },
          ],
        },
        {
          name: 'Data Access & Security',
          description: 'Classify data sensitivity and manage access policies',
          purpose: 'Protect sensitive data while enabling authorized access for business needs',
          activities: [
            { name: 'Classify Data Sensitivity', description: 'Apply classification levels (Public, Internal, Confidential, Restricted) to assets', responsibleRole: 'Data Owner', inputsOutputs: 'In: data asset catalog, regulatory requirements, risk assessment. Out: classification assignments, handling requirements, labeling standards.' },
            { name: 'Define Access Policies', description: 'Establish who can access what data under which conditions', responsibleRole: 'Data Custodian', inputsOutputs: 'In: classification levels, role definitions, regulatory requirements. Out: access control policies, role-based access matrix, approval workflows.' },
            { name: 'Review Access Requests', description: 'Process and approve/deny requests for data access', responsibleRole: 'Data Owner', inputsOutputs: 'In: access requests, requester justification, current access policies. Out: approval/denial decisions, access grants, audit trail entries.' },
            { name: 'Audit Access Compliance', description: 'Verify that actual access patterns match approved policies', responsibleRole: 'Data Custodian', inputsOutputs: 'In: access logs, approved policies, access grants. Out: compliance report, violation alerts, remediation actions.' },
          ],
        },
        {
          name: 'Issue & Change Management',
          description: 'Track, prioritize, and resolve data governance issues',
          purpose: 'Provide a structured process for handling data problems and governance changes',
          activities: [
            { name: 'Log Data Issues', description: 'Capture reported data problems with context, impact, and urgency', responsibleRole: 'Business Data Steward', inputsOutputs: 'In: issue reports, user complaints, quality alerts. Out: issue records, initial triage, acknowledgment to reporter.' },
            { name: 'Prioritize Issues', description: 'Triage issues by business impact, regulatory risk, and effort', responsibleRole: 'Data Governance Lead', inputsOutputs: 'In: issue records, impact assessments, resource availability. Out: prioritized issue backlog, severity assignments, SLA targets.' },
            { name: 'Assign and Resolve Issues', description: 'Route issues to responsible parties and track resolution', responsibleRole: 'Business Data Steward', inputsOutputs: 'In: prioritized issues, team assignments, resolution procedures. Out: resolution records, root cause documentation, closure notifications.' },
            { name: 'Implement Changes', description: 'Execute approved changes to data, systems, or processes', responsibleRole: 'Technical Data Steward', inputsOutputs: 'In: approved change requests, implementation plans, test criteria. Out: implemented changes, test results, updated documentation.' },
            { name: 'Communicate Resolutions', description: 'Notify stakeholders of resolved issues and preventive measures', responsibleRole: 'Data Governance Lead', inputsOutputs: 'In: resolution records, stakeholder list, preventive measures. Out: resolution notifications, lessons learned, updated knowledge base.' },
          ],
        },
      ],
    },
  ];

/**
 * Build the wizard-facing preview of the governance hierarchy. Returns the
 * same `{ valueStreams: [...] }` shape the operational (AI) template endpoint
 * produces, so the Process Wizard's Review screen renders governance
 * identically — value stream → processes → activities.
 */
function buildGovernancePreview() {
  return {
    valueStreams: GOVERNANCE_TEMPLATE.map((vs) => ({
      name: vs.name,
      description: vs.description,
      purpose: vs.purpose,
      businessOutcome: vs.businessOutcome,
      processes: vs.processes.map((p) => ({
        name: p.name,
        description: p.description,
        purpose: p.purpose,
        activities: p.activities.map((a) => ({
          name: a.name,
          description: a.description,
          responsibleRole: (a as { responsibleRole?: string }).responsibleRole,
          inputsOutputs: (a as { inputsOutputs?: string }).inputsOutputs,
        })),
      })),
    })),
  };
}

// Resolve the enterprise (company-root) org for governance by walking up
// from the requested org. Governance is an enterprise function, so it
// always lands at the company level, never per-division. Also reports
// whether a governance program is already planted there.
function resolveGovernanceCompanyOrg(requestOrgId?: string): { templateOrgId: string; companyName: string; exists: boolean } {
  let companyOrgId = requestOrgId || DEV_ORG_ID;
  const knownOrgs = getCachedOrgList();
  let current = knownOrgs.find((o) => o.id === companyOrgId);
  while (current?.parentId) {
    current = knownOrgs.find((o) => o.id === current!.parentId);
    if (current) companyOrgId = current.id;
  }
  const exists = nodeSource().some((n) =>
    n.level === 'VALUE_STREAM' && n.orgId === companyOrgId && isGovernanceNode(n),
  );
  const companyName = knownOrgs.find((o) => o.id === companyOrgId)?.name || companyOrgId;
  return { templateOrgId: companyOrgId, companyName, exists };
}

/**
 * GET /governance-template — preview the standard governance hierarchy
 * without creating anything. Feeds the Process Wizard's Review screen so the
 * governance flow looks and behaves like the operational one: review the
 * value stream → processes → activities, then Apply. `exists` tells the
 * wizard whether a governance program is already planted at the company.
 */
router.get('/governance-template', (req: Request, res: Response) => {
  const requestOrgId = typeof req.query.orgId === 'string' ? req.query.orgId : undefined;
  const { templateOrgId, companyName, exists } = resolveGovernanceCompanyOrg(requestOrgId);
  res.json({ success: true, data: buildGovernancePreview(), templateOrgId, companyName, exists });
});

/**
 * POST /apply-governance-template — create a standard data governance
 * process hierarchy. Unlike business processes (which are industry-specific
 * and AI-generated), governance processes are universal and use a static
 * template. Idempotent — skips if governance value streams already exist.
 */
router.post('/apply-governance-template', async (req: Request, res: Response) => {
  const { orgId: requestOrgId } = req.body;

  // Always create governance processes at the company level.
  const { templateOrgId, companyName, exists } = resolveGovernanceCompanyOrg(requestOrgId);
  if (exists) {
    res.json({ success: true, data: [], message: `Governance processes already exist at ${companyName}. Delete them to regenerate.` });
    return;
  }

  const template = GOVERNANCE_TEMPLATE;

  const created: ProcessNode[] = [];
  const now = new Date().toISOString();

  for (const tvs of template) {
    const vsNode: ProcessNode = {
      id: uuid(), parentId: null, level: 'VALUE_STREAM',
      name: tvs.name, description: tvs.description,
      activityId: generateNodeId('VALUE_STREAM'), status: 'DRAFT',
      orderIndex: nodeSource().filter((n) => n.level === 'VALUE_STREAM').length,
      orgId: templateOrgId, orgIds: [templateOrgId], ownerId: null,
      version: 1, domain: 'GOVERNANCE',
      purpose: combinePurpose(tvs.purpose, tvs.businessOutcome),
      createdAt: now, updatedAt: now,
    };
    await processNodesRepo.create(vsNode);
    created.push(vsNode);

    for (let pIdx = 0; pIdx < tvs.processes.length; pIdx++) {
      const proc = tvs.processes[pIdx];
      const procNode: ProcessNode = {
        id: uuid(), parentId: vsNode.id, level: 'PROCESS',
        name: proc.name, description: proc.description,
        activityId: generateNodeId('PROCESS'), status: 'DRAFT', orderIndex: pIdx,
        orgId: templateOrgId, orgIds: [templateOrgId], ownerId: null,
        version: 1, domain: 'GOVERNANCE', purpose: proc.purpose,
        createdAt: now, updatedAt: now,
      };
      await processNodesRepo.create(procNode);
      created.push(procNode);

      const prevActivities: ProcessNode[] = [];
      for (let aIdx = 0; aIdx < proc.activities.length; aIdx++) {
        const act = proc.activities[aIdx];
        const actNode: ProcessNode = {
          id: uuid(), parentId: procNode.id, level: 'ACTIVITY',
          name: act.name, description: act.description,
          activityId: generateNodeId('ACTIVITY'), status: 'DRAFT', orderIndex: aIdx,
          orgId: templateOrgId, orgIds: [templateOrgId], ownerId: null,
          version: 1, domain: 'GOVERNANCE',
          ...((act as any).responsibleRole ? { responsibleRole: (act as any).responsibleRole } : {}),
          ...((act as any).inputsOutputs ? { inputsOutputs: (act as any).inputsOutputs } : {}),
          createdAt: now, updatedAt: now,
        };
        await processNodesRepo.create(actNode);
        created.push(actNode);

        if (prevActivities.length > 0) {
          const prev = prevActivities[prevActivities.length - 1];
          await flowRelationshipsRepo.create({
            id: uuid(), fromNodeId: prev.id, toNodeId: actNode.id,
            type: 'SEQUENCE', label: null, createdAt: now,
          });
        }
        prevActivities.push(actNode);
      }
    }
  }
  if (hasDatabase()) await refreshProcessNodesCache();

  // ── Seed governance documents (Charter, Policies, Standards, ACL) ──
  // The old governance template created 15 "Data Assets" as
  // standard inputs/outputs for the governance processes. In
  // practice almost none of those rows were real data assets —
  // most were governance documents (Charter, Standards, Access
  // Control Policies) that don't have columns / health / tier /
  // source bindings, or were duplicates of entities that already
  // have a dedicated home in Procela (Glossary, Domains, Lineage,
  // DQ Rules, Issues, Tasks).
  //
  // Now we only seed the four document-shaped rows, and we plant
  // them in governancePolicies with the right documentType so they
  // get the lifecycle + review-cadence + ownership treatment they
  // actually need. The other 11 rows are not created — the
  // corresponding entities already exist (or get created via
  // their own templates), and process-activity outputs that aren't
  // stored entities (reports, communications) are dropped.
  //
  // The startup migration in src/migrations/2026-05-governance-docs.ts
  // also cleans up the old assets for orgs that ran the previous
  // template.
  try {
    const policiesRepo = getGovernancePoliciesRepo();
    // Single source-of-truth read; raw governancePolicies array is empty
    // in Postgres mode. Derive org scoping, dedupe-by-name, and per-type
    // sequence counters from this one snapshot.
    const allPolicies = await policiesRepo.list();

    const docDefs: Array<{ name: string; description: string; documentType: 'CHARTER' | 'FRAMEWORK' | 'STANDARD' | 'POLICY'; category: string }> = [
      { name: 'Data Governance Charter', description: 'Mission, vision, principles, decision rights, and scope of the governance program', documentType: 'CHARTER', category: 'GOVERNANCE' },
      { name: 'Data Policies',           description: 'Enterprise policies for data quality, security, privacy, retention, and sharing',     documentType: 'POLICY',   category: 'GENERAL' },
      { name: 'Data Standards',          description: 'Naming conventions, data type standards, formatting rules, and reference data',       documentType: 'STANDARD', category: 'GOVERNANCE' },
      { name: 'Access Control Policies', description: 'Role-based access matrix, approval workflows, and access request procedures',         documentType: 'POLICY',   category: 'ACCESS' },
    ];
    const orgPolicies = allPolicies.filter((p: any) => p.orgId === templateOrgId);
    const existingByName = new Map<string, any>(orgPolicies.map((p: any) => [p.name.toLowerCase(), p]));
    const codePrefix: Record<string, string> = { CHARTER: 'CHA', FRAMEWORK: 'FRW', STANDARD: 'STD', POLICY: 'POL' };
    // Per-type sequence counters seeded from the snapshot, then bumped
    // locally as we create so two defs of the same documentType (e.g. the
    // two POLICY rows) still get distinct codes without re-reading.
    const seqByType: Record<string, number> = {};
    for (const p of allPolicies) seqByType[(p as any).documentType] = (seqByType[(p as any).documentType] ?? 0) + 1;
    let createdDocs = 0;
    for (const def of docDefs) {
      if (existingByName.has(def.name.toLowerCase())) continue;
      const seq = (seqByType[def.documentType] ?? 0) + 1;
      seqByType[def.documentType] = seq;
      await policiesRepo.create({
        id: uuid(),
        orgId: templateOrgId,
        code: `${codePrefix[def.documentType]}-${String(seq).padStart(3, '0')}`,
        name: def.name,
        description: def.description,
        documentType: def.documentType,
        status: 'DRAFT',
        ownerAssignmentId: null,
        category: def.category,
        reviewFrequency: 'ANNUAL',
        nextReviewDate: null,
        effectiveDate: null,
        content: '',
        createdAt: now,
        updatedAt: now,
      } as any);
      createdDocs++;
    }
    logger.info({ docs: createdDocs }, 'Seeded governance documents (Charter / Policies / Standards / ACL) under templateOrgId');
  } catch (err) {
    logger.error({ err }, 'Failed to seed governance documents (non-fatal)');
  }
  logger.info({ created: created.length, orgId: templateOrgId }, 'Applied governance process template');
  res.status(201).json({ success: true, data: created, message: `Created ${created.length} governance process nodes at ${companyName} (company level)` });
});

export default router;
