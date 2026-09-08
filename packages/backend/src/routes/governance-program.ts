import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { auditService } from '../services/audit.service';
import { loadStore, saveStore, registerStore } from '../lib/persistence';
import { filterByOrgScope } from '../lib/org-scope';
import { assertOrgAccess } from '../lib/tenant-scope';
import { hasPermission } from '../lib/permissions';
import { AuthenticatedRequest } from '../middleware/auth';
import logger from '../lib/logger';
import { getGovernanceProgramsRepository } from '../db/governance-programs.repo';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OperatingModel = 'CENTRALIZED' | 'FEDERATED' | 'HYBRID' | '';
export type ProgramStatus = 'PLANNING' | 'ACTIVE' | 'PAUSED' | 'COMPLETED';

// Program status is an org-wide, audit-weight signal the scorecard and
// dashboards key off — so transitions are governed, not a free field:
//
//  • Only an admin / program owner (governance:write) may change it.
//  • Only the transitions below are legal. Anything else is rejected so
//    the status can't silently slide backwards or skip the lifecycle.
//  • Entering ACTIVE is additionally gated: Phase 1 (Foundation) is a
//    hard prerequisite; Phases 2–4 are a soft gate that needs an
//    explicit `force` (the UI shows what's incomplete and confirms).
//
//  PLANNING ─▶ ACTIVE ⇄ PAUSED
//                 │        │
//                 └──▶ COMPLETED ──▶ ACTIVE   (explicit reopen)
const VALID_TRANSITIONS: Record<ProgramStatus, ProgramStatus[]> = {
  PLANNING: ['ACTIVE'],
  ACTIVE: ['PAUSED', 'COMPLETED'],
  PAUSED: ['ACTIVE', 'COMPLETED'],
  COMPLETED: ['ACTIVE'], // reopening a closed program is allowed but explicit
};

export interface StoredGovernanceProgram {
  id: string;
  orgId: string;
  name: string;
  scope: {
    inScope: string;
    outOfScope: string;
    boundaries: string;
    constraints: string;
  };
  principles: {
    vision: string;
    principles: string[];
    decisionRights: string;
    operatingModel: OperatingModel;
  };
  targetStartDate: string | null;
  targetLaunchDate: string | null;
  status: ProgramStatus;
  /** Actual go-live timestamp — set the first time the program goes ACTIVE,
   *  preserved through pause/resume/reopen. Null until first launched. */
  launchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PhaseCheck {
  label: string;
  done: boolean;
}

interface PhaseInfo {
  name: string;
  completed: boolean;
  progress: number;
  checks: PhaseCheck[];
}

interface PhaseStatus {
  currentPhase: 1 | 2 | 3 | 4;
  phases: {
    phase1: PhaseInfo;
    phase2: PhaseInfo;
    phase3: PhaseInfo;
    phase4: PhaseInfo;
  };
  overallProgress: number;
}

interface Recommendation {
  phase: 1 | 2 | 3 | 4;
  action: string;
  link: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const governancePrograms: StoredGovernanceProgram[] =
  loadStore<StoredGovernanceProgram>('governancePrograms');
registerStore('governancePrograms', governancePrograms);

const governanceProgramsRepo = getGovernanceProgramsRepository(governancePrograms);

const DEV_ORG_ID = '00000000-0000-0000-0000-000000000010';

function buildDefaultProgram(orgId: string): StoredGovernanceProgram {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    orgId,
    name: 'Data Governance Program',
    scope: { inScope: '', outOfScope: '', boundaries: '', constraints: '' },
    principles: { vision: '', principles: [], decisionRights: '', operatingModel: '' },
    targetStartDate: null,
    targetLaunchDate: null,
    status: 'PLANNING',
    launchedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Phase computation
// ---------------------------------------------------------------------------

// Load an org's slice of a sibling store through its repository. The lazy
// require keeps the original circular-import safety (this module is imported
// while its siblings are still loading), and going through the repo — rather
// than reading the in-memory array directly — is what makes phase computation
// correct in Postgres mode, where those arrays are empty and the DB is the
// source of truth.
async function listOrgScoped(
  routePath: string,
  arrayExport: string,
  repoPath: string,
  repoAccessor: string,
  orgId: string,
): Promise<any[]> {
  try {
    const store = require(routePath)[arrayExport];
    const getRepo = require(repoPath)[repoAccessor];
    const repo = getRepo(store);
    return await repo.list({ orgId });
  } catch {
    return [];
  }
}

async function computePhaseStatus(program: StoredGovernanceProgram): Promise<PhaseStatus> {
  const orgId = program.orgId;

  const [orgDomains, orgGroups, allRoles, orgPolicies, orgProcesses] = await Promise.all([
    listOrgScoped('./data-domains', 'dataDomains', '../db/data-domains.repo', 'getDataDomainsRepository', orgId),
    listOrgScoped('./governance-groups', 'governanceGroups', '../db/governance-groups.repo', 'getGovernanceGroupsRepository', orgId),
    // DamaRole has no orgId column — its repo.list ignores the filter and
    // returns every row, so scope it here by the ORG-scoped assignment.
    listOrgScoped('./dama-roles', 'damaRoles', '../db/dama-roles.repo', 'getDamaRolesRepository', orgId),
    listOrgScoped('./governance-policies', 'governancePolicies', '../db/governance-policies.repo', 'getGovernancePoliciesRepository', orgId),
    listOrgScoped('./process-catalog', 'processNodes', '../db/process-nodes.repo', 'getProcessNodesRepository', orgId),
  ]);

  const orgRoles = allRoles.filter(
    (r: any) => r.scopeType === 'ORG' && r.scopeId === orgId,
  );

  // ── Phase 1 — Foundation Definition
  const phase1Checks: PhaseCheck[] = [
    {
      label: 'Scope defined',
      done: (program.scope?.inScope || '').trim().length > 0,
    },
    {
      label: 'Guiding principles established',
      done: (program.principles?.principles || []).length > 0,
    },
    {
      label: 'Operating model selected',
      done: (program.principles?.operatingModel || '') !== '',
    },
  ];

  // ── Phase 2 — Structural Design
  const phase2Checks: PhaseCheck[] = [
    {
      label: 'Data domains defined',
      done: orgDomains.length >= 1,
    },
    {
      label: 'Governance Council established',
      done: orgGroups.some((g: any) => g.type === 'COUNCIL'),
    },
    {
      label: 'Governance Committee established',
      done: orgGroups.some((g: any) => g.type === 'COMMITTEE'),
    },
    {
      label: 'Governance leadership roles established',
      done: ['CDO', 'DATA_GOVERNANCE_LEAD'].every(
        (rt) => orgRoles.some((r: any) => r.roleType === rt),
      ),
    },
  ];

  // ── Phase 3 — People & Processes
  const hasDataSteward = orgRoles.some(
    (r: any) =>
      r.roleType === 'BUSINESS_DATA_STEWARD' ||
      r.roleType === 'TECHNICAL_DATA_STEWARD',
  );
  const hasStewardshipTeam = orgGroups.some(
    (g: any) => g.type === 'STEWARDSHIP_TEAM',
  );
  const allDomainsOwned =
    orgDomains.length > 0 && orgDomains.every((d: any) => !!d.ownerId);

  const hasDataOwner = orgRoles.some((r: any) => r.roleType === 'DATA_OWNER');

  const phase3Checks: PhaseCheck[] = [
    { label: 'Data owners assigned', done: hasDataOwner },
    { label: 'Data stewards identified', done: hasDataSteward },
    { label: 'Stewardship teams formed', done: hasStewardshipTeam },
    { label: 'Domain ownership assigned', done: allDomainsOwned },
  ];

  // ── Phase 4 — Operationalization
  // Prefer the persisted domain classifier; the lazy require matches how
  // this module pulls its siblings (avoids a circular top-level import).
  let isGovernanceNode: (n: { domain?: string; name?: string }) => boolean;
  try {
    isGovernanceNode = require('./process-catalog').isGovernanceNode;
  } catch {
    isGovernanceNode = (n) => /governance|data management/i.test(n?.name || '');
  }
  const hasGovernanceProcesses = orgProcesses.some((n: any) => isGovernanceNode(n));
  const hasActivePolicy = orgPolicies.some((p: any) => p.status === 'ACTIVE');
  // A completed program has, by definition, been launched — count both so a
  // program marked COMPLETED doesn't drop this check (and overall progress)
  // back below 100%.
  const programLaunched = program.status === 'ACTIVE' || program.status === 'COMPLETED';

  const phase4Checks: PhaseCheck[] = [
    { label: 'Core processes defined', done: hasGovernanceProcesses },
    { label: 'Policies activated', done: hasActivePolicy },
    { label: 'Program launched', done: programLaunched },
  ];

  function progressOf(checks: PhaseCheck[]): number {
    if (checks.length === 0) return 0;
    const done = checks.filter((c) => c.done).length;
    return Math.round((done / checks.length) * 100);
  }
  function completedAll(checks: PhaseCheck[]): boolean {
    return checks.length > 0 && checks.every((c) => c.done);
  }

  const phase1: PhaseInfo = {
    name: 'Foundation Definition',
    completed: completedAll(phase1Checks),
    progress: progressOf(phase1Checks),
    checks: phase1Checks,
  };
  const phase2: PhaseInfo = {
    name: 'Structural Design',
    completed: completedAll(phase2Checks),
    progress: progressOf(phase2Checks),
    checks: phase2Checks,
  };
  const phase3: PhaseInfo = {
    name: 'People & Processes',
    completed: completedAll(phase3Checks),
    progress: progressOf(phase3Checks),
    checks: phase3Checks,
  };
  const phase4: PhaseInfo = {
    name: 'Operationalization',
    completed: completedAll(phase4Checks),
    progress: progressOf(phase4Checks),
    checks: phase4Checks,
  };

  // Current phase = first incomplete phase; if all complete, stay at 4.
  let currentPhase: 1 | 2 | 3 | 4 = 4;
  if (!phase1.completed) currentPhase = 1;
  else if (!phase2.completed) currentPhase = 2;
  else if (!phase3.completed) currentPhase = 3;
  else currentPhase = 4;

  const allChecks = [
    ...phase1Checks,
    ...phase2Checks,
    ...phase3Checks,
    ...phase4Checks,
  ];
  const overallProgress = progressOf(allChecks);

  return {
    currentPhase,
    phases: { phase1, phase2, phase3, phase4 },
    overallProgress,
  };
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

async function computeRecommendations(program: StoredGovernanceProgram): Promise<Recommendation[]> {
  const status = await computePhaseStatus(program);
  const recs: Recommendation[] = [];

  // Phase 1
  if (!status.phases.phase1.completed) {
    for (const check of status.phases.phase1.checks) {
      if (check.done) continue;
      if (check.label === 'Scope defined') {
        recs.push({
          phase: 1,
          action: 'Define governance scope',
          link: '/governance/foundation',
          priority: 'HIGH',
        });
      } else if (check.label === 'Guiding principles established') {
        recs.push({
          phase: 1,
          action: 'Establish guiding principles',
          link: '/governance/foundation',
          priority: 'HIGH',
        });
      } else if (check.label === 'Operating model selected') {
        recs.push({
          phase: 1,
          action: 'Select an operating model',
          link: '/governance/foundation',
          priority: 'HIGH',
        });
      }
    }
    return recs;
  }

  // Phase 2
  if (!status.phases.phase2.completed) {
    for (const check of status.phases.phase2.checks) {
      if (check.done) continue;
      if (check.label === 'Data domains defined') {
        recs.push({
          phase: 2,
          action: 'Create at least one data domain',
          link: '/data-domains',
          priority: 'HIGH',
        });
      } else if (check.label === 'Governance Council established') {
        recs.push({
          phase: 2,
          action: 'Establish a Data Governance Council',
          link: '/governance-groups',
          priority: 'HIGH',
        });
      } else if (check.label === 'Governance Committee established') {
        recs.push({
          phase: 2,
          action: 'Establish a Data Governance Committee',
          link: '/governance-groups',
          priority: 'MEDIUM',
        });
      } else if (check.label === 'Governance leadership roles established') {
        recs.push({
          phase: 2,
          action: 'Assign governance leadership roles (CDO, Governance Lead) to establish the governance structure',
          link: '/dama-roles',
          priority: 'MEDIUM',
        });
      }
    }
    return recs;
  }

  // Phase 3
  if (!status.phases.phase3.completed) {
    for (const check of status.phases.phase3.checks) {
      if (check.done) continue;
      if (check.label === 'Data owners assigned') {
        recs.push({
          phase: 3,
          action: 'Assign Data Owners to be accountable for each data domain',
          link: '/dama-roles',
          priority: 'HIGH',
        });
      } else if (check.label === 'Data stewards identified') {
        recs.push({
          phase: 3,
          action: 'Assign a Business Data Steward',
          link: '/people',
          priority: 'HIGH',
        });
      } else if (check.label === 'Stewardship teams formed') {
        recs.push({
          phase: 3,
          action: 'Form a stewardship team',
          link: '/governance-groups',
          priority: 'HIGH',
        });
      } else if (check.label === 'Domain ownership assigned') {
        recs.push({
          phase: 3,
          action: 'Assign owners to every data domain',
          link: '/data-domains',
          priority: 'MEDIUM',
        });
      }
    }
    return recs;
  }

  // Phase 4
  if (!status.phases.phase4.completed) {
    for (const check of status.phases.phase4.checks) {
      if (check.done) continue;
      if (check.label === 'Core processes defined') {
        recs.push({
          phase: 4,
          action: 'Define core governance processes',
          link: '/processes',
          priority: 'HIGH',
        });
      } else if (check.label === 'Policies activated') {
        recs.push({
          phase: 4,
          action: 'Activate at least one governance policy',
          link: '/governance-policies',
          priority: 'HIGH',
        });
      } else if (check.label === 'Program launched') {
        recs.push({
          phase: 4,
          action: 'Launch the governance program (set status to ACTIVE)',
          link: '/setup',
          priority: 'HIGH',
        });
      }
    }
    return recs;
  }

  return recs;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router();

/**
 * GET /api/v1/governance-program?orgId=X
 * Returns the program for the given org. Creates a default program if none
 * exists so the UI always has something to render.
 */
router.get('/', async (req: Request, res: Response) => {
  const orgIdQuery = req.query.orgId as string | undefined;
  const orgId = orgIdQuery || DEV_ORG_ID;

  // Read through the repository so Postgres mode sees seeded/created
  // programs — the in-memory `governancePrograms` array is empty there.
  const all = await governanceProgramsRepo.list();

  // Prefer an exact-match program for this org. Fall back to org-scope
  // filter only if no direct match — programs are per-org.
  let program = all.find((p) => p.orgId === orgId);
  if (!program) {
    const scoped = filterByOrgScope(all, orgId);
    program = scoped[0];
  }

  if (!program) {
    program = buildDefaultProgram(orgId);
    await governanceProgramsRepo.create(program);
    auditService.log(orgId, null, 'GovernanceProgram', program.id, 'CREATE', null, program);
    logger.info({ programId: program.id, orgId }, 'Created default governance program');
  }

  res.json({ success: true, data: program });
});

/** PUT /api/v1/governance-program/:id — update the program */
router.put('/:id', async (req: Request, res: Response) => {
  const program = await governanceProgramsRepo.get(String(req.params.id));
  if (!program) {
    res.status(404).json({ success: false, error: 'Governance program not found' });
    return;
  }

  const before = JSON.parse(JSON.stringify(program));
  const { name, scope, principles, targetStartDate, targetLaunchDate, status } = req.body || {};

  if (name !== undefined) program.name = String(name);

  if (scope !== undefined && scope && typeof scope === 'object') {
    program.scope = {
      inScope: typeof scope.inScope === 'string' ? scope.inScope : program.scope.inScope,
      outOfScope: typeof scope.outOfScope === 'string' ? scope.outOfScope : program.scope.outOfScope,
      boundaries: typeof scope.boundaries === 'string' ? scope.boundaries : program.scope.boundaries,
      constraints: typeof scope.constraints === 'string' ? scope.constraints : program.scope.constraints,
    };
  }

  if (principles !== undefined && principles && typeof principles === 'object') {
    const nextOperatingModel: OperatingModel =
      principles.operatingModel === 'CENTRALIZED' ||
      principles.operatingModel === 'FEDERATED' ||
      principles.operatingModel === 'HYBRID' ||
      principles.operatingModel === ''
        ? principles.operatingModel
        : program.principles.operatingModel;

    program.principles = {
      vision: typeof principles.vision === 'string' ? principles.vision : program.principles.vision,
      principles: Array.isArray(principles.principles)
        ? principles.principles.filter((x: any) => typeof x === 'string')
        : program.principles.principles,
      decisionRights: typeof principles.decisionRights === 'string'
        ? principles.decisionRights
        : program.principles.decisionRights,
      operatingModel: nextOperatingModel,
    };
  }

  if (targetStartDate !== undefined) {
    program.targetStartDate = targetStartDate ? String(targetStartDate) : null;
  }
  if (targetLaunchDate !== undefined) {
    program.targetLaunchDate = targetLaunchDate ? String(targetLaunchDate) : null;
  }

  // ── Governed status transition ──────────────────────────────────────
  // Status is handled separately from the rest of the form so the role
  // gate, state machine, and launch gating only apply when the status
  // actually changes — editing scope/principles stays unrestricted.
  let statusTransition: { from: ProgramStatus; to: ProgramStatus; earlyLaunch: boolean } | null = null;

  if (status !== undefined && status !== program.status) {
    const valid: ProgramStatus[] = ['PLANNING', 'ACTIVE', 'PAUSED', 'COMPLETED'];
    if (!valid.includes(status)) {
      res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${valid.join(', ')}`,
      });
      return;
    }

    const actor = (req as AuthenticatedRequest).user;
    // Only an admin / program owner may move the program's lifecycle.
    if (!actor || !hasPermission(actor.role, 'governance:write')) {
      res.status(403).json({
        success: false,
        error: `Changing the program status requires an admin / program-owner role (your role: ${actor?.role || 'unknown'}).`,
      });
      return;
    }

    const from = program.status;
    const to = status as ProgramStatus;

    // State machine — block backwards slides and lifecycle skips.
    if (!VALID_TRANSITIONS[from].includes(to)) {
      res.status(409).json({
        success: false,
        error: `Cannot move the program from ${from} to ${to}. Allowed from ${from}: ${VALID_TRANSITIONS[from].join(', ') || 'none'}.`,
      });
      return;
    }

    let earlyLaunch = false;

    // Entering ACTIVE (launch or relaunch) is gated on phase completion.
    if (to === 'ACTIVE') {
      const phaseStatus = await computePhaseStatus(program);
      const p = phaseStatus.phases;

      // Phase 1 is a hard prerequisite — launching with no scope or
      // operating model isn't a pilot, it's empty.
      if (!p.phase1.completed) {
        const missing = p.phase1.checks.filter((c) => !c.done).map((c) => c.label);
        res.status(400).json({
          success: false,
          error: 'Phase 1 (Foundation) must be complete before the program can go active.',
          blockingPhase: 1,
          missing,
        });
        return;
      }

      const incompletePhases = [
        !p.phase2.completed ? { phase: 2, name: p.phase2.name, missing: p.phase2.checks.filter((c) => !c.done).map((c) => c.label) } : null,
        !p.phase3.completed ? { phase: 3, name: p.phase3.name, missing: p.phase3.checks.filter((c) => !c.done).map((c) => c.label) } : null,
        !p.phase4.completed ? { phase: 4, name: p.phase4.name, missing: p.phase4.checks.filter((c) => !c.done && c.label !== 'Program launched').map((c) => c.label) } : null,
      ].filter(Boolean);

      // Soft gate: phases 2–4 incomplete needs an explicit confirmation.
      // The client gets the incomplete list back so it can show exactly
      // what's missing, then re-submits with force: true.
      if (incompletePhases.length > 0 && req.body?.force !== true) {
        res.status(409).json({
          success: false,
          requiresConfirmation: true,
          error: 'The program has incomplete phases. Confirm an early launch to proceed.',
          incompletePhases,
        });
        return;
      }
      earlyLaunch = incompletePhases.length > 0;

      // Record the actual go-live the first time the program launches, and
      // never overwrite it — a later pause/resume/reopen keeps the original
      // launch date.
      if (!program.launchedAt) program.launchedAt = new Date().toISOString();
    }

    program.status = to;
    statusTransition = { from, to, earlyLaunch };
  }

  program.updatedAt = new Date().toISOString();
  await governanceProgramsRepo.update(program.id, program);

  const actorId = (req as AuthenticatedRequest).user?.sub || null;
  auditService.log(program.orgId, actorId, 'GovernanceProgram', program.id, 'UPDATE', before, program);

  // Dedicated, queryable audit entry for the lifecycle change so a
  // compliance reviewer can answer "who launched/paused/closed this and
  // when" without diffing generic UPDATE rows.
  if (statusTransition) {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    auditService.log(
      program.orgId,
      actorId,
      'GovernanceProgram',
      program.id,
      'STATUS_CHANGE',
      { status: statusTransition.from },
      {
        status: statusTransition.to,
        ...(reason ? { reason } : {}),
        ...(statusTransition.earlyLaunch ? { earlyLaunch: true } : {}),
      },
    );
    logger.info(
      { programId: program.id, from: statusTransition.from, to: statusTransition.to, by: actorId, earlyLaunch: statusTransition.earlyLaunch },
      'Governance program status changed',
    );
  } else {
    logger.info({ programId: program.id }, 'Updated governance program');
  }

  res.json({ success: true, data: program });
});

/** GET /api/v1/governance-program/:id/status — compute current phase */
router.get('/:id/status', async (req: Request, res: Response) => {
  const program = await governanceProgramsRepo.get(String(req.params.id));
  if (!program) {
    res.status(404).json({ success: false, error: 'Governance program not found' });
    return;
  }
  if (!assertOrgAccess(req, res, program.orgId, 'Governance program not found')) return;
  const status = await computePhaseStatus(program);
  res.json({ success: true, data: status });
});

/** GET /api/v1/governance-program/:id/recommendations — next-step suggestions */
router.get('/:id/recommendations', async (req: Request, res: Response) => {
  const program = await governanceProgramsRepo.get(String(req.params.id));
  if (!program) {
    res.status(404).json({ success: false, error: 'Governance program not found' });
    return;
  }
  if (!assertOrgAccess(req, res, program.orgId, 'Governance program not found')) return;
  const recommendations = await computeRecommendations(program);
  res.json({ success: true, data: recommendations });
});

export default router;
