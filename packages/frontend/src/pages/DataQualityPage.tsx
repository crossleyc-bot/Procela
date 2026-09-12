import { SkeletonRows } from '../components/Skeleton';
import React, { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { apiClient } from '../api/client';
import PageHeader from '../components/PageHeader';
import Card from '../components/Card';
import StatTile from '../components/StatTile';
import Spinner from '../components/Spinner';
import Button from '../components/Button';
import TruncatedText from '../components/TruncatedText';
import { useOrgContext } from '../stores/orgContext';
import ExportMenu from '../components/ExportMenu';
import { usePolling } from '../hooks/usePolling';
import { usePermissions } from '../hooks/usePermissions';
import { useColumnPicker } from '../hooks/useColumnPicker';
import ColumnPicker from '../components/ColumnPicker';
import SavedViewsMenu from '../components/SavedViewsMenu';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToastStore } from '../stores/toastStore';
import IconButton from '../components/IconButton';
import EmptyState from '../components/EmptyState';
import ErrorState from '../components/ErrorState';
import { errorMessage } from '../lib/errorToast';
import { renderNavIcon } from '../components/navIcons';
import HelpPopover from '../components/HelpPopover';
import ActiveFiltersBar from '../components/ActiveFiltersBar';
import SearchInput from '../components/SearchInput';
import type { RulesModalAsset } from '../components/DataQualityRulesModal';
// Lazy: only renders when the user clicks the rules icon on a row.
const DataQualityRulesModal = lazy(() => import('../components/DataQualityRulesModal'));
import { useSortedList } from '../hooks/useSortedList';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import { useRowSelection } from '../hooks/useRowSelection';
import BulkActionBar, { BulkActionButton } from '../components/BulkActionBar';

// Assets tab: we need more than just {id,name} to display source provenance
// and per-asset stewardship / health — the backend already returns these on
// GET /data-assets.
interface DataAssetFull {
  id: string;
  name: string;
  description: string;
  systemId: string;
  owner?: string;
  steward?: string;
  healthScore?: number;
  sourceConnectionId?: string;
  sourceAsset?: string;
  sourceColumn?: string;
  // Enriched by the list endpoint from domain cross-reference.
  domainName?: string | null;
  ownerName?: string | null;
  stewardName?: string | null;
}

interface SystemRef {
  id: string;
  name: string;
}

type ScheduleFrequency = 'NEVER' | 'HOURLY' | 'DAILY' | 'WEEKLY';

interface QualityRule {
  id: string;
  orgId: string;
  dataAssetId: string;
  dimension: string;
  name: string;
  description: string;
  threshold: number;
  currentScore: number;
  weight: number;
  status: string;
  lastMeasured: string | null;
  dataAssetName: string;
  // Provenance of the last run — a simulated result carries a fabricated
  // pass rate and does NOT count toward the asset's measured health.
  lastRun?: { simulated?: boolean } | null;
  ruleType?: string;
  columnName?: string;
  scheduleFrequency?: ScheduleFrequency;
  nextRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DataAssetRef {
  id: string;
  name: string;
}

interface FormData {
  dataAssetId: string;
  columnId: string;
  dimension: string;
  name: string;
  description: string;
  threshold: number;
  currentScore: number;
  weight: number;
  ruleType: string;
  parameters: Record<string, unknown>;
}

const emptyForm: FormData = {
  dataAssetId: '',
  columnId: '',
  dimension: 'COMPLETENESS',
  name: '',
  description: '',
  threshold: 80,
  currentScore: 0,
  weight: 5,
  ruleType: '',
  parameters: {},
};

const QUALITY_DIMENSIONS = ['COMPLETENESS', 'ACCURACY', 'TIMELINESS', 'CONSISTENCY', 'UNIQUENESS', 'VALIDITY'];

// Rule types the form can set. The first five are measured for real by an
// on-prem connector (aggregate pushdown) or a CSV upload; regex/custom and the
// untyped option are simulated and don't count toward measured health. Only a
// typed rule is picked up by the connector's rule plan — an untyped rule never
// measures, which is why "None" is clearly labelled.
const RULE_TYPE_OPTIONS: Array<{ value: string; label: string; measured: boolean }> = [
  { value: '',              label: 'None — manual / unmeasured',  measured: false },
  { value: 'NOT_NULL',      label: 'Not null',                    measured: true  },
  { value: 'UNIQUE',        label: 'Unique',                      measured: true  },
  { value: 'IN_SET',        label: 'In set (allowed values)',     measured: true  },
  { value: 'NUMERIC_RANGE', label: 'Numeric range',               measured: true  },
  { value: 'LENGTH_RANGE',  label: 'Length range',                measured: true  },
  { value: 'REGEX_MATCH',   label: 'Regex match (simulated)',     measured: false },
  { value: 'CUSTOM',        label: 'Custom (simulated)',          measured: false },
];

const DIMENSION_BADGES: Record<string, { bg: string; color: string }> = {
  COMPLETENESS: { bg: '#dbeafe', color: '#1e40af' },
  ACCURACY: { bg: '#d1f0eb', color: '#0f4f46' },
  TIMELINESS: { bg: '#fef3c7', color: '#92400e' },
  CONSISTENCY: { bg: '#ede9fe', color: '#5b21b6' },
  UNIQUENESS: { bg: '#e0e7ff', color: '#3730a3' },
  VALIDITY: { bg: '#f1f5f9', color: '#64748b' },
};

const STATUS_BADGES: Record<string, { bg: string; color: string }> = {
  PASSING: { bg: '#d1f0eb', color: '#0f4f46' },
  WARNING: { bg: '#fef3c7', color: '#92400e' },
  FAILING: { bg: '#fce7f3', color: '#9d174d' },
  NOT_MEASURED: { bg: '#f1f5f9', color: '#64748b' },
};

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  padding: '6px 10px',
  fontSize: 13,
  width: '100%',
  background: 'var(--color-surface)',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: 'auto' as any,
};

function Badge({ label, colors }: { label: string; colors: { bg: string; color: string } }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 9999,
      fontSize: 11,
      fontWeight: 600,
      background: colors.bg,
      color: colors.color,
    }}>
      {label.replace(/_/g, ' ')}
    </span>
  );
}

function ScoreBar({ score, threshold }: { score: number; threshold: number }) {
  const barColor = score >= threshold ? 'var(--color-success)' : score >= threshold - 10 ? 'var(--color-warning)' : 'var(--color-error)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{
        flex: 1, height: 8, background: '#f1f5f9', borderRadius: 4,
        position: 'relative', minWidth: 60, maxWidth: 120,
      }}>
        <div style={{
          width: `${score}%`, height: '100%', background: barColor,
          borderRadius: 4, transition: 'width 0.3s',
        }} />
        {/* Threshold marker */}
        <div style={{
          position: 'absolute', left: `${threshold}%`, top: -2,
          width: 2, height: 12, background: '#374151', borderRadius: 1,
        }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, color: barColor, minWidth: 32 }}>{score}%</span>
    </div>
  );
}

// Toggleable columns for the Assets (Quality) tab table. The Asset name and
// the Actions column are always shown, so they're not listed here.
type AssetColId = 'system' | 'owner' | 'health' | 'rules';
const ASSET_COLUMN_DEFS: Array<{ id: AssetColId; label: string; defaultVisible: boolean }> = [
  { id: 'system', label: 'System', defaultVisible: true },
  { id: 'owner',  label: 'Owner',  defaultVisible: true },
  { id: 'health', label: 'Health', defaultVisible: true },
  { id: 'rules',  label: 'Rules',  defaultVisible: true },
];

type DqColId = 'asset' | 'column' | 'name' | 'dimension' | 'threshold' | 'currentScore' | 'weight' | 'status' | 'schedule' | 'lastMeasured';
const DQ_COLUMN_DEFS: Array<{ id: DqColId; label: string; defaultVisible: boolean }> = [
  { id: 'asset',         label: 'Data Asset',     defaultVisible: true  },
  { id: 'column',        label: 'Column',         defaultVisible: true  },
  { id: 'name',          label: 'Rule Name',      defaultVisible: true  },
  { id: 'dimension',     label: 'Dimension',      defaultVisible: true  },
  { id: 'threshold',     label: 'Threshold',      defaultVisible: false },
  { id: 'currentScore',  label: 'Current Score',  defaultVisible: true  },
  { id: 'weight',        label: 'Weight',         defaultVisible: false },
  { id: 'status',        label: 'Status',         defaultVisible: true  },
  { id: 'schedule',      label: 'Schedule',       defaultVisible: false },
  { id: 'lastMeasured',  label: 'Last Measured',  defaultVisible: true  },
];

export default function DataQualityPage({
  embedded = false,
  actionsPortal,
  tab: tabProp,
  onTabChange,
}: {
  embedded?: boolean;
  /** When embedded in the Data Assets hub, the Rules toolbar renders into
   *  this slot (the tab-bar row) instead of a strip below the tabs. */
  actionsPortal?: HTMLElement | null;
  tab?: 'assets' | 'rules';
  onTabChange?: (tab: 'assets' | 'rules') => void;
} = {}) {
  const { activeOrgId } = useOrgContext();
  const { canWrite } = usePermissions();
  const addToast = useToastStore((s) => s.addToast);
  const dqCols = useColumnPicker<DqColId>('procela.dataQuality.visibleCols.v1', DQ_COLUMN_DEFS);
  const [rules, setRules] = useState<QualityRule[]>([]);
  const [assetsList, setAssetsList] = useState<DataAssetRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);
  // Columns of the asset selected in the form, so a rule can target a specific
  // column (the bound/discovered set) instead of the asset as a whole.
  const [formColumns, setFormColumns] = useState<ColumnWithHealth[]>([]);
  const [formColumnsLoading, setFormColumnsLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [filterAssetId, setFilterAssetId] = useState('');
  const [filterDimension, setFilterDimension] = useState('');
  const [filterOwner, setFilterOwner] = useState('');
  const [filterDomain, setFilterDomain] = useState('');
  const [search, setSearch] = useState('');
  // New: per-asset view with Manage Rules modal lives under the Assets tab.
  // When embedded in the Data Assets hub the parent owns the active tab
  // (Quality / Rules) and passes it in; standalone we keep it internal.
  const [internalTab, setInternalTab] = useState<'assets' | 'rules'>('assets');
  const tab = tabProp ?? internalTab;
  const setTab = (t: 'assets' | 'rules') => { setInternalTab(t); onTabChange?.(t); };
  const [fullAssets, setFullAssets] = useState<DataAssetFull[]>([]);
  const [systemsList, setSystemsList] = useState<SystemRef[]>([]);
  const [rulesModalAsset, setRulesModalAsset] = useState<RulesModalAsset | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoadError(null);
      const query = activeOrgId ? `?orgId=${activeOrgId}` : '';
      const [rulesRes, assetsRes] = await Promise.all([
        apiClient.get<{ success: boolean; data: QualityRule[] }>(`/data-quality${query}`),
        apiClient.get<{ success: boolean; data: DataAssetFull[]; systems: SystemRef[] }>(`/data-assets${query}`),
      ]);
      setRules(rulesRes.data || []);
      const assets = assetsRes.data || [];
      setFullAssets(assets);
      setSystemsList(assetsRes.systems || []);
      // Keep the legacy ref list in sync for the existing Rules-tab filter.
      setAssetsList(assets.map((a) => ({ id: a.id, name: a.name })));
    } catch (err) { setLoadError(errorMessage(err, 'Failed to load data quality.')); }
    finally { setLoading(false); }
  }, [activeOrgId]);

  useEffect(() => { fetchData(); }, [fetchData]);
  usePolling(fetchData, 30000);

  // Owner / domain of a rule are inherited from its data asset — map by
  // asset id so the Rules tab can filter on the same two dimensions the
  // Registry and Quality (Assets) tabs do.
  const assetById = new Map(fullAssets.map((a) => [a.id, a] as const));
  const ruleOwnerOptions = Array.from(new Set(fullAssets.map((a) => a.ownerName).filter(Boolean))).sort() as string[];
  const ruleDomainOptions = Array.from(new Set(fullAssets.map((a) => a.domainName).filter(Boolean))).sort() as string[];

  // Apply local filters
  let filteredRules = rules;
  if (filterAssetId) filteredRules = filteredRules.filter((r) => r.dataAssetId === filterAssetId);
  if (filterDimension) filteredRules = filteredRules.filter((r) => r.dimension === filterDimension);
  if (filterOwner) {
    filteredRules = filteredRules.filter((r) => {
      const own = assetById.get(r.dataAssetId)?.ownerName || '';
      return filterOwner === '__none__' ? !own : own === filterOwner;
    });
  }
  if (filterDomain) {
    filteredRules = filteredRules.filter((r) => {
      const dom = assetById.get(r.dataAssetId)?.domainName || '';
      return filterDomain === '__none__' ? !dom : dom === filterDomain;
    });
  }
  if (search.trim()) {
    // Free-text over the fields a user is likely to remember: the rule name,
    // its asset, and its column.
    const q = search.trim().toLowerCase();
    filteredRules = filteredRules.filter((r) =>
      r.name.toLowerCase().includes(q) ||
      (r.dataAssetName || '').toLowerCase().includes(q) ||
      ((r as { columnName?: string }).columnName || '').toLowerCase().includes(q),
    );
  }

  // Sort: comparators keyed by column name; URL persists ?sort=&dir=
  const { sorted: sortedRules, sortKey, sortDir, toggleSort } = useSortedList(
    filteredRules,
    {
      dataAssetName: (a, b) => (a.dataAssetName || '').localeCompare(b.dataAssetName || ''),
      column: (a, b) => (a.columnName || '').localeCompare(b.columnName || ''),
      name: (a, b) => a.name.localeCompare(b.name),
      dimension: (a, b) => a.dimension.localeCompare(b.dimension),
      threshold: (a, b) => a.threshold - b.threshold,
      status: (a, b) => a.status.localeCompare(b.status),
      currentScore: (a, b) => a.currentScore - b.currentScore,
      weight: (a, b) => a.weight - b.weight,
      lastMeasured: (a, b) => (a.lastMeasured || '').localeCompare(b.lastMeasured || ''),
    },
    'dataAssetName',
  );

  const sel = useRowSelection(sortedRules, (r) => r.id);

  // Stats
  const totalRules = rules.length;
  const passingCount = rules.filter((r) => r.status === 'PASSING').length;
  const warningCount = rules.filter((r) => r.status === 'WARNING').length;
  const failingCount = rules.filter((r) => r.status === 'FAILING').length;
  const avgScore = totalRules > 0 ? Math.round(rules.reduce((sum, r) => sum + r.currentScore, 0) / totalRules) : 0;

  // Load the selected asset's columns for the form's column picker.
  const loadFormColumns = useCallback(async (assetId: string) => {
    if (!assetId) { setFormColumns([]); return; }
    setFormColumnsLoading(true);
    try {
      const res = await apiClient.get<{ success: boolean; data: ColumnWithHealth[] }>(`/data-assets/${assetId}/columns`);
      setFormColumns(res.data || []);
    } catch { setFormColumns([]); }
    finally { setFormColumnsLoading(false); }
  }, []);

  // Changing the asset resets the column choice and reloads the column list.
  const onFormAssetChange = (assetId: string) => {
    setForm((prev) => ({ ...prev, dataAssetId: assetId, columnId: '' }));
    loadFormColumns(assetId);
  };

  const openAdd = () => {
    if (!activeOrgId) { addToast('error', 'Select an organization from the header first.'); return; }
    setForm(emptyForm);
    setFormColumns([]);
    setEditingId(null);
    setShowForm(true);
  };

  const openEdit = (rule: QualityRule) => {
    setForm({
      dataAssetId: rule.dataAssetId,
      columnId: (rule as any).columnId || '',
      dimension: rule.dimension,
      name: rule.name,
      description: rule.description,
      threshold: rule.threshold,
      currentScore: rule.currentScore,
      weight: rule.weight,
      ruleType: (rule as any).ruleType || '',
      parameters: ((rule as any).parameters as Record<string, unknown>) || {},
    });
    loadFormColumns(rule.dataAssetId);
    setEditingId(rule.id);
    setShowForm(true);
  };

  const updateParam = (key: string, value: unknown) => {
    setForm((prev) => ({ ...prev, parameters: { ...prev.parameters, [key]: value } }));
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.dataAssetId) {
      addToast('error', 'Name and Data Asset are required');
      return;
    }
    try {
      if (editingId) {
        await apiClient.put(`/data-quality/${editingId}`, form);
        addToast('success', 'Quality rule updated');
      } else {
        await apiClient.post('/data-quality', { ...form, ...(activeOrgId ? { orgId: activeOrgId } : {}) });
        addToast('success', 'Quality rule created');
      }
      setShowForm(false);
      setEditingId(null);
      setForm(emptyForm);
      fetchData();
    } catch {
      addToast('error', 'Failed to save quality rule');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      // Capture the asset id before deletion so we can recompute health
      // for the right asset after the row disappears.
      const assetId = rules.find((r) => r.id === id)?.dataAssetId;
      await apiClient.delete(`/data-quality/${id}`);
      if (assetId) {
        try { await apiClient.post(`/data-quality/compute-health/${assetId}`); } catch { /* */ }
      }
      // Drop it from the selection so the bulk-action bar doesn't keep
      // counting a row that no longer exists.
      sel.remove(id);
      addToast('success', 'Quality rule deleted');
      fetchData();
    } catch {
      addToast('error', 'Failed to delete quality rule');
    }
  };

  const [runningRuleId, setRunningRuleId] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState<string | null>(null);

  const handleRunRule = async (rule: QualityRule) => {
    if (!rule.ruleType) {
      addToast('error', 'This rule has no ruleType and cannot be executed');
      return;
    }
    setRunningRuleId(rule.id);
    try {
      const res = await apiClient.post<{ success: boolean; data: { passRate: number; simulated: boolean } }>(`/data-quality/${rule.id}/run`);
      const r = res.data;
      const verdict = r.passRate >= 95 ? 'success' : r.passRate >= 80 ? 'info' : 'error';
      const sim = r.simulated ? ' (simulated)' : '';
      addToast(verdict as 'success' | 'info' | 'error', `${rule.name}: ${r.passRate}% pass${sim}`);
      fetchData();
    } catch (e) {
      addToast('error', `${rule.name}: ${e instanceof Error ? e.message : 'run failed'}`);
    } finally {
      setRunningRuleId(null);
    }
  };

  const handleScheduleChange = async (ruleId: string, freq: ScheduleFrequency) => {
    try {
      await apiClient.put(`/data-quality/${ruleId}`, { scheduleFrequency: freq });
      const label = freq === 'NEVER' ? 'Schedule cleared' : `Scheduled ${freq.toLowerCase()}`;
      addToast('success', label);
      setScheduleOpen(null);
      fetchData();
    } catch {
      addToast('error', 'Failed to update schedule');
    }
  };

  // ── Bulk select handlers ──
  const handleBulkDeleteRules = async () => {
    if (sel.count === 0) return;
    try {
      await Promise.all(Array.from(sel.selectedIds).map((id) => apiClient.delete(`/data-quality/${id}`)));
      addToast('success', `Deleted ${sel.count} quality rules`);
      sel.clear();
      fetchData();
    } catch {
      addToast('error', 'Bulk delete failed');
    }
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
  };

  const updateField = (field: keyof FormData, value: string | number) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  if (loadError) {
    return (
      <div>
        <Card shadow="none">
          <ErrorState message={loadError} onRetry={() => { setLoadError(null); setLoading(true); fetchData(); }} />
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <Card shadow="none">
          <SkeletonRows rows={5} columns={12} />
        </Card>
      </div>
    );
  }

  const scheduleLabel = (rule: QualityRule): string => {
    const freq = rule.scheduleFrequency && rule.scheduleFrequency !== 'NEVER'
      ? `Scheduled ${rule.scheduleFrequency.toLowerCase()}`
      : 'Manual only';
    const next = rule.nextRunAt ? `\nNext run: ${new Date(rule.nextRunAt).toLocaleString()}` : '';
    return `${freq}${next}\nClick to change`;
  };

  // Per-asset aggregate view (used by the Assets tab). Groups rules by
  // dataAssetId and pulls latest run info so the user sees per-asset health
  // at a glance and can jump into the Manage Rules modal.
  const rulesByAsset = new Map<string, QualityRule[]>();
  for (const r of rules) {
    const list = rulesByAsset.get(r.dataAssetId) || [];
    list.push(r);
    rulesByAsset.set(r.dataAssetId, list);
  }
  const systemNameById: Record<string, string> = {};
  for (const s of systemsList) systemNameById[s.id] = s.name;

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '10px 20px',
    fontSize: 14,
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
    border: 'none',
    background: 'none',
    color: active ? 'var(--color-primary)' : 'var(--color-text-muted)',
    borderBottom: active ? '2px solid var(--color-primary)' : '2px solid transparent',
  });

  const ruleColumns = ([
    dqCols.isVisible('asset') && {
      key: 'dataAssetName', header: 'Data Asset', sortable: true,
      render: (rule: QualityRule) => rule.dataAssetName || rule.dataAssetId,
    },
    dqCols.isVisible('column') && {
      key: 'column', header: 'Column', sortable: true,
      cellStyle: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-secondary)' },
      render: (rule: QualityRule) => (rule as any).columnName || <span style={{ color: 'var(--color-text-muted)' }}>{'—'}</span>,
    },
    dqCols.isVisible('name') && {
      key: 'name', header: 'Rule Name', sortable: true,
      render: (rule: QualityRule) => rule.name,
    },
    dqCols.isVisible('dimension') && {
      key: 'dimension', header: 'Dimension', sortable: true,
      render: (rule: QualityRule) => <Badge label={rule.dimension} colors={DIMENSION_BADGES[rule.dimension] || DIMENSION_BADGES.VALIDITY} />,
    },
    dqCols.isVisible('threshold') && {
      key: 'threshold', header: 'Threshold', sortable: true,
      render: (rule: QualityRule) => `${rule.threshold}%`,
    },
    dqCols.isVisible('currentScore') && {
      key: 'currentScore', header: 'Current Score', sortable: true,
      render: (rule: QualityRule) => <ScoreBar score={rule.currentScore} threshold={rule.threshold} />,
    },
    dqCols.isVisible('weight') && {
      key: 'weight', header: 'Weight', sortable: true,
      render: (rule: QualityRule) => rule.weight,
    },
    dqCols.isVisible('status') && {
      key: 'status', header: 'Status', sortable: true,
      render: (rule: QualityRule) => <Badge label={rule.status} colors={STATUS_BADGES[rule.status] || STATUS_BADGES.NOT_MEASURED} />,
    },
    dqCols.isVisible('schedule') && {
      key: 'schedule',
      header: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Schedule <HelpPopover id="dq-schedule" title="Rule Scheduling">Click the clock icon to set how often a rule runs automatically: Hourly, Daily, or Weekly. Manual-only rules must be run with the play button.</HelpPopover></span>,
      cellStyle: { fontSize: 12, position: 'relative' as const },
      render: (rule: QualityRule) => (
        <>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <IconButton
              size="sm"
              icon="clock"
              label={scheduleLabel(rule)}
              onClick={() => setScheduleOpen(scheduleOpen === rule.id ? null : rule.id)}
            />
            <span style={{ color: rule.scheduleFrequency && rule.scheduleFrequency !== 'NEVER' ? 'var(--color-text)' : 'var(--color-text-muted)', fontSize: 11 }}>
              {rule.scheduleFrequency && rule.scheduleFrequency !== 'NEVER' ? rule.scheduleFrequency.charAt(0) + rule.scheduleFrequency.slice(1).toLowerCase() : 'Manual'}
            </span>
          </div>
          {scheduleOpen === rule.id && (
            <Card padding={8} shadow="md" style={{ position: 'absolute', top: '100%', left: 0, zIndex: 20, minWidth: 150, fontSize: 12 }}>
              {(['NEVER', 'HOURLY', 'DAILY', 'WEEKLY'] as ScheduleFrequency[]).map((f) => (
                <div
                  key={f}
                  onClick={() => handleScheduleChange(rule.id, f)}
                  style={{
                    padding: '6px 10px', cursor: 'pointer', borderRadius: 4,
                    fontWeight: rule.scheduleFrequency === f ? 600 : 400,
                    background: rule.scheduleFrequency === f ? 'var(--color-bg)' : 'transparent',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = rule.scheduleFrequency === f ? 'var(--color-bg)' : 'transparent'; }}
                >
                  {f === 'NEVER' ? 'Manual only' : f.charAt(0) + f.slice(1).toLowerCase()}
                </div>
              ))}
              {rule.nextRunAt && (
                <div style={{ padding: '6px 10px', fontSize: 10, color: 'var(--color-text-muted)', borderTop: '1px solid var(--color-border)', marginTop: 4 }}>
                  Next run: {new Date(rule.nextRunAt).toLocaleString()}
                </div>
              )}
            </Card>
          )}
        </>
      ),
    },
    dqCols.isVisible('lastMeasured') && {
      key: 'lastMeasured', header: 'Last Measured', sortable: true,
      cellStyle: { fontSize: 12, color: 'var(--color-text-muted)' },
      render: (rule: QualityRule) => rule.lastMeasured ? new Date(rule.lastMeasured).toLocaleDateString() : '--',
    },
    {
      key: 'actions', header: 'Actions', align: 'center' as const,
      render: (rule: QualityRule) => (
        <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          {rule.ruleType && (
            <IconButton
              size="sm"
              icon="play"
              label={runningRuleId === rule.id ? 'Running…' : 'Run now'}
              onClick={() => handleRunRule(rule)}
              disabled={runningRuleId !== null}
            />
          )}
          {canWrite && <IconButton size="sm" icon="edit" label="Edit" onClick={() => openEdit(rule)} />}
          {canWrite && <IconButton size="sm" icon="trash" label="Delete" variant="danger" onClick={() => setConfirmDelete(rule.id)} />}
        </div>
      ),
    },
  ].filter(Boolean) as DataTableColumn<QualityRule>[]);

  return (
    <div>
      {/* Header + tab bar. Suppressed when embedded in the Data Assets hub —
          the parent owns the page title and the Quality / Rules tabs. */}
      {!embedded && (
        <>
          <PageHeader
            title="Data Quality"
            subtitle="Monitor and improve the quality and reliability of your data assets."
          >
            <HelpPopover id="dq-overview" title="Data Quality">
              Define quality rules per data asset, compute health scores, and track
              data quality across your organization. Rules can run on demand or on a schedule.
            </HelpPopover>
          </PageHeader>

          <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border)', marginBottom: 16 }}>
            <button style={tabStyle(tab === 'assets')} onClick={() => setTab('assets')}>Assets</button>
            <button style={tabStyle(tab === 'rules')} onClick={() => setTab('rules')}>Rules</button>
          </div>
        </>
      )}

      {tab === 'assets' && (
        <AssetsTab
          assets={fullAssets}
          rulesByAsset={rulesByAsset}
          systemNameById={systemNameById}
          activeOrgId={activeOrgId}
          onRefreshAll={fetchData}
          onManageRules={(a, colName) => setRulesModalAsset({ id: a.id, name: a.name, sourceAsset: a.sourceAsset, sourceColumn: colName || a.sourceColumn })}
          actionsPortal={actionsPortal}
        />
      )}

      {rulesModalAsset && (
        <Suspense fallback={null}>
          <DataQualityRulesModal
            asset={rulesModalAsset}
            onClose={() => setRulesModalAsset(null)}
            onAfterChange={fetchData}
          />
        </Suspense>
      )}

      {tab === 'rules' && (<>
      {/* Header. Embedded (in the Data Assets hub) renders just the action
          strip — the parent owns the page title. */}
      {(() => {
        const rulesActions = (
          <>
            <SavedViewsMenu
              pageKey="data-quality-rules"
              currentFilters={{ filterAssetId, filterDimension }}
              onApply={(f) => {
                setFilterAssetId((f.filterAssetId as string) || '');
                setFilterDimension((f.filterDimension as string) || '');
              }}
            />
            {rules.length > 0 && (
              <ExportMenu build={() => ({
                filenameBase: 'data-quality-rules',
                sheetName: 'Rules',
                headers: ['Data Asset', 'Column', 'Rule Name', 'Dimension', 'Threshold', 'Current Score', 'Weight', 'Status', 'Last Measured'],
                rows: rules.map((r) => [
                  r.dataAssetName,
                  (r as any).columnName || '',
                  r.name,
                  r.dimension,
                  r.threshold,
                  r.currentScore,
                  r.weight,
                  r.status,
                  r.lastMeasured || '',
                ]),
              })} />
            )}
            <ColumnPicker state={dqCols} />
            {canWrite && (
              <IconButton icon="plus" label="Add rule" variant="primary" onClick={openAdd} />
            )}
          </>
        );
        return embedded ? (
          // Portal the Rules toolbar up onto the hub's tab row (see the hub's
          // actions slot); fall back to an inline strip only when embedded
          // without a slot supplied.
          actionsPortal !== undefined ? (
            actionsPortal ? createPortal(rulesActions, actionsPortal) : null
          ) : (
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              {rulesActions}
            </div>
          )
        ) : (
          <PageHeader
            title="Data Quality Rules"
            subtitle="Define quality rules per data asset and compute health scores."
            actions={rulesActions}
          >
            <HelpPopover id="dq-rules-overview" title="Quality rules">
              A rule validates one column of one asset against a check (uniqueness,
              not-null, regex, range, custom). Procela runs rules on demand or on
              a schedule and rolls each asset's results into a health score.
            </HelpPopover>
          </PageHeader>
        );
      })()}

      {/* Stats — shared StatTile (dense) so the KPI row matches the
          Dashboard's height and styling instead of the old taller
          hand-rolled cards (whose number div had no line-height). */}
      {rules.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10, marginBottom: 16 }}>
          <StatTile dense label="Total Rules" value={totalRules} />
          <StatTile dense label="Passing" value={passingCount} valueColor="var(--color-success)" />
          <StatTile dense label="Warning" value={warningCount} valueColor="var(--color-warning)" />
          <StatTile dense label="Failing" value={failingCount} valueColor="var(--color-error)" />
          <StatTile dense label="Avg Score" value={`${avgScore}%`} />
        </div>
      )}

      {/* Filters */}
      {rules.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search rules, asset, column…"
              ariaLabel="Search rules"
              width={230}
            />
            <select aria-label="Filter by asset" style={{ ...selectStyle, width: 'auto', minWidth: 180 }} value={filterAssetId} onChange={(e) => setFilterAssetId(e.target.value)}>
              <option value="">All Assets</option>
              {assetsList.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select aria-label="Filter by owner" style={{ ...selectStyle, width: 'auto', minWidth: 140 }} value={filterOwner} onChange={(e) => setFilterOwner(e.target.value)}>
              <option value="">All Owners</option>
              {ruleOwnerOptions.map((o) => <option key={o} value={o}>{o}</option>)}
              <option value="__none__">No owner ({rules.filter((r) => !(assetById.get(r.dataAssetId)?.ownerName)).length})</option>
            </select>
            <select aria-label="Filter by domain" style={{ ...selectStyle, width: 'auto', minWidth: 140 }} value={filterDomain} onChange={(e) => setFilterDomain(e.target.value)}>
              <option value="">All Domains</option>
              {ruleDomainOptions.map((d) => <option key={d} value={d}>{d}</option>)}
              <option value="__none__">No domain ({rules.filter((r) => !(assetById.get(r.dataAssetId)?.domainName)).length})</option>
            </select>
            <select aria-label="Filter by dimension" style={{ ...selectStyle, width: 'auto', minWidth: 150 }} value={filterDimension} onChange={(e) => setFilterDimension(e.target.value)}>
              <option value="">All Dimensions</option>
              {QUALITY_DIMENSIONS.map((d) => <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <ActiveFiltersBar
            filters={[
              search.trim() && { label: 'Search', value: search.trim(), onClear: () => setSearch('') },
              filterAssetId && { label: 'Asset', value: assetsList.find((a) => a.id === filterAssetId)?.name || filterAssetId, onClear: () => setFilterAssetId('') },
              filterOwner && { label: 'Owner', value: filterOwner === '__none__' ? 'No owner' : filterOwner, onClear: () => setFilterOwner('') },
              filterDomain && { label: 'Domain', value: filterDomain === '__none__' ? 'No domain' : filterDomain, onClear: () => setFilterDomain('') },
              filterDimension && { label: 'Dimension', value: filterDimension.replace(/_/g, ' '), onClear: () => setFilterDimension('') },
            ].filter(Boolean) as any}
            onClearAll={() => { setFilterAssetId(''); setFilterOwner(''); setFilterDomain(''); setFilterDimension(''); setSearch(''); }}
          />
        </>
      )}


      {/* Add/Edit Form */}
      {showForm && (
        <Card padding={20} marginBottom={20}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>
            {editingId ? 'Edit Quality Rule' : 'Add New Quality Rule'}
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Data Asset *</label>
              <select aria-label="Data Asset" style={selectStyle} value={form.dataAssetId} onChange={(e) => onFormAssetChange(e.target.value)}>
                <option value="">-- Select data asset --</option>
                {assetsList.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Column</label>
              <select
                aria-label="Column"
                style={selectStyle}
                value={form.columnId}
                disabled={!form.dataAssetId || formColumnsLoading}
                onChange={(e) => updateField('columnId', e.target.value)}
              >
                <option value="">{formColumnsLoading ? 'Loading columns…' : 'Whole asset (no specific column)'}</option>
                {formColumns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.columnName}{c.rulesCount ? ` · ${c.rulesCount} rule${c.rulesCount === 1 ? '' : 's'}` : ''}
                  </option>
                ))}
              </select>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 3 }}>
                {!form.dataAssetId
                  ? 'Pick an asset first.'
                  : !formColumnsLoading && formColumns.length === 0
                    ? 'No columns yet — link the asset to a source and pick its columns, or leave asset-level.'
                    : 'Target a specific column so the rule measures just that field.'}
              </div>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Dimension</label>
              <select aria-label="Dimension" style={selectStyle} value={form.dimension} onChange={(e) => updateField('dimension', e.target.value)}>
                {QUALITY_DIMENSIONS.map((d) => <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Rule Type</label>
              <select aria-label="Rule Type" style={selectStyle} value={form.ruleType} onChange={(e) => updateField('ruleType', e.target.value)}>
                {RULE_TYPE_OPTIONS.map((o) => <option key={o.value || 'none'} value={o.value}>{o.label}</option>)}
              </select>
              <div style={{ fontSize: 11, color: form.ruleType === '' ? 'var(--color-warning)' : 'var(--color-text-muted)', marginTop: 3 }}>
                {form.ruleType === ''
                  ? 'Untyped rules are never measured by the connector — pick a type for a real pass rate.'
                  : RULE_TYPE_OPTIONS.find((o) => o.value === form.ruleType)?.measured
                    ? 'Measured for real by an on-prem connector (aggregate pushdown) or a CSV upload.'
                    : 'Simulated — returns a labelled result that does not count toward measured health.'}
              </div>
            </div>
            {form.ruleType === 'IN_SET' && (
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Allowed values</label>
                <input
                  aria-label="Allowed values"
                  style={inputStyle}
                  value={(Array.isArray(form.parameters.allowedValues) ? form.parameters.allowedValues as string[] : []).join(', ')}
                  onChange={(e) => updateParam('allowedValues', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
                  placeholder="e.g. residential, commercial, industrial"
                />
              </div>
            )}
            {form.ruleType === 'NUMERIC_RANGE' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Min</label>
                  <input type="number" aria-label="Minimum" style={inputStyle}
                    value={form.parameters.min === undefined ? '' : Number(form.parameters.min)}
                    onChange={(e) => updateParam('min', e.target.value === '' ? undefined : Number(e.target.value))} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Max</label>
                  <input type="number" aria-label="Maximum" style={inputStyle}
                    value={form.parameters.max === undefined ? '' : Number(form.parameters.max)}
                    onChange={(e) => updateParam('max', e.target.value === '' ? undefined : Number(e.target.value))} />
                </div>
              </div>
            )}
            {form.ruleType === 'LENGTH_RANGE' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Min length</label>
                  <input type="number" aria-label="Minimum length" style={inputStyle} min={0}
                    value={form.parameters.minLength === undefined ? '' : Number(form.parameters.minLength)}
                    onChange={(e) => updateParam('minLength', e.target.value === '' ? undefined : Number(e.target.value))} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Max length</label>
                  <input type="number" aria-label="Maximum length" style={inputStyle} min={0}
                    value={form.parameters.maxLength === undefined ? '' : Number(form.parameters.maxLength)}
                    onChange={(e) => updateParam('maxLength', e.target.value === '' ? undefined : Number(e.target.value))} />
                </div>
              </div>
            )}
            {form.ruleType === 'REGEX_MATCH' && (
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Pattern</label>
                <input aria-label="Pattern" style={inputStyle}
                  value={typeof form.parameters.pattern === 'string' ? form.parameters.pattern : ''}
                  onChange={(e) => updateParam('pattern', e.target.value)}
                  placeholder="e.g. ^[^@]+@[^@]+\.[^@]+$" />
              </div>
            )}
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Rule Name *</label>
              <input
                autoFocus
                aria-label="Rule Name"
                style={inputStyle}
                value={form.name}
                onChange={(e) => updateField('name', e.target.value)}
                placeholder="e.g. Email field completeness"
              />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>
                Threshold: {form.threshold}%
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="range"
                  aria-label="Threshold"
                  min={0}
                  max={100}
                  value={form.threshold}
                  onChange={(e) => updateField('threshold', Number(e.target.value))}
                  style={{ flex: 1 }}
                />
                <input
                  type="number"
                  aria-label="Threshold"
                  min={0}
                  max={100}
                  value={form.threshold}
                  onChange={(e) => updateField('threshold', Math.max(0, Math.min(100, Number(e.target.value))))}
                  style={{ ...inputStyle, width: 60, textAlign: 'center' }}
                />
              </div>
            </div>
            {/* Current Score is read-only: it's the measured pass rate set
                by running the rule (or fabricated for untyped rules). The
                editable slider was removed; the score shows read-only in the
                list column and is populated by rule execution. */}
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>
                Weight: {form.weight}
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="range"
                  aria-label="Weight"
                  min={1}
                  max={10}
                  value={form.weight}
                  onChange={(e) => updateField('weight', Number(e.target.value))}
                  style={{ flex: 1 }}
                />
                <input
                  type="number"
                  aria-label="Weight"
                  min={1}
                  max={10}
                  value={form.weight}
                  onChange={(e) => updateField('weight', Math.max(1, Math.min(10, Number(e.target.value))))}
                  style={{ ...inputStyle, width: 60, textAlign: 'center' }}
                />
              </div>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Description</label>
              <input
                aria-label="Description"
                style={inputStyle}
                value={form.description}
                onChange={(e) => updateField('description', e.target.value)}
                placeholder="Describe what this quality rule checks"
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={handleCancel}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!form.name.trim() || !form.dataAssetId}
              onClick={handleSave}
            >
              {editingId ? 'Save Changes' : 'Add Rule'}
            </Button>
          </div>
        </Card>
      )}

      {/* Confirm dialogs */}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Quality Rule?"
        message="Are you sure you want to delete this quality rule?"
        confirmLabel="Delete"
        onConfirm={() => { if (confirmDelete) handleDelete(confirmDelete); setConfirmDelete(null); }}
        onCancel={() => setConfirmDelete(null)}
      />
      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete Selected Quality Rules?"
        message={`Delete ${sel.count} selected rules? This cannot be undone.`}
        confirmLabel="Delete Selected"
        onConfirm={async () => { setConfirmBulkDelete(false); await handleBulkDeleteRules(); }}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      {/* Bulk Action Bar */}
      <BulkActionBar count={sel.count} onClear={sel.clear}>
        <BulkActionButton variant="danger" onClick={() => setConfirmBulkDelete(true)}>Delete Selected</BulkActionButton>
      </BulkActionBar>

      {/* Table */}
      {filteredRules.length === 0 ? (
        rules.length === 0 ? (
          <EmptyState
            icon={renderNavIcon('/data-quality')}
            title="No quality rules yet"
            description="Quality rules validate your data — uniqueness, non-null, regex match, value ranges. Pick an asset, attach a rule, and Procela will run it and score the asset's health."
            action={{ label: '+ Add Rule', onClick: openAdd }}
          />
        ) : (
          <Card padding={40} shadow="none" style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>
            <div style={{ fontSize: 14 }}>No rules match the current filters.</div>
          </Card>
        )
      ) : (
        <Card padding={0} style={{ overflow: 'auto' }}>
          <DataTable
            rows={sortedRules}
            columns={ruleColumns}
            rowKey={(r) => r.id}
            selection={sel}
            sort={{ sortKey, sortDir, onSort: toggleSort }}
            selectAllLabel="Select all rules"
            emptyMessage="No rules match the current filters."
          />
        </Card>
      )}
      </>)}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Assets tab — per-asset expandable view. Each asset row expands to show
// its columns with per-column health, rule counts, quick-add rule buttons,
// and a Manage Rules entry point that opens the DQ modal pre-scoped.
// ──────────────────────────────────────────────────────────────────────────

interface ColumnWithHealth {
  id: string;
  dataAssetId: string;
  columnName: string;
  dataType?: string;
  description?: string;
  sourceAsset?: string;
  sourceColumn?: string;
  rulesCount?: number;
  rulesPassing?: number;
  rulesFailing?: number;
  rulesWarning?: number;
  healthScore?: number | null;
}

function AssetsTab({ assets, rulesByAsset, systemNameById, activeOrgId, onRefreshAll, onManageRules, actionsPortal }: {
  assets: DataAssetFull[];
  rulesByAsset: Map<string, QualityRule[]>;
  systemNameById: Record<string, string>;
  activeOrgId: string;
  onRefreshAll: () => void | Promise<void>;
  onManageRules: (asset: DataAssetFull, columnName?: string) => void;
  // Tab-strip slot (from the Data Assets hub) to portal this tab's toolbar
  // into, so the Quality tab carries the same Export + Columns controls the
  // Registry and Rules tabs do.
  actionsPortal?: HTMLElement | null;
}) {
  const { addToast } = useToastStore();
  const assetCols = useColumnPicker<AssetColId>('procela.dataQuality.assetsCols.v1', ASSET_COLUMN_DEFS);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [columnsMap, setColumnsMap] = useState<Record<string, ColumnWithHealth[]>>({});
  const [loadingCols, setLoadingCols] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState<string | null>(null);
  const [filterSystem, setFilterSystem] = useState('');
  const [filterOwner, setFilterOwner] = useState('');
  const [filterDomain, setFilterDomain] = useState('');
  const [filterText, setFilterText] = useState('');

  const systemOptions = [...new Set(assets.map((a) => a.systemId).filter(Boolean))].map((id) => ({
    id, name: systemNameById[id] || id,
  }));
  const ownerOptions = ([...new Set(assets.map((a) => a.ownerName).filter(Boolean))] as string[]).sort();
  const domainOptions = ([...new Set(assets.map((a) => a.domainName).filter(Boolean))] as string[]).sort();

  const searchQ = filterText.trim().toLowerCase();
  const filteredAssets = assets.filter((a) => {
    if (filterSystem && a.systemId !== filterSystem) return false;
    if (filterOwner) {
      if (filterOwner === '__none__') { if (a.ownerName) return false; }
      else if ((a.ownerName || '') !== filterOwner) return false;
    }
    if (filterDomain) {
      if (filterDomain === '__none__') { if (a.domainName) return false; }
      else if ((a.domainName || '') !== filterDomain) return false;
    }
    if (searchQ && !(
      a.name.toLowerCase().includes(searchQ) ||
      (a.description || '').toLowerCase().includes(searchQ)
    )) return false;
    return true;
  });

  // Sort — comparators keyed by column key; URL persists ?sort=&dir=. The
  // health and rules comparators sort by the same derived values the cells
  // show (health score, rule count). Unassigned owners sort to the end.
  const { sorted: sortedAssets, sortKey, sortDir, toggleSort } = useSortedList(
    filteredAssets,
    {
      asset: (a, b) => a.name.localeCompare(b.name),
      system: (a, b) => (systemNameById[a.systemId] || '').localeCompare(systemNameById[b.systemId] || ''),
      owner: (a, b) => {
        const an = a.ownerName || '';
        const bn = b.ownerName || '';
        if (!an && !bn) return 0;
        if (!an) return 1;
        if (!bn) return -1;
        return an.localeCompare(bn);
      },
      health: (a, b) => (a.healthScore ?? 0) - (b.healthScore ?? 0),
      rules: (a, b) => (rulesByAsset.get(a.id)?.length ?? 0) - (rulesByAsset.get(b.id)?.length ?? 0),
    },
    'asset',
  );

  const thLocal: React.CSSProperties = {
    textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 600,
    color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em',
  };

  const toggleExpand = async (assetId: string) => {
    if (expandedId === assetId) { setExpandedId(null); return; }
    setExpandedId(assetId);
    setLoadingCols(assetId);
    try {
      const res = await apiClient.get<{ success: boolean; data: ColumnWithHealth[] }>(`/data-assets/${assetId}/columns`);
      setColumnsMap((prev) => ({ ...prev, [assetId]: res.data || [] }));
    } catch { /* */ }
    finally { setLoadingCols(null); }
  };

  const refreshColumns = async (assetId: string) => {
    try {
      const res = await apiClient.get<{ success: boolean; data: ColumnWithHealth[] }>(`/data-assets/${assetId}/columns`);
      setColumnsMap((prev) => ({ ...prev, [assetId]: res.data || [] }));
    } catch { /* */ }
  };

  const quickAddRule = async (assetId: string, col: ColumnWithHealth, ruleType: string) => {
    const dimensions: Record<string, string> = { NOT_NULL: 'COMPLETENESS', UNIQUE: 'UNIQUENESS' };
    try {
      await apiClient.post('/data-quality', {
        dataAssetId: assetId,
        columnId: col.id,
        name: `${col.columnName}: ${ruleType.replace('_', ' ')}`,
        dimension: dimensions[ruleType] || 'VALIDITY',
        ruleType,
        parameters: {},
        threshold: 95,
        ...(activeOrgId ? { orgId: activeOrgId } : {}),
      });
      // Recompute the asset's health so the Rules column / health bar
      // reflect the new rule immediately.
      try { await apiClient.post(`/data-quality/compute-health/${assetId}`); } catch { /* */ }
      addToast('success', `Added ${ruleType.replace('_', ' ')} rule for ${col.columnName}`);
      await refreshColumns(assetId);
      await onRefreshAll();
    } catch { addToast('error', 'Failed to add rule'); }
  };

  const runAllRules = async (e: React.MouseEvent, assetId: string, assetName: string) => {
    e.stopPropagation();
    setRunningAll(assetId);
    try {
      const res = await apiClient.post<{ success: boolean; data: { ran: number; assetHealth: number; results: { name: string; passRate: number; status: string }[] } }>(`/data-quality/run-all/${assetId}`);
      const d = res.data;
      if (d.ran === 0) {
        addToast('info', `${assetName}: no typed rules to run`);
      } else {
        const passing = d.results.filter((r) => r.status === 'PASSING').length;
        addToast(
          passing === d.ran ? 'success' : 'info',
          `${assetName}: ran ${d.ran} rules \u2014 health ${d.assetHealth}%`,
        );
      }
      if (expandedId === assetId) await refreshColumns(assetId);
      await onRefreshAll();
    } catch {
      addToast('error', `Failed to run rules for ${assetName}`);
    } finally {
      setRunningAll(null);
    }
  };

  if (assets.length === 0) {
    return (
      <Card padding="4rem 2rem" shadow="none" style={{ textAlign: 'center' }}>
        <p style={{ color: 'var(--color-text-muted)' }}>No data assets yet. Create data assets on the Data Assets page first.</p>
      </Card>
    );
  }

  // Per-asset derived stats shared by the Health / Rules / Actions columns.
  const assetStats = (a: DataAssetFull) => {
    const rs = rulesByAsset.get(a.id) || [];
    const measured = rs.filter((r) => r.currentScore > 0);
    const passing = rs.filter((r) => r.status === 'PASSING').length;
    const failing = rs.filter((r) => r.status === 'FAILING').length;
    const warn = rs.filter((r) => r.status === 'WARNING').length;
    // A run is "measured" only when a real driver evaluated it. Simulated runs
    // carry a fabricated pass rate and no longer feed the asset's healthScore,
    // so when an asset has rules but none measured, its health is an estimate
    // (connector freshness / manual) — flag it so it isn't read as measured DQ.
    const measuredRuns = rs.filter((r) => r.lastRun && r.lastRun.simulated === false).length;
    const estimated = rs.length > 0 && measuredRuns === 0;
    const score = a.healthScore ?? 0;
    const healthColor = rs.length === 0 ? 'var(--color-text-muted)' : score >= 80 ? 'var(--color-success)' : score >= 50 ? 'var(--color-warning)' : 'var(--color-error)';
    const totalWeight = rs.reduce((s, r) => s + r.weight, 0);
    const healthTooltip = rs.length === 0
      ? 'No rules defined. Add rules to calculate health.'
      : estimated
        ? `Health: ${score}% (estimated)\nThis asset's ${rs.length} rule${rs.length > 1 ? 's have' : ' has'} only simulated results, so they don't count toward measured health. The shown value comes from connector freshness or a manual score.\nMeasured DQ comes from a local-file (CSV) upload, a direct-connect database Connection, or an on-prem connector (the five supported types: NOT_NULL, UNIQUE, IN_SET, NUMERIC_RANGE, LENGTH_RANGE, run as a pushdown query). Data-warehouse Connections and REGEX_MATCH/CUSTOM rules still simulate.`
        : `Health: ${score}%\nWeighted average of ${measuredRuns} measured rule${measuredRuns > 1 ? 's' : ''} (of ${rs.length} total)\nFormula: Σ(score × weight) / Σ(weight)\nTotal weight: ${totalWeight}\nPassing: ${passing} | Warning: ${warn} | Failing: ${failing}`;
    return { rs, measured, measuredRuns, estimated, passing, failing, warn, score, healthColor, totalWeight, healthTooltip };
  };

  const assetColumns = [
    {
      key: 'asset', header: 'Asset', sortable: true, cellStyle: { fontWeight: 500 },
      render: (a: DataAssetFull) => (
        <>
          {a.name}
          {a.description && (
            <TruncatedText
              text={a.description}
              style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 400, marginTop: 1 }}
            />
          )}
        </>
      ),
    },
    assetCols.isVisible('system') && {
      key: 'system', header: 'System', sortable: true,
      render: (a: DataAssetFull) => systemNameById[a.systemId] || <span style={{ color: 'var(--color-text-muted)' }}>--</span>,
    },
    assetCols.isVisible('owner') && {
      key: 'owner', header: 'Owner', sortable: true,
      render: (a: DataAssetFull) => a.ownerName || <span style={{ color: 'var(--color-text-muted)' }}>--</span>,
    },
    assetCols.isVisible('health') && {
      key: 'health', header: 'Health', sortable: true,
      render: (a: DataAssetFull) => {
        const { score, healthColor, healthTooltip, estimated } = assetStats(a);
        return (
          <div title={healthTooltip} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'help' }}>
            <div style={{ flex: 1, maxWidth: 80, height: 6, borderRadius: 3, background: 'var(--color-border)', overflow: 'hidden' }}>
              <div style={{ width: `${score}%`, height: '100%', borderRadius: 3, background: healthColor }} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 500, color: healthColor }}>{score}%</span>
            {estimated && (
              <span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-warning)', border: '1px solid var(--color-warning)', borderRadius: 4, padding: '0 4px' }}>
                Est
              </span>
            )}
          </div>
        );
      },
    },
    assetCols.isVisible('rules') && {
      key: 'rules', header: 'Rules', sortable: true, cellStyle: { fontSize: 12 },
      render: (a: DataAssetFull) => {
        const { rs, passing, warn, failing } = assetStats(a);
        return rs.length === 0 ? (
          <span style={{ color: 'var(--color-text-muted)' }}>No rules</span>
        ) : (
          <span>
            {rs.length} total
            {passing > 0 && <span style={{ color: 'var(--color-success)', marginLeft: 6 }}>{'✔'} {passing}</span>}
            {warn > 0 && <span style={{ color: '#ca8a04', marginLeft: 6 }}>{'⚠'} {warn}</span>}
            {failing > 0 && <span style={{ color: 'var(--color-error)', marginLeft: 6 }}>{'✖'} {failing}</span>}
          </span>
        );
      },
    },
    {
      key: 'actions', header: 'Actions', align: 'center' as const,
      render: (a: DataAssetFull) => {
        const { rs } = assetStats(a);
        // runAllRules calls e.stopPropagation() itself, so clicking Run all
        // does not also toggle the row in trigger:'row-click' mode.
        return rs.length > 0 ? (
          <IconButton
            size="sm"
            icon="play"
            label={runningAll === a.id ? 'Running…' : 'Run all rules'}
            onClick={(e) => runAllRules(e, a.id, a.name)}
            disabled={runningAll !== null}
          />
        ) : null;
      },
    },
  ].filter(Boolean) as DataTableColumn<DataAssetFull>[];

  // Toolbar for the Quality tab — Export the asset-health view and a Columns
  // picker, portaled onto the hub's tab row so this tab matches the Registry
  // and Rules tabs. (The per-tab "add" differs: Quality has no add — you add
  // rules on the Rules tab and assets on the Registry tab.)
  const qualityActions = (
    <>
      {filteredAssets.length > 0 && (
        <ExportMenu build={() => ({
          filenameBase: 'data-asset-health',
          sheetName: 'Asset Health',
          headers: ['Asset', 'System', 'Owner', 'Health %', 'Rules', 'Passing', 'Warning', 'Failing'],
          rows: filteredAssets.map((a) => {
            const { rs, passing, warn, failing, score } = assetStats(a);
            return [a.name, systemNameById[a.systemId] || '', a.ownerName || '', score, rs.length, passing, warn, failing];
          }),
        })} />
      )}
      <ColumnPicker state={assetCols} />
    </>
  );

  // Expanded region is page-owned: DataTable never fetches. Columns are
  // lazy-loaded into columnsMap by toggleExpand.
  const renderExpandedRow = (a: DataAssetFull) => {
    const cols = columnsMap[a.id] || [];
    return (
      <div style={{ padding: '12px 20px 12px 50px' }}>
        {loadingCols === a.id ? (
          <Spinner label="Loading…" />
        ) : cols.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: 8 }}>
            No columns defined. Auto-discover them from the Data Assets page.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--color-bg)' }}>
                <th scope="col" style={{ ...thLocal, fontSize: 10, padding: '6px 10px' }}>Column</th>
                <th scope="col" style={{ ...thLocal, fontSize: 10, padding: '6px 10px' }}>Type</th>
                <th scope="col" style={{ ...thLocal, fontSize: 10, padding: '6px 10px' }}>Health</th>
                <th scope="col" style={{ ...thLocal, fontSize: 10, padding: '6px 10px' }}>Rules</th>
                <th scope="col" style={{ ...thLocal, fontSize: 10, padding: '6px 10px', textAlign: 'center' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {cols.map((col) => {
                const h = col.healthScore;
                const hc = h == null ? 'var(--color-text-muted)' : h >= 80 ? 'var(--color-success)' : h >= 50 ? 'var(--color-warning)' : 'var(--color-error)';
                return (
                  <tr key={col.id}>
                    <td style={{ padding: '5px 10px', borderTop: '1px solid var(--color-border)', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
                      {col.columnName}
                    </td>
                    <td style={{ padding: '5px 10px', borderTop: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>{col.dataType || '—'}</td>
                    <td style={{ padding: '5px 10px', borderTop: '1px solid var(--color-border)' }}>
                      {h != null ? (
                        <span style={{ fontWeight: 600, fontSize: 12, color: hc }}>{h}%</span>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{(col.rulesCount || 0) > 0 ? 'Not run' : '—'}</span>
                      )}
                    </td>
                    <td style={{ padding: '5px 10px', borderTop: '1px solid var(--color-border)', fontSize: 11 }}>
                      {(col.rulesCount || 0) > 0 ? (
                        <span>
                          {col.rulesCount}
                          {(col.rulesPassing || 0) > 0 && <span style={{ color: 'var(--color-success)', marginLeft: 4 }}>{'✔'}{col.rulesPassing}</span>}
                          {(col.rulesFailing || 0) > 0 && <span style={{ color: 'var(--color-error)', marginLeft: 4 }}>{'✖'}{col.rulesFailing}</span>}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--color-text-muted)' }}>None</span>
                      )}
                    </td>
                    <td style={{ padding: '5px 10px', borderTop: '1px solid var(--color-border)', textAlign: 'center' }}>
                      <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                        <IconButton size="sm" icon="check" label="Add NOT NULL rule" onClick={() => quickAddRule(a.id, col, 'NOT_NULL')} />
                        <IconButton size="sm" icon="check" label="Add UNIQUE rule" onClick={() => quickAddRule(a.id, col, 'UNIQUE')} />
                        <IconButton size="sm" icon="settings" label="Manage rules for this column" onClick={() => onManageRules(a, col.columnName)} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      {actionsPortal && createPortal(qualityActions, actionsPortal)}
      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <SearchInput
          value={filterText}
          onChange={setFilterText}
          placeholder="Search assets…"
          ariaLabel="Search assets"
          width={200}
        />
        <select aria-label="Filter by system" style={{ ...selectStyle, width: 'auto', minWidth: 140 }} value={filterSystem} onChange={(e) => setFilterSystem(e.target.value)}>
          <option value="">All Systems</option>
          {systemOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select aria-label="Filter by owner" style={{ ...selectStyle, width: 'auto', minWidth: 140 }} value={filterOwner} onChange={(e) => setFilterOwner(e.target.value)}>
          <option value="">All Owners</option>
          {ownerOptions.map((o) => <option key={o} value={o}>{o}</option>)}
          <option value="__none__">No owner ({assets.filter((a) => !a.ownerName).length})</option>
        </select>
        <select aria-label="Filter by domain" style={{ ...selectStyle, width: 'auto', minWidth: 140 }} value={filterDomain} onChange={(e) => setFilterDomain(e.target.value)}>
          <option value="">All Domains</option>
          {domainOptions.map((d) => <option key={d} value={d}>{d}</option>)}
          <option value="__none__">No domain ({assets.filter((a) => !a.domainName).length})</option>
        </select>
        {(filterSystem || filterOwner || filterDomain || filterText) && (
          <button onClick={() => { setFilterSystem(''); setFilterOwner(''); setFilterDomain(''); setFilterText(''); }} style={{ fontSize: 11, color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
            Clear filters
          </button>
        )}
        {(filterSystem || filterOwner || filterDomain || filterText) && (
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            Showing {filteredAssets.length} of {assets.length}
          </span>
        )}
      </div>
      <Card padding={0} shadow="none">
        <DataTable
          rows={sortedAssets}
          columns={assetColumns}
          rowKey={(a) => a.id}
          sort={{ sortKey, sortDir, onSort: toggleSort }}
          expansion={{
            expandedIds: expandedId ? new Set([expandedId]) : new Set<string>(),
            onToggleExpanded: toggleExpand,
            renderExpandedRow,
            trigger: 'row-click',
          }}
          emptyMessage="No assets match the current filters."
        />
      </Card>
    </div>
  );
}
