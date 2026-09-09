import logger from '../lib/logger';
import { sweepOverdueTasks } from '../routes/governance-tasks';
import { captureStatsSnapshot } from '../routes/dashboard';
import { digestForOrg } from './digest.service';
import { deliverScheduledReports } from './report-delivery.service';
import { processNodes } from '../routes/process-catalog';
import { dataAssets } from '../routes/data-assets';
import { mappings } from '../routes/mappings';
import { organizations } from '../routes/organizations';
import { settingsRepo } from '../stores/app-settings';
import { getOrganizationsRepository } from '../db/organizations.repo';
import { getProcessNodesRepository } from '../db/process-nodes.repo';
import { getDataAssetsRepository } from '../db/data-assets.repo';
import { getMappingsRepository } from '../db/mappings.repo';
import { backgroundTimersDisabled } from '../lib/background-timer';
import { isSchedulerLeader } from '../lib/scheduler-leadership';

// ──────────────────────────────────────────────────────────────────────────
// scheduler.service — self-driving background loops that turn
// otherwise-manual endpoints into automation. Three jobs, one timer:
//
//   * Overdue task sweep — every SWEEP_INTERVAL_MS. Fires the same
//     sweepOverdueTasks helper the /sweep-overdue endpoint calls.
//
//   * Weekly digest — hits digestForOrg for every org, once, on the
//     scheduled weekly boundary. In dev + demo we lean into a shorter
//     "weekly if the wall clock crosses Sunday 23:59 UTC since the
//     last check" rule so the loop is testable without waiting seven
//     days. In production this stays exactly as tight; the same
//     boundary catches the real cron moment.
//
//   * Daily stats-snapshot capture — once per UTC calendar day, records
//     each org's headline numbers (coverage / avg health / gaps) via
//     captureStatsSnapshot. This is what builds real trend history: once
//     an org has >= 2 real snapshots, /dashboard/trends returns them
//     instead of the synthesized (illustrative) fallback series.
//
// The scheduler holds a single Node interval. Callers should invoke
// startScheduler() during boot and stopScheduler() during graceful
// shutdown. The intervals are wrapped in try/catch so a
// per-tick failure doesn't take the loop down.
//
// Disable via PROCELA_DISABLE_SCHEDULERS=1 (the shared kill switch that
// also silences every other background loop — set it on non-leader
// replicas so scheduled work runs once, not once per replica). Auto-off
// under NODE_ENV=test. PROCELA_DISABLE_SCHEDULER (singular) still works as
// a backward-compatible alias.
// ──────────────────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let timer: NodeJS.Timeout | null = null;

// Repositories for the org sweep + digest inputs. In Postgres mode these read
// the database; in JSON mode they wrap the same in-memory arrays. PR 6.
const orgRepo = getOrganizationsRepository(organizations);
const processNodesRepo = getProcessNodesRepository(processNodes);
const dataAssetsRepo = getDataAssetsRepository(dataAssets);
const mappingsRepo = getMappingsRepository(mappings);

// The weekly-digest last-fired timestamp is persisted so a boot in the firing
// window (e.g. Sunday 23:30 after a Sunday 23:15 fire) doesn't forget the
// earlier run and double-notify. Stored in the shared AppSetting table under
// the "schedulerState" key.
interface SchedulerState { lastWeeklyDigestFiredAt: number | null }
async function getLastWeeklyDigestFiredAt(): Promise<number | null> {
  const state = await settingsRepo.get<SchedulerState>('schedulerState');
  return state?.lastWeeklyDigestFiredAt ?? null;
}
async function setLastWeeklyDigestFiredAt(ms: number): Promise<void> {
  await settingsRepo.set<SchedulerState>('schedulerState', { lastWeeklyDigestFiredAt: ms });
}

// The daily stats-snapshot capture tracks which UTC calendar day it last ran,
// so it captures each org's headline numbers at most once per day. Stored under
// its own AppSetting key so it never clobbers the digest state above. Building
// up >= 2 real snapshots is what lets /dashboard/trends return real history
// instead of the synthesized (illustrative) fallback.
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
interface StatsSnapshotState { lastCapturedDay: string | null }
async function getLastStatsSnapshotDay(): Promise<string | null> {
  const state = await settingsRepo.get<StatsSnapshotState>('statsSnapshotState');
  return state?.lastCapturedDay ?? null;
}
async function setLastStatsSnapshotDay(day: string): Promise<void> {
  await settingsRepo.set<StatsSnapshotState>('statsSnapshotState', { lastCapturedDay: day });
}
async function shouldCaptureSnapshots(nowMs: number): Promise<boolean> {
  return (await getLastStatsSnapshotDay()) !== utcDay(nowMs);
}

function isDisabled(): boolean {
  // Honour the shared background-timer kill switch (PROCELA_DISABLE_SCHEDULERS
  // + NODE_ENV=test) so a single env var silences EVERY background loop — this
  // service's sweep/digest included — on non-leader replicas. The older
  // singular PROCELA_DISABLE_SCHEDULER is kept as a backward-compatible alias.
  return backgroundTimersDisabled()
    || process.env.PROCELA_DISABLE_SCHEDULER === '1';
}

/**
 * Detects whether the wall clock has crossed the weekly-digest boundary
 * (Sunday 23:59 UTC) since the last check. Simpler than a real cron
 * because the interval always runs at a coarse boundary anyway — we
 * just need "did the boundary pass since we last fired?".
 */
async function shouldFireWeeklyDigest(nowMs: number): Promise<boolean> {
  const now = new Date(nowMs);
  // Sunday = 0 in JS. Fire when it's Sunday AFTER 23:00 UTC, once.
  const isSundayLate = now.getUTCDay() === 0 && now.getUTCHours() >= 23;
  if (!isSundayLate) return false;
  const last = await getLastWeeklyDigestFiredAt();
  if (last === null) return true;
  // At least six days must have passed since the last fire so a
  // Sunday sweep at 23:15 and then 23:45 don't double-fire, and so a
  // restart during the firing window doesn't re-trigger.
  const sixDays = 6 * 24 * 60 * 60 * 1000;
  return nowMs - last >= sixDays;
}

async function tick(): Promise<void> {
  // Single-owner guard: only the elected leader does the shared work
  // (overdue sweep + weekly digest). Checked per-tick so leadership can move
  // between replicas without a restart. Always true in single-instance / JSON
  // mode. The __test__.tick export bypasses the timer, not this guard — tests
  // that drive tick() directly run with no DB, so isSchedulerLeader() is true.
  if (!isSchedulerLeader()) return;
  try {
    const overdue = await sweepOverdueTasks();
    if (overdue.fired.length > 0) {
      logger.info({ fired: overdue.fired.length }, 'Scheduler: overdue sweep fired');
    }
  } catch (err) {
    logger.error({ err }, 'Scheduler: overdue sweep failed');
  }

  if (await shouldFireWeeklyDigest(Date.now())) {
    try {
      // Fetch the org list + digest inputs once (Postgres or JSON) rather than
      // reading the stale in-memory arrays.
      const [orgs, pn, da, mp] = await Promise.all([
        orgRepo.list(),
        processNodesRepo.list(),
        dataAssetsRepo.list(),
        mappingsRepo.list(),
      ]);
      let totalWritten = 0;
      for (const org of orgs) {
        try {
          const result = await digestForOrg(
            org.id,
            { processNodes: pn, dataAssets: da, mappings: mp },
            { orgName: (org as { name?: string }).name },
          );
          totalWritten += result.notifications.length;
        } catch (err) {
          logger.error({ err, orgId: org.id }, 'Scheduler: digest failed for org');
        }
      }
      await setLastWeeklyDigestFiredAt(Date.now());
      logger.info({ totalWritten, orgs: orgs.length }, 'Scheduler: weekly digest fired');
    } catch (err) {
      logger.error({ err }, 'Scheduler: weekly digest failed');
    }

    // Scheduled report delivery rides the same weekly boundary (and the same
    // leader gate). Best-effort and a no-op when SMTP is unconfigured, so it's
    // safe to run unconditionally here.
    try {
      const { delivered } = await deliverScheduledReports();
      if (delivered > 0) logger.info({ delivered }, 'Scheduler: scheduled reports delivered');
    } catch (err) {
      logger.error({ err }, 'Scheduler: scheduled report delivery failed');
    }
  }

  // Daily stats-snapshot capture — once per UTC calendar day, record each
  // org's headline numbers so /dashboard/trends builds real history and the
  // sparklines stop falling back to the synthesized (illustrative) series.
  if (await shouldCaptureSnapshots(Date.now())) {
    try {
      const orgs = await orgRepo.list();
      let captured = 0;
      for (const org of orgs) {
        try {
          await captureStatsSnapshot(org.id);
          captured++;
        } catch (err) {
          logger.error({ err, orgId: org.id }, 'Scheduler: stats snapshot failed for org');
        }
      }
      // Mark the day done only after the sweep so a mid-sweep crash retries
      // next tick rather than skipping the day entirely.
      await setLastStatsSnapshotDay(utcDay(Date.now()));
      logger.info({ captured, orgs: orgs.length }, 'Scheduler: daily stats snapshots captured');
    } catch (err) {
      logger.error({ err }, 'Scheduler: stats snapshot sweep failed');
    }
  }
}

export function startScheduler(): void {
  if (isDisabled()) {
    logger.info('Scheduler disabled by env');
    return;
  }
  if (timer) return;
  // Fire once shortly after boot so the first sweep doesn't wait a
  // full hour when the server starts up mid-day.
  setTimeout(() => { void tick(); }, 30_000);
  timer = setInterval(() => { void tick(); }, SWEEP_INTERVAL_MS);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, 'Scheduler started');
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Exports for tests. The tick and boundary helper are pure over the
// stores, so tests can drive them directly without touching the timer.
// resetSchedulerState lets a test wipe the persisted last-fire time
// so its assertions don't depend on run ordering across suites.
async function resetSchedulerState(): Promise<void> {
  await settingsRepo.set<SchedulerState>('schedulerState', { lastWeeklyDigestFiredAt: null });
  await settingsRepo.set<StatsSnapshotState>('statsSnapshotState', { lastCapturedDay: null });
}
export const __test__ = {
  tick,
  shouldFireWeeklyDigest,
  shouldCaptureSnapshots,
  setLastStatsSnapshotDay,
  resetSchedulerState,
};
