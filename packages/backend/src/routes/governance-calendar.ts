import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { loadStore, saveStore, registerStore } from '../lib/persistence';
import { scopeListForRequest } from '../lib/tenant-scope';
import { auditService } from '../services/audit.service';
import { people } from './people';
import logger from '../lib/logger';
import { getCalendarEventsRepository } from '../db/calendar-events.repo';
import { getPeopleRepository } from '../db/people.repo';

const EVENT_TYPES = [
  'COUNCIL_MEETING',
  'COMMITTEE_MEETING',
  'STEWARDSHIP_SYNC',
  'POLICY_REVIEW',
  'MATURITY_ASSESSMENT',
  'CUSTOM',
] as const;

const CADENCES = [
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'SEMI_ANNUAL',
  'ANNUAL',
] as const;

const STATUSES = ['ACTIVE', 'PAUSED'] as const;

export interface StoredCalendarEvent {
  id: string;
  orgId: string;
  name: string;
  description: string;
  eventType: typeof EVENT_TYPES[number];
  cadence: typeof CADENCES[number];
  dayOfMonth: number | null;
  dayOfWeek: number | null;
  timeOfDay: string;
  durationMinutes: number;
  attendees: string[];
  agendaTemplate: string;
  nextOccurrence: string | null;
  lastOccurrence: string | null;
  autoCreateTasks: boolean;
  status: typeof STATUSES[number];
  createdAt: string;
  updatedAt: string;
}

export const calendarEvents: StoredCalendarEvent[] = loadStore<StoredCalendarEvent>('calendarEvents');
registerStore('calendarEvents', calendarEvents);

const calendarEventsRepo = getCalendarEventsRepository(calendarEvents);

// Lazy accessor for the foreign People store's repo. In Postgres mode the
// in-memory `people` array is empty and the Prisma repo is the source of
// truth for attendee-name resolution.
let _peopleRepo: ReturnType<typeof getPeopleRepository> | null = null;
const peopleRepo = () => (_peopleRepo ??= getPeopleRepository(people));

/** Build a personId → name lookup once per request. */
async function loadPeopleById(): Promise<Map<string, string>> {
  const allPeople = await peopleRepo().list();
  return new Map(allPeople.map((p) => [p.id, p.name]));
}

// ── Helpers ──

function computeNextOccurrence(event: Partial<StoredCalendarEvent>, from: Date = new Date()): Date {
  const next = new Date(from);
  switch (event.cadence) {
    case 'WEEKLY':
      next.setDate(next.getDate() + 7);
      break;
    case 'BIWEEKLY':
      next.setDate(next.getDate() + 14);
      break;
    case 'MONTHLY':
      next.setMonth(next.getMonth() + 1);
      break;
    case 'QUARTERLY':
      next.setMonth(next.getMonth() + 3);
      break;
    case 'SEMI_ANNUAL':
      next.setMonth(next.getMonth() + 6);
      break;
    case 'ANNUAL':
      next.setFullYear(next.getFullYear() + 1);
      break;
  }
  // If dayOfMonth is set, align to it for monthly-or-longer cadences
  if (event.dayOfMonth && ['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL'].includes(event.cadence || '')) {
    next.setDate(Math.min(event.dayOfMonth, 28));
  }
  return next;
}

function resolveAttendeeNames(ids: string[], peopleById: Map<string, string>): string[] {
  return ids
    .map((id) => peopleById.get(id))
    .filter((n): n is string => !!n);
}

function enrichEvent(event: StoredCalendarEvent, peopleById: Map<string, string>): any {
  return {
    ...event,
    attendeeNames: resolveAttendeeNames(event.attendees || [], peopleById),
  };
}

function toIsoDate(d: Date): string {
  return d.toISOString();
}

/**
 * Given a seed date and cadence, iterate forward and return all occurrences
 * falling within [from, to]. Used by the /upcoming endpoint to project out
 * multiple future occurrences (e.g. 4 weekly syncs within the next 30 days).
 */
function projectOccurrences(
  seed: Date,
  event: StoredCalendarEvent,
  from: Date,
  to: Date,
  maxCount: number = 16,
): Date[] {
  const out: Date[] = [];
  let cursor = new Date(seed);
  // Walk forward until we are within window; hard cap to avoid runaway loops.
  let guard = 0;
  while (cursor < from && guard < 500) {
    cursor = computeNextOccurrence(event, cursor);
    guard++;
  }
  while (cursor <= to && out.length < maxCount) {
    if (cursor >= from) out.push(new Date(cursor));
    cursor = computeNextOccurrence(event, cursor);
    guard++;
    if (guard > 1000) break;
  }
  return out;
}

const router = Router();

/** GET /api/v1/governance-calendar — list events */
router.get('/', async (req: Request, res: Response) => {
  const { status, eventType } = req.query;
  let filtered = scopeListForRequest(req, await calendarEventsRepo.list());
  if (status) filtered = filtered.filter((e) => e.status === status);
  if (eventType) filtered = filtered.filter((e) => e.eventType === eventType);

  const peopleById = await loadPeopleById();
  res.json({ success: true, data: filtered.map((e) => enrichEvent(e, peopleById)) });
});

/** GET /api/v1/governance-calendar/upcoming?orgId=X&days=30 */
router.get('/upcoming', async (req: Request, res: Response) => {
  const days = Math.max(1, parseInt((req.query.days as string) || '30', 10));
  const now = new Date();
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + days);

  const events = scopeListForRequest(req, await calendarEventsRepo.list())
    .filter((e) => e.status === 'ACTIVE');

  const peopleById = await loadPeopleById();

  type UpcomingOccurrence = {
    eventId: string;
    name: string;
    description: string;
    eventType: string;
    cadence: string;
    durationMinutes: number;
    timeOfDay: string;
    occursAt: string;
    daysAway: number;
    attendeeNames: string[];
  };

  const occurrences: UpcomingOccurrence[] = [];

  for (const e of events) {
    // Determine seed — use stored nextOccurrence if present & valid; otherwise
    // compute from "now" so freshly-created events project forward sanely.
    let seed: Date;
    if (e.nextOccurrence) {
      const parsed = new Date(e.nextOccurrence);
      seed = isNaN(parsed.getTime()) ? computeNextOccurrence(e, now) : parsed;
    } else {
      seed = computeNextOccurrence(e, now);
    }

    const projected = projectOccurrences(seed, e, now, windowEnd);
    for (const occ of projected) {
      const daysAway = Math.round((occ.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      occurrences.push({
        eventId: e.id,
        name: e.name,
        description: e.description,
        eventType: e.eventType,
        cadence: e.cadence,
        durationMinutes: e.durationMinutes,
        timeOfDay: e.timeOfDay,
        occursAt: toIsoDate(occ),
        daysAway,
        attendeeNames: resolveAttendeeNames(e.attendees || [], peopleById),
      });
    }
  }

  occurrences.sort((a, b) => a.occursAt.localeCompare(b.occursAt));

  res.json({ success: true, data: occurrences });
});

/** POST /api/v1/governance-calendar — create event */
router.post('/', async (req: Request, res: Response) => {
  const {
    orgId, name, description, eventType, cadence,
    dayOfMonth, dayOfWeek, timeOfDay, durationMinutes,
    attendees, agendaTemplate, autoCreateTasks, status,
  } = req.body;

  if (!orgId) { res.status(400).json({ success: false, error: 'orgId is required' }); return; }
  if (!name) { res.status(400).json({ success: false, error: 'Name is required' }); return; }
  if (eventType && !EVENT_TYPES.includes(eventType)) {
    res.status(400).json({ success: false, error: `Invalid eventType. Must be one of: ${EVENT_TYPES.join(', ')}` });
    return;
  }
  if (cadence && !CADENCES.includes(cadence)) {
    res.status(400).json({ success: false, error: `Invalid cadence. Must be one of: ${CADENCES.join(', ')}` });
    return;
  }
  if (status && !STATUSES.includes(status)) {
    res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${STATUSES.join(', ')}` });
    return;
  }

  const now = new Date();
  const partial: Partial<StoredCalendarEvent> = {
    cadence: cadence || 'MONTHLY',
    dayOfMonth: typeof dayOfMonth === 'number' ? dayOfMonth : null,
  };
  const nextOcc = computeNextOccurrence(partial, now);

  const event: StoredCalendarEvent = {
    id: uuid(),
    orgId,
    name,
    description: description || '',
    eventType: eventType || 'CUSTOM',
    cadence: cadence || 'MONTHLY',
    dayOfMonth: typeof dayOfMonth === 'number' ? dayOfMonth : null,
    dayOfWeek: typeof dayOfWeek === 'number' ? dayOfWeek : null,
    timeOfDay: timeOfDay || '09:00',
    durationMinutes: typeof durationMinutes === 'number' ? durationMinutes : 60,
    attendees: Array.isArray(attendees) ? attendees : [],
    agendaTemplate: agendaTemplate || '',
    nextOccurrence: toIsoDate(nextOcc),
    lastOccurrence: null,
    autoCreateTasks: !!autoCreateTasks,
    status: status || 'ACTIVE',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  await calendarEventsRepo.create(event);
  auditService.log(event.orgId, null, 'CalendarEvent', event.id, 'CREATE', null, event);
  logger.info({ eventId: event.id, name: event.name, cadence: event.cadence }, 'Created calendar event');
  res.status(201).json({ success: true, data: enrichEvent(event, await loadPeopleById()) });
});

/** PUT /api/v1/governance-calendar/:id — update event */
router.put('/:id', async (req: Request, res: Response) => {
  const event = await calendarEventsRepo.get(String(req.params.id));
  if (!event) { res.status(404).json({ success: false, error: 'Calendar event not found' }); return; }

  const before = { ...event };
  const {
    name, description, eventType, cadence,
    dayOfMonth, dayOfWeek, timeOfDay, durationMinutes,
    attendees, agendaTemplate, autoCreateTasks, status, nextOccurrence,
  } = req.body;

  if (eventType !== undefined) {
    if (!EVENT_TYPES.includes(eventType)) {
      res.status(400).json({ success: false, error: `Invalid eventType` });
      return;
    }
    event.eventType = eventType;
  }
  if (cadence !== undefined) {
    if (!CADENCES.includes(cadence)) {
      res.status(400).json({ success: false, error: `Invalid cadence` });
      return;
    }
    event.cadence = cadence;
  }
  if (status !== undefined) {
    if (!STATUSES.includes(status)) {
      res.status(400).json({ success: false, error: `Invalid status` });
      return;
    }
    event.status = status;
  }

  if (name !== undefined) event.name = name;
  if (description !== undefined) event.description = description;
  if (dayOfMonth !== undefined) event.dayOfMonth = dayOfMonth;
  if (dayOfWeek !== undefined) event.dayOfWeek = dayOfWeek;
  if (timeOfDay !== undefined) event.timeOfDay = timeOfDay;
  if (durationMinutes !== undefined) event.durationMinutes = durationMinutes;
  if (attendees !== undefined) event.attendees = Array.isArray(attendees) ? attendees : [];
  if (agendaTemplate !== undefined) event.agendaTemplate = agendaTemplate;
  if (autoCreateTasks !== undefined) event.autoCreateTasks = !!autoCreateTasks;
  if (nextOccurrence !== undefined) event.nextOccurrence = nextOccurrence;

  // If cadence or dayOfMonth changed and caller didn't override nextOccurrence,
  // recompute so the projection stays consistent.
  if (
    nextOccurrence === undefined &&
    (cadence !== undefined || dayOfMonth !== undefined)
  ) {
    event.nextOccurrence = toIsoDate(computeNextOccurrence(event, new Date()));
  }

  event.updatedAt = new Date().toISOString();
  await calendarEventsRepo.update(event.id, event);
  auditService.log(event.orgId, null, 'CalendarEvent', event.id, 'UPDATE', before, event);
  res.json({ success: true, data: enrichEvent(event, await loadPeopleById()) });
});

/** DELETE /api/v1/governance-calendar/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  const removed = await calendarEventsRepo.get(String(req.params.id));
  if (!removed) { res.status(404).json({ success: false, error: 'Calendar event not found' }); return; }
  auditService.log(removed.orgId, null, 'CalendarEvent', removed.id, 'DELETE', removed, null);
  await calendarEventsRepo.delete(removed.id);
  logger.info({ eventId: removed.id, name: removed.name }, 'Deleted calendar event');
  res.status(204).send();
});

/**
 * POST /api/v1/governance-calendar/:id/run — record this occurrence, advance
 * nextOccurrence, and optionally create a governance task per attendee.
 */
router.post('/:id/run', async (req: Request, res: Response) => {
  const event = await calendarEventsRepo.get(String(req.params.id));
  if (!event) { res.status(404).json({ success: false, error: 'Calendar event not found' }); return; }

  const before = { ...event };
  const now = new Date();

  // Advance the schedule
  const baseForNext = event.nextOccurrence ? new Date(event.nextOccurrence) : now;
  event.lastOccurrence = now.toISOString();
  event.nextOccurrence = toIsoDate(computeNextOccurrence(event, baseForNext));
  event.updatedAt = now.toISOString();

  // Optionally spawn governance tasks for attendees. Loaded at runtime to
  // avoid circular imports with the tasks router.
  let createdTaskIds: string[] = [];
  if (event.autoCreateTasks) {
    try {
      const { governanceTasks } = require('./governance-tasks');
      const { getGovernanceTasksRepository } = require('../db/governance-tasks.repo');
      const governanceTasksRepo = getGovernanceTasksRepository(governanceTasks);
      const dueDate = new Date(event.nextOccurrence || now);
      const assignees = event.attendees && event.attendees.length > 0 ? event.attendees : [null];
      for (const assigneeId of assignees) {
        const task: any = {
          id: uuid(),
          orgId: event.orgId,
          title: `${event.name} — prep & follow-up`,
          description: event.agendaTemplate || event.description || '',
          taskType: 'REVIEW',
          status: 'OPEN',
          priority: 'MEDIUM',
          assigneeId: assigneeId || null,
          dueDate: dueDate.toISOString().slice(0, 10),
          linkedObjectType: 'CalendarEvent',
          linkedObjectId: event.id,
          automationMode: 'HUMAN',
          createdBy: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          completedAt: null,
        };
        await governanceTasksRepo.create(task);
        createdTaskIds.push(task.id);
      }
    } catch (err) {
      logger.warn({ err }, 'Could not auto-create governance tasks for calendar event run');
    }
  }

  await calendarEventsRepo.update(event.id, event);
  auditService.log(event.orgId, null, 'CalendarEvent', event.id, 'RUN', before, event);
  logger.info({ eventId: event.id, name: event.name, createdTaskIds }, 'Ran calendar event occurrence');

  res.json({
    success: true,
    data: {
      event: enrichEvent(event, await loadPeopleById()),
      createdTaskIds,
    },
  });
});

/**
 * POST /api/v1/governance-calendar/seed — create the standard set of events
 * for an org if not already present. Idempotent per-event by name+orgId.
 */
router.post('/seed', async (req: Request, res: Response) => {
  const { orgId } = req.body;
  if (!orgId) { res.status(400).json({ success: false, error: 'orgId is required' }); return; }

  const standard: Array<Partial<StoredCalendarEvent> & { name: string }> = [
    {
      name: 'Data Governance Council',
      description: 'Executive-level council that sets governance direction and reviews program health.',
      eventType: 'COUNCIL_MEETING',
      cadence: 'QUARTERLY',
      durationMinutes: 120,
      agendaTemplate: '1. Program status\n2. Policy decisions\n3. Risks & escalations\n4. Investments',
    },
    {
      name: 'Data Governance Committee',
      description: 'Working committee driving day-to-day governance operations.',
      eventType: 'COMMITTEE_MEETING',
      cadence: 'MONTHLY',
      durationMinutes: 60,
      agendaTemplate: '1. Open items\n2. New policies / controls\n3. Issues & remediation\n4. Metrics review',
    },
    {
      name: 'Stewardship Team Sync',
      description: 'Recurring sync for data stewards to align on issues and progress.',
      eventType: 'STEWARDSHIP_SYNC',
      cadence: 'BIWEEKLY',
      durationMinutes: 30,
      agendaTemplate: '1. Active issues\n2. Data quality findings\n3. Asset updates\n4. Blockers',
    },
    {
      name: 'Quarterly Maturity Review',
      description: 'Assess governance program maturity and set next-quarter targets.',
      eventType: 'MATURITY_ASSESSMENT',
      cadence: 'QUARTERLY',
      durationMinutes: 90,
      agendaTemplate: '1. Maturity scorecard\n2. Capability gaps\n3. Quarter plan\n4. Owner assignments',
    },
  ];

  const now = new Date();
  const created: StoredCalendarEvent[] = [];
  const skipped: string[] = [];

  const existingEvents = await calendarEventsRepo.list();

  for (const tmpl of standard) {
    const exists = existingEvents.some(
      (e) => e.orgId === orgId && e.name.toLowerCase() === tmpl.name.toLowerCase(),
    );
    if (exists) { skipped.push(tmpl.name); continue; }

    const nextOcc = computeNextOccurrence({ cadence: tmpl.cadence, dayOfMonth: null }, now);
    const event: StoredCalendarEvent = {
      id: uuid(),
      orgId,
      name: tmpl.name,
      description: tmpl.description || '',
      eventType: tmpl.eventType || 'CUSTOM',
      cadence: tmpl.cadence || 'MONTHLY',
      dayOfMonth: null,
      dayOfWeek: null,
      timeOfDay: '14:00',
      durationMinutes: tmpl.durationMinutes || 60,
      attendees: [],
      agendaTemplate: tmpl.agendaTemplate || '',
      nextOccurrence: toIsoDate(nextOcc),
      lastOccurrence: null,
      autoCreateTasks: false,
      status: 'ACTIVE',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await calendarEventsRepo.create(event);
    created.push(event);
    auditService.log(event.orgId, null, 'CalendarEvent', event.id, 'CREATE', null, event);
  }

  logger.info({ orgId, createdCount: created.length, skippedCount: skipped.length }, 'Seeded calendar events');

  const peopleById = await loadPeopleById();
  res.json({
    success: true,
    data: {
      created: created.map((e) => enrichEvent(e, peopleById)),
      skipped,
    },
  });
});

export default router;
