import { Router, Request, Response } from 'express';
import { processNodes } from './process-catalog';
import { systems } from './systems';
import { dataAssets } from './data-assets';
import { people } from './people';
import { dataDomains } from './data-domains';
import { governanceGroups } from './governance-groups';
import { mappings } from './mappings';
import { connections } from './connections';
import { glossaryTerms } from './business-glossary';
import { scopeListForRequest } from '../lib/tenant-scope';
// Global search is a read aggregator across 9 stores; each is read through
// its repository so results come from Postgres in DB mode and the in-memory
// array in JSON mode (the factory wraps the same array these modules export).
// PR 9b.7.
import { getProcessNodesRepository } from '../db/process-nodes.repo';
import { getSystemsRepository } from '../db/systems.repo';
import { getDataAssetsRepository } from '../db/data-assets.repo';
import { getPeopleRepository } from '../db/people.repo';
import { getDataDomainsRepository } from '../db/data-domains.repo';
import { getGovernanceGroupsRepository } from '../db/governance-groups.repo';
import { getMappingsRepository } from '../db/mappings.repo';
import { getConnectionsRepository } from '../db/connections.repo';
import { getGlossaryTermsRepository } from '../db/glossary-terms.repo';

const processNodesRepo = getProcessNodesRepository(processNodes);
const systemsRepo = getSystemsRepository(systems);
const dataAssetsRepo = getDataAssetsRepository(dataAssets);
const peopleRepo = getPeopleRepository(people);
const dataDomainsRepo = getDataDomainsRepository(dataDomains);
const governanceGroupsRepo = getGovernanceGroupsRepository(governanceGroups);
const mappingsRepo = getMappingsRepository(mappings);
const connectionsRepo = getConnectionsRepository(connections);
const glossaryTermsRepo = getGlossaryTermsRepository(glossaryTerms);

const router = Router();

// ──────────────────────────────────────────────────────────────────────────
// Global search — backs the Cmd-K palette.
//
// Procela's growth has produced many surface areas (Systems, Data Assets,
// Activities, Connections, People, Domains, Glossary…); without a single
// search front door, users hunt through the nav. This endpoint fans out
// across the catalog and returns ranked, navigable matches.
//
// Org-scoping is mandatory: every searchable entity has an org_id and is
// filtered through `filterByOrgScope` so cross-tenant leaks aren't
// possible.
//
// Ranking favours name-exact > name-prefix > name-substring >
// subtitle/description substring. Per-type results are capped so a single
// noisy entity type can't crowd out the rest.
// ──────────────────────────────────────────────────────────────────────────

type SearchType =
  | 'system'
  | 'data-asset'
  | 'activity'
  | 'connection'
  | 'person'
  | 'data-domain'
  | 'governance-group'
  | 'glossary-term'
  | 'mapping';

interface SearchResult {
  type: SearchType;
  /** Stable label shown as the primary text in the palette row. */
  label: string;
  /** Optional secondary text (system type, governance tier, role, etc.). */
  subtitle?: string;
  /** Where to navigate when the user picks this row. Always uses the
   *  ?highlight=<id> pattern so pages can scroll to and pulse the row. */
  path: string;
  /** Internal ID — included so the frontend can dedup recents. */
  id: string;
  /** Internal score — exposed for debugging; frontend hides it. */
  _score: number;
}

const PER_TYPE_CAP = 5;
const GLOBAL_CAP = 30;

/** Score a candidate against the query. Higher is better.
 *  Returns -1 if neither field matches at all. */
function scoreMatch(query: string, primary: string, secondary?: string): number {
  const q = query.toLowerCase();
  const p = primary.toLowerCase();
  const s = (secondary || '').toLowerCase();
  if (p === q) return 1000;
  if (p.startsWith(q)) return 800;
  // Word-boundary match — e.g. "ord" finds "Order Management".
  if (new RegExp(`(^|\\s|-|_|/)${escapeRegex(q)}`).test(p)) return 600;
  if (p.includes(q)) return 400;
  if (s.includes(q)) return 200;
  return -1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** GET /api/v1/search?q=query[&orgId=]
 *
 *  Returns up to GLOBAL_CAP ranked matches across the catalog. Each row
 *  carries a `path` the frontend can navigate to directly. */
router.get('/', async (req: Request, res: Response) => {
  const q = (req.query.q as string || '').trim();

  if (!q) {
    res.json({ success: true, data: { results: [], query: '' } });
    return;
  }

  // Each store read through its repository; local consts shadow the
  // module-level array imports so the scoring logic below is unchanged.
  const [systems, dataAssets, processNodes, connections, people, dataDomains, governanceGroups, glossaryTerms, mappings] = await Promise.all([
    systemsRepo.list(), dataAssetsRepo.list(), processNodesRepo.list(),
    connectionsRepo.list(), peopleRepo.list(), dataDomainsRepo.list(),
    governanceGroupsRepo.list(), glossaryTermsRepo.list(), mappingsRepo.list(),
  ]);

  const out: SearchResult[] = [];
  const push = (candidates: SearchResult[]) => {
    candidates
      .sort((a, b) => b._score - a._score)
      .slice(0, PER_TYPE_CAP)
      .forEach((c) => out.push(c));
  };

  // Systems
  push(scopeListForRequest(req, systems).flatMap((sys) => {
    const score = scoreMatch(q, sys.name, sys.description);
    if (score < 0) return [];
    return [{
      type: 'system' as const,
      id: sys.id,
      label: sys.name,
      subtitle: [sys.systemType, sys.vendor].filter(Boolean).join(' · ') || undefined,
      path: `/systems?highlight=${encodeURIComponent(sys.id)}`,
      _score: score,
    }];
  }));

  // Data assets
  push(scopeListForRequest(req, dataAssets).flatMap((a) => {
    const score = scoreMatch(q, a.name, a.description);
    if (score < 0) return [];
    return [{
      type: 'data-asset' as const,
      id: a.id,
      label: a.name,
      subtitle: a.governanceTier ? `${a.governanceTier} tier` : undefined,
      path: `/data-assets?highlight=${encodeURIComponent(a.id)}`,
      _score: score,
    }];
  }));

  // Activities (process nodes) — score includes parent path so
  // "Billing > Invoice > Issue" can be found by typing "issue".
  push(scopeListForRequest(req, processNodes).flatMap((n) => {
    const score = scoreMatch(q, n.name, n.description);
    if (score < 0) return [];
    const parent = n.parentId ? processNodes.find((p) => p.id === n.parentId) : null;
    return [{
      type: 'activity' as const,
      id: n.id,
      label: n.name,
      subtitle: [n.level, parent?.name].filter(Boolean).join(' · ') || undefined,
      path: `/processes?highlight=${encodeURIComponent(n.id)}`,
      _score: score,
    }];
  }));

  // Connections
  push(scopeListForRequest(req, connections).flatMap((c) => {
    const score = scoreMatch(q, c.name);
    if (score < 0) return [];
    return [{
      type: 'connection' as const,
      id: c.id,
      label: c.name,
      subtitle: [c.connectionType, c.status].filter(Boolean).join(' · ') || undefined,
      path: `/connections?highlight=${encodeURIComponent(c.id)}`,
      _score: score,
    }];
  }));

  // People
  push(scopeListForRequest(req, people).flatMap((p) => {
    const score = scoreMatch(q, p.name, p.email);
    if (score < 0) return [];
    return [{
      type: 'person' as const,
      id: p.id,
      label: p.name,
      subtitle: [p.title, p.role].filter(Boolean).join(' · ') || undefined,
      path: `/people/${p.id}`,
      _score: score,
    }];
  }));

  // Data domains
  push(scopeListForRequest(req, dataDomains).flatMap((d) => {
    const score = scoreMatch(q, d.name, d.description);
    if (score < 0) return [];
    return [{
      type: 'data-domain' as const,
      id: d.id,
      label: d.name,
      subtitle: d.status || undefined,
      path: `/data-domains?highlight=${encodeURIComponent(d.id)}`,
      _score: score,
    }];
  }));

  // Governance groups
  push(scopeListForRequest(req, governanceGroups).flatMap((g) => {
    const score = scoreMatch(q, g.name, g.description);
    if (score < 0) return [];
    return [{
      type: 'governance-group' as const,
      id: g.id,
      label: g.name,
      subtitle: [g.type, g.status].filter(Boolean).join(' · ') || undefined,
      path: `/governance-groups?highlight=${encodeURIComponent(g.id)}`,
      _score: score,
    }];
  }));

  // Glossary terms
  push(scopeListForRequest(req, glossaryTerms).flatMap((t) => {
    const score = scoreMatch(q, t.term, t.definition);
    if (score < 0) return [];
    return [{
      type: 'glossary-term' as const,
      id: t.id,
      label: t.term,
      subtitle: t.definition ? t.definition.slice(0, 80) + (t.definition.length > 80 ? '…' : '') : undefined,
      path: `/business-glossary?highlight=${encodeURIComponent(t.id)}`,
      _score: score,
    }];
  }));

  // Mappings — useful for "where does X feed Y" searches. Subtitle
  // shows both ends so the row carries enough context.
  push(scopeListForRequest(req, mappings).flatMap((m) => {
    const step = processNodes.find((n) => n.id === m.processStepId);
    const asset = dataAssets.find((a) => a.id === m.dataAssetId);
    if (!step && !asset) return [];
    const label = `${step?.name || 'Unknown step'} ↔ ${asset?.name || 'Unknown asset'}`;
    const score = scoreMatch(q, label, m.notes);
    if (score < 0) return [];
    return [{
      type: 'mapping' as const,
      id: m.id,
      label,
      subtitle: m.linkType,
      path: `/mappings?highlight=${encodeURIComponent(m.id)}`,
      _score: score,
    }];
  }));

  out.sort((a, b) => b._score - a._score);
  res.json({
    success: true,
    data: {
      query: q,
      results: out.slice(0, GLOBAL_CAP),
    },
  });
});

export default router;
