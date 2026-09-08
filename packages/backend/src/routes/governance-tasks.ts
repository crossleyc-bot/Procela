import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { auditService } from '../services/audit.service';
import { loadStore, registerStore } from '../lib/persistence';
import { scopeListForRequest, assertOrgAccess } from '../lib/tenant-scope';
import { people } from './people';
import { createNotification } from './notifications';
import logger from '../lib/logger';
import { getGovernanceTasksRepository } from '../db/governance-tasks.repo';
import { getPeopleRepository } from '../db/people.repo';

const TASK_TYPES = [
  'STEWARDSHIP',
  'REVIEW',
  'APPROVAL',
  'REMEDIATION',
  'CLASSIFICATION',
  'METADATA',
  'GENERAL',
] as const;

const TASK_STATUSES = [
  'DRAFT',
  'OPEN',
  'IN_PROGRESS',
  'PENDING_REVIEW',
  'PENDING_APPROVAL',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
] as const;

const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

const AUTOMATION_MODES = ['HUMAN', 'AGENT', 'HYBRID'] as const;

// Valid status transitions — keys are current status, values are allowed next statuses
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['OPEN'],
  OPEN: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['PENDING_REVIEW', 'PENDING_APPROVAL', 'COMPLETED', 'CANCELLED'],
  PENDING_REVIEW: ['IN_PROGRESS', 'COMPLETED', 'REJECTED'],
  PENDING_APPROVAL: ['COMPLETED', 'REJECTED', 'IN_PROGRESS'],
  COMPLETED: [],
  REJECTED: ['OPEN', 'CANCELLED'],
  CANCELLED: [],
};

export interface StoredGovernanceTask {
  id: string;
  orgId: string;
  title: string;
  description: string;
  taskType: typeof TASK_TYPES[number];
  status: typeof TASK_STATUSES[number];
  priority: typeof TASK_PRIORITIES[number];
  assigneeId: string | null;
  dueDate: string | null;
  linkedObjectType: string | null;
  linkedObjectId: string | null;
  automationMode: typeof AUTOMATION_MODES[number];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** ISO timestamp of the most recent overdue notification the sweep
   *  fired for this task. Used to dedupe: sweep only fires a new
   *  notification when overdueNotifiedAt is missing OR older than the
   *  task's dueDate (i.e. the due date was pushed forward and the row
   *  became overdue again). Cleared on completion / cancel so a
   *  reopened task can re-fire. */
  overdueNotifiedAt?: string | null;
}

// Shape validator applied by loadStore — a row missing a required
// field (drift after a rename / migration / hand-edit) is quarantined
// and logged rather than crashing at first mutation. Kept in this
// module because the interface + enums are already declared here.
const governanceTaskRowSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  title: z.string(),
  description: z.string(),
  taskType: z.enum(TASK_TYPES),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  assigneeId: z.string().nullable(),
  dueDate: z.string().nullable(),
  linkedObjectType: z.string().nullable(),
  linkedObjectId: z.string().nullable(),
  automationMode: z.enum(AUTOMATION_MODES),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  overdueNotifiedAt: z.string().nullable().optional(),
}) satisfies z.ZodType<StoredGovernanceTask>;

export const governanceTasks: StoredGovernanceTask[] = loadStore<StoredGovernanceTask>('governanceTasks', governanceTaskRowSchema);
registerStore('governanceTasks', governanceTasks);

const governanceTasksRepo = getGovernanceTasksRepository(governanceTasks);

// people is a foreign store — lazy repo (cycle-safe) for assignee enrichment.
let _peopleRepo: ReturnType<typeof getPeopleRepository> | null = null;
const peopleRepo = () => (_peopleRepo ??= getPeopleRepository(people));

// Request-body schemas — Zod at the API boundary. Enum checks + type
// guarantees fall out of the parse so downstream code can drop the
// `.includes(x as any)` runtime checks and use the typed body directly.
const createTaskBodySchema = z.object({
  title: z.string().min(1, 'title is required'),
  orgId: z.string().min(1, 'orgId is required'),
  description: z.string().optional(),
  taskType: z.enum(TASK_TYPES).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  linkedObjectType: z.string().nullable().optional(),
  linkedObjectId: z.string().nullable().optional(),
  automationMode: z.enum(AUTOMATION_MODES).optional(),
  createdBy: z.string().nullable().optional(),
});
const updateTaskBodySchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  taskType: z.enum(TASK_TYPES).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  linkedObjectType: z.string().nullable().optional(),
  linkedObjectId: z.string().nullable().optional(),
  automationMode: z.enum(AUTOMATION_MODES).optional(),
});

function enrichTask(
  task: StoredGovernanceTask,
  allPeople: typeof people,
): StoredGovernanceTask & { assigneeName: string | null } {
  const assignee = task.assigneeId ? allPeople.find((p) => p.id === task.assigneeId) : null;
  return {
    ...task,
    assigneeName: assignee?.name || null,
  };
}

/**
 * Overdue-task sweep. Scans OPEN + IN_PROGRESS + PENDING_APPROVAL
 * tasks in scope, notifies the assignee (or org-wide when the task
 * is unassigned) for each task whose dueDate has slipped and hasn't
 * already been notified for this cycle.
 *
 * Idempotency: overdueNotifiedAt is stamped on the task after a fire.
 * A second sweep skips the row unless overdueNotifiedAt < dueDate —
 * which happens when the reviewer pushed the due date forward and
 * missed the new one too. Completing or cancelling the task should
 * clear overdueNotifiedAt so a reopened task can re-fire (handled in
 * the status branches below).
 *
 * Optional orgId param scopes the sweep; omit to sweep every org.
 * Returns the ids of the tasks that fired so a caller (or the
 * scheduler) can log the result.
 */
const ACTIVE_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'PENDING_APPROVAL']);

export async function sweepOverdueTasks(scopeOrgId?: string): Promise<{ fired: string[] }> {
  const now = Date.now();
  const fired: string[] = [];
  const allTasks = await governanceTasksRepo.list();
  for (const task of allTasks) {
    if (scopeOrgId && task.orgId !== scopeOrgId) continue;
    if (!ACTIVE_STATUSES.has(task.status)) continue;
    if (!task.dueDate) continue;
    const due = new Date(task.dueDate).getTime();
    if (Number.isNaN(due) || due >= now) continue;
    // Idempotent: skip if we already notified since the current
    // due date was set. A pushed-forward dueDate re-arms the fire.
    if (task.overdueNotifiedAt) {
      const notifiedAt = new Date(task.overdueNotifiedAt).getTime();
      if (!Number.isNaN(notifiedAt) && notifiedAt >= due) continue;
    }
    const daysOverdue = Math.floor((now - due) / (24 * 60 * 60 * 1000));
    const suffix = daysOverdue === 0 ? 'today' : daysOverdue === 1 ? '1 day ago' : `${daysOverdue} days ago`;
    createNotification({
      orgId: task.orgId,
      userId: task.assigneeId || null,
      type: 'WARNING',
      title: `Task overdue: ${task.title}`,
      message: `Due ${suffix}. Update the status or push the due date if it's still in flight.`,
      link: `/governance-work?tab=tasks&id=${task.id}`,
    });
    task.overdueNotifiedAt = new Date().toISOString();
    task.updatedAt = task.overdueNotifiedAt;
    await governanceTasksRepo.update(task.id, {
      overdueNotifiedAt: task.overdueNotifiedAt,
      updatedAt: task.updatedAt,
    });
    fired.push(task.id);
  }
  if (fired.length > 0) {
    logger.info({ scopeOrgId, count: fired.length }, 'Overdue task sweep fired');
  }
  return { fired };
}

const router = Router();

/** POST /api/v1/governance-tasks/sweep-overdue?orgId=... — trigger the
 *  overdue sweep manually. The scheduler in index.ts calls the same
 *  function on a timer; this route exists so an admin (or a test) can
 *  drive the flow synchronously. */
router.post('/sweep-overdue', async (req: Request, res: Response) => {
  const orgId = ((req.query.orgId as string) || '').trim() || undefined;
  const result = await sweepOverdueTasks(orgId);
  res.json({ success: true, data: result });
});

/** GET /api/v1/governance-tasks/summary */
router.get('/summary', async (req: Request, res: Response) => {
  const filtered = scopeListForRequest(req, await governanceTasksRepo.list());

  const byStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};

  for (const s of TASK_STATUSES) byStatus[s] = 0;
  for (const p of TASK_PRIORITIES) byPriority[p] = 0;

  for (const task of filtered) {
    byStatus[task.status] = (byStatus[task.status] || 0) + 1;
    byPriority[task.priority] = (byPriority[task.priority] || 0) + 1;
  }

  res.json({
    success: true,
    data: { total: filtered.length, byStatus, byPriority },
  });
});

/** GET /api/v1/governance-tasks */
router.get('/', async (req: Request, res: Response) => {
  const { status, assigneeId, taskType, priority } = req.query;
  let filtered = scopeListForRequest(req, await governanceTasksRepo.list());

  if (status) filtered = filtered.filter((t) => t.status === status);
  if (assigneeId) filtered = filtered.filter((t) => t.assigneeId === assigneeId);
  if (taskType) filtered = filtered.filter((t) => t.taskType === taskType);
  if (priority) filtered = filtered.filter((t) => t.priority === priority);

  const allPeople = await peopleRepo().list();
  res.json({ success: true, data: filtered.map((t) => enrichTask(t, allPeople)) });
});

/** GET /api/v1/governance-tasks/:id */
router.get('/:id', async (req: Request, res: Response) => {
  const task = await governanceTasksRepo.get(String(req.params.id));
  if (!task) { res.status(404).json({ success: false, error: 'Governance task not found' }); return; }
  if (!assertOrgAccess(req, res, task.orgId, 'Governance task not found')) return;
  res.json({ success: true, data: enrichTask(task, await peopleRepo().list()) });
});

/** POST /api/v1/governance-tasks */
router.post('/', async (req: Request, res: Response) => {
  const parsed = createTaskBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const body = parsed.data;

  const now = new Date().toISOString();
  const resolvedStatus = body.status || 'OPEN';
  const task: StoredGovernanceTask = {
    id: uuid(),
    orgId: body.orgId,
    title: body.title,
    description: body.description || '',
    taskType: body.taskType || 'GENERAL',
    status: resolvedStatus,
    priority: body.priority || 'MEDIUM',
    assigneeId: body.assigneeId || null,
    dueDate: body.dueDate || null,
    linkedObjectType: body.linkedObjectType || null,
    linkedObjectId: body.linkedObjectId || null,
    automationMode: body.automationMode || 'HUMAN',
    createdBy: body.createdBy || null,
    createdAt: now,
    updatedAt: now,
    completedAt: resolvedStatus === 'COMPLETED' ? now : null,
  };

  await governanceTasksRepo.create(task);
  auditService.log(task.orgId, null, 'GovernanceTask', task.id, 'CREATE', null, task);
  logger.info({ taskId: task.id, title: task.title, taskType: task.taskType }, 'Created governance task');
  res.status(201).json({ success: true, data: enrichTask(task, await peopleRepo().list()) });
});

/** PUT /api/v1/governance-tasks/:id */
router.put('/:id', async (req: Request, res: Response) => {
  const task = await governanceTasksRepo.get(String(req.params.id));
  if (!task) { res.status(404).json({ success: false, error: 'Governance task not found' }); return; }

  const parsed = updateTaskBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ success: false, error: first?.message || 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const body = parsed.data;

  const before = { ...task };
  const {
    title, description, taskType, status, priority,
    assigneeId, dueDate, linkedObjectType, linkedObjectId,
    automationMode,
  } = body;

  // Validate status transition
  if (status !== undefined && status !== task.status) {
    const allowed = VALID_TRANSITIONS[task.status] || [];
    if (!allowed.includes(status)) {
      res.status(400).json({
        success: false,
        error: `Invalid status transition from ${task.status} to ${status}. Allowed transitions: ${allowed.length > 0 ? allowed.join(', ') : 'none (terminal state)'}`,
      });
      return;
    }
  }

  if (taskType !== undefined) task.taskType = taskType;
  if (priority !== undefined) task.priority = priority;
  if (automationMode !== undefined) task.automationMode = automationMode;

  if (title !== undefined) task.title = title;
  if (description !== undefined) task.description = description;
  if (assigneeId !== undefined) task.assigneeId = assigneeId;
  if (dueDate !== undefined) task.dueDate = dueDate;
  if (linkedObjectType !== undefined) task.linkedObjectType = linkedObjectType;
  if (linkedObjectId !== undefined) task.linkedObjectId = linkedObjectId;

  // Apply status last so completedAt logic runs after all other fields
  if (status !== undefined) {
    task.status = status;
    if (status === 'COMPLETED' && !task.completedAt) {
      task.completedAt = new Date().toISOString();
    }
    // Clear the overdue-notified marker on terminal or reopen
    // transitions so a reopened task can re-fire the sweep on its
    // next due date. Also cleared when the due date itself changes
    // below.
    if (status === 'COMPLETED' || status === 'CANCELLED' || status === 'OPEN') {
      task.overdueNotifiedAt = null;
    }
  }
  // A pushed-forward due date re-arms the fire even without a status
  // change. Clear the marker so the sweep considers this row again.
  if (dueDate !== undefined && dueDate !== before.dueDate) {
    task.overdueNotifiedAt = null;
  }

  task.updatedAt = new Date().toISOString();
  await governanceTasksRepo.update(task.id, task);
  auditService.log(task.orgId, null, 'GovernanceTask', task.id, 'UPDATE', before, task);
  logger.info({ taskId: task.id, title: task.title }, 'Updated governance task');
  res.json({ success: true, data: enrichTask(task, await peopleRepo().list()) });
});

/** DELETE /api/v1/governance-tasks/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  const removed = await governanceTasksRepo.get(String(req.params.id));
  if (!removed) { res.status(404).json({ success: false, error: 'Governance task not found' }); return; }
  auditService.log(removed.orgId, null, 'GovernanceTask', removed.id, 'DELETE', removed, null);
  await governanceTasksRepo.delete(removed.id);
  logger.info({ taskId: removed.id, title: removed.title }, 'Deleted governance task');
  res.status(204).send();
});

export default router;
