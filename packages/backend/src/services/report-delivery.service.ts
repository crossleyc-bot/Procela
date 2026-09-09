// Scheduled report delivery.
//
// A saved report can carry a schedule ({ frequency: 'weekly', recipients }).
// The scheduler's weekly sweep calls deliverScheduledReports(), which runs
// each scheduled report against the live catalog and emails the rendered
// rows (CSV attachment + summary) to its recipients, reusing the shared mail
// sender. Runs are recorded in the report's run log with kind 'scheduled'.
//
// A no-op when SMTP is unconfigured; best-effort per report so one failure
// never blocks the rest of the sweep.

import { reports, appendRun, type ReportRun } from '../routes/reports';
import { getReportsRepository } from '../db/reports.repo';
import { executeReport } from './report-engine';
import { isConfigured as isMailConfigured, sendReportEmail } from './mail.service';
import { getCachedOrgList } from '../lib/org-scope';
import logger from '../lib/logger';

const reportsRepo = getReportsRepository(reports);

type Cell = string | number | boolean | null | undefined;
function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

export async function deliverScheduledReports(): Promise<{ delivered: number; considered: number }> {
  if (!isMailConfigured()) return { delivered: 0, considered: 0 };

  const all = await reportsRepo.list();
  const orgs = getCachedOrgList();
  let delivered = 0;
  let considered = 0;

  for (const report of all) {
    const sched = report.schedule;
    if (!sched || sched.frequency !== 'weekly' || sched.recipients.length === 0) continue;
    considered += 1;
    try {
      const result = await executeReport(report.definition, report.orgId);
      const orgName = orgs.find((o) => o.id === report.orgId)?.name || report.orgId;
      const headers = result.columns.map((c) => c.label);
      const rows = result.rows.map((row) => result.columns.map((c) => toCell(row[c.field])));
      const ok = await sendReportEmail({
        to: sched.recipients,
        reportName: report.name,
        orgName,
        headers,
        rows,
        totalMatched: result.totalMatched,
      });
      if (ok) {
        delivered += 1;
        const run: ReportRun = {
          ranAt: new Date().toISOString(),
          rowCount: result.totalMatched,
          byUserId: null,
          kind: 'scheduled',
        };
        try { await reportsRepo.update(report.id, appendRun(report, run)); }
        catch { /* run history is non-critical */ }
      }
    } catch (err) {
      logger.error({ err, reportId: report.id }, 'Scheduled report delivery failed');
    }
  }

  if (considered > 0) logger.info({ delivered, considered }, 'Scheduled report sweep complete');
  return { delivered, considered };
}
