import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { isOwnershipLevel, getVisibleOrgScope, OWNERSHIP_LEVELS } from '../lib/org-scope';
import { scopeListForRequest, assertOrgAccess } from '../lib/tenant-scope';
import logger from '../lib/logger';
import { getSkillsRepository } from '../db/skills.repo';
import {
  unqualifiedSummaryByPerson,
  listUnqualifiedAssignments,
  rankPeopleByRoleSkills,
  orgSkillGapReport,
} from '../services/skill-coverage';
import {
  SKILL_CATEGORIES,
  skills,
  type SkillCategory,
  type StoredSkill,
} from '../stores/skills';

// Re-export so existing imports keep working without a churn diff.
export { skills, SKILL_CATEGORIES };
export type { StoredSkill };

const skillsRepo = getSkillsRepository(skills);

// ──────────────────────────────────────────────────────────────────────────
// Skills — DAMA-aligned capabilities that agents (and people) can possess.
// Phase 1 of the AI agent automation feature. Each skill belongs to a
// category and an org; the seed endpoint populates a standard taxonomy.
// ──────────────────────────────────────────────────────────────────────────

const router = Router();

// ── Standard DAMA-aligned seed skills ────────────────────────────────────

const SEED_SKILLS: Array<{ name: string; category: SkillCategory; description: string }> = [
  // DATA_QUALITY
  { name: 'Data Profiling', category: 'DATA_QUALITY', description: 'Analyze data sets to collect statistics and information about data quality, structure, and content.' },
  { name: 'Data Cleansing', category: 'DATA_QUALITY', description: 'Detect and correct (or remove) corrupt, inaccurate, or irrelevant records from a data set.' },
  { name: 'Rule Authoring', category: 'DATA_QUALITY', description: 'Define and maintain business rules that validate data quality expectations.' },
  { name: 'Anomaly Detection', category: 'DATA_QUALITY', description: 'Identify unexpected patterns, outliers, or deviations in data that may indicate quality issues.' },
  { name: 'Quality Monitoring', category: 'DATA_QUALITY', description: 'Continuously track data quality metrics and alert on threshold breaches.' },

  // METADATA
  { name: 'Metadata Management', category: 'METADATA', description: 'Organize, store, and maintain metadata across enterprise data assets.' },
  { name: 'Data Cataloging', category: 'METADATA', description: 'Discover, inventory, and classify data assets into a searchable catalog.' },
  { name: 'Lineage Mapping', category: 'METADATA', description: 'Trace and document the flow of data from source to destination across systems.' },
  { name: 'Schema Validation', category: 'METADATA', description: 'Verify that data structures conform to expected schemas and formats.' },
  { name: 'Tag Management', category: 'METADATA', description: 'Apply, maintain, and govern classification tags on data assets.' },

  // ARCHITECTURE
  { name: 'Data Modeling', category: 'ARCHITECTURE', description: 'Design logical and physical data models that support business requirements.' },
  { name: 'Integration Design', category: 'ARCHITECTURE', description: 'Architect data integration patterns and data flow between systems.' },
  { name: 'API Management', category: 'ARCHITECTURE', description: 'Design, publish, and govern APIs for data access and exchange.' },
  { name: 'Cloud Architecture', category: 'ARCHITECTURE', description: 'Design and optimize cloud-based data infrastructure and services.' },
  { name: 'Performance Tuning', category: 'ARCHITECTURE', description: 'Optimize data systems for query performance, throughput, and resource utilization.' },

  // SECURITY
  { name: 'Access Control', category: 'SECURITY', description: 'Manage authentication and authorization policies for data access.' },
  { name: 'Data Classification', category: 'SECURITY', description: 'Categorize data by sensitivity level to apply appropriate protection controls.' },
  { name: 'Encryption Management', category: 'SECURITY', description: 'Implement and manage encryption for data at rest and in transit.' },
  { name: 'Privacy Compliance', category: 'SECURITY', description: 'Ensure data handling practices comply with privacy regulations (GDPR, CCPA, etc.).' },
  { name: 'Audit Trail Management', category: 'SECURITY', description: 'Maintain comprehensive logs of data access and modifications for compliance.' },

  // INTEGRATION
  { name: 'ETL Development', category: 'INTEGRATION', description: 'Build and maintain extract, transform, and load pipelines for data movement.' },
  { name: 'API Integration', category: 'INTEGRATION', description: 'Connect systems through API-based data exchange and synchronization.' },
  { name: 'Real-time Streaming', category: 'INTEGRATION', description: 'Implement real-time data streaming and event-driven integration patterns.' },
  { name: 'File Transfer', category: 'INTEGRATION', description: 'Manage secure file-based data transfers between systems and partners.' },
  { name: 'Data Replication', category: 'INTEGRATION', description: 'Replicate data across systems for availability, disaster recovery, or analytics.' },

  // ANALYTICS
  { name: 'Report Development', category: 'ANALYTICS', description: 'Create and maintain operational and analytical reports for stakeholders.' },
  { name: 'Dashboard Design', category: 'ANALYTICS', description: 'Design interactive dashboards that visualize key metrics and KPIs.' },
  { name: 'Statistical Analysis', category: 'ANALYTICS', description: 'Apply statistical methods to extract insights from data sets.' },
  { name: 'Data Visualization', category: 'ANALYTICS', description: 'Transform data into visual representations that communicate findings effectively.' },
  { name: 'Predictive Modeling', category: 'ANALYTICS', description: 'Build models that forecast future outcomes based on historical data patterns.' },

  // GOVERNANCE
  { name: 'Policy Development', category: 'GOVERNANCE', description: 'Draft and maintain data governance policies, standards, and procedures.' },
  { name: 'Standards Enforcement', category: 'GOVERNANCE', description: 'Monitor and enforce compliance with data governance standards across the organization.' },
  { name: 'Issue Resolution', category: 'GOVERNANCE', description: 'Investigate and resolve data governance issues and escalations.' },
  { name: 'Change Management', category: 'GOVERNANCE', description: 'Manage controlled changes to data assets, schemas, and governance processes.' },
  { name: 'Compliance Monitoring', category: 'GOVERNANCE', description: 'Track regulatory and policy compliance across data management activities.' },

  // COMMUNICATION
  { name: 'Stakeholder Management', category: 'COMMUNICATION', description: 'Engage and align stakeholders on data governance initiatives and priorities.' },
  { name: 'Training Delivery', category: 'COMMUNICATION', description: 'Develop and deliver training on data governance practices and tools.' },
  { name: 'Documentation', category: 'COMMUNICATION', description: 'Create and maintain documentation for data processes, standards, and systems.' },
  { name: 'Business Translation', category: 'COMMUNICATION', description: 'Translate between technical data concepts and business language for stakeholders.' },
  { name: 'Executive Reporting', category: 'COMMUNICATION', description: 'Prepare executive-level summaries and presentations on data governance outcomes.' },
];

/** GET /api/v1/skills — list skills visible from ?orgId=. Uses
 *  filterByOrgScope so a division-scoped view sees company-level
 *  skills rolling down and team-level skills rolling up, matching the
 *  visibility pattern for data assets, systems, and process nodes. */
router.get('/', async (req: Request, res: Response) => {
  const filtered = scopeListForRequest(req, await skillsRepo.list());
  res.json({
    success: true,
    data: filtered,
    categories: SKILL_CATEGORIES,
  });
});

/** POST /api/v1/skills — create a skill. Enforces:
 *   - orgId must be a company or division (departments and teams
 *     inherit their parent's catalog; owning at a sub-level would
 *     silo the skill).
 *   - Name is unique in the visible scope (own org + ancestors +
 *     descendants) so a division can't shadow a company-level
 *     "Data Profiling" with a subtly different one. */
router.post('/', async (req: Request, res: Response) => {
  const { orgId, name, category, description } = req.body;
  if (!orgId) { res.status(400).json({ success: false, error: 'orgId is required' }); return; }
  if (!isOwnershipLevel(orgId)) {
    res.status(400).json({ success: false, error: `Skills can only be owned at ${OWNERSHIP_LEVELS.join(' or ')} level; sub-levels inherit them.` });
    return;
  }
  if (typeof name !== 'string' || !name.trim()) { res.status(400).json({ success: false, error: 'Name is required' }); return; }
  const trimmedName = name.trim();
  // Uniqueness across the visible scope (ancestors + descendants).
  // Case-insensitive so "Data Profiling" and "data profiling"
  // collide, and an inherited "Data Profiling" from the company
  // level blocks a division from creating another.
  const visibleScope = getVisibleOrgScope(orgId);
  const allSkills = await skillsRepo.list();
  const clash = allSkills.find((s) => (visibleScope?.has(s.orgId) ?? s.orgId === orgId) && s.name.toLowerCase() === trimmedName.toLowerCase());
  if (clash) {
    res.status(409).json({ success: false, error: `A skill named "${clash.name}" already exists in this organization.` });
    return;
  }
  const resolvedCategory: SkillCategory = SKILL_CATEGORIES.includes(category) ? category : 'GOVERNANCE';
  const now = new Date().toISOString();
  const skill: StoredSkill = {
    id: uuid(),
    orgId,
    name: trimmedName,
    category: resolvedCategory,
    description: description || '',
    createdAt: now,
    updatedAt: now,
  };
  await skillsRepo.create(skill);
  res.status(201).json({ success: true, data: skill });
});

/** POST /api/v1/skills/seed — seed standard DAMA-aligned skills for an org */
router.post('/seed', async (req: Request, res: Response) => {
  const { orgId } = req.body;
  if (!orgId) { res.status(400).json({ success: false, error: 'orgId is required' }); return; }
  if (!isOwnershipLevel(orgId)) {
    res.status(400).json({ success: false, error: `Skills can only be owned at ${OWNERSHIP_LEVELS.join(' or ')} level; sub-levels inherit them.` });
    return;
  }
  // Seed dedup respects roll-down too — if the parent already seeded
  // "Data Profiling" at the company level, don't create a division-
  // level duplicate the frontend would badge as inherited anyway.
  const visibleScope = getVisibleOrgScope(orgId);
  const now = new Date().toISOString();
  const created: StoredSkill[] = [];
  const existing = await skillsRepo.list();
  for (const seed of SEED_SKILLS) {
    if (existing.find((s) => (visibleScope?.has(s.orgId) ?? s.orgId === orgId) && s.name === seed.name)) continue;
    const skill: StoredSkill = {
      id: uuid(),
      orgId,
      name: seed.name,
      category: seed.category,
      description: seed.description,
      createdAt: now,
      updatedAt: now,
    };
    await skillsRepo.create(skill);
    created.push(skill);
    existing.push(skill);
  }
  logger.info({ created: created.length, orgId }, 'Seeded DAMA skills');
  res.status(201).json({ success: true, data: created, message: `Seeded ${created.length} skills` });
});

/** PUT /api/v1/skills/:id — update a skill */
router.put('/:id', async (req: Request, res: Response) => {
  const skill = await skillsRepo.get(String(req.params.id));
  if (!skill) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }
  if (!assertOrgAccess(req, res, skill.orgId, 'Skill not found')) return;
  const { name, category, description } = req.body;
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, error: 'Name cannot be empty' });
      return;
    }
    const trimmedName = name.trim();
    // Same uniqueness check as POST — a rename that collides with
    // another skill visible from the owning org (self, ancestors,
    // descendants) gets 409. Own-row match is fine (a no-op rename
    // or a case change).
    const visibleScope = getVisibleOrgScope(skill.orgId);
    const allSkills = await skillsRepo.list();
    const clash = allSkills.find((s) => s.id !== skill.id && (visibleScope?.has(s.orgId) ?? s.orgId === skill.orgId) && s.name.toLowerCase() === trimmedName.toLowerCase());
    if (clash) {
      res.status(409).json({ success: false, error: `A skill named "${clash.name}" already exists in this organization.` });
      return;
    }
    skill.name = trimmedName;
  }
  if (category !== undefined && SKILL_CATEGORIES.includes(category)) skill.category = category;
  if (description !== undefined) skill.description = description;
  skill.updatedAt = new Date().toISOString();
  await skillsRepo.update(skill.id, skill);
  res.json({ success: true, data: skill });
});

/** DELETE /api/v1/skills/:id — delete a skill.
 *
 *  Cascade: sweep the removed id off every person's, every
 *  agent's, and every activity's skill-id array so nothing
 *  dangles. Same pattern as the control-cascade on
 *  governance-controls DELETE. Persists each touched store
 *  independently so a partial failure downstream doesn't leave
 *  the skills list out of sync with the reference tables.
 *
 *  Response body reports the sweep counts so a caller (or a
 *  future confirm-dialog on the Skills page) can surface a
 *  meaningful blast-radius summary.
 */
router.delete('/:id', async (req: Request, res: Response) => {
  const removed = await skillsRepo.get(String(req.params.id));
  if (!removed) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }
  if (!assertOrgAccess(req, res, removed.orgId, 'Skill not found')) return;
  await skillsRepo.delete(removed.id);

  // Cascade off people, agents, and process nodes. Lazy requires break
  // any lingering import-graph cycle at boot; each cascade lists through
  // the store's repository and persists each cleared row via repo.update
  // so the sweep reaches Postgres too (a bare saveStore only wrote JSON).
  let peopleTouched = 0;
  let agentsTouched = 0;
  let nodesTouched = 0;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { people } = require('./people') as typeof import('./people');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getPeopleRepository } = require('../db/people.repo') as typeof import('../db/people.repo');
    const peopleRepo = getPeopleRepository(people);
    for (const p of await peopleRepo.list()) {
      if (!Array.isArray(p.skillIds) || p.skillIds.length === 0) continue;
      const next = p.skillIds.filter((id) => id !== removed.id);
      if (next.length !== p.skillIds.length) {
        p.skillIds = next;
        await peopleRepo.update(p.id, p);
        peopleTouched++;
      }
    }
  } catch (err) {
    logger.warn({ err, skillId: removed.id }, 'Failed to cascade skill delete to people');
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { agents } = require('./agents') as typeof import('./agents');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getAgentsRepository } = require('../db/agents.repo') as typeof import('../db/agents.repo');
    const agentsRepo = getAgentsRepository(agents);
    for (const a of await agentsRepo.list()) {
      if (!Array.isArray(a.skillIds) || a.skillIds.length === 0) continue;
      const next = a.skillIds.filter((id) => id !== removed.id);
      if (next.length !== a.skillIds.length) {
        a.skillIds = next;
        await agentsRepo.update(a.id, a);
        agentsTouched++;
      }
    }
  } catch (err) {
    logger.warn({ err, skillId: removed.id }, 'Failed to cascade skill delete to agents');
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { processNodes } = require('./process-catalog') as typeof import('./process-catalog');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getProcessNodesRepository } = require('../db/process-nodes.repo') as typeof import('../db/process-nodes.repo');
    const processNodesRepo = getProcessNodesRepository(processNodes);
    for (const n of await processNodesRepo.list()) {
      if (!Array.isArray(n.requiredSkillIds) || n.requiredSkillIds.length === 0) continue;
      const next = n.requiredSkillIds.filter((id) => id !== removed.id);
      if (next.length !== n.requiredSkillIds.length) {
        // Pass the (possibly empty) array, not undefined — the repo skips an
        // undefined M2M field, which would leave the deleted id in Postgres.
        n.requiredSkillIds = next;
        await processNodesRepo.update(n.id, n);
        nodesTouched++;
      }
    }
  } catch (err) {
    logger.warn({ err, skillId: removed.id }, 'Failed to cascade skill delete to process nodes');
  }

  logger.info({ skillId: removed.id, name: removed.name, peopleTouched, agentsTouched, nodesTouched }, 'Deleted skill');
  res.json({ success: true, cascade: { peopleTouched, agentsTouched, nodesTouched } });
});

// ──────────────────────────────────────────────────────────────────────────
// Value-loop endpoints — closes the gap between "we collected skills"
// and "the app does something with them." See services/skill-coverage.ts
// for the math. All four endpoints are org-scoped via ?orgId=...
// ──────────────────────────────────────────────────────────────────────────

/** GET /api/v1/skills/coverage?orgId=…
 *  Two slices in one response so the People page can render its
 *  skill-coverage column AND the Process Catalog can lookup
 *  warnings without a second round-trip:
 *    byPerson: per-person summary (count + sample of unqualified
 *              activities). Keyed by personId.
 *    byNode:   per-node detail (missing skill names). Keyed by
 *              nodeId. Populated only for nodes whose responsible
 *              person is short on skills. */
router.get('/coverage', async (req: Request, res: Response) => {
  const orgId = String(req.query.orgId || '');
  if (!orgId) {
    res.status(400).json({ success: false, error: 'orgId is required' });
    return;
  }
  const byPersonMap = await unqualifiedSummaryByPerson(orgId);
  const byPerson: Record<string, { unqualifiedCount: number; sample: string[] }> = {};
  for (const [pid, summary] of byPersonMap) byPerson[pid] = summary;

  const unqualifiedMap = await listUnqualifiedAssignments(orgId);
  const byNode: Record<string, { personId: string; missingSkillNames: string[] }> = {};
  for (const [pid, list] of unqualifiedMap) {
    for (const entry of list) {
      byNode[entry.nodeId] = { personId: pid, missingSkillNames: entry.missingSkillNames };
    }
  }

  res.json({ success: true, data: { byPerson, byNode } });
});

/** GET /api/v1/skills/recommend-for-role?orgId=…&skills=Skill1,Skill2,…
 *  Used by the RoleDetailDrawer's "Best-matching people" panel.
 *  The skill list is passed by name because the role definitions
 *  in roleDefinitions.ts carry names rather than catalog ids — a
 *  role saying it needs "Data Cataloging" should match any person
 *  whose catalog entry happens to be named "Data Cataloging"
 *  regardless of id. */
router.get('/recommend-for-role', async (req: Request, res: Response) => {
  const orgId = String(req.query.orgId || '');
  if (!orgId) {
    res.status(400).json({ success: false, error: 'orgId is required' });
    return;
  }
  const raw = String(req.query.skills || '');
  const requiredNames = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const limit = parseInt(String(req.query.limit || '5'), 10) || 5;
  res.json({ success: true, data: await rankPeopleByRoleSkills(orgId, requiredNames, limit) });
});

/** GET /api/v1/skills/gap-report?orgId=…
 *  Org-wide skill-gap report for the dashboard widget. Skills are
 *  sorted by gap score descending so the worst-staffed required
 *  skills bubble to the top. */
router.get('/gap-report', async (req: Request, res: Response) => {
  const orgId = String(req.query.orgId || '');
  if (!orgId) {
    res.status(400).json({ success: false, error: 'orgId is required' });
    return;
  }
  res.json({ success: true, data: await orgSkillGapReport(orgId) });
});

/** GET /api/v1/skills/:id
 *  Registered LAST so the literal-path GET routes above (/coverage,
 *  /recommend-for-role, /gap-report) resolve first — a `/:id` registered
 *  ahead of them matches `id="coverage"` and 404s the real handler. */
router.get('/:id', async (req: Request, res: Response) => {
  const skill = await skillsRepo.get(String(req.params.id));
  if (!skill) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }
  if (!assertOrgAccess(req, res, skill.orgId, 'Skill not found')) return;
  res.json({ success: true, data: skill });
});

export default router;
