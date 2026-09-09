import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { SkeletonRows } from '../components/Skeleton';
import PageHeader from '../components/PageHeader';
import ExportMenu from '../components/ExportMenu';
import type { Cell, ExportPayload, ExportFormat } from '../lib/export';
import { apiClient } from '../api/client';
import { useOrgContext } from '../stores/orgContext';
import { useToastStore } from '../stores/toastStore';

interface UserReportSummary {
  id: string;
  name: string;
  description: string;
  visibility: 'private' | 'org';
  primaryEntity: string;
  columnCount: number;
  lastRunAt: string | null;
  lastRunRowCount: number | null;
  runCount: number;
  scheduleFrequency: 'off' | 'weekly';
  updatedAt: string;
}

interface RunResult {
  columns: Array<{ field: string; label: string }>;
  rows: Array<Record<string, unknown>>;
  totalMatched: number;
}

// Formats offered by the per-row run+export menu (PDF included, matching the
// Report Builder's menu).
const REPORT_EXPORT_FORMATS: ExportFormat[] = ['csv', 'xlsx', 'json', 'pdf', 'clipboard'];

function toExportCell(v: unknown): Cell {
  if (v == null) return '';
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── User Reports tab — saved Report Builder definitions ────────────────────

function UserReportsTab() {
  const navigate = useNavigate();
  const { activeOrgId } = useOrgContext();
  const addToast = useToastStore((s) => s.addToast);
  const [reports, setReports] = useState<UserReportSummary[] | null>(null);

  const load = useCallback(() => {
    if (!activeOrgId) { setReports([]); return; }
    apiClient.get<{ success: boolean; data: UserReportSummary[] }>(`/reports?orgId=${activeOrgId}`)
      .then((r) => setReports(r.data || []))
      .catch(() => setReports([]));
  }, [activeOrgId]);

  useEffect(() => { load(); }, [load]);

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
    try {
      await apiClient.delete(`/reports/${id}`);
      addToast('success', `Deleted "${name}".`);
      load();
    } catch {
      addToast('error', 'Delete failed.');
    }
  };

  // Run the report and hand its rows to the export dispatcher. Running a
  // saved report records it in the report's run history server-side, so we
  // refresh the list afterward to surface the updated "last run".
  const buildRunExport = (r: UserReportSummary) => async (): Promise<ExportPayload | null> => {
    const res = await apiClient.post<{ success: boolean; data: RunResult }>(`/reports/${r.id}/run`, {});
    const result = res.data;
    load(); // refresh run-history metadata
    if (result.rows.length === 0) {
      addToast('info', 'No rows match this report — nothing to export.');
      return null;
    }
    if (result.totalMatched > result.rows.length) {
      addToast('info', `Export capped at ${result.rows.length.toLocaleString()} of ${result.totalMatched.toLocaleString()} matched rows.`);
    }
    const headers = result.columns.map((c) => c.label);
    const rows: Cell[][] = result.rows.map((row) => result.columns.map((c) => toExportCell(row[c.field])));
    const base = (r.name || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
    return { filenameBase: base, headers, rows, sheetName: r.name || 'Report' };
  };

  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          Reports you've built with the Report Builder. Click any to open it.
        </div>
        <Link
          to="/reports/builder"
          style={{
            fontSize: 13, fontWeight: 600,
            color: '#fff', background: 'var(--color-primary)',
            padding: '6px 14px', borderRadius: 4, textDecoration: 'none',
          }}
        >
          + New report
        </Link>
      </div>
      {reports === null ? (
        <SkeletonRows rows={4} columnWidths={[220, null, 120]} />
      ) : reports.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: '24px 0', textAlign: 'center' }}>
          No reports yet. Click <strong>+ New report</strong> to build one.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {reports.map((r) => (
            <li key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {r.name}
                  {r.visibility === 'private' && (
                    <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 3, background: 'var(--color-bg)', color: 'var(--color-text-muted)' }}>
                      PRIVATE
                    </span>
                  )}
                </div>
                {r.description && <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{r.description}</div>}
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
                  {r.primaryEntity} · {r.columnCount} {r.columnCount === 1 ? 'column' : 'columns'}
                  {r.lastRunAt && (
                    <> · Last run {timeAgo(r.lastRunAt)}{r.lastRunRowCount != null ? ` · ${r.lastRunRowCount.toLocaleString()} ${r.lastRunRowCount === 1 ? 'row' : 'rows'}` : ''}</>
                  )}
                  {r.scheduleFrequency === 'weekly' && (
                    <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 3, background: 'var(--color-primary-light, #e0f2f1)', color: 'var(--color-primary)' }}>
                      WEEKLY EMAIL
                    </span>
                  )}
                </div>
              </div>
              <ExportMenu
                label="Run & export"
                formats={REPORT_EXPORT_FORMATS}
                build={buildRunExport(r)}
              />
              <button
                onClick={() => navigate(`/reports/builder/${r.id}`)}
                style={{ fontSize: 12, color: 'var(--color-primary)', background: 'transparent', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                Open →
              </button>
              <button
                onClick={() => remove(r.id, r.name)}
                style={{ fontSize: 12, color: 'var(--color-text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                title="Delete report"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ReportsPage() {
  // Reports is now just the report catalog + Builder. The Executive Report and
  // Governance Maturity Scorecard tabs were removed, so the tab bar is gone too.
  return (
    <div>
      <PageHeader title="Reports" subtitle="Reports you and your org have built against the Procela data model." />
      <UserReportsTab />
    </div>
  );
}
