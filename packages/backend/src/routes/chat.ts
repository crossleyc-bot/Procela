import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { aiService } from '../services/ai.service';
import { ChatMessage } from '../types';
import logger from '../lib/logger';
import { loadStore, registerStore } from '../lib/persistence';
import { getChatThreadsRepository } from '../db/chat-threads.repo';
import { scopeListForRequest, assertOrgAccess } from '../lib/tenant-scope';
import type { AuthenticatedRequest } from '../middleware/auth';
import { processNodes } from './process-catalog';
import { dataAssets } from './data-assets';
import { systems } from './systems';
import { mappings } from './mappings';
import { people } from './people';
import { dataDomains } from './data-domains';
import { glossaryTerms } from './business-glossary';
import { governancePolicies } from './governance-policies';
import { governanceIssues } from './governance-issues';
import { governanceTasks } from './governance-tasks';
import { dataQualityRules } from './data-quality';
import { connections, connectionSystemLinks } from './connections';
import { filterByOrgScope, getCachedOrgList } from '../lib/org-scope';
import { countMeasuredRulesByAsset, effectiveHealthScore } from '../lib/asset-health';
import { getProcessNodesRepository } from '../db/process-nodes.repo';
import { getDataAssetsRepository } from '../db/data-assets.repo';
import { getSystemsRepository } from '../db/systems.repo';
import { getMappingsRepository } from '../db/mappings.repo';
import { getPeopleRepository } from '../db/people.repo';
import { getDataDomainsRepository } from '../db/data-domains.repo';
import { getGlossaryTermsRepository } from '../db/glossary-terms.repo';
import { getGovernancePoliciesRepository } from '../db/governance-policies.repo';
import { getGovernanceIssuesRepository } from '../db/governance-issues.repo';
import { getGovernanceTasksRepository } from '../db/governance-tasks.repo';
import { getDataQualityRulesRepository } from '../db/data-quality-rules.repo';
import { getConnectionsRepository } from '../db/connections.repo';
import { getConnectionSystemLinksRepository } from '../db/connection-system-links.repo';

// Repositories — read Postgres when DATABASE_URL is set, else the JSON arrays.
// The AI snapshot is read-only; each request loads a fresh catalog picture.
const processNodesRepo = getProcessNodesRepository(processNodes);
const dataAssetsRepo = getDataAssetsRepository(dataAssets);
const systemsRepo = getSystemsRepository(systems);
const mappingsRepo = getMappingsRepository(mappings);
const peopleRepo = getPeopleRepository(people);
const dataDomainsRepo = getDataDomainsRepository(dataDomains);
const glossaryTermsRepo = getGlossaryTermsRepository(glossaryTerms);
const governancePoliciesRepo = getGovernancePoliciesRepository(governancePolicies);
const governanceIssuesRepo = getGovernanceIssuesRepository(governanceIssues);
const governanceTasksRepo = getGovernanceTasksRepository(governanceTasks);
const dataQualityRulesRepo = getDataQualityRulesRepository(dataQualityRules);
const connectionsRepo = getConnectionsRepository(connections);
const connectionSystemLinksRepo = getConnectionSystemLinksRepository(connectionSystemLinks);

// ── Persisted chat threads ──
// A saved conversation the assistant panel can re-open and replay. Owned
// by one user (ownerId) within one org — chat history is private to the
// person who had the conversation, never shared org-wide.
export interface ChatThread {
  id: string;
  orgId: string;
  ownerId: string | null;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export const chatThreads: ChatThread[] = loadStore<ChatThread>('chat-threads');
registerStore('chat-threads', chatThreads);
const chatThreadsRepo = getChatThreadsRepository(chatThreads);

/** The signed-in user's id, or null when the request is unauthenticated
 *  (e.g. a bare test harness that mounts the router without auth). */
function ownerOf(req: Request): string | null {
  return (req as { user?: { sub?: string } }).user?.sub || null;
}

/** A thread is the caller's own when they created it. A null ownerId (a
 *  thread created before ownership was recorded, or by an unauthenticated
 *  harness) is treated as accessible so history isn't orphaned. */
function ownsThread(thread: ChatThread, ownerId: string | null): boolean {
  return thread.ownerId == null || thread.ownerId === ownerId;
}

/** List-view projection — the transcript itself is dropped so the
 *  history list stays small. Only enough to label and sort each row. */
function threadSummary(t: ChatThread) {
  return {
    id: t.id,
    orgId: t.orgId,
    title: t.title,
    messageCount: t.messages.length,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

const router = Router();

// ── Org-data snapshot ──
// Builds a compact plain-text summary of one organization's Procela
// catalog so the AI assistant can answer grounded questions ("where
// are our gaps?", "what data supports X?") instead of guessing. Kept
// bounded — long catalogs are truncated so the system prompt stays a
// reasonable size.

const MAX_TREE_LINES = 150;
const MAX_ASSET_LINES = 100;
const MAX_MAPPING_LINES = 120;

export async function buildOrgSnapshot(orgId: string): Promise<string | undefined> {
  if (!orgId) return undefined;

  // Load every store (Postgres or JSON) once, then filter in memory.
  const [
    allNodes, allAssets, allSystems, allMappings, allPeople, allDomains,
    allTerms, allPolicies, allIssues, allTasks, allDqRules, allConns,
    allSysLinks,
  ] = await Promise.all([
    processNodesRepo.list(), dataAssetsRepo.list(), systemsRepo.list(),
    mappingsRepo.list(), peopleRepo.list(), dataDomainsRepo.list(),
    glossaryTermsRepo.list(), governancePoliciesRepo.list(), governanceIssuesRepo.list(),
    governanceTasksRepo.list(), dataQualityRulesRepo.list(), connectionsRepo.list(),
    connectionSystemLinksRepo.list(),
  ]);

  const org = getCachedOrgList().find((o) => o.id === orgId);
  // Use the same visibility rules the rest of the app enforces:
  // walk up to ancestors (a division sees company-level policies,
  // systems, assets) AND down to descendants (a company user sees
  // every division's data). Previously this used raw `orgId === X`
  // filters, so the AI saw a strictly smaller world than the user
  // — a Water-division user asking "what data supports outages?"
  // would be told there's no ArcGIS system, even though the row
  // was right there on the Systems page (inherited from the
  // Utilities parent). filterByOrgScope is the shared helper every
  // scoped route uses; keeping the chat snapshot on that same
  // filter is the only way the two stay in sync.
  const nodes = filterByOrgScope(allNodes, orgId);
  const assets = filterByOrgScope(allAssets, orgId);
  const sys = filterByOrgScope(allSystems, orgId);
  const maps = filterByOrgScope(allMappings, orgId);
  const ppl = filterByOrgScope(allPeople, orgId);
  const domains = filterByOrgScope(allDomains, orgId);
  const terms = filterByOrgScope(allTerms, orgId);
  const policies = filterByOrgScope(allPolicies, orgId);
  const issues = filterByOrgScope(allIssues, orgId);
  const tasks = filterByOrgScope(allTasks, orgId);
  const dqRules = filterByOrgScope(allDqRules, orgId);
  const conns = filterByOrgScope(allConns, orgId);

  if (nodes.length === 0 && assets.length === 0 && sys.length === 0) return undefined;

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const personById = new Map(ppl.map((p) => [p.id, p]));
  const systemById = new Map(sys.map((s) => [s.id, s]));
  // Effective health for the AI context: measured DQ score, or 0 when no
  // measured rule backs the asset. The assistant should never present a
  // connector-freshness or manual stand-in as an asset's quality.
  const measuredHealthByAsset = countMeasuredRulesByAsset(dqRules);
  const effHealth = (a: { id: string; healthScore?: number }) =>
    effectiveHealthScore(a.healthScore, measuredHealthByAsset.get(a.id) || 0);
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const ownerName = (id: string | null | undefined) =>
    id ? (personById.get(id)?.name ?? 'unknown') : null;

  const lines: string[] = [];

  // Process catalog as an indented outline.
  const childrenOf = (pid: string | null) =>
    nodes.filter((n) => n.parentId === pid).sort((a, b) => a.orderIndex - b.orderIndex);
  lines.push('## PROCESS CATALOG');
  let treeLines = 0;
  const walk = (pid: string | null, depth: number) => {
    for (const n of childrenOf(pid)) {
      if (treeLines >= MAX_TREE_LINES) return;
      const indent = '  '.repeat(depth);
      const owner = ownerName(n.ownerId);
      const bits = [
        `${n.level.replace('_', ' ').toLowerCase()}`,
        n.domain === 'GOVERNANCE' ? '[governance]' : null,
        n.status ? `status:${n.status.toLowerCase()}` : null,
        owner ? `owner:${owner}` : 'OWNERLESS',
        n.responsibleRole ? `role:${n.responsibleRole}` : null,
      ].filter(Boolean);
      lines.push(`${indent}- ${n.name} (${bits.join(', ')})`);
      treeLines++;
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  if (treeLines >= MAX_TREE_LINES) lines.push('  …(catalog truncated)');
  if (treeLines === 0) lines.push('  (no processes defined)');

  // Systems.
  lines.push('', '## SYSTEMS');
  if (sys.length === 0) lines.push('  (none defined)');
  for (const s of sys) lines.push(`  - ${s.name}${s.systemType ? ` (${s.systemType})` : ''}`);

  // Data connections (source connection profiles — DB, file, API,
  // warehouse, spreadsheet). Each connection can be tied to zero
  // or more systems via the connectionSystemLinks join table.
  // Users routinely ask the assistant "what systems is <connection>
  // tied to?" — that only works if the snapshot names both the
  // connection AND the systems it feeds. Skipped when empty so
  // orgs that haven't defined any connections don't pay tokens.
  const MAX_CONNECTIONS = 40;
  if (conns.length > 0) {
    lines.push('', '## DATA CONNECTIONS');
    conns.slice(0, MAX_CONNECTIONS).forEach((c) => {
      const linkedSysIds = allSysLinks
        .filter((l) => l.connectionId === c.id)
        .map((l) => l.systemId);
      const linkedNames = linkedSysIds
        .map((sid) => systemById.get(sid)?.name)
        .filter(Boolean);
      const bits = [
        c.connectionType.replace('_', ' ').toLowerCase(),
        `status:${c.status.toLowerCase()}`,
      ];
      const linkPart = linkedNames.length > 0
        ? `, systems:${linkedNames.join(', ')}`
        : ', systems:(none linked)';
      lines.push(`  - ${c.name} (${bits.join(', ')}${linkPart})`);
    });
    if (conns.length > MAX_CONNECTIONS) lines.push(`  …(${conns.length - MAX_CONNECTIONS} more)`);
  }

  // Data assets with tier + health.
  lines.push('', '## DATA ASSETS');
  if (assets.length === 0) lines.push('  (none defined)');
  assets.slice(0, MAX_ASSET_LINES).forEach((a) => {
    const sysName = a.systemId ? systemById.get(a.systemId)?.name : null;
    lines.push(
      `  - ${a.name} (tier:${a.governanceTier?.toLowerCase() ?? 'bronze'}, `
        + `health:${effHealth(a)}%${sysName ? `, system:${sysName}` : ''})`,
    );
  });
  if (assets.length > MAX_ASSET_LINES) lines.push(`  …(${assets.length - MAX_ASSET_LINES} more)`);

  // Activity ↔ system declarations (Phase 3). These are independent
  // of data-asset mappings — an activity can declare "this step runs
  // on SAP" without yet having data assets mapped, and the user often
  // asks the assistant "which systems does X use". Keep it tight: one
  // line per activity that declares any system, truncated like the
  // tree above.
  const activitySystemLines: string[] = [];
  let sysLines = 0;
  for (const n of nodes) {
    if (n.level !== 'ACTIVITY' || !n.systemIds || n.systemIds.length === 0) continue;
    if (sysLines >= MAX_MAPPING_LINES) break;
    const sysNames = n.systemIds
      .map((sid) => systemById.get(sid)?.name)
      .filter(Boolean)
      .join(', ');
    if (!sysNames) continue;
    activitySystemLines.push(`  - "${n.name}" runs on: ${sysNames}`);
    sysLines++;
  }

  // Process ↔ data mappings.
  // Mapping rows can target a Data Asset, a Policy, or an
  // Attachment; the chat-context summary only describes the
  // asset-shaped ones because they're the most useful for "what
  // data does this activity use" questions. Policy and attachment
  // mappings are skipped here.
  const assetMaps = maps.filter((m) => !!m.dataAssetId);
  lines.push('', '## PROCESS COVERAGE (activity → data asset links)');
  if (assetMaps.length === 0) lines.push('  (no data mapped to any activity yet)');
  assetMaps.slice(0, MAX_MAPPING_LINES).forEach((m) => {
    const act = nodeById.get(m.processStepId)?.name ?? 'unknown activity';
    const asset = assetById.get(m.dataAssetId!)?.name ?? 'unknown asset';
    lines.push(`  - "${act}" ${m.linkType ?? 'uses'} "${asset}"`);
  });
  if (assetMaps.length > MAX_MAPPING_LINES) lines.push(`  …(${assetMaps.length - MAX_MAPPING_LINES} more)`);

  // Activity ↔ system declarations. Emit only if there are any so
  // the snapshot stays compact for orgs not yet using systemIds.
  if (activitySystemLines.length > 0) {
    lines.push('', '## ACTIVITY → SYSTEM (declared)');
    lines.push(...activitySystemLines);
    if (sysLines >= MAX_MAPPING_LINES) lines.push('  …(more)');
  }

  // Gaps — the things the user most often asks about.
  const mappedActivityIds = new Set(maps.map((m) => m.processStepId));
  const activities = nodes.filter((n) => n.level === 'ACTIVITY');
  const unmappedActivities = activities.filter((n) => !mappedActivityIds.has(n.id));
  const ownerlessProcesses = nodes.filter(
    (n) => ['VALUE_STREAM', 'PROCESS'].includes(n.level) && !n.ownerId,
  );
  const linkedAssetIds = new Set(assetMaps.map((m) => m.dataAssetId!));
  const ungovernedAssets = assets.filter(
    (a) => a.governanceTier === 'BRONZE' && linkedAssetIds.has(a.id),
  );
  // Only assets with a measured rule can be "below 80% health" — an
  // unmeasured asset (0 effective health) is a coverage gap, not a
  // low-quality signal, and is surfaced by the orphan/mapping gaps instead.
  const lowHealthAssets = assets.filter(
    (a) => (measuredHealthByAsset.get(a.id) || 0) > 0 && effHealth(a) < 80,
  );
  const ownerlessDomains = domains.filter((d) => !d.ownerId);
  // Phase 3 reverse-view signal: assets that exist in the catalog
  // but aren't referenced by any mapping. These are candidates to
  // retire or to map to a step that uses them.
  const orphanAssets = assets.filter((a) => !linkedAssetIds.has(a.id));
  lines.push('', '## KNOWN GAPS');
  lines.push(`  - Activities with no data mapped (${unmappedActivities.length}): `
    + (unmappedActivities.slice(0, 25).map((n) => n.name).join('; ') || 'none'));
  lines.push(`  - Value streams / processes with no owner (${ownerlessProcesses.length}): `
    + (ownerlessProcesses.slice(0, 25).map((n) => n.name).join('; ') || 'none'));
  lines.push(`  - Mapped data assets still at Bronze/uncertified tier (${ungovernedAssets.length}): `
    + (ungovernedAssets.slice(0, 25).map((a) => a.name).join('; ') || 'none'));
  lines.push(`  - Data assets below 80% health (${lowHealthAssets.length}): `
    + (lowHealthAssets.slice(0, 25).map((a) => `${a.name} ${effHealth(a)}%`).join('; ') || 'none'));
  lines.push(`  - Data domains with no owner (${ownerlessDomains.length}): `
    + (ownerlessDomains.slice(0, 25).map((d) => d.name).join('; ') || 'none'));
  lines.push(`  - Orphan data assets — exist in the catalog but no process step uses them (${orphanAssets.length}): `
    + (orphanAssets.slice(0, 25).map((a) => a.name).join('; ') || 'none'));

  lines.push('', `## PEOPLE\n  ${ppl.length} people in this organization.`);

  // Business glossary — the "what does X mean" surface. Include
  // approved terms first so the AI cites the canonical definition
  // rather than a stale draft. Drafts/proposed terms show a
  // status marker so answers can be qualified when needed. Bounded
  // like the other list sections to keep the prompt compact.
  const MAX_GLOSSARY = 60;
  if (terms.length > 0) {
    lines.push('', '## BUSINESS GLOSSARY (approved terms first)');
    const sortedTerms = [...terms].sort((a, b) => {
      const rank = (s: string) => (s === 'APPROVED' ? 0 : s === 'PROPOSED' ? 1 : s === 'DRAFT' ? 2 : 3);
      return rank(a.status) - rank(b.status);
    });
    sortedTerms.slice(0, MAX_GLOSSARY).forEach((t) => {
      const statusBit = t.status === 'APPROVED' ? '' : ` [${t.status.toLowerCase()}]`;
      const def = (t.definition || '').replace(/\s+/g, ' ').trim();
      lines.push(`  - ${t.term}${statusBit}: ${def}`);
    });
    if (terms.length > MAX_GLOSSARY) lines.push(`  …(${terms.length - MAX_GLOSSARY} more)`);
  }

  // Governance policies / charters / frameworks / standards. One
  // line each — the assistant needs the code + name + category so
  // it can answer "what's our data classification policy" without
  // fabricating a fake policy name.
  const MAX_POLICIES = 40;
  if (policies.length > 0) {
    lines.push('', '## GOVERNANCE DOCUMENTS');
    policies.slice(0, MAX_POLICIES).forEach((p) => {
      const bits = [
        p.documentType.toLowerCase(),
        `status:${p.status.toLowerCase()}`,
        `category:${p.category.toLowerCase()}`,
      ];
      lines.push(`  - [${p.code}] ${p.name} (${bits.join(', ')})`);
    });
    if (policies.length > MAX_POLICIES) lines.push(`  …(${policies.length - MAX_POLICIES} more)`);
  }

  // Governance issues — open first, then in-progress. Closed
  // issues are dropped: they're rarely relevant to the "what's
  // broken right now?" questions users ask the assistant, and
  // they burn tokens.
  const openIssues = issues.filter((i) => i.status !== 'CLOSED' && i.status !== 'RESOLVED');
  const MAX_ISSUES = 40;
  if (openIssues.length > 0) {
    lines.push('', '## OPEN GOVERNANCE ISSUES');
    openIssues.slice(0, MAX_ISSUES).forEach((i) => {
      const assetName = i.dataAssetId ? assetById.get(i.dataAssetId)?.name : null;
      const sysName = i.systemId ? systemById.get(i.systemId)?.name : null;
      const target = assetName ? `asset:${assetName}` : sysName ? `system:${sysName}` : null;
      const bits = [
        `severity:${i.severity.toLowerCase()}`,
        `status:${i.status.toLowerCase()}`,
        target,
      ].filter(Boolean);
      lines.push(`  - ${i.title} (${bits.join(', ')})`);
    });
    if (openIssues.length > MAX_ISSUES) lines.push(`  …(${openIssues.length - MAX_ISSUES} more open)`);
  }

  // Governance tasks — open work only, same rationale as issues.
  const openTasks = tasks.filter((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED' && t.status !== 'REJECTED');
  const MAX_TASKS = 40;
  if (openTasks.length > 0) {
    lines.push('', '## OPEN GOVERNANCE TASKS');
    openTasks.slice(0, MAX_TASKS).forEach((t) => {
      const assignee = ownerName(t.assigneeId);
      const bits = [
        `priority:${t.priority.toLowerCase()}`,
        `status:${t.status.toLowerCase()}`,
        assignee ? `assignee:${assignee}` : 'unassigned',
        t.dueDate ? `due:${t.dueDate}` : null,
      ].filter(Boolean);
      lines.push(`  - ${t.title} (${bits.join(', ')})`);
    });
    if (openTasks.length > MAX_TASKS) lines.push(`  …(${openTasks.length - MAX_TASKS} more open)`);
  }

  // Data quality rules — currently failing ones first so the
  // assistant can answer "what DQ problems do we have right now?".
  // Passing rules count is summarised but not listed line-by-line.
  if (dqRules.length > 0) {
    const failing = dqRules.filter((r) => r.status === 'FAILING' || r.status === 'WARNING');
    const passing = dqRules.filter((r) => r.status === 'PASSING').length;
    const notMeasured = dqRules.filter((r) => r.status === 'NOT_MEASURED').length;
    lines.push('', '## DATA QUALITY');
    lines.push(`  Summary: ${passing} passing, ${failing.length} failing/warning, ${notMeasured} not measured.`);
    const MAX_DQ = 30;
    failing.slice(0, MAX_DQ).forEach((r) => {
      const assetName = assetById.get(r.dataAssetId)?.name ?? 'unknown asset';
      const col = r.columnName ? `.${r.columnName}` : '';
      lines.push(`  - ${assetName}${col} · ${r.name} (${r.dimension.toLowerCase()}, ${r.status.toLowerCase()}, score:${r.currentScore}/${r.threshold})`);
    });
    if (failing.length > MAX_DQ) lines.push(`  …(${failing.length - MAX_DQ} more failing/warning)`);
  }

  const header = `Snapshot of "${org?.name ?? 'this organization'}"`
    + ` (industry: ${org?.industry || 'unspecified'}).`;
  return `${header}\n\n${lines.join('\n')}`;
}

/** Entity index for the assistant's inline citations. Given an orgId,
 *  returns a list of `{ name, kind, url }` rows the frontend can use
 *  to substitute Claude's mentions of entity names with clickable
 *  links. Names that are too short (≤ 2 chars) or that would collide
 *  with common English words are skipped — better to miss a match
 *  than to over-link "Use" into a system called Use.
 *
 *  Sorted longest-name first so the regex builder on the client side
 *  matches "Customer Billing Master" before "Customer", which would
 *  otherwise eat the prefix and leave " Billing Master" unmatched. */
export interface EntityIndexEntry {
  name: string;
  kind: 'activity' | 'process' | 'system' | 'asset' | 'person';
  url: string;
}
export async function buildEntityIndex(orgId: string): Promise<EntityIndexEntry[]> {
  if (!orgId) return [];
  const [allNodes, allSystems, allAssets, allPeople] = await Promise.all([
    processNodesRepo.list(), systemsRepo.list(), dataAssetsRepo.list(), peopleRepo.list(),
  ]);
  const rows: EntityIndexEntry[] = [];
  for (const n of allNodes) {
    if (n.orgId !== orgId && !n.orgIds?.includes(orgId)) continue;
    if (n.level === 'ACTIVITY') {
      rows.push({ name: n.name, kind: 'activity', url: `/processes?node=${n.id}` });
    } else if (n.level === 'PROCESS' || n.level === 'VALUE_STREAM') {
      rows.push({ name: n.name, kind: 'process', url: `/processes?node=${n.id}` });
    }
  }
  for (const s of allSystems) {
    if (s.orgId !== orgId) continue;
    rows.push({ name: s.name, kind: 'system', url: `/systems?id=${s.id}` });
  }
  for (const a of allAssets) {
    if (a.orgId !== orgId) continue;
    rows.push({ name: a.name, kind: 'asset', url: `/data-assets?id=${a.id}` });
  }
  for (const p of allPeople) {
    if (!p.orgIds?.includes(orgId)) continue;
    rows.push({ name: p.name, kind: 'person', url: `/people?id=${p.id}` });
  }
  // Drop short names (would over-match common substrings) and
  // deduplicate by lowercased name — duplicate names across kinds
  // would create ambiguous citations and the client picks the
  // longest match anyway.
  const seen = new Set<string>();
  return rows
    .filter((r) => r.name && r.name.length > 2)
    .filter((r) => {
      const key = r.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.name.length - a.name.length);
}

/**
 * POST /api/v1/chat
 * Multi-turn conversational chat grounded in the organization's data.
 *
 * Body: { messages: [{role, content}...], orgContext?: { orgId, orgName, industry } }
 * Returns: { success: true, data: { reply: string } }
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { messages, orgContext } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        success: false,
        error: 'messages is required and must be a non-empty array of {role, content} objects.',
      });
      return;
    }

    for (const msg of messages) {
      if (!msg.role || !msg.content || !['user', 'assistant'].includes(msg.role)) {
        res.status(400).json({
          success: false,
          error: 'Each message must have a valid role ("user" or "assistant") and content.',
        });
        return;
      }
    }

    const chatMessages: ChatMessage[] = messages.map((m: ChatMessage) => ({
      role: m.role,
      content: m.content,
    }));

    const orgId: string = orgContext?.orgId ?? '';
    const org = orgId ? getCachedOrgList().find((o) => o.id === orgId) : undefined;
    const context = {
      orgId,
      orgName: org?.name ?? orgContext?.orgName ?? 'Unknown',
      industry: org?.industry || orgContext?.industry || 'General',
    };

    const snapshot = await buildOrgSnapshot(orgId);
    const reply = await aiService.chat(chatMessages, context, snapshot);
    const entities = await buildEntityIndex(orgId);

    res.json({ success: true, data: { reply, entities } });
  } catch (err) {
    logger.error({ err }, 'Chat request failed');
    res.status(500).json({
      success: false,
      error: 'Failed to process chat request. Please try again.',
    });
  }
});

/**
 * POST /api/v1/chat/stream
 * Streaming counterpart of POST /chat. Returns Server-Sent Events
 * (text/event-stream) so the UI can render the reply progressively as
 * it arrives from Anthropic, instead of staring at "Thinking…" for
 * several seconds.
 *
 * Event types on the stream:
 *   event: chunk     data: {"text": "<delta>"}
 *   event: entities  data: [{name, kind, url}, ...]   (one frame, end of stream)
 *   event: done      data: {"ok": true}
 *   event: error     data: {"error": "<message>"}
 *
 * The entities frame fires once at the end so the client has the
 * full reply text in hand before the link-substitution pass runs.
 * Same validation + context-pack semantics as the non-streaming
 * endpoint.
 */
router.post('/stream', async (req: Request, res: Response) => {
  // Validation first — keep this synchronous so a 400 still returns
  // a JSON error rather than an empty SSE stream.
  const { messages, orgContext } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({
      success: false,
      error: 'messages is required and must be a non-empty array of {role, content} objects.',
    });
    return;
  }
  for (const msg of messages) {
    if (!msg.role || !msg.content || !['user', 'assistant'].includes(msg.role)) {
      res.status(400).json({
        success: false,
        error: 'Each message must have a valid role ("user" or "assistant") and content.',
      });
      return;
    }
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Disable proxy buffering — Nginx in particular will hold the
  // response until close without this hint.
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (event: string, payload: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const chatMessages: ChatMessage[] = messages.map((m: ChatMessage) => ({
      role: m.role,
      content: m.content,
    }));
    const orgId: string = orgContext?.orgId ?? '';
    const org = orgId ? getCachedOrgList().find((o) => o.id === orgId) : undefined;
    const context = {
      orgId,
      orgName: org?.name ?? orgContext?.orgName ?? 'Unknown',
      industry: org?.industry || orgContext?.industry || 'General',
    };
    const snapshot = await buildOrgSnapshot(orgId);

    for await (const chunk of aiService.chatStream(chatMessages, context, snapshot)) {
      send('chunk', { text: chunk });
    }
    // Entity index lands once at the end of the stream. The frontend
    // uses it to convert entity-name mentions in the final reply into
    // clickable links pointing back at the catalog.
    send('entities', await buildEntityIndex(orgId));
    send('done', { ok: true });
    res.end();
  } catch (err: any) {
    logger.error({ err: err?.message }, 'Chat stream failed');
    // Best-effort error frame — if headers are already sent the
    // client receives this as a final SSE event; otherwise express
    // falls through to the catch-all error handler.
    try { send('error', { error: err?.message || 'stream failed' }); res.end(); }
    catch { /* response already closed */ }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Chat-thread persistence.
//
// The assistant panel is stateless between visits without this: reload the
// page and the conversation is gone. These endpoints let the panel save a
// conversation, list a user's past conversations, re-open one, and delete
// it. Every thread carries an orgId (multi-tenant scoping) and an ownerId
// (chat history is private to the person, not the org).
// ──────────────────────────────────────────────────────────────────────────

/** Validate a messages payload the same way the chat endpoints do.
 *  Returns an error string, or null when the array is well-formed. */
function validateMessagesPayload(messages: unknown): string | null {
  if (!Array.isArray(messages)) {
    return 'messages must be an array of {role, content} objects.';
  }
  for (const msg of messages as ChatMessage[]) {
    if (!msg || !msg.role || !['user', 'assistant'].includes(msg.role) || typeof msg.content !== 'string') {
      return 'Each message must have a valid role ("user" or "assistant") and string content.';
    }
  }
  return null;
}

/** Derive a short title from the first user message. */
function titleFromMessages(messages: ChatMessage[], fallback = 'New conversation'): string {
  const firstUser = messages.find((m) => m.role === 'user');
  const raw = (firstUser?.content || '').trim().replace(/\s+/g, ' ');
  if (!raw) return fallback;
  return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
}

/** GET /api/v1/chat/threads?orgId=… — the caller's saved conversations in
 *  the org, newest first, without the transcript bodies. */
router.get('/threads', async (req: Request, res: Response) => {
  const ownerId = ownerOf(req);
  const all = await chatThreadsRepo.list();
  const scoped = scopeListForRequest(req as AuthenticatedRequest, all)
    .filter((t) => ownsThread(t, ownerId))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  res.json({ success: true, data: scoped.map(threadSummary) });
});

/** GET /api/v1/chat/threads/:id — one conversation with its full transcript. */
router.get('/threads/:id', async (req: Request, res: Response) => {
  const thread = await chatThreadsRepo.get(String(req.params.id));
  if (!thread) { res.status(404).json({ success: false, error: 'Conversation not found' }); return; }
  if (!assertOrgAccess(req as AuthenticatedRequest, res, thread.orgId, 'Conversation not found')) return;
  if (!ownsThread(thread, ownerOf(req))) { res.status(404).json({ success: false, error: 'Conversation not found' }); return; }
  res.json({ success: true, data: thread });
});

/** POST /api/v1/chat/threads — save a new conversation.
 *  Body: { orgId, messages, title? }. */
router.post('/threads', async (req: Request, res: Response) => {
  const { orgId, messages, title } = req.body || {};
  if (!orgId) { res.status(400).json({ success: false, error: 'orgId is required' }); return; }
  const invalid = validateMessagesPayload(messages);
  if (invalid) { res.status(400).json({ success: false, error: invalid }); return; }
  if (!assertOrgAccess(req as AuthenticatedRequest, res, orgId, 'Organization not found')) return;

  const now = new Date().toISOString();
  const thread: ChatThread = {
    id: uuid(),
    orgId,
    ownerId: ownerOf(req),
    title: (typeof title === 'string' && title.trim()) ? title.trim().slice(0, 120) : titleFromMessages(messages),
    messages,
    createdAt: now,
    updatedAt: now,
  };
  await chatThreadsRepo.create(thread);
  res.status(201).json({ success: true, data: thread });
});

/** PUT /api/v1/chat/threads/:id — append/replace the transcript as the
 *  conversation grows, and optionally rename it. Body: { messages?, title? }. */
router.put('/threads/:id', async (req: Request, res: Response) => {
  const thread = await chatThreadsRepo.get(String(req.params.id));
  if (!thread) { res.status(404).json({ success: false, error: 'Conversation not found' }); return; }
  if (!assertOrgAccess(req as AuthenticatedRequest, res, thread.orgId, 'Conversation not found')) return;
  if (!ownsThread(thread, ownerOf(req))) { res.status(404).json({ success: false, error: 'Conversation not found' }); return; }

  const { messages, title } = req.body || {};
  const patch: Partial<ChatThread> = {};
  if (messages !== undefined) {
    const invalid = validateMessagesPayload(messages);
    if (invalid) { res.status(400).json({ success: false, error: invalid }); return; }
    patch.messages = messages;
    // Keep an auto-derived title fresh until the user renames it, but never
    // clobber a title the user set explicitly in the same request.
    if (title === undefined && (!thread.title || thread.title === 'New conversation')) {
      patch.title = titleFromMessages(messages, thread.title);
    }
  }
  if (typeof title === 'string' && title.trim()) patch.title = title.trim().slice(0, 120);
  patch.updatedAt = new Date().toISOString();

  const updated = await chatThreadsRepo.update(thread.id, patch);
  res.json({ success: true, data: updated });
});

/** DELETE /api/v1/chat/threads/:id */
router.delete('/threads/:id', async (req: Request, res: Response) => {
  const thread = await chatThreadsRepo.get(String(req.params.id));
  if (!thread) { res.status(404).json({ success: false, error: 'Conversation not found' }); return; }
  if (!assertOrgAccess(req as AuthenticatedRequest, res, thread.orgId, 'Conversation not found')) return;
  if (!ownsThread(thread, ownerOf(req))) { res.status(404).json({ success: false, error: 'Conversation not found' }); return; }
  await chatThreadsRepo.delete(thread.id);
  res.status(204).send();
});

export default router;
