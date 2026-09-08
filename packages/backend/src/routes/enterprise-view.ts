import { Router, Request, Response } from 'express';
import { processNodes, isGovernanceNode } from './process-catalog';
import { dataAssets } from './data-assets';
import { systems } from './systems';
import { people } from './people';
import { dataDomains } from './data-domains';
import { dataLineageLinks } from './data-lineage';
import { dataQualityRules } from './data-quality';
import { getVisibleOrgScope } from '../lib/org-scope';
import { scopeListForRequest } from '../lib/tenant-scope';
import { effectiveHealthScore } from '../lib/asset-health';
import { getProcessNodesRepository } from '../db/process-nodes.repo';
import { getDataAssetsRepository } from '../db/data-assets.repo';
import { getSystemsRepository } from '../db/systems.repo';
import { getPeopleRepository } from '../db/people.repo';
import { getDataDomainsRepository } from '../db/data-domains.repo';
import { getDataLineageLinksRepository } from '../db/data-lineage-links.repo';
import { getDataQualityRulesRepository } from '../db/data-quality-rules.repo';
import { getMappingsRepository } from '../db/mappings.repo';

const router = Router();

// Repositories — read Postgres when DATABASE_URL is set, else the JSON arrays.
// This aggregator is read-only; each request loads a fresh snapshot.
const processNodesRepo = getProcessNodesRepository(processNodes);
const dataAssetsRepo = getDataAssetsRepository(dataAssets);
const systemsRepo = getSystemsRepository(systems);
const peopleRepo = getPeopleRepository(people);
const dataDomainsRepo = getDataDomainsRepository(dataDomains);
const dataLineageLinksRepo = getDataLineageLinksRepository(dataLineageLinks);
const dataQualityRulesRepo = getDataQualityRulesRepository(dataQualityRules);
// mappings is required lazily (its module imports back into the catalog graph).
let _mappingsRepo: ReturnType<typeof getMappingsRepository> | null = null;
const mappingsRepo = () => {
  if (!_mappingsRepo) {
    let arr: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    try { arr = require('./mappings').mappings || []; } catch { /* */ }
    _mappingsRepo = getMappingsRepository(arr);
  }
  return _mappingsRepo;
};

interface GraphNode {
  id: string;
  type: 'process' | 'system' | 'data-asset' | 'person' | 'domain';
  label: string;
  status?: string;
  meta: Record<string, any>;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  label: string;
}

router.get('/', async (req: Request, res: Response) => {
  const { orgId } = req.query;

  const [allNodes, allSystems, allAssets, allDomains, allRules, allPeople, allLineage, allMappings] = await Promise.all([
    processNodesRepo.list(),
    systemsRepo.list(),
    dataAssetsRepo.list(),
    dataDomainsRepo.list(),
    dataQualityRulesRepo.list(),
    peopleRepo.list(),
    dataLineageLinksRepo.list(),
    mappingsRepo().list(),
  ]);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();

  const addNode = (n: GraphNode) => {
    if (!nodeIds.has(n.id)) { nodeIds.add(n.id); nodes.push(n); }
  };

  // Process nodes (the four drill levels: VALUE_STREAM, PROCESS, SUBPROCESS,
  // ACTIVITY). The client's depth control collapses/expands this tree and rolls
  // cross-hierarchy edges up to the deepest visible ancestor, so the full tree
  // is sent and the drilling happens client-side.
  const topLevels = new Set(['VALUE_STREAM', 'PROCESS', 'SUBPROCESS', 'ACTIVITY']);
  // Enforce the caller's visible-org set (plus any explicit ?orgId), multi-org
  // node aware — so omitting orgId can't aggregate across tenants.
  const filteredProcesses = scopeListForRequest(req, allNodes);
  for (const p of filteredProcesses) {
    if (!topLevels.has(p.level)) continue;
    addNode({
      id: p.id, type: 'process',
      label: p.name, status: p.status,
      // isGovernance lets the client exclude the governance value streams
      // (Data Governance Management, etc.) by default, with a toggle to show
      // them — same domain classifier the Process ↔ Data Map filters on.
      meta: { level: p.level, description: p.description, ownerId: p.ownerId, isGovernance: isGovernanceNode(p) },
    });
    if (p.parentId && nodeIds.has(p.parentId)) {
      edges.push({ id: `ph-${p.id}`, source: p.parentId, target: p.id, type: 'hierarchy', label: 'contains' });
    }
  }
  // Second pass for parent edges (parent may be added after child)
  for (const p of filteredProcesses) {
    if (!topLevels.has(p.level) || !p.parentId) continue;
    if (nodeIds.has(p.parentId) && !edges.some((e) => e.id === `ph-${p.id}`)) {
      edges.push({ id: `ph-${p.id}`, source: p.parentId, target: p.id, type: 'hierarchy', label: 'contains' });
    }
  }

  // Systems
  const filteredSystems = scopeListForRequest(req, allSystems);
  for (const s of filteredSystems as any[]) {
    addNode({
      id: s.id, type: 'system',
      label: s.name, status: undefined,
      meta: { systemType: s.systemType, description: s.description },
    });
  }

  // Data assets
  const filteredAssets = scopeListForRequest(req, allAssets);
  for (const a of filteredAssets) {
    const assetRules = allRules.filter((r) => r.dataAssetId === a.id);
    // Effective health: measured DQ score, or 0 when no measured rule backs it.
    const measuredRuleCount = assetRules.filter((r) => r.lastRun && r.lastRun.simulated === false).length;
    addNode({
      id: a.id, type: 'data-asset',
      label: a.name, status: undefined,
      meta: {
        governanceTier: a.governanceTier,
        healthScore: effectiveHealthScore(a.healthScore, measuredRuleCount),
        systemId: a.systemId,
        rulesCount: assetRules.length,
        description: a.description,
      },
    });
    // Asset → System edge
    if (a.systemId && nodeIds.has(a.systemId)) {
      edges.push({ id: `as-${a.id}`, source: a.id, target: a.systemId, type: 'hosted-by', label: 'hosted by' });
    }
  }

  // Data domains
  const filteredDomains = scopeListForRequest(req, allDomains);
  for (const d of filteredDomains) {
    addNode({
      id: d.id, type: 'domain',
      label: d.name, status: d.status,
      meta: { description: d.description, assetCount: d.dataAssetIds.length },
    });
    // Domain → Assets edges
    for (const aid of d.dataAssetIds) {
      if (nodeIds.has(aid)) {
        edges.push({ id: `da-${d.id}-${aid}`, source: d.id, target: aid, type: 'governs', label: 'governs' });
      }
    }
  }

  // People (only those who own/steward something to keep graph manageable)
  const relevantPeopleIds = new Set<string>();
  for (const p of filteredProcesses) { if (p.ownerId) relevantPeopleIds.add(p.ownerId); }
  for (const a of filteredAssets) {
    if (a.owner) relevantPeopleIds.add(a.owner);
    for (const sid of a.stewardIds || []) relevantPeopleIds.add(sid);
  }
  for (const d of filteredDomains) {
    if (d.ownerId) relevantPeopleIds.add(d.ownerId);
    for (const sid of d.stewardIds) relevantPeopleIds.add(sid);
  }
  for (const pid of relevantPeopleIds) {
    const person = allPeople.find((p) => p.id === pid);
    if (!person) continue;
    addNode({
      id: person.id, type: 'person',
      label: person.name, status: undefined,
      meta: { email: person.email, role: person.role, title: person.title },
    });
  }

  // Ownership edges: Process → Person
  for (const p of filteredProcesses) {
    if (p.ownerId && nodeIds.has(p.ownerId) && topLevels.has(p.level)) {
      edges.push({ id: `po-${p.id}`, source: p.id, target: p.ownerId, type: 'owned-by', label: 'owned by' });
    }
  }
  // Ownership edges: Asset → Person
  for (const a of filteredAssets) {
    if (a.owner && nodeIds.has(a.owner)) {
      edges.push({ id: `ao-${a.id}`, source: a.id, target: a.owner, type: 'owned-by', label: 'owned by' });
    }
  }
  // Ownership edges: Domain → Person
  for (const d of filteredDomains) {
    if (d.ownerId && nodeIds.has(d.ownerId)) {
      edges.push({ id: `do-${d.id}`, source: d.id, target: d.ownerId, type: 'owned-by', label: 'owned by' });
    }
  }

  // Mappings: Process step → Data Asset (loaded via the repo above)
  const filteredMappings = scopeListForRequest(req, allMappings);
  for (const m of filteredMappings as any[]) {
    // Map to the process node (step/activity) and data asset
    if (nodeIds.has(m.processStepId) && nodeIds.has(m.dataAssetId)) {
      edges.push({
        id: `m-${m.id}`,
        source: m.processStepId,
        target: m.dataAssetId,
        type: 'mapping',
        label: m.linkType || 'uses',
      });
    }
  }

  // Lineage: System → System
  const filteredLineage = scopeListForRequest(req, allLineage);
  for (const l of filteredLineage as any[]) {
    if (nodeIds.has(l.sourceSystemId) && nodeIds.has(l.targetSystemId)) {
      edges.push({
        id: `lin-${l.id}`,
        source: l.sourceSystemId,
        target: l.targetSystemId,
        type: 'lineage',
        label: l.transformationType || 'feeds',
      });
    }
  }

  res.json({
    success: true,
    data: { nodes, edges },
    summary: {
      processes: nodes.filter((n) => n.type === 'process').length,
      systems: nodes.filter((n) => n.type === 'system').length,
      dataAssets: nodes.filter((n) => n.type === 'data-asset').length,
      domains: nodes.filter((n) => n.type === 'domain').length,
      people: nodes.filter((n) => n.type === 'person').length,
      edges: edges.length,
    },
  });
});

export default router;
