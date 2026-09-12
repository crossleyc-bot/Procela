import React, { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import PageHeader from '../components/PageHeader';
import CreateScopeNotice from '../components/CreateScopeNotice';
import SectionLabel from '../components/SectionLabel';
import Card from '../components/Card';
import FieldStack from '../components/FieldStack';
import Spinner from '../components/Spinner';
import Modal from '../components/Modal';
import { useNavigate, useSearchParams } from 'react-router-dom';
import WhereUsed, { WhereUsedGroup } from '../components/WhereUsed';
import { OwnerBadge, isInheritedAsset } from '../components/OwnerBadge';
import { useOrgNameLookup } from '../hooks/useOrgNameLookup';
import { apiClient } from '../api/client';
import { useTierLabel, TIER_VALUES, compareTier } from '../lib/governanceTier';
import { useColumnPicker } from '../hooks/useColumnPicker';
import ColumnPicker from '../components/ColumnPicker';
import { useOrgContext } from '../stores/orgContext';
import ExportMenu from '../components/ExportMenu';
import SensitivityPanel from '../components/SensitivityPanel';
import ImpactAnalysisPanel from '../components/ImpactAnalysisPanel';
import CommentsPanel from '../components/CommentsPanel';
import { renderNavIcon } from '../components/navIcons';
import ActivityFeed from '../components/ActivityFeed';
import SavedViewsMenu from '../components/SavedViewsMenu';
import { usePolling } from '../hooks/usePolling';
import { usePermissions } from '../hooks/usePermissions';
import { useAiEnabled } from '../stores/aiConfigStore';
import ConfirmDialog from '../components/ConfirmDialog';
import IconButton from '../components/IconButton';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import ErrorState from '../components/ErrorState';
import HelpPopover from '../components/HelpPopover';
import { SkeletonRows } from '../components/Skeleton';
import PersonPicker from '../components/PersonPicker';
import BulkSelectHint from '../components/BulkSelectHint';
import { useSortedList } from '../hooks/useSortedList';
import { useRowSelection } from '../hooks/useRowSelection';
import BulkActionBar, { BulkActionButton } from '../components/BulkActionBar';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import HealthBar from '../components/HealthBar';
import TierBadge from '../components/TierBadge';
import { useToastStore } from '../stores/toastStore';
import { errorMessage, errorToast } from '../lib/errorToast';
import { clickable } from '../lib/a11y';
// Lazy: only renders when the user clicks "Link to connection" on a row.
const LinkConnectionModal = lazy(() => import('../components/LinkConnectionModal'));
import UnsavedBanner from '../components/UnsavedBanner';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import SectionCard from '../components/SectionCard';
import { useFormValidation, fieldErrorStyle, inputErrorBorder } from '../hooks/useFormValidation';
import { formatPersonLabel } from '../lib/personLabel';

interface DataAssetEntity {
  id: string;
  name: string;
  description: string;
  systemId: string;
  // Owning org. Asset is editable only when this matches the active
  // "Working in..." scope; otherwise the row renders an OwnerBadge
  // and gates every edit surface with isInheritedAsset.
  orgId?: string;
  /** @deprecated free-text owner; prefer ownerPersonId */
  owner?: string;
  ownerPersonId?: string | null;
  stewardIds?: string[];
  governanceTier?: 'BRONZE' | 'SILVER' | 'GOLD';
  healthScore?: number;
  healthScoreAt?: string | null;
  /** True when this asset is the authoritative system-of-record (golden copy). */
  isSystemOfRecord?: boolean;
  /** Content classification (Master/Reference/Transactional/Analytical/Metadata). */
  dataType?: string;
  /** @deprecated mixed-axis legacy enum; replaced by dataType. */
  category?: string;
  /** @deprecated free-text retention; prefer retentionDuration + retentionReason */
  retentionPolicy?: string;
  retentionDuration?: { value: number; unit: 'DAYS' | 'MONTHS' | 'YEARS' };
  retentionReason?: string;
  refreshFrequency?: string;
  origin?: 'MANUAL' | 'GOVERNANCE_TEMPLATE' | 'DISCOVERED' | 'IMPORTED' | 'SYNCED';
  /** Human-accepted sensitivity classification. Populated via the
   *  Suggest & Review flow (POST /:id/suggest-sensitivity → user
   *  Accept/Reject → PUT /:id/sensitivity). Empty means untagged. */
  sensitivityTags?: Array<'PII' | 'PHI' | 'PCI' | 'FINANCIAL' | 'CREDENTIAL' | 'CONFIDENTIAL' | 'PUBLIC' | 'CUI' | 'ITAR' | 'EXPORT_CONTROLLED'>;
  /** Set by the on-prem connector when it last refreshed this asset.
   *  Drives the freshness chip on the row so users can tell at a
   *  glance whether the metadata reflects reality. */
  lastSyncedByConnectorId?: string | null;
  lastSyncedAt?: string | null;
  /** Latest connector-reported row count (approximate — engine
   *  statistics). Rendered as a compact "N rows" chip next to the sync
   *  freshness chip. Undefined for manually-created assets. */
  rowCount?: number | null;
  /** @deprecated use bindings */
  sourceConnectionId?: string;
  /** @deprecated use bindings */
  sourceAsset?: string;
  /** @deprecated use bindings */
  sourceColumn?: string;
  createdAt: string;
  updatedAt: string;
  // Enriched by the list endpoint so the table can render inline.
  domainName?: string | null;
  ownerName?: string | null;
  // Owner-resolution provenance. 'asset' = a specific person is
  // assigned on this row; 'domain' = inherited from the containing
  // domain's owner (ownerName still populated for display); null
  // = no owner anywhere. Drives the "Inherits from domain / Overrides
  // domain" hint under the Owner picker in the edit form.
  ownerSource?: 'asset' | 'domain' | null;
  domainOwnerId?: string | null;
  domainOwnerName?: string | null;
  stewardName?: string | null;
  // Steward-resolution provenance, same shape as ownerSource.
  // 'asset' = row has its own stewardIds list; 'domain' = inherited
  // from the domain's stewards; null = neither. domainStewardIds /
  // domainStewardNames are always populated when the domain has
  // stewards so the form can render "Overrides domain (…)" plus
  // the effective domain-level list.
  stewardSource?: 'asset' | 'domain' | null;
  domainStewardIds?: string[];
  domainStewardNames?: string[];
  /** Highest tier the asset is eligible for given current signals.
   *  Advisory only — set by the backend, never persisted. The UI shows
   *  a Promote prompt when this exceeds the actual governanceTier. */
  suggestedTier?: 'BRONZE' | 'SILVER' | 'GOLD';
  /** True when no process-step mapping points at this asset — the
   *  "orphan" signal that used to live on its own page. Drives the
   *  Unmapped row badge and the mapping-status filter. */
  isOrphan?: boolean;
  /** DQ coverage counts (from the list endpoint) that drive the rules
   *  filter: total rules on the asset, and how many have a real
   *  (non-simulated) measured result. */
  ruleCount?: number;
  measuredRuleCount?: number;
}

interface SystemRef {
  id: string;
  name: string;
}

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


interface Asset360Column {
  id: string;
  columnName: string;
  dataType?: string;
  sourceColumn?: string;
  rulesCount: number;
  healthScore: number | null;
  isPrimaryKey?: boolean;
  references?: string;
}
interface Asset360Data {
  asset: DataAssetEntity;
  system: { id: string; name: string; systemType: string } | null;
  domain: { id: string; name: string; ownerName: string | null; stewards: { id: string; name: string }[] } | null;
  mappings: { id: string; processStepId: string; linkType: string; notes: string; processPath: string }[];
  ownerInfo: { id: string | null; name: string } | null;
  stewardInfos: { id: string; name: string }[];
  binding: {
    id: string;
    connectionId: string;
    sourceAsset: string;
    sourceColumn?: string;
    sourceColumns: string[];
    label?: string;
  } | null;
  columns: Asset360Column[];
}

interface FormData {
  name: string;
  description: string;
  systemId: string;
  ownerPersonId: string;
  stewardIds: string[];
  governanceTier: string;
  isSystemOfRecord: boolean;
  domainId: string;
  dataType: string;
  retentionDurationValue: string;
  retentionDurationUnit: 'DAYS' | 'MONTHS' | 'YEARS' | '';
  retentionReason: string;
  refreshFrequency: string;
  sourceConnectionId: string;
  sourceAsset: string;
  sourceColumn: string;
}

const emptyForm: FormData = {
  name: '',
  description: '',
  systemId: '',
  ownerPersonId: '',
  stewardIds: [],
  governanceTier: 'BRONZE',
  isSystemOfRecord: false,
  domainId: '',
  dataType: '',
  retentionDurationValue: '',
  retentionDurationUnit: '',
  retentionReason: '',
  refreshFrequency: '',
  sourceConnectionId: '',
  sourceAsset: '',
  sourceColumn: '',
};

interface ColumnRule {
  id: string;
  name: string;
  ruleType: string | null;
  dimension: string;
  threshold: number;
  currentScore: number;
  status: string;
  lastMeasured: string | null;
  weight: number;
}

interface DataAssetColumn {
  id: string;
  dataAssetId: string;
  columnName: string;
  dataType?: string;
  description?: string;
  sourceConnectionId?: string;
  sourceAsset?: string;
  sourceColumn?: string;
  rulesCount?: number;
  rulesPassing?: number;
  rulesFailing?: number;
  rulesWarning?: number;
  healthScore?: number | null;
  rules?: ColumnRule[];
  isPrimaryKey?: boolean;
  references?: string;
}

const ORIGIN_BADGE: Record<string, { label: string; bg: string; fg: string; title: string }> = {
  GOVERNANCE_TEMPLATE: { label: 'Gov',       bg: '#ede9fe', fg: '#5b21b6', title: 'Seeded by the Data Governance value stream' },
  DISCOVERED:          { label: 'Discovered', bg: '#dbeafe', fg: '#1e40af', title: 'Created from a connection scan' },
  IMPORTED:            { label: 'Imported',  bg: '#fef3c7', fg: '#92400e', title: 'Created via bulk import' },
  SYNCED:              { label: 'Synced',    bg: '#dcfce7', fg: '#166534', title: 'Created by a sync connection' },
};

// "Unmapped" pill — shown when no process-step mapping references the
// asset (backend `isOrphan`). This is the orphan signal that used to be
// its own page; surfacing it inline lets a steward spot cleanup / fresh-
// mapping candidates without leaving the catalog. Amber to read as
// "worth a look", not an error. Palette kept as hex (semantic-badge
// convention) so it doesn't drift when --color-warning is retuned.
function UnmappedBadge({ isOrphan }: { isOrphan?: boolean }) {
  if (!isOrphan) return null;
  return (
    <span
      title="Not mapped to any process step — investigate, map it to a step, or retire it."
      style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 600, background: '#fef3c7', color: '#92400e', letterSpacing: '0.02em' }}
    >
      Unmapped
    </span>
  );
}

function OriginBadge({ origin }: { origin?: string }) {
  if (!origin || origin === 'MANUAL') return null;
  const m = ORIGIN_BADGE[origin];
  if (!m) return null;
  return (
    <span
      title={m.title}
      style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 500, background: m.bg, color: m.fg }}
    >
      {m.label}
    </span>
  );
}

// "Synced N min ago" pill — appears only when an on-prem connector
// has reported on this asset. Same three buckets as the Settings
// connector list (online / stale / offline) so admins can correlate
// at a glance.
function SyncFreshnessChip({ lastSyncedAt }: { lastSyncedAt?: string | null }) {
  if (!lastSyncedAt) return null;
  const ms = Date.now() - new Date(lastSyncedAt).getTime();
  let bg = '#dcfce7', color = '#166534', label: string;
  if (ms < 30 * 60_000) {
    label = 'Live';
  } else if (ms < 4 * 60 * 60_000) {
    bg = '#fef3c7'; color = '#92400e';
    const m = Math.floor(ms / 60_000);
    label = m < 60 ? `Synced ${m}m ago` : `Synced ${Math.floor(m / 60)}h ago`;
  } else {
    bg = '#fee2e2'; color = '#991b1b';
    const h = Math.floor(ms / 3_600_000);
    label = h < 24 ? `Synced ${h}h ago` : `Synced ${Math.floor(h / 24)}d ago`;
  }
  return (
    <span
      title={`Last connector sync: ${new Date(lastSyncedAt).toLocaleString()}`}
      style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 500, background: bg, color }}
    >
      {label}
    </span>
  );
}

// Compact "N rows" pill — the latest connector-reported row count. The
// count is approximate (engine statistics, not a live COUNT(*)), so the
// label is abbreviated (2.4M rows) with the exact figure in the tooltip.
// Renders only when a connector has reported one.
function RowCountChip({ rowCount }: { rowCount?: number | null }) {
  if (rowCount === null || rowCount === undefined) return null;
  const n = rowCount;
  const label = n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
    : n >= 1_000 ? `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
    : String(n);
  return (
    <span
      title={`${n.toLocaleString()} rows (approximate — last connector scan)`}
      style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 500, background: 'var(--color-bg)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
    >
      {label} rows
    </span>
  );
}

// Toggleable columns. Name + Actions are always visible; everything
// listed here is user-controllable from the Columns popover. Order
// here is the render order in the table.
// 'description' is no longer a toggleable column — it renders as a
// single-line sub-label under the asset name (see the Asset cell), so
// the row reads name-over-description like a directory entry.
type ColumnId = 'system' | 'source' | 'tier' | 'health' | 'domain' | 'owner' | 'steward';
const COLUMN_DEFS: Array<{ id: ColumnId; label: string; defaultVisible: boolean }> = [
  { id: 'system',      label: 'System',      defaultVisible: true  },
  { id: 'source',      label: 'Source',      defaultVisible: false },
  { id: 'tier',        label: 'Tier',        defaultVisible: true  },
  // Health is off by default here — it's the Quality tab's focus (with the
  // rule breakdown). Registry leads with catalog/governance attributes
  // (Tier, Domain, Owner); health stays one click away in the column picker.
  { id: 'health',      label: 'Health',      defaultVisible: false },
  { id: 'domain',      label: 'Domain',      defaultVisible: true  },
  { id: 'owner',       label: 'Owner',       defaultVisible: true  },
  { id: 'steward',     label: 'Steward',     defaultVisible: false },
];
const COLUMN_STORAGE_KEY = 'procela.dataAssets.visibleCols.v1';

export default function DataAssetsPage({
  embedded = false,
  actionsPortal,
}: {
  embedded?: boolean;
  /** When embedded in the Data Assets hub, the toolbar renders into this
   *  slot (the tab-bar row) instead of a strip below the tabs. */
  actionsPortal?: HTMLElement | null;
} = {}) {
  const { activeOrgId, canCreateValueStreams } = useOrgContext();
  // Resolves a row's orgId to a display name so the OwnerBadge can
  // render "Owned by Tidewater Utilities" on inherited rows.
  const { getOrgName } = useOrgNameLookup();
  // Ownership-level guard. canCreateValueStreams is the store's
  // canonical "this org can own scoped artefacts" boolean — same
  // rule applies to data assets and systems, so we reuse it
  // directly. Departments / teams can't own; only company /
  // division can.
  const canOwnHere = canCreateValueStreams;
  const { canWrite } = usePermissions();
  const aiEnabled = useAiEnabled();
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const tierLabel = useTierLabel();
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight');
  const [assets, setAssets] = useState<DataAssetEntity[]>([]);
  const [systems, setSystems] = useState<SystemRef[]>([]);
  const [peopleList, setPeopleList] = useState<{ id: string; name: string }[]>([]);
  const [domainsList, setDomainsList] = useState<{ id: string; name: string; dataAssetIds: string[]; ownerId?: string | null; ownerName?: string | null; stewardIds?: string[]; stewards?: { id: string; name: string }[] }[]>([]);
  const [standardDataTypes, setStandardDataTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showAdvancedFields, setShowAdvancedFields] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);
  const formValidation = useFormValidation({
    name: (v: any) => !v?.trim() ? 'Name is required.' : null,
    sourceAsset: (v: any, form: any) => form?.sourceConnectionId && !v?.trim()
      ? 'Pick the table / file / asset to link to.'
      : null,
  });
  const [filterCategory, setFilterCategory] = useState('');
  // Seeded from ?tier= so the Dashboard's Governance Posture donut can deep-link
  // to a tier-filtered view (e.g. /data-assets?tier=BRONZE).
  const [filterTier, setFilterTier] = useState<string>(
    () => { const t = (searchParams.get('tier') || '').toUpperCase(); return TIER_VALUES.includes(t as never) ? t : ''; },
  );
  const [filterSystemId, setFilterSystemId] = useState('');
  const [filterOrigin, setFilterOrigin] = useState<'' | 'MANUAL' | 'GOVERNANCE_TEMPLATE' | 'DISCOVERED' | 'IMPORTED' | 'SYNCED'>('');
  // Mapping-status filter — folds in the old Orphan Assets page. 'unmapped'
  // shows only orphans (assets no process step uses); 'mapped' the inverse.
  // Seeded from ?mapping= so /data-assets?mapping=unmapped (the redirect
  // target for the retired /data-assets/orphans route) lands pre-filtered.
  // DQ coverage filter: '' all · 'has' any rule · 'none' no rules ·
  // 'unmeasured' has rules but none measured (health is estimated, not real).
  const [filterCoverage, setFilterCoverage] = useState<'' | 'has' | 'none' | 'unmeasured'>('');
  const [filterMapping, setFilterMapping] = useState<'' | 'mapped' | 'unmapped'>(
    () => { const m = searchParams.get('mapping'); return m === 'mapped' || m === 'unmapped' ? m : ''; },
  );
  // Owner / Domain filters — match by the effective owner/domain name shown in
  // the list columns; '__none__' isolates the unassigned buckets.
  const [filterOwner, setFilterOwner] = useState('');
  const [filterDomain, setFilterDomain] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // Keep the URL in sync with the mapping filter so the view is
  // shareable/bookmarkable and the browser back button restores it,
  // mirroring how the retired orphans page was a distinct URL.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (filterMapping) next.set('mapping', filterMapping); else next.delete('mapping');
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [filterMapping]); // eslint-disable-line react-hooks/exhaustive-deps

  // Column visibility — toggleable from the Columns popover via the
  // shared hook + component. Storage key and column defs declared above.
  const colPicker = useColumnPicker<ColumnId>(COLUMN_STORAGE_KEY, COLUMN_DEFS);
  const isVisible = colPicker.isVisible;
  const [viewing360, setViewing360] = useState<Asset360Data | null>(null);
  const [loading360, setLoading360] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  // Duplicate-name soft-warn: stashes the pending save so the ConfirmDialog
  // can resume it on confirm. `keepOpen` mirrors the handleSave argument.
  const [confirmDuplicate, setConfirmDuplicate] = useState<{ name: string; keepOpen: boolean } | null>(null);
  // Confirm before deleting a column that has DQ rules referencing it —
  // deleting the column leaves those rules orphaned (they keep their
  // dataAssetId + denormalized columnName but their columnId dangles).
  const [confirmColDelete, setConfirmColDelete] = useState<{ assetId: string; colId: string; columnName: string; rulesCount: number } | null>(null);

  // Source-connection discovery state — populated when the user clicks
  // "Discover" on the Link to Source block so they can pick a table /
  // file / sheet / endpoint instead of typing one. Reset on every
  // connection change so the dropdown matches the current connection.
  const [sourceDiscovering, setSourceDiscovering] = useState(false);
  const [sourceDiscovered, setSourceDiscovered] = useState<Array<{ name: string; type?: string }>>([]);
  const [sourceDiscoverError, setSourceDiscoverError] = useState<string | null>(null);

  // Column state — expandable per-asset
  const [expandedAssetId, setExpandedAssetId] = useState<string | null>(null);
  const [columnsMap, setColumnsMap] = useState<Record<string, DataAssetColumn[]>>({});
  const [columnsLoading, setColumnsLoading] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [expandedColumnIds, setExpandedColumnIds] = useState<Set<string>>(new Set());
  const toggleColumnExpand = (colId: string) => setExpandedColumnIds((prev) => {
    const next = new Set(prev);
    if (next.has(colId)) next.delete(colId); else next.add(colId);
    return next;
  });
  // Inline comments state previously lived here. Now replaced by the
  // shared CommentsPanel component, which handles threading, mentions,
  // and notifications consistently with the rest of the app.

  // Binding state: one primary binding per asset is the common case. We
  // fetch them in one roundtrip keyed by asset id and expose tiny bits
  // (connection name + column) inline on each row.
  interface BindingRow {
    id: string;
    connectionId: string;
    sourceAsset: string;
    sourceColumn?: string;
    sourceColumns?: string[];
    isPrimary: boolean;
  }
  const [bindingsByAsset, setBindingsByAsset] = useState<Record<string, BindingRow[]>>({});
  const [connectionNameById, setConnectionNameById] = useState<Record<string, string>>({});
  const [connectionsList, setConnectionsList] = useState<Array<{ id: string; name: string; connectionType: string }>>([]);
  const [linkModalAsset, setLinkModalAsset] = useState<DataAssetEntity | null>(null);
  const [linkModalMode, setLinkModalMode] = useState<'new' | 'change'>('new');
  // Asset-rooted "Suggest source" — opens a small modal with ranked
  // candidate bindings drawn from existing connections in the org.
  const [suggestAsset, setSuggestAsset] = useState<DataAssetEntity | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{
    connectionId: string; connectionName: string; connectionType: string;
    sourceAsset: string; sourceColumn: string | null; score: number; reason: string;
  }>>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestBusyId, setSuggestBusyId] = useState<string | null>(null);

  const openSuggestSource = async (asset: DataAssetEntity) => {
    setSuggestAsset(asset);
    setSuggestions([]);
    setSuggestLoading(true);
    try {
      const res = await apiClient.get<{ success: boolean; data: typeof suggestions }>(`/data-assets/${asset.id}/suggest-source`);
      setSuggestions(res.data || []);
    } catch (err) {
      addToast('error', errorMessage(err, 'Could not load suggestions'));
    } finally {
      setSuggestLoading(false);
    }
  };

  const acceptSuggestion = async (s: typeof suggestions[number]) => {
    if (!suggestAsset) return;
    const key = `${s.connectionId}::${s.sourceAsset}::${s.sourceColumn || ''}`;
    setSuggestBusyId(key);
    try {
      await apiClient.post(`/data-assets/${suggestAsset.id}/bindings`, {
        connectionId: s.connectionId,
        sourceAsset: s.sourceAsset,
        ...(s.sourceColumn ? { sourceColumn: s.sourceColumn } : {}),
        isPrimary: true,
      });
      addToast('success', `Bound "${suggestAsset.name}" to ${s.sourceAsset}${s.sourceColumn ? '.' + s.sourceColumn : ''}`);
      setSuggestAsset(null);
      fetchData();
    } catch (err) {
      addToast('error', errorMessage(err, 'Could not create binding'));
    } finally {
      setSuggestBusyId(null);
    }
  };

  const fetchData = useCallback(async () => {
    try {
      setLoadError(null);
      const query = activeOrgId ? `?orgId=${activeOrgId}` : '';
      const [assetRes, connRes, peopleRes, domainsRes] = await Promise.all([
        apiClient.get<{ success: boolean; data: DataAssetEntity[]; systems: SystemRef[] }>(`/data-assets${query}`),
        apiClient.get<{ success: boolean; data: Array<{ id: string; name: string }> }>(`/connections${query}`),
        apiClient.get<{ success: boolean; data: Array<{ id: string; name: string }> }>(`/people${query}`),
        apiClient.get<{ success: boolean; data: Array<{ id: string; name: string; dataAssetIds: string[]; ownerId?: string | null; ownerName?: string | null; stewardIds?: string[]; stewards?: { id: string; name: string }[] }> }>(`/data-domains${query}`),
      ]);
      setPeopleList(peopleRes.data || []);
      setDomainsList(domainsRes.data || []);
      const nextAssets = assetRes.data || [];
      setAssets(nextAssets);
      setSystems(assetRes.systems || []);
      setStandardDataTypes((assetRes as any).dataTypes || []);
      // Build a lookup of connection names so the binding column can show
      // "<conn-name> / <asset>.<col>" without a second trip per row.
      const connList = connRes.data || [];
      const cmap: Record<string, string> = {};
      for (const c of connList) cmap[c.id] = c.name;
      setConnectionNameById(cmap);
      setConnectionsList(connList as any);
      // Fan-out: fetch bindings per asset in parallel. Small N in practice;
      // if this grows we'll add a bulk endpoint.
      const entries = await Promise.all(nextAssets.map(async (a) => {
        try {
          const res = await apiClient.get<{ success: boolean; data: BindingRow[] }>(`/data-assets/${a.id}/bindings`);
          return [a.id, res.data || []] as const;
        } catch { return [a.id, [] as BindingRow[]] as const; }
      }));
      const map: Record<string, BindingRow[]> = {};
      for (const [id, bs] of entries) map[id] = bs;
      setBindingsByAsset(map);
    } catch (err) { setLoadError(errorMessage(err, 'Failed to load data assets.')); }
    finally { setLoading(false); }
  }, [activeOrgId]);

  const primaryBindingOf = (assetId: string): BindingRow | undefined => {
    const list = bindingsByAsset[assetId] || [];
    return list.find((b) => b.isPrimary) || list[0];
  };

  // The named column set a binding resolves to (empty = whole table/file).
  const bindingColumnSet = (b?: { sourceColumns?: string[]; sourceColumn?: string }): string[] => {
    if (!b) return [];
    if (b.sourceColumns && b.sourceColumns.length) return b.sourceColumns;
    return b.sourceColumn ? [b.sourceColumn] : [];
  };
  // Compact "table" / "table.col" / "table · 3 cols" label for list rows.
  const bindingSourceLabel = (b?: { sourceAsset: string; sourceColumns?: string[]; sourceColumn?: string }): string => {
    if (!b) return '';
    const cols = bindingColumnSet(b);
    if (cols.length === 0) return b.sourceAsset;
    if (cols.length === 1) return `${b.sourceAsset}.${cols[0]}`;
    return `${b.sourceAsset} · ${cols.length} cols`;
  };

  const unlinkPrimary = async (asset: DataAssetEntity) => {
    const b = primaryBindingOf(asset.id);
    if (!b) return;
    try {
      await apiClient.delete(`/data-assets/${asset.id}/bindings/${b.id}`);
      fetchData();
    } catch { /* */ }
  };

  useEffect(() => { fetchData(); }, [fetchData]);

  usePolling(fetchData, 30000);

  // Highlight row when arriving from global search
  useEffect(() => {
    if (highlightId) {
      const el = document.getElementById(`row-${highlightId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.animation = 'highlightPulse 2s ease-out';
        setTimeout(() => {
          el.style.animation = '';
          const params = new URLSearchParams(searchParams);
          params.delete('highlight');
          setSearchParams(params, { replace: true });
        }, 2000);
      }
    }
  }, [highlightId]); // eslint-disable-line react-hooks/exhaustive-deps

  const systemName = (systemId: string) => {
    const sys = systems.find((s) => s.id === systemId);
    return sys ? sys.name : '';
  };

  const filteredAssets = assets.filter((a) => {
    if (filterCategory) {
      if (filterCategory === '__none__') { if (a.dataType) return false; }
      else if ((a.dataType || '') !== filterCategory) return false;
    }
    if (filterTier && (a.governanceTier || 'BRONZE') !== filterTier) return false;
    if (filterSystemId && a.systemId !== filterSystemId) return false;
    if (filterOwner) {
      if (filterOwner === '__none__') { if (a.ownerName) return false; }
      else if ((a.ownerName || '') !== filterOwner) return false;
    }
    if (filterDomain) {
      if (filterDomain === '__none__') { if (a.domainName) return false; }
      else if ((a.domainName || '') !== filterDomain) return false;
    }
    if (filterOrigin && (a.origin || 'MANUAL') !== filterOrigin) return false;
    if (filterMapping === 'unmapped' && !a.isOrphan) return false;
    if (filterMapping === 'mapped' && a.isOrphan) return false;
    if (filterCoverage) {
      const rc = a.ruleCount || 0;
      const mc = a.measuredRuleCount || 0;
      if (filterCoverage === 'has' && rc === 0) return false;
      if (filterCoverage === 'none' && rc > 0) return false;
      // "Est" — has rules but none are actually measured (all simulated or
      // never run), so its health is estimated. The false-confidence bucket.
      if (filterCoverage === 'unmeasured' && !(rc > 0 && mc === 0)) return false;
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!a.name.toLowerCase().includes(q) && !a.description.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const hasActiveFilters = !!(filterCategory || filterTier || filterSystemId || filterOwner || filterDomain || filterOrigin || filterMapping || filterCoverage || searchQuery);

  // Distinct owner / domain names present in the current asset set, for the
  // filter dropdowns.
  const ownerOptions = Array.from(new Set(assets.map((a) => a.ownerName).filter(Boolean))).sort() as string[];
  const domainOptions = Array.from(new Set(assets.map((a) => a.domainName).filter(Boolean))).sort() as string[];

  // URL-persisted sort.
  const { sorted, sortKey, sortDir, toggleSort } = useSortedList(
    filteredAssets,
    {
      name: (a, b) => a.name.localeCompare(b.name),
      description: (a, b) => (a.description || '').localeCompare(b.description || ''),
      system: (a, b) => systemName(a.systemId).localeCompare(systemName(b.systemId)),
      // Sort by the source binding label the Source cell renders
      // ("<asset>.<column>"); unbound assets sort to the end either way.
      source: (a, b) => {
        const ba = primaryBindingOf(a.id);
        const bb = primaryBindingOf(b.id);
        const sa = ba ? `${ba.sourceAsset}${ba.sourceColumn ? '.' + ba.sourceColumn : ''}` : '';
        const sb = bb ? `${bb.sourceAsset}${bb.sourceColumn ? '.' + bb.sourceColumn : ''}` : '';
        if (!sa && !sb) return 0;
        if (!sa) return 1;
        if (!sb) return -1;
        return sa.localeCompare(sb);
      },
      tier: (a, b) => compareTier(a.governanceTier, b.governanceTier),
      health: (a, b) => (a.healthScore ?? 0) - (b.healthScore ?? 0),
      domain: (a, b) => (a.domainName || '').localeCompare(b.domainName || ''),
      owner: (a, b) => (a.ownerName || '').localeCompare(b.ownerName || ''),
      steward: (a, b) => (a.stewardName || '').localeCompare(b.stewardName || ''),
      updated: (a, b) => +new Date(a.updatedAt) - +new Date(b.updatedAt),
    },
    'name',
  );

  // Row selection for bulk actions. Only rows the user can actually tick are
  // selectable — inherited (cross-org) rows have disabled checkboxes — so
  // select-all governs exactly the visible, selectable set (this is what
  // fixes the old bug where select-all compared against the full unfiltered
  // `assets` list and ticked hidden rows).
  const selectableAssets = sorted.filter((a) => !isInheritedAsset(a.orgId, activeOrgId));
  const sel = useRowSelection(selectableAssets, (a) => a.id);

  // Column management
  const toggleExpandColumns = async (assetId: string) => {
    if (expandedAssetId === assetId) { setExpandedAssetId(null); return; }
    setExpandedAssetId(assetId);
    // Fetch columns if we haven't already (or refresh)
    setColumnsLoading(assetId);
    try {
      const res = await apiClient.get<{ success: boolean; data: DataAssetColumn[] }>(`/data-assets/${assetId}/columns`);
      setColumnsMap((prev) => ({ ...prev, [assetId]: res.data || [] }));
    } catch { /* */ }
    finally { setColumnsLoading(null); }
  };

  const autoDiscoverColumns = async (assetId: string) => {
    setDiscovering(assetId);
    try {
      const res = await apiClient.post<{ success: boolean; data: DataAssetColumn[]; message: string }>(`/data-assets/${assetId}/columns/auto-discover`, {});
      if (res.data?.length > 0) {
        addToast('success', res.message || `Discovered ${res.data.length} columns`);
      } else {
        addToast('info', res.message || 'No new columns found.');
      }
      // Refresh column list
      const listRes = await apiClient.get<{ success: boolean; data: DataAssetColumn[] }>(`/data-assets/${assetId}/columns`);
      setColumnsMap((prev) => ({ ...prev, [assetId]: listRes.data || [] }));
    } catch (err) {
      errorToast(err, 'Column discovery failed');
    } finally {
      setDiscovering(null);
    }
  };

  // Gate the delete on a confirm ONLY when the column has DQ rules — a
  // clean column deletes silently (the connector re-adds it on the next
  // scan anyway). With rules, warn first so the orphaning is a choice.
  const requestDeleteColumn = (assetId: string, col: DataAssetColumn) => {
    const n = col.rulesCount ?? col.rules?.length ?? 0;
    if (n > 0) setConfirmColDelete({ assetId, colId: col.id, columnName: col.columnName, rulesCount: n });
    else void deleteColumn(assetId, col.id);
  };

  const deleteColumn = async (assetId: string, colId: string) => {
    try {
      await apiClient.delete(`/data-assets/${assetId}/columns/${colId}`);
      addToast('success', 'Column removed');
      setColumnsMap((prev) => ({
        ...prev,
        [assetId]: (prev[assetId] || []).filter((c) => c.id !== colId),
      }));
    } catch (err) {
      errorToast(err, 'Failed to delete column');
    }
  };

  const updateColumnType = async (assetId: string, colId: string, dataType: string) => {
    try {
      await apiClient.put(`/data-assets/${assetId}/columns/${colId}`, { dataType });
      addToast('success', 'Column type updated');
      setColumnsMap((prev) => ({
        ...prev,
        [assetId]: (prev[assetId] || []).map((c) => c.id === colId ? { ...c, dataType } : c),
      }));
    } catch (err) {
      errorToast(err, 'Failed to update column type');
    }
  };

  // Generic column field patch (primary-key flag, FK references). Optimistic
  // local update + PUT.
  const updateColumnField = async (assetId: string, colId: string, patch: Partial<DataAssetColumn>) => {
    setColumnsMap((prev) => ({
      ...prev,
      [assetId]: (prev[assetId] || []).map((c) => c.id === colId ? { ...c, ...patch } : c),
    }));
    try {
      await apiClient.put(`/data-assets/${assetId}/columns/${colId}`, patch);
    } catch (err) {
      errorToast(err, 'Failed to update column');
    }
  };

  const openAdd = () => {
    if (!activeOrgId) { addToast('error', 'Select an organization from the header first.'); return; }
    setForm(emptyForm);
    setEditingId(null);
    setShowForm(true);
  };

  // Deep-link create intent: /data-assets?new=1 (from the Setup Hub) opens
  // the add form, then strips the param so refresh/back doesn't re-open it.
  useEffect(() => {
    if (searchParams.get('new') !== '1' || !activeOrgId || showForm) return;
    openAdd();
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, activeOrgId]); // eslint-disable-line react-hooks/exhaustive-deps

  const domainForAsset = (assetId: string) => domainsList.find((d) => d.dataAssetIds?.includes(assetId));

  const openEdit = (asset: DataAssetEntity) => {
    const dom = domainForAsset(asset.id);
    setForm({
      name: asset.name,
      description: asset.description,
      systemId: asset.systemId,
      ownerPersonId: asset.ownerPersonId || '',
      stewardIds: asset.stewardIds || [],
      governanceTier: asset.governanceTier || 'BRONZE',
      isSystemOfRecord: !!asset.isSystemOfRecord,
      domainId: dom?.id || '',
      dataType: asset.dataType || '',
      retentionDurationValue: asset.retentionDuration?.value ? String(asset.retentionDuration.value) : '',
      retentionDurationUnit: asset.retentionDuration?.unit || '',
      retentionReason: asset.retentionReason || asset.retentionPolicy || '',
      refreshFrequency: asset.refreshFrequency || '',
      sourceConnectionId: asset.sourceConnectionId || '',
      sourceAsset: asset.sourceAsset || '',
      sourceColumn: asset.sourceColumn || '',
    });
    setEditingId(asset.id);
    setShowForm(true);
  };

  const openDuplicate = (asset: DataAssetEntity) => {
    setForm({
      name: `${asset.name} (copy)`,
      description: asset.description,
      systemId: asset.systemId,
      ownerPersonId: asset.ownerPersonId || '',
      stewardIds: asset.stewardIds || [],
      governanceTier: asset.governanceTier || 'BRONZE',
      isSystemOfRecord: !!asset.isSystemOfRecord,
      domainId: '',
      dataType: asset.dataType || '',
      retentionDurationValue: asset.retentionDuration?.value ? String(asset.retentionDuration.value) : '',
      retentionDurationUnit: asset.retentionDuration?.unit || '',
      retentionReason: asset.retentionReason || asset.retentionPolicy || '',
      refreshFrequency: asset.refreshFrequency || '',
      sourceConnectionId: asset.sourceConnectionId || '',
      sourceAsset: asset.sourceAsset || '',
      sourceColumn: asset.sourceColumn || '',
    });
    setEditingId(null);
    setShowForm(true);
  };

  const handleSave = async (keepOpen: boolean = false) => {
    if (!formValidation.validateAll(form)) return;
    // Soft-warn on duplicate names within the same org. Case-insensitive,
    // trim-tolerant. Skipped when editing the same asset back onto itself.
    // Sometimes legitimate (different divisions both have "Customer
    // Accounts") so we confirm rather than block.
    const normalized = form.name.trim().toLowerCase();
    const collision = assets.find((a) =>
      a.id !== editingId &&
      (a.name || '').trim().toLowerCase() === normalized,
    );
    if (collision) {
      setConfirmDuplicate({ name: collision.name, keepOpen });
      return;
    }
    await performSave(keepOpen);
  };

  const performSave = async (keepOpen: boolean = false) => {
    const { domainId, retentionDurationValue, retentionDurationUnit, ...rest } = form;
    // Translate the split duration inputs into the structured shape the
    // backend expects. Empty value clears the field.
    const durationValue = retentionDurationValue ? Number(retentionDurationValue) : NaN;
    const retentionDuration = (Number.isFinite(durationValue) && durationValue > 0 && retentionDurationUnit)
      ? { value: durationValue, unit: retentionDurationUnit }
      : null;
    const assetFields = { ...rest, retentionDuration };
    let savedId = editingId;
    try {
      if (editingId) {
        await apiClient.put(`/data-assets/${editingId}`, assetFields);
      } else {
        const res = await apiClient.post<{ success: boolean; data: { id: string } }>('/data-assets', { ...assetFields, ...(activeOrgId ? { orgId: activeOrgId } : {}) });
        savedId = res.data?.id || null;
      }
      addToast('success', editingId ? 'Data asset updated' : 'Data asset created');
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Failed to save data asset');
      return;
    }
    // Update domain assignment if changed
    if (savedId && domainId) {
      const prevDomain = domainForAsset(savedId);
      if (prevDomain?.id !== domainId) {
        // Remove from old domain
        if (prevDomain) {
          const newIds = prevDomain.dataAssetIds.filter((id) => id !== savedId);
          try { await apiClient.put(`/data-domains/${prevDomain.id}`, { dataAssetIds: newIds }); } catch { /* */ }
        }
        // Add to new domain
        const targetDomain = domainsList.find((d) => d.id === domainId);
        if (targetDomain) {
          const newIds = [...new Set([...targetDomain.dataAssetIds, savedId])];
          try { await apiClient.put(`/data-domains/${domainId}`, { dataAssetIds: newIds }); } catch { /* */ }
        }
      }
    } else if (savedId && !domainId) {
      // Unassign from current domain if cleared
      const prevDomain = domainForAsset(savedId);
      if (prevDomain) {
        const newIds = prevDomain.dataAssetIds.filter((id) => id !== savedId);
        try { await apiClient.put(`/data-domains/${prevDomain.id}`, { dataAssetIds: newIds }); } catch { /* */ }
      }
    }
    // "Save and add another": keep the form open with fresh inputs so
    // the user can keep keying in new assets without clicking Add each
    // time. The original form state isn't reset on edit (keepOpen only
    // applies to create flow).
    markClean();
    if (keepOpen && !editingId) {
      setForm(emptyForm);
      fetchData();
      return;
    }
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
    fetchData();
  };

  const handleDelete = async (id: string) => {
    const asset = assets.find((a) => a.id === id);
    try {
      await apiClient.delete(`/data-assets/${id}`);
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Failed to delete data asset');
      return;
    }
    fetchData();
    if (asset) {
      addToast('success', `"${asset.name}" deleted`, {
        action: {
          label: 'Undo',
          handler: async () => {
            await apiClient.post('/data-assets', {
              name: asset.name, description: asset.description,
              systemId: asset.systemId,
              ownerPersonId: asset.ownerPersonId,
              stewardIds: asset.stewardIds,
              governanceTier: asset.governanceTier,
              dataType: asset.dataType,
              retentionDuration: asset.retentionDuration,
              retentionReason: asset.retentionReason,
              refreshFrequency: asset.refreshFrequency,
              ...(activeOrgId ? { orgId: activeOrgId } : {}),
            });
            addToast('success', `"${asset.name}" restored`);
            fetchData();
          },
        },
        duration: 6000,
      });
    }
  };

  const { isDirty, markDirty, markClean, confirmIfDirty } = useUnsavedChanges();

  const closeForm = () => {
    markClean();
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
  };

  const handleCancel = () => {
    confirmIfDirty(closeForm);
  };

  const updateField = (field: keyof FormData, value: string | number) => {
    markDirty();
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  /** Re-run a field's validator so the error clears the moment the
   *  value becomes valid, but ONLY once the field has actually been
   *  engaged with (touched). Prevents the red error from sticking on
   *  screen while the user is mid-typing, which reads as "my input
   *  isn't being accepted." */
  const updateAndRevalidate = (field: keyof FormData, value: string) => {
    markDirty();
    setForm((prev) => {
      const next = { ...prev, [field]: value };
      if (formValidation.touched[field]) {
        formValidation.validateField(field, value, next);
      }
      return next;
    });
  };

  /** Ask the backend what tables / files / sheets / endpoints live
   *  behind the picked connection. If there's exactly one result it
   *  goes straight into the field (the common case for a single-file
   *  upload); otherwise we show the list so the user can pick. */
  const discoverSourceAssets = async () => {
    if (!form.sourceConnectionId) return;
    setSourceDiscovering(true);
    setSourceDiscoverError(null);
    try {
      const res = await apiClient.post<{ success: boolean; data: { details?: { assets?: Array<{ name: string; type?: string }> } } }>(
        `/connections/${form.sourceConnectionId}/discover`,
        {},
      );
      const assets = res.data?.details?.assets || [];
      setSourceDiscovered(assets);
      if (assets.length === 0) {
        setSourceDiscoverError('No assets found on this connection.');
      } else if (assets.length === 1 && !form.sourceAsset.trim()) {
        updateAndRevalidate('sourceAsset', assets[0].name);
      }
    } catch (err: any) {
      setSourceDiscoverError(err?.response?.data?.error || 'Discovery failed.');
    } finally {
      setSourceDiscovering(false);
    }
  };

  const handleBulkDelete = async () => {
    if (sel.count === 0) return;
    const count = sel.count;
    try {
      await Promise.all(Array.from(sel.selectedIds).map((id) => apiClient.delete(`/data-assets/${id}`)));
      addToast('success', `Deleted ${count} asset${count === 1 ? '' : 's'}`);
      sel.clear();
      fetchData();
    } catch (err) {
      errorToast(err, 'Bulk delete failed');
      fetchData();
    }
  };

  const bulkSetTier = async (tier: string) => {
    const ids = Array.from(sel.selectedIds);
    if (ids.length === 0) return;
    try {
      await Promise.all(ids.map((id) => apiClient.put(`/data-assets/${id}`, { governanceTier: tier })));
      addToast('success', `Set ${ids.length} asset${ids.length === 1 ? '' : 's'} to ${tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase()}`);
      sel.clear();
      fetchData();
    } catch (err) {
      errorToast(err, 'Failed to update governance tier');
    }
  };

  const bulkSetOwner = async (ownerId: string) => {
    const ids = Array.from(sel.selectedIds);
    if (ids.length === 0) return;
    try {
      await Promise.all(ids.map((id) => apiClient.put(`/data-assets/${id}`, { ownerPersonId: ownerId })));
      const ownerName = peopleList.find((p) => p.id === ownerId)?.name || 'selected owner';
      addToast('success', `Assigned ${ownerName} as owner to ${ids.length} asset${ids.length === 1 ? '' : 's'}`);
      sel.clear();
      fetchData();
    } catch (err) {
      errorToast(err, 'Failed to assign owner');
    }
  };

  const bulkSetSystem = async (systemId: string) => {
    const ids = Array.from(sel.selectedIds);
    if (ids.length === 0) return;
    try {
      await Promise.all(ids.map((id) => apiClient.put(`/data-assets/${id}`, { systemId })));
      const sysName = systems.find((s) => s.id === systemId)?.name || 'selected system';
      addToast('success', `Assigned ${ids.length} asset${ids.length === 1 ? '' : 's'} to ${sysName}`);
      sel.clear();
      fetchData();
    } catch (err) {
      errorToast(err, 'Failed to assign system');
    }
  };

  const inlineSaveField = async (assetId: string, field: string, value: string) => {
    try {
      const payload: Record<string, any> = {};
      if (field === 'healthScore') {
        payload[field] = value === '' ? null : Number(value);
      } else {
        payload[field] = value;
      }
      await apiClient.put(`/data-assets/${assetId}`, payload);
      addToast('success', `Updated ${field === 'governanceTier' ? 'governance tier' : field === 'healthScore' ? 'health score' : field}`);
      fetchData();
    } catch (err) {
      errorToast(err, `Failed to update ${field}`);
    }
  };

  const open360 = async (id: string) => {
    setLoading360(true);
    try {
      const res = await apiClient.get<{ success: boolean; data: Asset360Data }>(`/data-assets/${id}/360`);
      setViewing360(res.data || null);
    } catch { /* */ }
    finally { setLoading360(false); }
  };

  const assetColumns = ([
    {
      key: 'name', header: 'Name', sortable: true, cellStyle: { fontWeight: 500, maxWidth: 380 },
      render: (asset: DataAssetEntity) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap', whiteSpace: 'nowrap', overflow: 'hidden' }}>
            {/* Name is a link to the detail modal for everyone - editors and
              *  viewers both. Renaming happens via the row's Edit pencil. */}
            <button
              type="button"
              onClick={() => open360(asset.id)}
              title="Click to view details"
              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-primary)', cursor: 'pointer', font: 'inherit', fontWeight: 500, textAlign: 'left' }}
              onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
              onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
            >
              {asset.name}
            </button>
            <OriginBadge origin={asset.origin} />
            <UnmappedBadge isOrphan={asset.isOrphan} />
            {asset.isSystemOfRecord && (
              <span
                title="System of record — the authoritative golden copy"
                style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', background: '#dcfce7', color: '#166534', padding: '1px 6px', borderRadius: 3 }}
              >
                SOR
              </span>
            )}
            <SyncFreshnessChip lastSyncedAt={asset.lastSyncedAt} />
            <RowCountChip rowCount={asset.rowCount} />
            {asset.sensitivityTags && asset.sensitivityTags.length > 0 && (
              <span
                title={`Sensitivity: ${asset.sensitivityTags.join(', ')}`}
                style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', background: '#fee2e2', color: '#991b1b', padding: '1px 6px', borderRadius: 3 }}
              >
                {asset.sensitivityTags[0]}{asset.sensitivityTags.length > 1 ? ` +${asset.sensitivityTags.length - 1}` : ''}
              </span>
            )}
            <OwnerBadge assetOrgId={asset.orgId} activeOrgId={activeOrgId} getOrgName={getOrgName} />
          </div>
          <div
            style={{ fontSize: 12, fontWeight: 400, color: asset.description ? 'var(--color-text-secondary)' : 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}
            title={asset.description || undefined}
          >
            {asset.description || '--'}
          </div>
        </div>
      ),
    },
    isVisible('system') && {
      key: 'system', header: 'System', sortable: true,
      render: (asset: DataAssetEntity) => systemName(asset.systemId) || <span style={{ color: 'var(--color-text-muted)' }}>{'--'}</span>,
    },
    isVisible('source') && {
      key: 'source', header: 'Source', sortable: true, cellStyle: { fontSize: 12, color: 'var(--color-text-secondary)' },
      render: (asset: DataAssetEntity) => {
        const binding = primaryBindingOf(asset.id);
        const connName = binding ? connectionNameById[binding.connectionId] : undefined;
        const cols = bindingColumnSet(binding);
        return binding ? (
          <span
            title={
              `Linked to connection ${connName || binding.connectionId}` +
              (cols.length > 1 ? `\nColumns: ${cols.join(', ')}` : '')
            }
          >
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              {bindingSourceLabel(binding)}
            </code>
          </span>
        ) : (
          <span style={{ color: 'var(--color-text-muted)' }}>{'--'}</span>
        );
      },
    },
    isVisible('tier') && {
      key: 'tier', header: 'Tier', sortable: true,
      render: (asset: DataAssetEntity) => {
        const inherited = isInheritedAsset(asset.orgId, activeOrgId);
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {canWrite && !inherited ? (
              <select
                aria-label="Governance tier"
                value={asset.governanceTier || 'BRONZE'}
                onChange={(e) => inlineSaveField(asset.id, 'governanceTier', e.target.value)}
                style={{ fontSize: 13, padding: '2px 4px', border: '1px solid var(--color-border)', borderRadius: 3, background: 'var(--color-surface)' }}
              >
                {TIER_VALUES.map((t) => <option key={t} value={t}>{tierLabel(t)}</option>)}
              </select>
            ) : (
              <TierBadge tier={asset.governanceTier} />
            )}
            {canWrite && !inherited && asset.suggestedTier && compareTier(asset.suggestedTier, asset.governanceTier) > 0 && (
              <button
                onClick={() => inlineSaveField(asset.id, 'governanceTier', asset.suggestedTier!)}
                title={`This asset meets the criteria for ${tierLabel(asset.suggestedTier)}. Click to promote.`}
                style={{ fontSize: 10, fontWeight: 500, padding: '2px 8px', borderRadius: 999, background: '#dcfce7', color: '#166534', border: '1px solid #86efac', cursor: 'pointer', alignSelf: 'flex-start' }}
              >
                {'↑'} Promote to {tierLabel(asset.suggestedTier)}
              </button>
            )}
          </div>
        );
      },
    },
    isVisible('health') && {
      key: 'health', header: 'Health', sortable: true,
      // Read-only: health is derived from measured data-quality rules, not
      // hand-set. An asset with no measured rule reads 0% until a rule runs
      // against it.
      render: (asset: DataAssetEntity) => {
        const noMeasured = !asset.measuredRuleCount;
        return (
          <span
            title={noMeasured
              ? 'Health is measured from data-quality rules. This asset has no measured rule yet, so it reads 0% — add and run a rule to establish its health.'
              : undefined}
          >
            <HealthBar score={asset.healthScore} />
          </span>
        );
      },
    },
    isVisible('domain') && {
      key: 'domain', header: 'Domain', sortable: true,
      render: (asset: DataAssetEntity) => asset.domainName || <span style={{ color: 'var(--color-text-muted)' }}>{'--'}</span>,
    },
    isVisible('owner') && {
      key: 'owner', header: 'Owner', sortable: true,
      render: (asset: DataAssetEntity) => asset.ownerName || <span style={{ color: 'var(--color-text-muted)' }}>{'--'}</span>,
    },
    isVisible('steward') && {
      key: 'steward', header: 'Steward', sortable: true,
      render: (asset: DataAssetEntity) => asset.stewardName || <span style={{ color: 'var(--color-text-muted)' }}>{'--'}</span>,
    },
    {
      key: 'actions', header: 'Actions', align: 'center' as const, width: 180,
      render: (asset: DataAssetEntity) => {
        const binding = primaryBindingOf(asset.id);
        const inherited = isInheritedAsset(asset.orgId, activeOrgId);
        const inheritedHint = inherited
          ? `Owned at ${getOrgName(asset.orgId)}. Switch the "Working in..." scope to ${getOrgName(asset.orgId)} to edit.`
          : '';
        return (
          <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            {binding ? (
              <>
                <IconButton size="sm" icon="refresh" label="Change connection" onClick={() => { setLinkModalAsset(asset); setLinkModalMode('change'); }} />
                <IconButton size="sm" icon="unlink" label="Unlink" onClick={() => unlinkPrimary(asset)} />
              </>
            ) : (
              <>
                <IconButton size="sm" icon="link" label="Link to connection" variant="primary" onClick={() => { setLinkModalAsset(asset); setLinkModalMode('new'); }} />
                {aiEnabled && <IconButton size="sm" icon="search" label="Suggest source" onClick={() => openSuggestSource(asset)} />}
              </>
            )}
            {canWrite && (
              <>
                <IconButton size="sm" icon="edit" label={inheritedHint || 'Edit'} disabled={inherited} onClick={() => openEdit(asset)} />
                <IconButton size="sm" icon="copy" label={inheritedHint || 'Duplicate'} disabled={inherited} onClick={() => openDuplicate(asset)} />
                <IconButton size="sm" icon="trash" label={inheritedHint || 'Delete'} variant="danger" disabled={inherited} onClick={() => setConfirmDelete(asset.id)} />
              </>
            )}
          </div>
        );
      },
    },
  ].filter(Boolean) as DataTableColumn<DataAssetEntity>[]);

  const renderAssetExpansion = (asset: DataAssetEntity) => {
    const binding = primaryBindingOf(asset.id);
    const cols = columnsMap[asset.id] || [];
    return (
      <div style={{ background: '#fafbfc', padding: '12px 20px 12px 60px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <SectionLabel marginBottom={0}>
            Columns ({cols.length})
          </SectionLabel>
          <div style={{ display: 'flex', gap: 6 }}>
            {binding && (
              <button
                onClick={() => autoDiscoverColumns(asset.id)}
                disabled={discovering === asset.id}
                style={{ padding: '4px 10px', fontSize: 11, fontWeight: 500, background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 4, cursor: discovering === asset.id ? 'not-allowed' : 'pointer', opacity: discovering === asset.id ? 0.6 : 1 }}
              >
                {discovering === asset.id ? 'Discovering…' : 'Auto-discover columns'}
              </button>
            )}
          </div>
        </div>
        {columnsLoading === asset.id ? (
          <Spinner label="Loading…" />
        ) : cols.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: 8 }}>
            {binding
              ? 'No columns yet. Click "Auto-discover columns" to populate from the linked connection.'
              : 'No columns yet. Link this asset to a connection first, then discover its columns.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {cols.map((col) => {
              const colRules = col.rules || [];
              const isColExpanded = expandedColumnIds.has(col.id);
              const h = col.healthScore;
              const hc = h == null ? 'var(--color-text-muted)' : h >= 80 ? 'var(--color-success)' : h >= 50 ? 'var(--color-warning)' : 'var(--color-error)';
              return (
                <div key={col.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  {/* Column row */}
                  <div
                    {...clickable(() => toggleColumnExpand(col.id), { label: `Toggle column ${col.columnName}` })}
                    aria-expanded={isColExpanded}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer', background: isColExpanded ? '#f0f9ff' : undefined }}
                    onMouseEnter={(e) => { if (!isColExpanded) e.currentTarget.style.background = 'var(--color-bg)'; }}
                    onMouseLeave={(e) => { if (!isColExpanded) e.currentTarget.style.background = ''; }}
                  >
                    <span style={{ fontSize: 10, color: 'var(--color-text-muted)', width: 12, flexShrink: 0 }}>
                      {isColExpanded ? '▼' : '▶'}
                    </span>
                    <span style={{ fontWeight: 500, fontFamily: 'var(--font-mono)', fontSize: 13, minWidth: 120 }}>
                      {col.columnName}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); updateColumnField(asset.id, col.id, { isPrimaryKey: !col.isPrimaryKey }); }}
                      title={col.isPrimaryKey ? 'Primary key — click to unset' : 'Mark as (part of) the primary key'}
                      aria-label={col.isPrimaryKey ? `Unset primary key on ${col.columnName}` : `Mark ${col.columnName} as primary key`}
                      style={{
                        flexShrink: 0, fontSize: 9, fontWeight: 700, letterSpacing: '0.04em', cursor: 'pointer',
                        padding: '1px 6px', borderRadius: 3,
                        background: col.isPrimaryKey ? '#fef3c7' : 'transparent',
                        color: col.isPrimaryKey ? '#92400e' : 'var(--color-text-muted)',
                        border: `1px solid ${col.isPrimaryKey ? '#fcd34d' : 'var(--color-border)'}`,
                      }}
                    >PK</button>
                    <span style={{ minWidth: 90 }} onClick={(e) => e.stopPropagation()}>
                      <select
                        aria-label="Column data type"
                        value={col.dataType || ''}
                        onChange={(e) => updateColumnType(asset.id, col.id, e.target.value)}
                        style={{ fontSize: 11, color: col.dataType ? 'var(--color-text-secondary)' : 'var(--color-text-muted)', border: 'none', background: 'transparent', cursor: 'pointer', padding: '1px 2px', fontFamily: 'inherit' }}
                        title="Click to set data type"
                      >
                        <option value="">{col.dataType || 'Set type...'}</option>
                        {standardDataTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {col.references ? <span title={`References ${col.references}`} style={{ color: 'var(--color-text-muted)' }}>→ {col.references}</span> : (col.description || '')}
                    </span>
                    {h != null && (
                      <span style={{ fontSize: 11, fontWeight: 600, color: hc, minWidth: 40, textAlign: 'right' }}>{h}%</span>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--color-text-muted)', minWidth: 60, textAlign: 'right' }}>
                      {colRules.length > 0 ? `${colRules.length} rule${colRules.length === 1 ? '' : 's'}` : ''}
                    </span>
                    <div onClick={(e) => e.stopPropagation()}>
                      <IconButton size="sm" icon="trash" label="Remove column" variant="danger" onClick={() => requestDeleteColumn(asset.id, col)} />
                    </div>
                  </div>
                  {/* Key relationship (FK) editor — always available when the
                      column is expanded. */}
                  {isColExpanded && (
                    <div style={{ paddingLeft: 46, paddingRight: 12, paddingBottom: 8, paddingTop: 4 }} onClick={(e) => e.stopPropagation()}>
                      <label style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-muted)', display: 'block', marginBottom: 3 }}>
                        Key relationship (foreign key)
                      </label>
                      <input
                        aria-label={`Foreign-key reference for ${col.columnName}`}
                        defaultValue={col.references || ''}
                        placeholder="e.g. Customer Master.customer_id — the entity/column this points to"
                        onBlur={(e) => { const v = e.target.value.trim(); if (v !== (col.references || '')) updateColumnField(asset.id, col.id, { references: v }); }}
                        style={{ width: '100%', maxWidth: 460, fontSize: 12, padding: '5px 8px', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}
                      />
                    </div>
                  )}
                  {/* Expanded rules under this column */}
                  {isColExpanded && colRules.length > 0 && (
                    <div style={{ paddingLeft: 46, paddingBottom: 8 }}>
                      {colRules.map((rule) => {
                        // Kept as hex (not tokenised): this value is alpha-blended below as `rc + '18'` for the badge tint, which only works with a hex string.
                        const rc = rule.status === 'PASSING' ? '#16a34a' : rule.status === 'FAILING' ? '#dc2626' : rule.status === 'WARNING' ? '#ca8a04' : '#64748b';
                        return (
                          <div key={rule.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 10px', fontSize: 12, borderLeft: `3px solid ${rc}`, marginBottom: 2, borderRadius: '0 4px 4px 0', background: 'var(--color-bg)' }}>
                            <span style={{ fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {rule.name}
                            </span>
                            <span style={{ fontSize: 10, color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>{rule.dimension}</span>
                            <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{rule.ruleType || 'manual'}</span>
                            <span style={{ fontSize: 11, fontWeight: 600, color: rc, minWidth: 35, textAlign: 'right' }}>
                              {rule.currentScore}%
                            </span>
                            <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 3, background: rc + '18', color: rc }}>
                              {rule.status}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {isColExpanded && colRules.length === 0 && (
                    <div style={{ paddingLeft: 46, paddingBottom: 8, fontSize: 11, color: 'var(--color-text-muted)' }}>
                      No rules defined for this column. Add rules on the Data Quality page.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // Toolbar actions — rendered inside the PageHeader on the standalone page,
  // or as a right-aligned strip when embedded in the Data Assets hub.
  const headerActions = (
    <>
      <SavedViewsMenu
        pageKey="data-assets"
        currentFilters={{ filterCategory, filterTier, filterSystemId, filterOwner, filterDomain, filterOrigin, filterMapping, searchQuery }}
        onApply={(f) => {
          setFilterCategory((f.filterCategory as string) || '');
          setFilterTier((f.filterTier as string) || '');
          setFilterSystemId((f.filterSystemId as string) || '');
          setFilterOwner((f.filterOwner as string) || '');
          setFilterDomain((f.filterDomain as string) || '');
          setFilterOrigin((f.filterOrigin as '' | 'MANUAL' | 'GOVERNANCE_TEMPLATE' | 'DISCOVERED' | 'IMPORTED' | 'SYNCED') || '');
          setFilterMapping((f.filterMapping as '' | 'mapped' | 'unmapped') || '');
          setSearchQuery((f.searchQuery as string) || '');
        }}
      />
      {assets.length > 0 && (
        <ExportMenu build={() => ({
          filenameBase: 'data-assets',
          sheetName: 'Data Assets',
          headers: ['Name', 'Description', 'System', 'Source', 'Domain', 'Owner', 'Steward'],
          rows: assets.map((a) => [
            a.name,
            a.description,
            systemName(a.systemId),
            a.sourceAsset ? `${a.sourceAsset}${a.sourceColumn ? '.' + a.sourceColumn : ''}` : '',
            a.domainName || '',
            a.ownerName || '',
            a.stewardName || '',
          ]),
        })} />
      )}
      <ColumnPicker state={colPicker} />
      {canWrite && canOwnHere && (
        <IconButton icon="plus" label="Add data asset" variant="primary" onClick={openAdd} />
      )}
    </>
  );

  return (
    <div>
      <style>{`@keyframes highlightPulse { 0% { background: #fef3c7; } 100% { background: transparent; } }`}</style>
      {/* Header. When embedded in the Data Assets hub the parent owns the
          page title, so we render just the action strip (mirroring the
          MappingsPage embedded pattern) instead of a second PageHeader. */}
      {embedded ? (
        // Hub always passes actionsPortal (a node once mounted, null on the
        // first render before the slot ref attaches) — portal the toolbar up
        // onto the tab row. The inline strip is only a fallback for an
        // embedded use with no slot supplied.
        actionsPortal !== undefined ? (
          actionsPortal ? createPortal(headerActions, actionsPortal) : null
        ) : (
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            {headerActions}
          </div>
        )
      ) : (
      <PageHeader
        title="Data Assets"
        subtitle={
          <>Business-level concepts &mdash; <em>&ldquo;Customer Accounts&rdquo;</em>, <em>&ldquo;Billing Records&rdquo;</em>, <em>&ldquo;Inventory Levels&rdquo;</em>. Not files or columns: the physical tables, files, and columns that back each asset are configured via Bindings on the row.</>
        }
        actions={headerActions}
      >
        <HelpPopover id="data-assets-overview" title="Data assets">
          Define your data in business terms first ("Customer accounts",
          "Billing records") — then link each one to where it actually
          lives via a connection. Asset identity stays stable even when
          the storage location changes.
        </HelpPopover>
      </PageHeader>
      )}

      {/* Wrong-level banner. Data assets can only be owned by
          companies or divisions; if the active scope is a
          department or team the Add button is hidden and this banner
          explains why. The list itself still renders so users can
          read inherited rows from above. */}
      {activeOrgId && !canOwnHere && <CreateScopeNotice noun="data assets" />}

      {/* Full-width content — Data Classification is now a facet in the top Filters row */}
      <div>

        {/* Content area */}
        <div>
      {/* Data Classification chips — only rendered when the facet actually
          splits the list (≥2 populated values); a lone "All / Untyped" pair
          filters nothing, so it's hidden to save vertical space. */}
      {(() => {
        const chips = ([
          { key: '', label: 'All', count: assets.length, hint: 'Every classification' },
          { key: 'MASTER', label: 'Master', count: assets.filter((a) => a.dataType === 'MASTER').length, hint: 'Master data' },
          { key: 'REFERENCE', label: 'Reference', count: assets.filter((a) => a.dataType === 'REFERENCE').length, hint: 'Reference data' },
          { key: 'TRANSACTIONAL', label: 'Transactional', count: assets.filter((a) => a.dataType === 'TRANSACTIONAL').length, hint: 'Transactional data' },
          { key: 'ANALYTICAL', label: 'Analytical', count: assets.filter((a) => a.dataType === 'ANALYTICAL').length, hint: 'Analytical data' },
          { key: 'METADATA', label: 'Metadata', count: assets.filter((a) => a.dataType === 'METADATA').length, hint: 'Metadata' },
          { key: '__none__', label: 'Untyped', count: assets.filter((a) => !a.dataType).length, hint: 'No classification set' },
        ] as const).filter((o) => o.key === '' || o.count > 0);
        if (chips.filter((o) => o.key !== '').length < 2) return null;
        return (
          <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-muted)', marginRight: 2 }}>Classification</span>
            {chips.map((o) => {
              const active = filterCategory === o.key;
              return (
                <button
                  key={o.key || 'all'}
                  onClick={() => setFilterCategory(o.key)}
                  title={o.hint}
                  style={{
                    padding: '4px 10px', fontSize: 11, fontWeight: 500, borderRadius: 999,
                    border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border)'}`,
                    background: active ? 'var(--color-primary-light)' : 'var(--color-surface)',
                    color: active ? 'var(--color-primary)' : 'var(--color-text)',
                    cursor: 'pointer',
                  }}
                >
                  {o.label} <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>({o.count})</span>
                </button>
              );
            })}
          </div>
        );
      })()}
      {/* Origin chips — only rendered when the facet actually splits the list. */}
      {(() => {
        const chips = ([
          { key: '', label: 'All', count: assets.length, hint: 'Show every data asset' },
          { key: 'MANUAL', label: 'Manual', count: assets.filter((a) => (a.origin || 'MANUAL') === 'MANUAL').length, hint: 'Typed by a user' },
          { key: 'DISCOVERED', label: 'Discovered', count: assets.filter((a) => a.origin === 'DISCOVERED').length, hint: 'Created from a connection' },
          { key: 'GOVERNANCE_TEMPLATE', label: 'Governance', count: assets.filter((a) => a.origin === 'GOVERNANCE_TEMPLATE').length, hint: 'Seeded by the Data Governance value stream' },
          { key: 'IMPORTED', label: 'Imported', count: assets.filter((a) => a.origin === 'IMPORTED').length, hint: 'Created via bulk import' },
          { key: 'SYNCED', label: 'Synced', count: assets.filter((a) => a.origin === 'SYNCED').length, hint: 'Created by a sync connection' },
        ] as const).filter((o) => o.key === '' || o.count > 0);
        if (chips.filter((o) => o.key !== '').length < 2) return null;
        return (
          <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-muted)', marginRight: 2 }}>Origin</span>
            {chips.map((o) => {
              const active = filterOrigin === o.key;
              return (
                <button
                  key={o.key || 'all'}
                  onClick={() => setFilterOrigin(o.key as typeof filterOrigin)}
                  title={o.hint}
                  style={{
                    padding: '4px 10px', fontSize: 11, fontWeight: 500, borderRadius: 999,
                    border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border)'}`,
                    background: active ? 'var(--color-primary-light)' : 'var(--color-surface)',
                    color: active ? 'var(--color-primary)' : 'var(--color-text)',
                    cursor: 'pointer',
                  }}
                >
                  {o.label} <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>({o.count})</span>
                </button>
              );
            })}
          </div>
        );
      })()}
      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          aria-label="Search assets" placeholder="Search assets..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{ border: '1px solid var(--color-border)', borderRadius: 4, padding: '5px 10px', fontSize: 12, background: 'var(--color-surface)', width: 200 }}
        />
        <select aria-label="Filter by tier" style={{ ...selectStyle, width: 'auto', minWidth: 130 }} value={filterTier} onChange={(e) => setFilterTier(e.target.value)}>
          <option value="">All Tiers</option>
          <option value="GOLD">{tierLabel('GOLD')} ({assets.filter((a) => a.governanceTier === 'GOLD').length})</option>
          <option value="SILVER">{tierLabel('SILVER')} ({assets.filter((a) => a.governanceTier === 'SILVER').length})</option>
          <option value="BRONZE">{tierLabel('BRONZE')} ({assets.filter((a) => !a.governanceTier || a.governanceTier === 'BRONZE').length})</option>
        </select>
        {systems.length > 0 && (
          <select aria-label="Filter by system" style={{ ...selectStyle, width: 'auto', minWidth: 140 }} value={filterSystemId} onChange={(e) => setFilterSystemId(e.target.value)}>
            <option value="">All Systems</option>
            {systems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
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
        <select
          aria-label="Filter by mapping status"
          title="Whether the asset is mapped to any process step"
          style={{ ...selectStyle, width: 'auto', minWidth: 150 }}
          value={filterMapping}
          onChange={(e) => setFilterMapping(e.target.value as typeof filterMapping)}
        >
          <option value="">All Mapping</option>
          <option value="unmapped">Unmapped ({assets.filter((a) => a.isOrphan).length})</option>
          <option value="mapped">Mapped ({assets.filter((a) => !a.isOrphan).length})</option>
        </select>
        <select
          aria-label="Filter by data-quality coverage"
          title="Whether the asset has data-quality rules — and whether any are actually measured"
          style={{ ...selectStyle, width: 'auto', minWidth: 150 }}
          value={filterCoverage}
          onChange={(e) => setFilterCoverage(e.target.value as typeof filterCoverage)}
        >
          <option value="">All Rules</option>
          <option value="has">Has rules ({assets.filter((a) => (a.ruleCount || 0) > 0).length})</option>
          <option value="none">No rules ({assets.filter((a) => (a.ruleCount || 0) === 0).length})</option>
          <option value="unmeasured">Rules but unmeasured ({assets.filter((a) => (a.ruleCount || 0) > 0 && (a.measuredRuleCount || 0) === 0).length})</option>
        </select>
        {hasActiveFilters && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => { setFilterCategory(''); setFilterTier(''); setFilterSystemId(''); setFilterOwner(''); setFilterDomain(''); setFilterOrigin(''); setFilterMapping(''); setFilterCoverage(''); setSearchQuery(''); }}
          >
            Clear Filters
          </Button>
        )}
        {hasActiveFilters && (
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            Showing {filteredAssets.length} of {assets.length}
          </span>
        )}
      </div>

      {/* Add/Edit Form */}
      {showForm && (
        <SectionCard title={editingId ? 'Edit Data Asset' : 'Add New Data Asset'}>
          <UnsavedBanner visible={isDirty()} onSave={() => handleSave(false)} onDiscard={closeForm} />

          {/* ── Section 1: Basics (always visible) ── */}
          <SectionLabel marginBottom={4}>What is this data?</SectionLabel>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 10, lineHeight: 1.4 }}>
            Name the <em>business concept</em>, not the table or file. <em>Customer Accounts</em>, <em>Billing Records</em>, <em>Inventory Levels</em> — the underlying source is configured separately on the row via a Binding.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Name *</label>
              <input
                autoFocus
                aria-label="Name"
                style={{ ...inputStyle, border: formValidation.fieldError('name') ? inputErrorBorder : inputStyle.border }}
                value={form.name}
                onChange={(e) => updateField('name', e.target.value)}
                onBlur={() => { formValidation.touch('name'); formValidation.validateField('name', form.name, form); }}
                placeholder="e.g. Customer Accounts, Billing Records (a business concept — not a table name)"
              />
              {formValidation.fieldError('name') && <div style={fieldErrorStyle}>{formValidation.fieldError('name')}</div>}
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Data Classification</label>
              <select aria-label="Data Classification" style={selectStyle} value={form.dataType} onChange={(e) => updateField('dataType', e.target.value)}>
                <option value="">-- Select --</option>
                <option value="MASTER">Master</option>
                <option value="REFERENCE">Reference</option>
                <option value="TRANSACTIONAL">Transactional</option>
                <option value="ANALYTICAL">Analytical</option>
                <option value="METADATA">Metadata</option>
              </select>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 3 }}>The kind of data this is — not a column type. (Sensitivity like PII / Confidential is set separately.)</div>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Description</label>
              <input
                aria-label="Description"
                style={inputStyle}
                value={form.description}
                onChange={(e) => updateField('description', e.target.value)}
                placeholder="What this data represents in business terms — what it's used for, who depends on it"
              />
            </div>
          </div>

          {/* ── Section 2: Governance & Ownership (always visible) ── */}
          <SectionLabel>Governance & ownership</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Domain</label>
              <select aria-label="Domain" style={selectStyle} value={form.domainId} onChange={(e) => updateField('domainId', e.target.value)}>
                <option value="">-- No domain --</option>
                {domainsList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>Governance Tier <HelpPopover id="asset-tier" title="Governance Tiers">Uncertified = catalogued but not yet governed. Managed = owner and steward assigned, basic quality rules in place. Certified = fully governed, audit-ready.</HelpPopover></label>
              <select aria-label="Governance Tier" style={selectStyle} value={form.governanceTier} onChange={(e) => updateField('governanceTier', e.target.value)}>
                {TIER_VALUES.map((t) => <option key={t} value={t}>{tierLabel(t)}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  aria-label="System of record"
                  checked={form.isSystemOfRecord}
                  onChange={(e) => setForm((f) => ({ ...f, isSystemOfRecord: e.target.checked }))}
                  style={{ marginTop: 2, cursor: 'pointer' }}
                />
                <span>
                  <span style={{ fontSize: 12, fontWeight: 500 }}>System of record</span>
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--color-text-muted)', marginTop: 1 }}>This asset is the authoritative golden copy others reconcile to. Mark exactly one when the same data lives in several systems.</span>
                </span>
              </label>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Owner</label>
              <PersonPicker
                mode="single"
                valueMode="id"
                value={form.ownerPersonId || null}
                onChange={(pid) => updateField('ownerPersonId', pid || '')}
                placeholder="-- No owner --"
              />
              {/* Ownership provenance hint. Three states:
                    1. No pick + domain has an owner → show "Inherits
                       from domain — X", so the user knows what will
                       land once they save. Non-destructive; picking
                       nothing IS the inherit choice.
                    2. Explicit pick that differs from the domain
                       owner → show "Overrides domain (X)" + a
                       "Reset to domain owner" link that clears the
                       explicit pick.
                    3. Empty pick + no domain owner → nothing to
                       show; the field is genuinely empty.
                  See DAMA convention: Data Asset Owner and Data
                  Domain Owner are separate accountabilities on
                  purpose; the asset can override when a specific
                  person is responsible for just that dataset. */}
              {(() => {
                const domain = form.domainId ? domainsList.find((d) => d.id === form.domainId) : null;
                const domainOwnerId = domain?.ownerId || null;
                const domainOwnerName = domain?.ownerName || null;
                if (!domainOwnerId || !domainOwnerName) return null;
                const explicit = form.ownerPersonId && form.ownerPersonId !== domainOwnerId;
                if (!form.ownerPersonId) {
                  return (
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4, fontStyle: 'italic' }}>
                      Inherits from domain — {domainOwnerName}
                    </div>
                  );
                }
                if (explicit) {
                  return (
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span>Overrides domain ({domainOwnerName}).</span>
                      <button
                        type="button"
                        onClick={() => updateField('ownerPersonId', '')}
                        style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-primary)', textDecoration: 'underline', cursor: 'pointer', fontSize: 11 }}
                      >
                        Reset to domain owner
                      </button>
                    </div>
                  );
                }
                return null;
              })()}
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                Data Steward(s)
                <HelpPopover id="asset-stewards" title="Data Stewards">
                  The first steward listed is the primary contact. Add additional stewards for backup coverage.
                </HelpPopover>
              </label>
              {/* Adder: pick a person → append to stewardIds. The chip
                  list below keeps the ordered "PRIMARY first" semantics
                  and per-chip removal. */}
              <PersonPicker
                mode="single"
                valueMode="id"
                value={null}
                onChange={(pid) => {
                  if (pid && !form.stewardIds.includes(pid)) {
                    setForm((prev) => ({ ...prev, stewardIds: [...prev.stewardIds, pid] }));
                  }
                }}
                placeholder="+ Add steward…"
              />
              {form.stewardIds.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                  {form.stewardIds.map((sid, idx) => {
                    const person = peopleList.find((p) => p.id === sid);
                    return (
                      <span key={sid} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 500,
                        background: idx === 0 ? '#dbeafe' : '#f1f5f9',
                        color: idx === 0 ? '#1e40af' : '#475569',
                        border: `1px solid ${idx === 0 ? '#93c5fd' : '#e2e8f0'}`,
                      }}>
                        {idx === 0 && <span style={{ fontSize: 9, fontWeight: 700 }}>PRIMARY</span>}
                        {person?.name || sid}
                        <button
                          onClick={() => setForm((prev) => ({ ...prev, stewardIds: prev.stewardIds.filter((id) => id !== sid) }))}
                          aria-label={`Remove steward ${person?.name || sid}`}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'inherit', padding: 0, lineHeight: 1 }}
                        >&times;</button>
                      </span>
                    );
                  })}
                </div>
              )}
              {/* Stewards inheritance hint — mirror of the Owner
                  field. Three states:
                    1. No stewards picked + domain has stewards →
                       "Inherits from domain — X, Y". Non-destructive;
                       leaving the picker empty IS the inherit choice.
                    2. Explicit stewards + list differs from the
                       domain's set → "Overrides domain (X, Y). Reset
                       to domain stewards". Clicking Reset clears the
                       asset's list, dropping back to inheritance.
                    3. Empty picks + no domain stewards → nothing
                       shown; the field is genuinely empty. */}
              {(() => {
                const domain = form.domainId ? domainsList.find((d) => d.id === form.domainId) : null;
                const domainStewards = domain?.stewards || [];
                if (domainStewards.length === 0) return null;
                const domainList = domainStewards.map((s) => s.name).join(', ');
                if (form.stewardIds.length === 0) {
                  return (
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 6, fontStyle: 'italic' }}>
                      Inherits from domain — {domainList}
                    </div>
                  );
                }
                // Compare set-equality: same members regardless of order.
                const domainSet = new Set(domainStewards.map((s) => s.id));
                const assetSet = new Set(form.stewardIds);
                const same = domainSet.size === assetSet.size
                  && [...domainSet].every((id) => assetSet.has(id));
                if (!same) {
                  return (
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span>Overrides domain ({domainList}).</span>
                      <button
                        type="button"
                        onClick={() => setForm((prev) => ({ ...prev, stewardIds: [] }))}
                        style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-primary)', textDecoration: 'underline', cursor: 'pointer', fontSize: 11 }}
                      >
                        Reset to domain stewards
                      </button>
                    </div>
                  );
                }
                return null;
              })()}
            </div>
          </div>

          {/* ── Section 3: Advanced fields (collapsible) ── */}
          <button
            onClick={() => setShowAdvancedFields(!showAdvancedFields)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500, color: 'var(--color-primary)', padding: 0, marginBottom: showAdvancedFields ? 12 : 0 }}
          >
            {showAdvancedFields ? '▼ Hide' : '▶ Show'} advanced fields (frequency, retention, system, source)
          </button>
          {showAdvancedFields && (
            <>
              <SectionLabel>Technical details</SectionLabel>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>System</label>
                  <select aria-label="System" style={selectStyle} value={form.systemId} onChange={(e) => updateField('systemId', e.target.value)}>
                    <option value="">-- Select system --</option>
                    {systems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>Refresh Frequency <HelpPopover id="asset-refresh" title="Refresh Frequency">How often is this data updated from its source? Affects how stale the data might be when consumed by processes.</HelpPopover></label>
                  <select aria-label="Refresh Frequency" style={selectStyle} value={form.refreshFrequency} onChange={(e) => updateField('refreshFrequency', e.target.value)}>
                    <option value="">-- Select --</option>
                    <option value="REAL_TIME">Real-time</option>
                    <option value="STREAMING">Streaming</option>
                    <option value="EVENT_DRIVEN">Event-driven</option>
                    <option value="HOURLY">Hourly</option>
                    <option value="DAILY">Daily</option>
                    <option value="WEEKLY">Weekly</option>
                    <option value="MONTHLY">Monthly</option>
                    <option value="AD_HOC">Ad-hoc</option>
                    <option value="MANUAL">Manual</option>
                  </select>
                </div>
                <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '120px 140px 1fr', gap: 8 }}>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>Retention <HelpPopover id="asset-retention" title="Retention Policy">How long is this data kept before deletion or archival? Add the regulatory or business reason for the policy.</HelpPopover></label>
                    <input
                      type="number"
                      aria-label="Retention"
                      min={0}
                      style={inputStyle}
                      value={form.retentionDurationValue}
                      onChange={(e) => updateField('retentionDurationValue', e.target.value)}
                      placeholder="e.g. 7"
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Unit</label>
                    <select
                      aria-label="Unit"
                      style={selectStyle}
                      value={form.retentionDurationUnit}
                      onChange={(e) => updateField('retentionDurationUnit', e.target.value)}
                    >
                      <option value="">-- Unit --</option>
                      <option value="DAYS">Days</option>
                      <option value="MONTHS">Months</option>
                      <option value="YEARS">Years</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Reason</label>
                    <input
                      aria-label="Reason"
                      style={inputStyle}
                      value={form.retentionReason}
                      onChange={(e) => updateField('retentionReason', e.target.value)}
                      placeholder="e.g. Regulatory: SOX 404 / 7-year retention"
                    />
                  </div>
                </div>
              </div>

              {/* Source Connection */}
              <SectionLabel>Source connection</SectionLabel>
              <div style={{ padding: '14px 16px', background: 'var(--color-bg)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 14 }}>&#x26A1;</span>
              Link to Source
              <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--color-text-muted)' }}>(optional)</span>
            </div>
            {(() => {
              const selectedConn = connectionsList.find((c) => c.id === form.sourceConnectionId);
              const connType = selectedConn?.connectionType || '';
              // Per-type vocabulary so the field stops asking generically
              // for "Table / File / Asset" — the right word depends on
              // what kind of source the user just picked.
              const assetLabelByType: Record<string, { label: string; placeholder: string }> = {
                DATABASE:       { label: 'Table',    placeholder: 'e.g. customers, public.invoices' },
                DATA_WAREHOUSE: { label: 'Table',    placeholder: 'e.g. analytics.fact_sales' },
                FILE_STORAGE:   { label: 'File',     placeholder: 'e.g. invoices.csv' },
                SPREADSHEET:    { label: 'Sheet',    placeholder: 'e.g. Sheet1 - Revenue' },
                API:            { label: 'Endpoint', placeholder: 'e.g. /api/customers' },
              };
              const lbl = assetLabelByType[connType] || { label: 'Table / File / Asset', placeholder: 'e.g. customers, invoices.csv' };
              return (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 500, display: 'block', marginBottom: 4 }}>Connection</label>
                    <select
                      aria-label="Connection"
                      style={selectStyle}
                      value={form.sourceConnectionId}
                      onChange={(e) => {
                        updateField('sourceConnectionId', e.target.value);
                        // Discovery results belong to the previous
                        // connection; clear so the picker matches the
                        // new one and the user isn't shown stale
                        // suggestions.
                        setSourceDiscovered([]);
                        setSourceDiscoverError(null);
                        // Intentionally do NOT pre-touch sourceAsset
                        // here — the field's "required" error should
                        // only surface after the user has actually
                        // engaged with it (or attempted to save), not
                        // the instant they pick a connection.
                        if (formValidation.touched.sourceAsset) {
                          formValidation.validateField('sourceAsset', form.sourceAsset, { ...form, sourceConnectionId: e.target.value });
                        }
                      }}
                    >
                      <option value="">-- No connection --</option>
                      {connectionsList.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}{c.connectionType ? ` (${c.connectionType})` : ''}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <span>{lbl.label}{form.sourceConnectionId ? ' *' : ''}</span>
                      {form.sourceConnectionId && (
                        <button
                          type="button"
                          onClick={discoverSourceAssets}
                          disabled={sourceDiscovering}
                          style={{
                            fontSize: 10, fontWeight: 500, padding: '2px 8px',
                            border: '1px solid var(--color-border)', borderRadius: 999,
                            background: 'var(--color-surface)', color: 'var(--color-primary)',
                            cursor: sourceDiscovering ? 'wait' : 'pointer',
                          }}
                          title={`List ${lbl.label.toLowerCase()}s on this connection`}
                        >
                          {sourceDiscovering ? 'Discovering…' : 'Discover'}
                        </button>
                      )}
                    </label>
                    {sourceDiscovered.length > 1 && (
                      <select
                        aria-label={`Pick discovered ${lbl.label.toLowerCase()}`}
                        style={{ ...selectStyle, marginBottom: 4 }}
                        value=""
                        onChange={(e) => {
                          if (e.target.value) updateAndRevalidate('sourceAsset', e.target.value);
                        }}
                      >
                        <option value="">-- Pick from {sourceDiscovered.length} discovered --</option>
                        {sourceDiscovered.map((a) => (
                          <option key={a.name} value={a.name}>{a.name}{a.type ? ` (${a.type.toLowerCase()})` : ''}</option>
                        ))}
                      </select>
                    )}
                    <input
                      aria-label={lbl.label}
                      style={{ ...inputStyle, border: formValidation.fieldError('sourceAsset') ? inputErrorBorder : inputStyle.border }}
                      value={form.sourceAsset}
                      onChange={(e) => updateAndRevalidate('sourceAsset', e.target.value)}
                      onBlur={() => { formValidation.touch('sourceAsset'); formValidation.validateField('sourceAsset', form.sourceAsset, form); }}
                      placeholder={lbl.placeholder}
                    />
                    {formValidation.fieldError('sourceAsset') && <div style={fieldErrorStyle}>{formValidation.fieldError('sourceAsset')}</div>}
                    {sourceDiscoverError && !formValidation.fieldError('sourceAsset') && (
                      <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 3 }}>{sourceDiscoverError}</div>
                    )}
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 500, display: 'block', marginBottom: 4 }}>Column (optional)</label>
                    <input aria-label="Column (optional)" style={inputStyle} value={form.sourceColumn} onChange={(e) => updateField('sourceColumn', e.target.value)} placeholder="e.g. email, account_id" />
                  </div>
                </div>
              );
            })()}
            {form.sourceConnectionId && (
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 6 }}>
                This asset will be linked to {connectionNameById[form.sourceConnectionId] || 'the selected connection'}
                {form.sourceAsset ? ` → ${form.sourceAsset}` : ''}
                {form.sourceColumn ? `.${form.sourceColumn}` : ''}.
                You can discover columns after saving.
              </div>
            )}
          </div>
            </>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={handleCancel}>Cancel</Button>
            {!editingId && (
              <Button
                variant="secondary"
                disabled={!form.name.trim()}
                onClick={() => handleSave(true)}
                title="Save this asset and keep the form open to add another"
              >
                Save & Add Another
              </Button>
            )}
            <Button
              variant="primary"
              disabled={!form.name.trim()}
              onClick={() => handleSave(false)}
            >
              {editingId ? 'Save Changes' : 'Add Data Asset'}
            </Button>
          </div>
        </SectionCard>
      )}

      <BulkSelectHint storageKey="data-assets" itemLabel="data assets" hasItems={assets.length > 0} hasSelection={sel.count > 0} />

      <BulkActionBar count={sel.count} onClear={sel.clear}>
        <BulkActionButton onClick={() => bulkSetTier('GOLD')}>Set {tierLabel('GOLD')}</BulkActionButton>
        <BulkActionButton onClick={() => bulkSetTier('SILVER')}>Set {tierLabel('SILVER')}</BulkActionButton>
        <BulkActionButton onClick={() => bulkSetTier('BRONZE')}>Set {tierLabel('BRONZE')}</BulkActionButton>
        <select
          aria-label="Assign owner"
          onChange={(e) => { if (e.target.value) bulkSetOwner(e.target.value); e.target.value = ''; }}
          style={{
            padding: '5px 12px', fontSize: 12, fontWeight: 500,
            background: 'var(--color-surface)', color: 'var(--color-text)',
            border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', cursor: 'pointer',
          }}
        >
          <option value="">Assign owner…</option>
          {peopleList.map((p) => (
            <option key={p.id} value={p.id}>{formatPersonLabel(p)}</option>
          ))}
        </select>
        <select
          aria-label="Assign system"
          onChange={(e) => { if (e.target.value) bulkSetSystem(e.target.value); e.target.value = ''; }}
          style={{
            padding: '5px 12px', fontSize: 12, fontWeight: 500,
            background: 'var(--color-surface)', color: 'var(--color-text)',
            border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', cursor: 'pointer',
          }}
        >
          <option value="">Assign system…</option>
          {systems.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <BulkActionButton variant="danger" onClick={() => setConfirmBulkDelete(true)}>Delete selected</BulkActionButton>
      </BulkActionBar>

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete Data Asset?"
        message="This will permanently delete this data asset. This cannot be undone."
        confirmLabel="Delete"
        onConfirm={async () => {
          const id = confirmDelete;
          setConfirmDelete(null);
          if (id) await handleDelete(id);
        }}
        onCancel={() => setConfirmDelete(null)}
      />

      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete Selected Data Assets?"
        message={`Delete ${sel.count} selected items? This cannot be undone.`}
        confirmLabel="Delete Selected"
        onConfirm={async () => {
          setConfirmBulkDelete(false);
          await handleBulkDelete();
        }}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      <ConfirmDialog
        open={confirmDuplicate !== null}
        variant="primary"
        title="Duplicate name?"
        message={confirmDuplicate
          ? `An asset called "${confirmDuplicate.name}" already exists in this organization. Save anyway? Cancel if this is a duplicate, or confirm if it's a legitimate same-name asset in a different context.`
          : ''}
        confirmLabel="Save Anyway"
        onConfirm={async () => {
          const pending = confirmDuplicate;
          setConfirmDuplicate(null);
          if (pending) await performSave(pending.keepOpen);
        }}
        onCancel={() => setConfirmDuplicate(null)}
      />

      <ConfirmDialog
        open={confirmColDelete !== null}
        title="Delete this column?"
        message={confirmColDelete
          ? `“${confirmColDelete.columnName}” has ${confirmColDelete.rulesCount} data-quality rule${confirmColDelete.rulesCount === 1 ? '' : 's'} referencing it. Deleting the column leaves ${confirmColDelete.rulesCount === 1 ? 'that rule' : 'those rules'} in place but detached from the column — ${confirmColDelete.rulesCount === 1 ? 'it' : 'they'} will still measure by column name if the source column exists, but no longer appear under this column. Delete the column anyway?`
          : ''}
        confirmLabel="Delete Column"
        onConfirm={async () => {
          const pending = confirmColDelete;
          setConfirmColDelete(null);
          if (pending) await deleteColumn(pending.assetId, pending.colId);
        }}
        onCancel={() => setConfirmColDelete(null)}
      />

      {/* Table */}
      <div style={{ background: 'var(--color-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', overflow: 'auto' }}>
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => { setLoadError(null); setLoading(true); fetchData(); }} />
        ) : loading ? (
          <SkeletonRows rows={5} columnWidths={[40, null, null, null, null, null, null, null, null, null, 180]} />
        ) : assets.length === 0 && !showForm ? (
          <EmptyState
            icon={renderNavIcon('/data-assets')}
            title="No data assets yet"
            description="Data assets are business-level concepts — Customer Accounts, Billing Records, Inventory Levels — not the underlying tables, files, or columns. Define them in plain business language, then link each one to its physical source via a Binding on the row."
            action={canOwnHere ? { label: '+ Add Data Asset', onClick: openAdd } : undefined}
          />
        ) : (
          <DataTable
            rows={sorted}
            columns={assetColumns}
            rowKey={(a) => a.id}
            rowId={(a) => `row-${a.id}`}
            selection={sel}
            isRowDisabled={(a) => isInheritedAsset(a.orgId, activeOrgId)}
            sort={{ sortKey, sortDir, onSort: toggleSort }}
            selectAllLabel="Select all assets"
            emptyMessage="No data assets match the current filters."
            pageSize={15}
            countNoun={['data asset', 'data assets']}
            expansion={{
              expandedIds: expandedAssetId ? new Set([expandedAssetId]) : new Set(),
              onToggleExpanded: toggleExpandColumns,
              renderExpandedRow: renderAssetExpansion,
            }}
          />
        )}
      </div>
        </div>
      </div>

      {/* Data Asset 360 View Modal */}
      <Modal
        open={!!(viewing360 || loading360)}
        onClose={() => { if (!loading360) setViewing360(null); }}
        size="lg"
        kicker="DATA ASSET"
        title={viewing360?.asset.name || 'Loading…'}
        subtitle={viewing360?.asset.description}
        ariaLabel={viewing360 ? `Data Asset: ${viewing360.asset.name}` : 'Data Asset details'}
        actions={viewing360 && canWrite ? (() => {
          const detailInherited = isInheritedAsset(viewing360.asset.orgId, activeOrgId);
          const ownerName = getOrgName(viewing360.asset.orgId);
          return (
            <>
              <OwnerBadge assetOrgId={viewing360.asset.orgId} activeOrgId={activeOrgId} getOrgName={getOrgName} />
              <button
                onClick={() => {
                  const asset = assets.find((a) => a.id === viewing360.asset.id);
                  if (asset) { setViewing360(null); openEdit(asset); }
                }}
                disabled={detailInherited}
                title={detailInherited ? `Owned at ${ownerName}. Switch the "Working in..." scope to ${ownerName} to edit.` : undefined}
                style={{
                  background: detailInherited ? 'var(--color-bg)' : 'var(--color-primary)',
                  color: detailInherited ? 'var(--color-text-muted)' : '#fff',
                  border: detailInherited ? '1px solid var(--color-border)' : 'none',
                  borderRadius: 4, padding: '6px 12px', fontSize: 13, fontWeight: 500,
                  cursor: detailInherited ? 'not-allowed' : 'pointer',
                }}
              >
                Edit
              </button>
            </>
          );
        })() : undefined}
        footer={viewing360 ? (
          // Explicit footer Close — keyboard / mobile users may not
          // discover the header X or backdrop click; the predictable
          // button-shaped affordance lives here.
          <button
            onClick={() => setViewing360(null)}
            style={{
              padding: '8px 16px', background: 'var(--color-bg)', color: 'var(--color-text)',
              border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
              fontSize: 13, fontWeight: 500, cursor: 'pointer',
            }}
          >
            Close
          </button>
        ) : undefined}
      >
        {loading360 ? (
          <Spinner center label="Loading…" />
        ) : viewing360 ? (
          <>
                {/* Asset Info */}
                <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                  {viewing360.system && (
                    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', background: 'var(--color-bg)', padding: '3px 10px', borderRadius: 4 }}>
                      System: {viewing360.system.name} {viewing360.system.systemType ? `(${viewing360.system.systemType})` : ''}
                    </span>
                  )}
                  {(viewing360.binding?.sourceAsset || viewing360.asset.sourceAsset) && (
                    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', background: 'var(--color-bg)', padding: '3px 10px', borderRadius: 4, fontFamily: 'var(--font-mono)' }}>
                      Source: {viewing360.binding?.sourceAsset || viewing360.asset.sourceAsset}
                    </span>
                  )}
                </div>

                {/* Physical binding — the business asset maps to this table and
                    (when scoped) this named set of its columns, each with its
                    own measured quality. */}
                {(viewing360.binding || viewing360.columns.length > 0) && (
                  <Card marginBottom={20}>
                    <SectionLabel>Bound columns</SectionLabel>
                    {viewing360.binding && (
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '6px 0 10px' }}>
                        {viewing360.binding.sourceColumns.length > 0
                          ? <>This asset is bound to {viewing360.binding.sourceColumns.length} column{viewing360.binding.sourceColumns.length === 1 ? '' : 's'} of <code style={{ fontFamily: 'var(--font-mono)' }}>{viewing360.binding.sourceAsset}</code>.</>
                          : <>This asset is bound to the whole of <code style={{ fontFamily: 'var(--font-mono)' }}>{viewing360.binding.sourceAsset}</code> (all columns).</>}
                      </div>
                    )}
                    {viewing360.columns.length > 0 ? (
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ textAlign: 'left', color: 'var(--color-text-muted)' }}>
                            <th style={{ padding: '4px 8px', fontWeight: 600 }}>Column</th>
                            <th style={{ padding: '4px 8px', fontWeight: 600 }}>Type</th>
                            <th style={{ padding: '4px 8px', fontWeight: 600 }}>Rules</th>
                            <th style={{ padding: '4px 8px', fontWeight: 600 }}>Health</th>
                          </tr>
                        </thead>
                        <tbody>
                          {viewing360.columns.map((col) => {
                            const h = col.healthScore;
                            const hColor = h == null ? 'var(--color-text-muted)'
                              : h >= 80 ? 'var(--color-success)'
                              : h >= 50 ? 'var(--color-warning)' : 'var(--color-error)';
                            return (
                              <tr key={col.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                                <td style={{ padding: '5px 8px', fontFamily: 'var(--font-mono)' }}>
                                  {col.columnName}
                                  {col.isPrimaryKey && <span title="Primary key" style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: '#92400e', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 3, padding: '0 4px' }}>PK</span>}
                                  {col.references && <span title={`References ${col.references}`} style={{ marginLeft: 6, fontSize: 10, color: 'var(--color-text-muted)' }}>→ {col.references}</span>}
                                </td>
                                <td style={{ padding: '5px 8px', color: 'var(--color-text-secondary)' }}>{col.dataType || '—'}</td>
                                <td style={{ padding: '5px 8px', color: col.rulesCount === 0 ? 'var(--color-warning)' : 'var(--color-text-secondary)' }}>
                                  {col.rulesCount === 0 ? 'No rules' : `${col.rulesCount} rule${col.rulesCount === 1 ? '' : 's'}`}
                                </td>
                                <td style={{ padding: '5px 8px', fontWeight: 600, color: hColor }}>
                                  {h == null ? '—' : `${h}%`}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                        No columns defined yet. Link this asset to a source and pick its columns, or auto-discover them.
                      </div>
                    )}
                  </Card>
                )}

                {/* Sensitivity — Suggest & Review flow. Sits above the
                    cross-layer WhereUsed view so a reviewer sees the
                    classification before deciding whether the asset's
                    downstream footprint is defensible. */}
                <SensitivityPanel
                  assetId={viewing360.asset.id}
                  initialTags={viewing360.asset.sensitivityTags}
                  disabled={!canWrite || isInheritedAsset(viewing360.asset.orgId, activeOrgId)}
                  onCommittedChange={(next) => {
                    setViewing360((prev) => prev ? { ...prev, asset: { ...prev.asset, sensitivityTags: next } } : prev);
                    setAssets((prev) => prev.map((a) => a.id === viewing360.asset.id ? { ...a, sensitivityTags: next } : a));
                  }}
                />

                {/* Impact analysis — the "what breaks + who to tell"
                    question. Sits above the WhereUsed view because
                    change management is the more urgent read; WhereUsed
                    stays as the general-purpose informational lookup. */}
                <ImpactAnalysisPanel
                  assetId={viewing360.asset.id}
                  onNavigateToActivity={(nodeId) => { setViewing360(null); navigate(`/processes?node=${encodeURIComponent(nodeId)}`); }}
                  onNavigateToPerson={(personId) => { setViewing360(null); navigate(`/people/${encodeURIComponent(personId)}`); }}
                />

                {/* Cross-layer view — same WhereUsed shape used on Systems,
                    Activities, and People so users learn one navigation
                    pattern. Detail sections below stay for now and will be
                    deduplicated as part of the visual density pass. */}
                <div style={{ marginBottom: 20 }}>
                  {(() => {
                    const groups: WhereUsedGroup[] = [
                      {
                        title: 'Lives in',
                        hint: 'The system of record for this asset.',
                        emptyText: 'No system set.',
                        items: viewing360.system ? [{
                          id: viewing360.system.id,
                          label: viewing360.system.name,
                          sublabel: viewing360.system.systemType || undefined,
                          onClick: () => { setViewing360(null); navigate(`/systems?highlight=${encodeURIComponent(viewing360.system!.id)}`); },
                        }] : [],
                      },
                      {
                        title: 'Supports activities',
                        hint: 'Process activities that consume or produce this asset.',
                        emptyText: 'Not mapped to any process activity yet.',
                        items: viewing360.mappings.map((m) => ({
                          id: m.id,
                          label: m.processPath,
                          sublabel: m.linkType,
                          onClick: () => { setViewing360(null); navigate(`/processes?highlight=${encodeURIComponent(m.processStepId)}`); },
                        })),
                      },
                      {
                        title: 'Belongs to domain',
                        hint: 'The data domain this asset is grouped under.',
                        emptyText: 'Not assigned to any domain.',
                        items: viewing360.domain ? [{
                          id: viewing360.domain.id,
                          label: viewing360.domain.name,
                          sublabel: viewing360.domain.ownerName ? `Owner: ${viewing360.domain.ownerName}` : undefined,
                          onClick: () => { setViewing360(null); navigate(`/data-domains?highlight=${encodeURIComponent(viewing360.domain!.id)}`); },
                        }] : [],
                      },
                      {
                        title: 'Ownership',
                        hint: 'Who is accountable for this asset.',
                        emptyText: 'No owner or steward assigned.',
                        items: [
                          ...(viewing360.ownerInfo ? [{
                            id: `owner-${viewing360.ownerInfo.id || viewing360.ownerInfo.name}`,
                            label: viewing360.ownerInfo.name,
                            badge: 'Owner',
                            badgeRoleType: 'DATA_ASSET_OWNER',
                            onClick: viewing360.ownerInfo.id
                              ? () => { setViewing360(null); navigate(`/people/${viewing360.ownerInfo!.id}`); }
                              : undefined,
                          }] : []),
                          ...viewing360.stewardInfos.map((s) => ({
                            id: `steward-${s.id}`,
                            label: s.name,
                            badge: 'Steward',
                            badgeRoleType: 'DATA_ASSET_STEWARD',
                            onClick: () => { setViewing360(null); navigate(`/people/${s.id}`); },
                          })),
                        ],
                      },
                    ];
                    return (
                      <WhereUsed
                        hint="Where this asset sits across the business, data, and people layers."
                        groups={groups}
                      />
                    );
                  })()}
                </div>

                <FieldStack gap="section">
                {/* Data Domain */}
                <div>
                  <SectionLabel>Data Domain</SectionLabel>
                  {viewing360.domain ? (
                    <div style={{ background: 'var(--color-bg)', borderRadius: 'var(--radius-md)', padding: '10px 14px' }}>
                      <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>{viewing360.domain.name}</div>
                      {viewing360.domain.ownerName && <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Owner: {viewing360.domain.ownerName}</div>}
                      {viewing360.domain.stewards.length > 0 && (
                        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Stewards: {viewing360.domain.stewards.map((s) => s.name).join(', ')}</div>
                      )}
                    </div>
                  ) : (
                    <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Not assigned to any domain</p>
                  )}
                </div>

                {/* Mappings */}
                <div>
                  <SectionLabel>Process Mappings ({viewing360.mappings.length})</SectionLabel>
                  {viewing360.mappings.length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>No process mappings for this asset</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {viewing360.mappings.map((m) => (
                        <div key={m.id} style={{ background: 'var(--color-bg)', borderRadius: 'var(--radius-md)', padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 12 }}>{m.processPath}</span>
                          <span style={{
                            display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 500,
                            background: 'var(--color-primary-light)', color: 'var(--color-primary)',
                          }}>{m.linkType}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Comments — uses the shared threaded panel with @mention
                  *  autocomplete and notifications. */}
                <div>
                  <SectionLabel>Discussion</SectionLabel>
                  <CommentsPanel
                    entityType="DataAsset"
                    entityId={viewing360.asset.id}
                    entityLabel={`Data Asset: ${viewing360.asset.name}`}
                  />
                </div>
                <div>
                  <SectionLabel>Activity</SectionLabel>
                  <ActivityFeed entityType="DataAsset" entityId={viewing360.asset.id} inline initialRows={5} />
                </div>
                </FieldStack>
              </>
            ) : null}
      </Modal>

      {linkModalAsset && (
        <Suspense fallback={null}>
          <LinkConnectionModal
            asset={{ id: linkModalAsset.id, name: linkModalAsset.name }}
            activeOrgId={activeOrgId}
            existingBinding={linkModalMode === 'change' ? (() => {
              const b = primaryBindingOf(linkModalAsset.id);
              return b ? { id: b.id, connectionId: b.connectionId, sourceAsset: b.sourceAsset, sourceColumn: b.sourceColumn, sourceColumns: b.sourceColumns } : undefined;
            })() : undefined}
            onClose={() => setLinkModalAsset(null)}
            onLinked={fetchData}
          />
        </Suspense>
      )}

      {suggestAsset && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--color-surface)', borderRadius: 'var(--radius-md)', width: '100%', maxWidth: 560, maxHeight: '85vh', overflow: 'auto', padding: 20, boxShadow: 'var(--shadow-lg)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
              <div>
                <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 2 }}>Suggest source</h2>
                <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                  Candidate bindings for <strong>{suggestAsset.name}</strong>, ranked by name match against connections in this org.
                </span>
              </div>
              <button onClick={() => setSuggestAsset(null)} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: 'var(--color-text-muted)', padding: 4 }}>&times;</button>
            </div>

            {suggestLoading ? (
              <div style={{ padding: 16, fontSize: 12, color: 'var(--color-text-muted)' }}>Searching connections…</div>
            ) : suggestions.length === 0 ? (
              <div style={{ padding: 16, fontSize: 12, color: 'var(--color-text-muted)', background: 'var(--color-bg)', borderRadius: 'var(--radius-md)' }}>
                No candidate sources found. Either no connection in this org has been crawled yet, or none have file/column names that overlap with the asset name. Try the <strong>Discover assets</strong> button on the Connections page first, or use <strong>Link to connection</strong> to bind manually.
              </div>
            ) : (
              <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                {suggestions.map((s) => {
                  const key = `${s.connectionId}::${s.sourceAsset}::${s.sourceColumn || ''}`;
                  const busy = suggestBusyId === key;
                  return (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderTop: '1px solid var(--color-border)' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>
                          {s.sourceAsset}{s.sourceColumn ? <span style={{ color: 'var(--color-primary)' }}>{` . ${s.sourceColumn}`}</span> : ''}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                          {s.connectionName} · {s.connectionType} · {s.reason}
                        </div>
                      </div>
                      <span title="Match score" style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 999, background: '#dbeafe', color: '#1e40af' }}>
                        {Math.round(s.score * 100)}%
                      </span>
                      <button
                        onClick={() => acceptSuggestion(s)}
                        disabled={busy}
                        style={{
                          padding: '5px 12px', fontSize: 12, fontWeight: 500,
                          background: 'var(--color-primary)', color: '#fff', border: 'none',
                          borderRadius: 'var(--radius-md)', cursor: busy ? 'not-allowed' : 'pointer',
                          opacity: busy ? 0.6 : 1,
                        }}
                      >
                        {busy ? 'Binding…' : 'Bind'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button onClick={() => setSuggestAsset(null)} style={{ padding: '8px 16px', background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 13, cursor: 'pointer' }}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
