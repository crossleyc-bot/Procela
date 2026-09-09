// Weekly digest — proactive notifications driven by week-over-week
// movement in the gap signals the Dashboard already shows.
//
// The Dashboard answers "what's broken right now"; this service
// answers "what changed since last week" so a process owner finds
// new orphans, dropped coverage, or owner-vacancies in the
// notifications bell rather than discovering them by accident.
//
// Mechanics:
//   1. takeGapSnapshot(orgId) computes the same gap counts the
//      dashboard /stats endpoint surfaces and persists one row to
//      gapSnapshots. Idempotent at the call-site level — taking
//      two snapshots in the same minute is allowed and intentional
//      (lets the test suite simulate a week passing without time
//      mocking).
//   2. digestForOrg(orgId) takes a snapshot, finds the immediately
//      previous snapshot for the same org, runs the diff rules
//      below, and writes one notification per meaningful delta via
//      the standard notifications surface so the bell + dropdown UI
//      pick them up automatically.
//
// Diff rules. Each rule looks at one metric and fires when a
// threshold is crossed. Thresholds are conservative — small
// week-over-week noise (one orphan promoted, one mapping created)
// shouldn't ping anyone.
//
// Where it runs. For the prototype this is fired manually via
// POST /digest/run?orgId=X. A scheduled job (Sunday 23:59 UTC) is
// the obvious next step — the function is already side-effect-only,
// so a cron caller is one line.

import { v4 as uuid } from 'uuid';
import { loadStore, registerStore } from '../lib/persistence';
import { getGapSnapshotsRepository } from '../db/gap-snapshots.repo';
import { createNotification } from '../routes/notifications';
import { isConfigured as isMailConfigured, sendDigestEmail } from './mail.service';
import { listPreferencesForOrg, type DigestCategory } from './digest-preferences';
import logger from '../lib/logger';

export interface GapMetrics {
  /** Activities in the catalog for this org. */
  activities: number;
  /** Activities that have at least one data-asset mapping. */
  mappedActivities: number;
  /** mappedActivities / activities, rounded to nearest integer
   *  percent. Zero when there are no activities yet. */
  coveragePct: number;
  /** Data assets with zero mapping rows pointing at them. */
  orphanAssets: number;
  /** Bronze/uncertified assets that are mapped to a step — the
   *  ungoverned-and-in-use signal the Dashboard surfaces. */
  ungovernedAssets: number;
  /** Value streams + processes with no ownerId. */
  ownerlessItems: number;
}

export interface GapSnapshot {
  id: string;
  orgId: string;
  takenAt: string;
  metrics: GapMetrics;
}

export const gapSnapshots: GapSnapshot[] = loadStore<GapSnapshot>('gapSnapshots');
registerStore('gapSnapshots', gapSnapshots);

// Snapshots persist through the repository (Postgres when DATABASE_URL is set,
// the in-memory array otherwise). list() returns insertion order in both modes
// (array order in JSON; ORDER BY takenAt in Postgres), which findPreviousSnapshot
// relies on. See docs/POSTGRES_CUTOVER_PLAN.md (PR 6).
const gapSnapshotsRepo = getGapSnapshotsRepository(gapSnapshots);

/** Compute the current metrics for an org. Caller supplies the
 *  required stores by injection rather than importing them so this
 *  service stays free of cross-route dependencies. */
export interface DigestInputs {
  processNodes: ReadonlyArray<{ orgId: string; orgIds?: string[]; level: string; ownerId: string | null; id: string }>;
  dataAssets: ReadonlyArray<{ orgId: string; id: string; governanceTier?: string }>;
  mappings: ReadonlyArray<{ orgId: string; processStepId: string; dataAssetId?: string }>;
}

export function computeMetrics(orgId: string, inputs: DigestInputs): GapMetrics {
  const inOrg = (n: { orgId: string; orgIds?: string[] }) =>
    n.orgId === orgId || (n.orgIds || []).includes(orgId);
  const orgNodes = inputs.processNodes.filter(inOrg);
  const orgAssets = inputs.dataAssets.filter((a) => a.orgId === orgId);
  const orgMaps = inputs.mappings.filter((m) => m.orgId === orgId);

  const activities = orgNodes.filter((n) => n.level === 'ACTIVITY');
  const mappedActivityIds = new Set(orgMaps.map((m) => m.processStepId));
  const mappedActivities = activities.filter((a) => mappedActivityIds.has(a.id)).length;
  const coveragePct = activities.length > 0
    ? Math.round((mappedActivities / activities.length) * 100)
    : 0;

  const mappedAssetIds = new Set(orgMaps.filter((m) => m.dataAssetId).map((m) => m.dataAssetId));
  const orphanAssets = orgAssets.filter((a) => !mappedAssetIds.has(a.id)).length;
  const ungovernedAssets = orgAssets.filter(
    (a) => a.governanceTier === 'BRONZE' && mappedAssetIds.has(a.id),
  ).length;
  const ownerlessItems = orgNodes.filter(
    (n) => (n.level === 'VALUE_STREAM' || n.level === 'PROCESS') && !n.ownerId,
  ).length;

  return {
    activities: activities.length,
    mappedActivities,
    coveragePct,
    orphanAssets,
    ungovernedAssets,
    ownerlessItems,
  };
}

/** Take and persist a snapshot. Returns the persisted row so callers
 *  that need to chain a digestForOrg() can read it back without a
 *  follow-up query. */
export async function takeGapSnapshot(orgId: string, inputs: DigestInputs): Promise<GapSnapshot> {
  const snap: GapSnapshot = {
    id: uuid(),
    orgId,
    takenAt: new Date().toISOString(),
    metrics: computeMetrics(orgId, inputs),
  };
  await gapSnapshotsRepo.create(snap);
  return snap;
}

/** Return the previous snapshot for an org (the one taken just
 *  before `current`). Walks the persisted array backwards from
 *  `current`'s index — that order is push-order, which we never
 *  reorder, so it's the source of truth for sequence. Using
 *  takenAt alone breaks down when two snapshots are taken inside
 *  the same millisecond (test suites, rapid manual triggers). */
async function findPreviousSnapshot(orgId: string, current: GapSnapshot): Promise<GapSnapshot | undefined> {
  const all = await gapSnapshotsRepo.list();
  const currentIdx = all.findIndex((s) => s.id === current.id);
  if (currentIdx <= 0) return undefined;
  for (let i = currentIdx - 1; i >= 0; i--) {
    if (all[i].orgId === orgId) return all[i];
  }
  return undefined;
}

interface FiredItem {
  /** Which gap-signal this item belongs to — drives per-user email
   *  category filtering (see services/digest-preferences). */
  category: DigestCategory;
  type: 'INFO' | 'WARNING' | 'ACTION';
  title: string;
  message: string;
  link: string;
}

interface DigestRule {
  /** Returns the notification body to write, or null if the rule
   *  doesn't fire on this delta. */
  evaluate(prev: GapMetrics, curr: GapMetrics): null | FiredItem;
}

const ORPHAN_THRESHOLD = 3;
const COVERAGE_DROP_PP = 5;
const UNGOVERNED_THRESHOLD = 3;
const OWNERLESS_THRESHOLD = 1;

const RULES: DigestRule[] = [
  // New orphan assets — the user added or had data assets fall out
  // of all mappings since last week. Worth surfacing because orphans
  // accumulate quietly otherwise.
  {
    evaluate(prev, curr) {
      const delta = curr.orphanAssets - prev.orphanAssets;
      if (delta < ORPHAN_THRESHOLD) return null;
      return {
        category: 'orphans',
        type: 'WARNING',
        title: `${delta} new orphan data assets this week`,
        message: `${delta} more assets aren't referenced by any process step (now ${curr.orphanAssets} total). Review them via the Unmapped filter on Data Assets.`,
        link: '/data-assets?mapping=unmapped',
      };
    },
  },
  // Coverage trending down. Five percentage points week-over-week
  // is a meaningful drop on a settled catalog.
  {
    evaluate(prev, curr) {
      const drop = prev.coveragePct - curr.coveragePct;
      if (drop < COVERAGE_DROP_PP) return null;
      return {
        category: 'coverage',
        type: 'WARNING',
        title: `Mapping coverage dropped to ${curr.coveragePct}%`,
        message: `Was ${prev.coveragePct}% last week, now ${curr.coveragePct}%. ${curr.activities - curr.mappedActivities} of ${curr.activities} activities have no data mapped.`,
        link: '/processes/data-map',
      };
    },
  },
  // Ungoverned-but-in-use assets — a Bronze/uncertified asset
  // newly mapped to a critical step is a governance gap.
  {
    evaluate(prev, curr) {
      const delta = curr.ungovernedAssets - prev.ungovernedAssets;
      if (delta < UNGOVERNED_THRESHOLD) return null;
      return {
        category: 'ungoverned',
        type: 'WARNING',
        title: `${delta} new ungoverned assets in use`,
        message: `${delta} Bronze-tier assets gained a process mapping this week (now ${curr.ungovernedAssets} total). Promote their tier or assign a steward.`,
        link: '/data-assets',
      };
    },
  },
  // Value streams / processes with no owner — even one shouldn't
  // sit. The threshold-of-1 makes this almost a tripwire.
  {
    evaluate(prev, curr) {
      const delta = curr.ownerlessItems - prev.ownerlessItems;
      if (delta < OWNERLESS_THRESHOLD) return null;
      return {
        category: 'ownerless',
        type: 'ACTION',
        title: `${delta} new ownerless process${delta === 1 ? '' : 'es'}`,
        message: `New value stream(s) or process(es) were created this week without an assigned owner. ${curr.ownerlessItems} total need an owner.`,
        link: '/processes',
      };
    },
  },
];

/** Take a snapshot, diff it against the previous one, write a
 *  notification per rule that fired, and return the list of created
 *  notifications. When there's no prior snapshot, this is the first
 *  digest for the org — record the baseline and skip the diff. */
export interface DigestResult {
  snapshot: GapSnapshot;
  notifications: ReturnType<typeof createNotification>[];
  baseline: boolean;
  /** How many users the digest was emailed to (0 when SMTP is
   *  unconfigured or nobody opted in). */
  emailsSent: number;
}
export async function digestForOrg(
  orgId: string,
  inputs: DigestInputs,
  opts: { orgName?: string } = {},
): Promise<DigestResult> {
  const snapshot = await takeGapSnapshot(orgId, inputs);
  const previous = await findPreviousSnapshot(orgId, snapshot);
  if (!previous) {
    logger.info({ orgId }, 'Digest: baseline snapshot, no notifications written');
    return { snapshot, notifications: [], baseline: true, emailsSent: 0 };
  }
  const written: ReturnType<typeof createNotification>[] = [];
  const fired: FiredItem[] = [];
  for (const rule of RULES) {
    const out = rule.evaluate(previous.metrics, snapshot.metrics);
    if (out) {
      fired.push(out);
      written.push(createNotification({
        orgId,
        type: out.type,
        title: out.title,
        message: out.message,
        link: out.link,
      }));
    }
  }
  const emailsSent = await deliverDigestEmails(orgId, opts.orgName || orgId, fired);
  logger.info({ orgId, written: written.length, emailsSent }, 'Digest run complete');
  return { snapshot, notifications: written, baseline: false, emailsSent };
}

/** Email the fired items to every user who opted into email delivery, each
 *  filtered to the gap-signal categories they subscribed to. In-app
 *  notifications are unaffected — this is a per-user opt-in layer on top.
 *  A no-op (returns 0) when SMTP isn't configured or nothing fired.
 *  Best-effort: a delivery error is logged, never thrown, so the digest run
 *  itself always succeeds. */
async function deliverDigestEmails(orgId: string, orgName: string, fired: FiredItem[]): Promise<number> {
  if (fired.length === 0 || !isMailConfigured()) return 0;
  let sent = 0;
  try {
    const prefs = await listPreferencesForOrg(orgId);
    for (const p of prefs) {
      if (p.frequency === 'off' || !p.emailEnabled || !p.email) continue;
      const items = fired.filter((f) => p.categories.includes(f.category));
      if (items.length === 0) continue;
      const ok = await sendDigestEmail({
        to: p.email,
        name: p.name,
        orgName,
        items: items.map((it) => ({ title: it.title, message: it.message, link: it.link })),
      });
      if (ok) sent += 1;
    }
  } catch (err) {
    logger.error({ err, orgId }, 'Digest: email delivery failed');
  }
  return sent;
}
