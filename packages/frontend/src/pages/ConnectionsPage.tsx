import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiClient } from '../api/client';
import { thStyle, tdStyle } from '../lib/tableStyles';
import EmbeddablePageHeader from '../components/EmbeddablePageHeader';
import SectionLabel from '../components/SectionLabel';
import Card from '../components/Card';
import TruncatedText from '../components/TruncatedText';
import { useOrgContext } from '../stores/orgContext';
import { useToastStore } from '../stores/toastStore';
import { usePolling } from '../hooks/usePolling';
import ConfirmDialog from '../components/ConfirmDialog';
import IconButton from './../components/IconButton';
import Button from '../components/Button';
import ExportMenu from '../components/ExportMenu';
import SavedViewsMenu from '../components/SavedViewsMenu';
import EmptyState from './../components/EmptyState';
import ErrorState from '../components/ErrorState';
import { errorMessage } from '../lib/errorToast';
import { renderNavIcon } from './../components/navIcons';
import StatusBadge from '../components/StatusBadge';
import { useSortedList } from '../hooks/useSortedList';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import { useRowSelection } from '../hooks/useRowSelection';
import BulkActionBar, { BulkActionButton } from '../components/BulkActionBar';
import { SkeletonRows } from '../components/Skeleton';
import { useColumnPicker } from '../hooks/useColumnPicker';
import ColumnPicker from '../components/ColumnPicker';
import { clickable } from '../lib/a11y';
import { useFormValidation, fieldErrorStyle, inputErrorBorder } from '../hooks/useFormValidation';
import { useFocusTrap } from '../hooks/useFocusTrap';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConnectionProfile {
  id: string;
  orgId: string;
  /** All systems this connection serves (many-to-many). Populated by
   *  the backend from the connectionSystemLinks join table. */
  systemIds?: string[];
  name: string;
  connectionType: string;
  config: Record<string, any> & {
    // LOCAL file storage fields populated by the upload endpoint
    localFilePath?: string;
    originalFileName?: string;
    fileSize?: number;
    rowCount?: number;
    columns?: string[];
    lastUploadedAt?: string;
  };
  credentials: Record<string, any>;
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'UNTESTED';
  lastTestedAt: string | null;
  lastTestResult: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SystemEntity {
  id: string;
  name: string;
  description: string;
  systemType: string;
}

interface DiscoveredAsset {
  name: string;
  type: string;
  rowCount?: number;
  lastModified?: string;
  columns?: string[];
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)', borderRadius: 4,
  padding: '6px 10px', fontSize: 13, width: '100%', background: 'var(--color-surface)',
};

const selectStyle: React.CSSProperties = { ...inputStyle, appearance: 'auto' as any };



// ---------------------------------------------------------------------------
// Badge colors
// ---------------------------------------------------------------------------

const STATUS_BADGES: Record<string, { bg: string; color: string }> = {
  CONNECTED: { bg: '#d1f0eb', color: '#0f4f46' },
  DISCONNECTED: { bg: '#f1f5f9', color: '#64748b' },
  ERROR: { bg: '#fce7f3', color: '#9d174d' },
  UNTESTED: { bg: '#fef3c7', color: '#92400e' },
};

const TYPE_BADGES: Record<string, { bg: string; color: string }> = {
  DATABASE: { bg: '#dbeafe', color: '#1e40af' },
  FILE_STORAGE: { bg: '#fef3c7', color: '#92400e' },
  API: { bg: '#d1f0eb', color: '#0f4f46' },
  DATA_WAREHOUSE: { bg: '#ede9fe', color: '#5b21b6' },
  SPREADSHEET: { bg: '#f1f5f9', color: '#64748b' },
};

const TYPE_LABELS: Record<string, string> = {
  DATABASE: 'Database',
  FILE_STORAGE: 'File Storage',
  API: 'API',
  DATA_WAREHOUSE: 'Data Warehouse',
  SPREADSHEET: 'Spreadsheet',
};

// ---------------------------------------------------------------------------
// Form interface
// ---------------------------------------------------------------------------

interface FormData {
  name: string;
  systemIds: string[];
  connectionType: string;
  config: Record<string, any>;
  credentials: Record<string, any>;
}

const emptyForm: FormData = {
  name: '', systemIds: [], connectionType: 'DATABASE',
  config: {}, credentials: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function configSummary(conn: ConnectionProfile): string {
  const c = conn.config;
  if (conn.connectionType === 'DATABASE') {
    const parts = [c.host, c.port ? `:${c.port}` : '', c.database ? `/${c.database}` : ''];
    return parts.join('') || '--';
  }
  if (conn.connectionType === 'FILE_STORAGE') {
    if (c.storageType === 'LOCAL') {
      return c.originalFileName
        ? `LOCAL://${c.originalFileName} (${formatBytes(c.fileSize)})`
        : 'LOCAL (no file uploaded)';
    }
    return c.bucket ? `${c.storageType || ''}://${c.bucket}${c.path ? '/' + c.path : ''}` : '--';
  }
  if (conn.connectionType === 'API') return c.baseUrl || '--';
  if (conn.connectionType === 'DATA_WAREHOUSE') {
    return c.account ? `${c.warehouseType || ''}://${c.account}${c.warehouse ? '/' + c.warehouse : ''}` : '--';
  }
  if (conn.connectionType === 'SPREADSHEET') return c.documentUrl || '--';
  return '--';
}

function timeAgo(iso: string | null): string {
  if (!iso) return '--';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type ConnColId = 'system' | 'name' | 'type' | 'config' | 'status' | 'lastTested';
const CONN_COLUMN_DEFS: Array<{ id: ConnColId; label: string; defaultVisible: boolean }> = [
  { id: 'system',     label: 'Systems',        defaultVisible: true  },
  { id: 'name',       label: 'Connection Name',defaultVisible: true  },
  { id: 'type',       label: 'Type',           defaultVisible: true  },
  { id: 'config',     label: 'Config',         defaultVisible: false },
  { id: 'status',     label: 'Status',         defaultVisible: true  },
  { id: 'lastTested', label: 'Last Tested',    defaultVisible: true  },
];

export default function ConnectionsPage({
  embedded = false,
  actionsPortal,
}: {
  embedded?: boolean;
  actionsPortal?: HTMLElement | null;
} = {}) {
  const { activeOrgId } = useOrgContext();
  const addToast = useToastStore((s) => s.addToast);
  const [searchParams, setSearchParams] = useSearchParams();
  // System filter read from / synced to the URL so Systems-tab shortcuts
  // (`?systemId=<id>`) and in-page dropdown changes share a single source
  // of truth.
  const systemFilter = searchParams.get('systemId') || '';
  const setSystemFilter = (next: string) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('systemId', next); else params.delete('systemId');
    params.delete('open');
    setSearchParams(params, { replace: true });
  };

  const connCols = useColumnPicker<ConnColId>('procela.connections.visibleCols.v1', CONN_COLUMN_DEFS);
  const [connections, setConnections] = useState<ConnectionProfile[]>([]);
  const [systems, setSystems] = useState<SystemEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);
  const validation = useFormValidation({ name: (v) => !(v as string)?.trim() ? 'Name is required' : null });
  // Local-file upload staging — the File is attached to the form but not sent
  // until Save (we need the connection id the POST/PUT returns).
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [discoveringId, setDiscoveringId] = useState<string | null>(null);
  const [discoveredAssets, setDiscoveredAssets] = useState<DiscoveredAsset[]>([]);
  const [discoverSimulated, setDiscoverSimulated] = useState(false);
  const [discoverModal, setDiscoverModal] = useState<{ connId: string; systemId: string; systemName: string } | null>(null);
  const discoverModalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(discoverModalRef, !!discoverModal);
  useEffect(() => {
    if (!discoverModal) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setDiscoverModal(null); setDiscoveredAssets([]); setExpandedAssets(new Set()); setReconcileMode(false); setReconcileItems([]); setReconcileDecisions({}); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [discoverModal]);
  const [formTestResult, setFormTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [formTesting, setFormTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [filterConnType, setFilterConnType] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  // Which assets in the Discover modal are expanded to show their columns.
  const [expandedAssets, setExpandedAssets] = useState<Set<string>>(new Set());

  // ── Reconciliation (Phase 3, A2): match discovered assets to the catalog ──
  interface ReconcileItem {
    sourceAsset: string;
    type: string;
    columns: string[];
    status: 'linked' | 'suggested' | 'new';
    linkedAssetId?: string;
    linkedAssetName?: string;
    suggestion?: { dataAssetId: string; dataAssetName: string; score: number; reason: string };
  }
  interface ReconcileDecision { action: 'link' | 'create' | 'skip'; dataAssetId?: string }
  const [reconcileMode, setReconcileMode] = useState(false);
  const [reconcileLoading, setReconcileLoading] = useState(false);
  const [reconcileApplying, setReconcileApplying] = useState(false);
  const [reconcileItems, setReconcileItems] = useState<ReconcileItem[]>([]);
  const [reconcileDecisions, setReconcileDecisions] = useState<Record<string, ReconcileDecision>>({});
  const [catalogAssets, setCatalogAssets] = useState<Array<{ id: string; name: string }>>([]);

  // Connection type options from server
  const [connectionTypes, setConnectionTypes] = useState<string[]>([]);
  const [dbTypes, setDbTypes] = useState<string[]>([]);
  const [storageTypes, setStorageTypes] = useState<string[]>([]);
  const [authTypes, setAuthTypes] = useState<string[]>([]);
  const [warehouseTypes, setWarehouseTypes] = useState<string[]>([]);

  // -----------------------------------------------------------------------
  // Fetch
  // -----------------------------------------------------------------------

  const fetchData = useCallback(async () => {
    try {
      setLoadError(null);
      const query = activeOrgId ? `?orgId=${activeOrgId}` : '';
      const [connRes, sysRes] = await Promise.all([
        apiClient.get<{
          success: boolean;
          data: ConnectionProfile[];
          connectionTypes: string[];
          dbTypes: string[];
          storageTypes: string[];
          authTypes: string[];
          warehouseTypes: string[];
        }>(`/connections${query}`),
        apiClient.get<{ success: boolean; data: SystemEntity[] }>(`/systems${query}`),
      ]);
      setConnections(connRes.data || []);
      setConnectionTypes(connRes.connectionTypes || []);
      setDbTypes(connRes.dbTypes || []);
      setStorageTypes(connRes.storageTypes || []);
      setAuthTypes(connRes.authTypes || []);
      setWarehouseTypes(connRes.warehouseTypes || []);
      setSystems(sysRes.data || []);
    } catch (err) { setLoadError(errorMessage(err, 'Failed to load connections.')); }
    finally { setLoading(false); }
  }, [activeOrgId]);

  useEffect(() => { fetchData(); }, [fetchData]);
  usePolling(fetchData, 30000);

  // When we arrive with `?open=1`, auto-open the Add form with the system
  // pre-selected (from `?systemId=`). We clear `open` afterwards so a page
  // reload doesn't re-trigger the form.
  useEffect(() => {
    if (searchParams.get('open') === '1') {
      const sid = searchParams.get('systemId') || '';
      setForm({ ...emptyForm, systemIds: sid ? [sid] : [] });
      setEditingId(null);
      setShowForm(true);
      const params = new URLSearchParams(searchParams);
      params.delete('open');
      setSearchParams(params, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  const openAdd = () => {
    if (!activeOrgId) { addToast('error', 'Select an organization from the header first.'); return; } setFormTestResult(null);
    // Pre-fill systemIds from the active filter so "+ Add Connection" under a
    // System filter keeps the user's context.
    setForm({ ...emptyForm, systemIds: systemFilter ? [systemFilter] : [] });
    setEditingId(null);
    setPendingFile(null);
    setShowForm(true);
  };

  const openEdit = (conn: ConnectionProfile) => {
    setForm({
      name: conn.name,
      systemIds: conn.systemIds ? [...conn.systemIds] : [],
      connectionType: conn.connectionType,
      config: { ...conn.config },
      credentials: { ...conn.credentials },
    });
    setEditingId(conn.id);
    setPendingFile(null);
    setShowForm(true);
  };

  // Duplicate — pre-fills the create form with the source's values,
  // nudges the name with a "(copy)" suffix so the user isn't forced
  // to pick something unique immediately.
  const openDuplicate = (conn: ConnectionProfile) => {
    setForm({
      name: `${conn.name} (copy)`,
      systemIds: conn.systemIds ? [...conn.systemIds] : [],
      connectionType: conn.connectionType,
      config: { ...conn.config },
      credentials: { ...conn.credentials },
    });
    setEditingId(null);
    setPendingFile(null);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!activeOrgId) { addToast('error', 'Select an organization from the header first.'); return; }
    if (!validation.validateAll(form)) return;
    try {
      setUploading(!!pendingFile);
      let savedId: string | null = editingId;
      if (editingId) {
        await apiClient.put(`/connections/${editingId}`, form);
        addToast('success', 'Connection profile updated');
      } else {
        // New connections don't have an id yet; grab it from the response so
        // a staged local file can be uploaded against the right profile.
        const res = await apiClient.post<{ success: boolean; data: ConnectionProfile }>(
          '/connections',
          { ...form, ...(activeOrgId ? { orgId: activeOrgId } : {}) },
        );
        savedId = res.data?.id || null;
        addToast('success', 'Connection profile created');
      }

      // Upload the staged file for LOCAL file-storage connections after the
      // profile exists, so the backend has an id to key the upload dir on.
      if (pendingFile && savedId && form.connectionType === 'FILE_STORAGE' && form.config.storageType === 'LOCAL') {
        try {
          const uploadRes = await apiClient.upload<{ success: boolean; data: { parseError: string | null } }>(
            `/connections/${savedId}/upload`,
            pendingFile,
          );
          if (uploadRes.data?.parseError) {
            addToast('error', `File saved but parse failed: ${uploadRes.data.parseError}`);
          } else {
            addToast('success', `Uploaded ${pendingFile.name}`);
          }
        } catch (e) {
          addToast('error', e instanceof Error ? e.message : 'Upload failed');
        }
      }

      setShowForm(false); setEditingId(null); setForm(emptyForm); setPendingFile(null);
      // After adding a new connection, drop the user back on the unfiltered
      // default view so the row they just created is visible regardless of
      // any system/type filter that was active during creation.
      if (!editingId) {
        setSearchParams(new URLSearchParams(), { replace: true });
        setFilterConnType('');
      }
      fetchData();
      return savedId;
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Save failed');
    } finally {
      setUploading(false);
    }
  };

  const handleTest = async () => {
    if (!form.name.trim()) return;
    setFormTesting(true);
    setFormTestResult(null);
    try {
      // Pre-save LOCAL file upload: send the staged file bytes to a
      // dedicated test endpoint that parses against an OS tmp file and
      // immediately deletes it, so the user can validate the file
      // without needing to Save first.
      const useStagedTest =
        form.connectionType === 'FILE_STORAGE' &&
        form.config.storageType === 'LOCAL' &&
        !!pendingFile;
      const res = useStagedTest
        ? await apiClient.upload<{ success: boolean; data: { success: boolean; message: string } }>(
            // apiClient.upload appends ?filename=… automatically; passing
            // it again here would produce a duplicate param that the
            // backend rejects with 400.
            '/connections/test-file',
            pendingFile!,
          )
        : await apiClient.post<{ success: boolean; data: { success: boolean; message: string } }>(
            '/connections/test',
            {
              ...(editingId ? { id: editingId } : {}),
              connectionType: form.connectionType,
              config: form.config,
              credentials: form.credentials,
            },
          );
      setFormTestResult({ success: res.data.success, message: res.data.message });
      if (res.data.success) {
        addToast('success', `Test passed: ${res.data.message}`);
      } else {
        addToast('error', `Test failed: ${res.data.message}`);
      }
    } catch (err: any) {
      const detail = err?.message && err.message !== 'Connection test failed' ? `: ${err.message}` : '';
      setFormTestResult({ success: false, message: `Connection test failed${detail}` });
      addToast('error', `Connection test failed${detail}`);
    } finally {
      setFormTesting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiClient.delete(`/connections/${id}`);
      addToast('success', 'Connection deleted');
      fetchData();
    } catch { addToast('error', 'Delete failed'); }
  };

  // ── Bulk select handlers ──
  const handleBulkDelete = async () => {
    if (sel.count === 0) return;
    try {
      await Promise.all(Array.from(sel.selectedIds).map((id) => apiClient.delete(`/connections/${id}`)));
      addToast('success', `Deleted ${sel.count} connections`);
      sel.clear();
      fetchData();
    } catch { addToast('error', 'Bulk delete failed'); }
  };

  const handleCancel = () => { setShowForm(false); setEditingId(null); setForm(emptyForm); setPendingFile(null); setFormTestResult(null); validation.clearErrors(); };

  // -----------------------------------------------------------------------
  // Test
  // -----------------------------------------------------------------------

  const handleRowTest = async (id: string) => {
    setTestingIds((prev) => new Set(prev).add(id));
    try {
      const res = await apiClient.post<{ success: boolean; data: { success: boolean; message: string; latencyMs: number; profile: ConnectionProfile } }>(`/connections/${id}/test`);
      if (res.data.success) {
        addToast('success', `Connected: ${res.data.message}`);
      } else {
        addToast('error', `Failed: ${res.data.message}`);
      }
      fetchData();
    } catch (err: any) {
      // Surface the backend's actual reason instead of a generic toast.
      // The ApiError carries the parsed `error` field from the response.
      const detail = err?.message && err.message !== 'Connection test failed' ? `: ${err.message}` : '';
      addToast('error', `Connection test failed${detail}`);
      fetchData();
    } finally {
      setTestingIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  // -----------------------------------------------------------------------
  // Discover
  // -----------------------------------------------------------------------

  const handleDiscover = async (conn: ConnectionProfile) => {
    // Discovery surfaces assets under one system; if a connection serves
    // multiple, pick the first link as the default landing spot.
    const ids = conn.systemIds ?? [];
    const primaryId = ids[0] || '';
    const sys = systems.find((s) => s.id === primaryId);
    setDiscoverModal({ connId: conn.id, systemId: primaryId, systemName: sys?.name || 'Unknown System' });
    setDiscoveringId(conn.id);
    setDiscoveredAssets([]);
    setDiscoverSimulated(false);
    try {
      const res = await apiClient.post<{ success: boolean; data: { success: boolean; simulated?: boolean; details?: { assets?: DiscoveredAsset[] } } }>(`/connections/${conn.id}/discover`);
      setDiscoveredAssets(res.data.details?.assets || []);
      setDiscoverSimulated(res.data.simulated === true);
    } catch {
      addToast('error', 'Discovery failed');
      setDiscoverModal(null);
    } finally {
      setDiscoveringId(null);
    }
  };

  // Note: the Discover modal is informational only now. Creating Data
  // Assets + binding them to a column happens from DataAssetsPage via
  // the Link flow, so there's no import/select shortcut here anymore.

  const toggleAssetExpanded = (assetName: string) => {
    setExpandedAssets((prev) => {
      const next = new Set(prev);
      if (next.has(assetName)) next.delete(assetName); else next.add(assetName);
      return next;
    });
  };

  // Switch the Discover modal into reconciliation mode: fetch the catalog
  // match for each discovered asset and seed a default decision (confirm the
  // suggestion, else create a new asset). Linked ones stay as-is.
  const openReconcile = async (connId: string) => {
    setReconcileMode(true);
    setReconcileLoading(true);
    try {
      const [recon, assetsRes] = await Promise.all([
        apiClient.get<{ success: boolean; data: { items: ReconcileItem[] } }>(`/data-assets/reconcile/${connId}`),
        apiClient.get<{ success: boolean; data: Array<{ id: string; name: string }> }>(`/data-assets`),
      ]);
      const items = recon.data.items || [];
      setReconcileItems(items);
      setCatalogAssets((assetsRes.data || []).map((a) => ({ id: a.id, name: a.name })));
      const seed: Record<string, ReconcileDecision> = {};
      for (const it of items) {
        if (it.status === 'linked') seed[it.sourceAsset] = { action: 'skip' };
        else if (it.status === 'suggested') seed[it.sourceAsset] = { action: 'link', dataAssetId: it.suggestion!.dataAssetId };
        else seed[it.sourceAsset] = { action: 'create' };
      }
      setReconcileDecisions(seed);
    } catch {
      addToast('error', 'Could not load reconciliation');
      setReconcileMode(false);
    } finally {
      setReconcileLoading(false);
    }
  };

  const setDecision = (sourceAsset: string, value: string) => {
    // value is 'create', 'skip', or an existing asset id (link).
    setReconcileDecisions((prev) => ({
      ...prev,
      [sourceAsset]: value === 'create' || value === 'skip'
        ? { action: value }
        : { action: 'link', dataAssetId: value },
    }));
  };

  const applyReconcile = async (connId: string) => {
    setReconcileApplying(true);
    try {
      const decisions = reconcileItems
        .filter((it) => it.status !== 'linked')
        .map((it) => {
          const d = reconcileDecisions[it.sourceAsset] || { action: 'skip' };
          return { sourceAsset: it.sourceAsset, action: d.action, dataAssetId: d.dataAssetId, columns: it.columns };
        });
      const res = await apiClient.post<{ success: boolean; data: { linked: number; created: number; skipped: number; errors: string[] } }>(`/data-assets/reconcile/${connId}`, { decisions });
      const s = res.data;
      addToast('success', `Reconciled: ${s.linked} linked, ${s.created} created${s.skipped ? `, ${s.skipped} skipped` : ''}`);
      if (s.errors && s.errors.length) addToast('error', `${s.errors.length} item(s) failed`);
      await openReconcile(connId); // refresh statuses (bound ones now read "linked")
    } catch {
      addToast('error', 'Reconciliation failed');
    } finally {
      setReconcileApplying(false);
    }
  };

  const closeDiscover = () => {
    setDiscoverModal(null); setDiscoveredAssets([]); setExpandedAssets(new Set());
    setReconcileMode(false); setReconcileItems([]); setReconcileDecisions({});
  };

  // -----------------------------------------------------------------------
  // Filtering + Stats
  // -----------------------------------------------------------------------

  // Stats and the table both operate on the system-filtered view so the
  // numbers line up with what the user is looking at.
  const visibleConnections = connections.filter((c) => {
    if (systemFilter) {
      const ids = c.systemIds ?? [];
      if (!ids.includes(systemFilter)) return false;
    }
    if (filterConnType && c.connectionType !== filterConnType) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const sysName = systems.filter((s) => (c.systemIds ?? []).includes(s.id)).map((s) => s.name).join(' ');
      if (
        !c.name.toLowerCase().includes(q) &&
        !sysName.toLowerCase().includes(q) &&
        !(c.connectionType || '').toLowerCase().includes(q)
      ) return false;
    }
    return true;
  });
  const filterSystem = systemFilter ? systems.find((s) => s.id === systemFilter) : null;

  const systemNameMap: Record<string, string> = {};
  systems.forEach((s) => { systemNameMap[s.id] = s.name; });

  // Sort: comparators keyed by column name; URL persists ?sort=&dir=
  const { sorted, sortKey, sortDir, toggleSort } = useSortedList(
    visibleConnections,
    {
      name: (a, b) => a.name.localeCompare(b.name),
      connectionType: (a, b) => a.connectionType.localeCompare(b.connectionType),
      status: (a, b) => a.status.localeCompare(b.status),
      // Sort by the first served system name the cell shows; unassigned
      // connections sort to the end regardless of direction.
      system: (a, b) => {
        const na = (a.systemIds ?? []).map((id) => systemNameMap[id]).filter(Boolean)[0] || '';
        const nb = (b.systemIds ?? []).map((id) => systemNameMap[id]).filter(Boolean)[0] || '';
        if (!na && !nb) return 0;
        if (!na) return 1;
        if (!nb) return -1;
        return na.localeCompare(nb);
      },
      // Sort by the derived config summary string the Config cell renders.
      config: (a, b) => configSummary(a).localeCompare(configSummary(b)),
      // Sort by the actual last-tested timestamp (the cell shows it as a
      // relative "N ago"); never-tested connections sort to the end.
      lastTested: (a, b) => {
        const ta = a.lastTestedAt ? Date.parse(a.lastTestedAt) : NaN;
        const tb = b.lastTestedAt ? Date.parse(b.lastTestedAt) : NaN;
        const aNan = Number.isNaN(ta);
        const bNan = Number.isNaN(tb);
        if (aNan && bNan) return 0;
        if (aNan) return 1;
        if (bNan) return -1;
        return ta - tb;
      },
    },
    'name',
    'asc',
    'c_',
  );

  const sel = useRowSelection(sorted, (c) => c.id);

  // -----------------------------------------------------------------------
  // Form fields by connection type
  // -----------------------------------------------------------------------

  const updateConfig = (key: string, value: any) => setForm((f) => ({ ...f, config: { ...f.config, [key]: value } }));
  const updateCreds = (key: string, value: any) => setForm((f) => ({ ...f, credentials: { ...f.credentials, [key]: value } }));

  const renderTypeFields = () => {
    const fieldRow = (label: string, content: React.ReactNode, fullWidth = false) => (
      <div style={fullWidth ? { gridColumn: '1 / -1' } : undefined}>
        <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>{label}</label>
        {content}
      </div>
    );

    switch (form.connectionType) {
      case 'DATABASE':
        return (
          <>
            {fieldRow('Database Type', (
              <select aria-label="Database Type" style={selectStyle} value={form.config.dbType || ''} onChange={(e) => updateConfig('dbType', e.target.value)}>
                <option value="">-- Select --</option>
                {dbTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            ))}
            {fieldRow('Host', <input aria-label="Host" style={inputStyle} value={form.config.host || ''} onChange={(e) => updateConfig('host', e.target.value)} placeholder="e.g. db.example.com" />)}
            {fieldRow('Port', <input aria-label="Port" style={inputStyle} type="number" value={form.config.port || ''} onChange={(e) => updateConfig('port', e.target.value ? parseInt(e.target.value) : '')} placeholder="e.g. 5432" />)}
            {fieldRow('Database', <input aria-label="Database" style={inputStyle} value={form.config.database || ''} onChange={(e) => updateConfig('database', e.target.value)} placeholder="e.g. production_db" />)}
            {fieldRow('Schema', <input aria-label="Schema" style={inputStyle} value={form.config.schema || ''} onChange={(e) => updateConfig('schema', e.target.value)} placeholder="e.g. public" />)}
            {fieldRow('Username', <input aria-label="Username" style={inputStyle} value={form.credentials.username || ''} onChange={(e) => updateCreds('username', e.target.value)} placeholder="Database username" />)}
            {fieldRow('Password', <input aria-label="Password" style={inputStyle} type="password" value={form.credentials.password || ''} onChange={(e) => updateCreds('password', e.target.value)} placeholder={editingId ? '(unchanged if left blank)' : 'Database password'} />)}
          </>
        );

      case 'FILE_STORAGE': {
        const isLocal = form.config.storageType === 'LOCAL';
        const existingFile = form.config.originalFileName;
        return (
          <>
            {fieldRow('Storage Type', (
              <select aria-label="Storage Type" style={selectStyle} value={form.config.storageType || ''} onChange={(e) => updateConfig('storageType', e.target.value)}>
                <option value="">-- Select --</option>
                {storageTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            ))}
            {isLocal ? (
              fieldRow('File', (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      id="local-file-input"
                      aria-label="File"
                      type="file"
                      accept=".csv,.tsv,.json,.jsonl,.ndjson,.parquet,.avro,text/csv,application/json"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setPendingFile(f);
                        // Reset the input so picking the same file again re-fires onChange.
                        e.target.value = '';
                      }}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => document.getElementById('local-file-input')?.click()}
                    >
                      {pendingFile || existingFile ? 'Choose Different File' : 'Browse\u2026'}
                    </Button>
                    {pendingFile ? (
                      <span style={{ fontSize: 12, color: 'var(--color-text)' }}>
                        <strong>{pendingFile.name}</strong> ({formatBytes(pendingFile.size)})
                        <span style={{ color: 'var(--color-text-muted)', marginLeft: 6 }}>— will upload on Save</span>
                      </span>
                    ) : existingFile ? (
                      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                        Current: <strong>{existingFile}</strong>
                        {form.config.fileSize != null && ` (${formatBytes(form.config.fileSize)})`}
                        {form.config.rowCount != null && ` — ${form.config.rowCount.toLocaleString()} rows`}
                        {form.config.columns && form.config.columns.length > 0 && ` × ${form.config.columns.length} columns`}
                      </span>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>No file selected yet. CSV, TSV, JSON, JSONL, Parquet, Avro up to 50 MB.</span>
                    )}
                  </div>
                  {form.config.columns && form.config.columns.length > 0 && !pendingFile && (
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                      Columns: {form.config.columns.slice(0, 10).join(', ')}{form.config.columns.length > 10 ? `, +${form.config.columns.length - 10} more` : ''}
                    </div>
                  )}
                </div>
              ), true)
            ) : (
              <>
                {fieldRow(form.config.storageType === 'AZURE_BLOB' ? 'Container' : 'Bucket / Container', <input aria-label="Bucket / Container" style={inputStyle} value={form.config.bucket || ''} onChange={(e) => updateConfig('bucket', e.target.value)} placeholder="e.g. my-data-bucket" />)}
                {fieldRow('Path', <input aria-label="Path" style={inputStyle} value={form.config.path || ''} onChange={(e) => updateConfig('path', e.target.value)} placeholder="e.g. /data/exports" />)}

                {/* S3 */}
                {form.config.storageType === 'S3' && fieldRow('Region', <input aria-label="Region" style={inputStyle} value={form.config.region || ''} onChange={(e) => updateConfig('region', e.target.value)} placeholder="e.g. us-east-1" />)}
                {form.config.storageType === 'S3' && fieldRow('Access Key ID', <input aria-label="Access Key ID" style={inputStyle} value={form.credentials.apiKey || ''} onChange={(e) => updateCreds('apiKey', e.target.value)} placeholder={editingId ? '(unchanged if left blank)' : 'blank = use the instance IAM role'} />)}
                {form.config.storageType === 'S3' && fieldRow('Secret Access Key', <input aria-label="Secret Access Key" style={inputStyle} type="password" value={form.credentials.password || ''} onChange={(e) => updateCreds('password', e.target.value)} placeholder={editingId ? '(unchanged if left blank)' : 'blank = use the instance IAM role'} />)}

                {/* Azure Blob */}
                {form.config.storageType === 'AZURE_BLOB' && fieldRow('Storage Account', <input aria-label="Storage Account" style={inputStyle} value={form.config.account || ''} onChange={(e) => updateConfig('account', e.target.value)} placeholder="e.g. mystorageacct" />)}
                {form.config.storageType === 'AZURE_BLOB' && fieldRow('Account Key', <input aria-label="Account Key" style={inputStyle} type="password" value={form.credentials.apiKey || ''} onChange={(e) => updateCreds('apiKey', e.target.value)} placeholder={editingId ? '(unchanged if left blank)' : 'Account key (or use SAS token below)'} />)}
                {form.config.storageType === 'AZURE_BLOB' && fieldRow('SAS Token', <input aria-label="SAS Token" style={inputStyle} type="password" value={form.credentials.token || ''} onChange={(e) => updateCreds('token', e.target.value)} placeholder={editingId ? '(unchanged if left blank)' : 'Alternative to the account key'} />)}

                {/* GCS */}
                {form.config.storageType === 'GCS' && fieldRow('Project ID', <input aria-label="Project ID" style={inputStyle} value={form.config.account || ''} onChange={(e) => updateConfig('account', e.target.value)} placeholder="optional — inferred from the key / ADC" />)}
                {form.config.storageType === 'GCS' && fieldRow('Service Account JSON', <input aria-label="Service Account JSON" style={inputStyle} type="password" value={form.credentials.token || ''} onChange={(e) => updateCreds('token', e.target.value)} placeholder={editingId ? '(unchanged if left blank)' : 'blank = Application Default Credentials'} />)}

                {/* SFTP / others — generic access key (real discovery not wired yet) */}
                {form.config.storageType !== 'S3' && form.config.storageType !== 'AZURE_BLOB' && form.config.storageType !== 'GCS' &&
                  fieldRow('API Key / Access Key', <input aria-label="API Key / Access Key" style={inputStyle} type="password" value={form.credentials.apiKey || ''} onChange={(e) => updateCreds('apiKey', e.target.value)} placeholder={editingId ? '(unchanged if left blank)' : 'Access key'} />)}
              </>
            )}
          </>
        );
      }

      case 'API':
        return (
          <>
            {fieldRow('Base URL', <input aria-label="Base URL" style={inputStyle} value={form.config.baseUrl || ''} onChange={(e) => updateConfig('baseUrl', e.target.value)} placeholder="e.g. https://api.example.com" />, true)}
            {fieldRow('Auth Type', (
              <select aria-label="Auth Type" style={selectStyle} value={form.config.authType || 'NONE'} onChange={(e) => updateConfig('authType', e.target.value)}>
                {authTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            ))}
            {(form.config.authType === 'API_KEY') && fieldRow('API Key', <input aria-label="API Key" style={inputStyle} type="password" value={form.credentials.apiKey || ''} onChange={(e) => updateCreds('apiKey', e.target.value)} placeholder={editingId ? '(unchanged if left blank)' : 'API key'} />)}
            {(form.config.authType === 'OAUTH2') && fieldRow('Token', <input aria-label="Token" style={inputStyle} type="password" value={form.credentials.token || ''} onChange={(e) => updateCreds('token', e.target.value)} placeholder={editingId ? '(unchanged if left blank)' : 'OAuth2 token'} />)}
            {(form.config.authType === 'BASIC') && (
              <>
                {fieldRow('Username', <input aria-label="Username" style={inputStyle} value={form.credentials.username || ''} onChange={(e) => updateCreds('username', e.target.value)} placeholder="Username" />)}
                {fieldRow('Password', <input aria-label="Password" style={inputStyle} type="password" value={form.credentials.password || ''} onChange={(e) => updateCreds('password', e.target.value)} placeholder={editingId ? '(unchanged if left blank)' : 'Password'} />)}
              </>
            )}
          </>
        );

      case 'DATA_WAREHOUSE':
        return (
          <>
            {fieldRow('Warehouse Type', (
              <select aria-label="Warehouse Type" style={selectStyle} value={form.config.warehouseType || ''} onChange={(e) => updateConfig('warehouseType', e.target.value)}>
                <option value="">-- Select --</option>
                {warehouseTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            ))}
            {fieldRow('Account', <input aria-label="Account" style={inputStyle} value={form.config.account || ''} onChange={(e) => updateConfig('account', e.target.value)} placeholder="e.g. org-account.snowflakecomputing.com" />)}
            {fieldRow('Warehouse', <input aria-label="Warehouse" style={inputStyle} value={form.config.warehouse || ''} onChange={(e) => updateConfig('warehouse', e.target.value)} placeholder="e.g. COMPUTE_WH" />)}
            {fieldRow('Username', <input aria-label="Username" style={inputStyle} value={form.credentials.username || ''} onChange={(e) => updateCreds('username', e.target.value)} placeholder="Username" />)}
            {fieldRow('Password', <input aria-label="Password" style={inputStyle} type="password" value={form.credentials.password || ''} onChange={(e) => updateCreds('password', e.target.value)} placeholder={editingId ? '(unchanged if left blank)' : 'Password'} />)}
          </>
        );

      case 'SPREADSHEET':
        return (
          <>
            {fieldRow('Spreadsheet Type', (
              <select aria-label="Spreadsheet Type" style={selectStyle} value={form.config.spreadsheetType || ''} onChange={(e) => updateConfig('spreadsheetType', e.target.value)}>
                <option value="">-- Select --</option>
                <option value="SHAREPOINT">SharePoint</option>
                <option value="GOOGLE_SHEETS">Google Sheets</option>
              </select>
            ))}
            {fieldRow('Document URL', <input aria-label="Document URL" style={inputStyle} value={form.config.documentUrl || ''} onChange={(e) => updateConfig('documentUrl', e.target.value)} placeholder="e.g. https://docs.google.com/spreadsheets/d/..." />, true)}
            {fieldRow('Token / API Key', <input aria-label="Token / API Key" style={inputStyle} type="password" value={form.credentials.token || ''} onChange={(e) => updateCreds('token', e.target.value)} placeholder={editingId ? '(unchanged if left blank)' : 'Auth token'} />)}
          </>
        );

      default:
        return null;
    }
  };

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const connectionColumns = ([
    connCols.isVisible('system') && {
      key: 'system', header: 'System', sortable: true, cellStyle: { fontWeight: 500, maxWidth: 240 },
      render: (conn: ConnectionProfile) => {
        const ids = conn.systemIds ?? [];
        if (ids.length === 0) {
          return <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>Unassigned</span>;
        }
        const names = ids.map((id) => systemNameMap[id]).filter(Boolean);
        if (names.length === 0) return <span style={{ color: 'var(--color-text-muted)' }}>--</span>;
        // Clip long system names to one line. The name
        // element takes the clipped space; the "+N"
        // affordance stays visible on the right and
        // hover surfaces the full list. Wrapping was
        // shoving `+1` onto a second row on long
        // names like "ArcGIS Utility Network Electric".
        return (
          <div
            title={names.join(', ')}
            style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}
          >
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
                flexShrink: 1,
              }}
            >
              {names[0]}
            </span>
            {names.length > 1 && (
              <span style={{ color: 'var(--color-text-muted)', fontSize: 11, flexShrink: 0 }}>
                +{names.length - 1}
              </span>
            )}
          </div>
        );
      },
    },
    connCols.isVisible('name') && {
      key: 'name', header: 'Connection Name', sortable: true, cellStyle: { fontWeight: 500, maxWidth: 260 },
      render: (conn: ConnectionProfile) => <TruncatedText text={conn.name} />,
    },
    connCols.isVisible('type') && {
      key: 'connectionType', header: 'Type', sortable: true,
      render: (conn: ConnectionProfile) => {
        const typeBadge = TYPE_BADGES[conn.connectionType] || TYPE_BADGES.DATABASE;
        return (
          <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 500, background: typeBadge.bg, color: typeBadge.color }}>
            {TYPE_LABELS[conn.connectionType] || conn.connectionType}
          </span>
        );
      },
    },
    connCols.isVisible('config') && {
      key: 'config', header: 'Config', sortable: true,
      cellStyle: { color: 'var(--color-text-secondary)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontFamily: 'var(--font-mono)' },
      render: (conn: ConnectionProfile) => configSummary(conn),
    },
    connCols.isVisible('status') && {
      key: 'status', header: 'Status', sortable: true,
      render: (conn: ConnectionProfile) => {
        const statusBadge = STATUS_BADGES[conn.status] || STATUS_BADGES.UNTESTED;
        return (
          <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 500, background: statusBadge.bg, color: statusBadge.color }}>
            {conn.status}
          </span>
        );
      },
    },
    connCols.isVisible('lastTested') && {
      key: 'lastTested', header: 'Last Tested', sortable: true,
      cellStyle: { color: 'var(--color-text-muted)', fontSize: 12 },
      render: (conn: ConnectionProfile) => timeAgo(conn.lastTestedAt),
    },
    {
      key: 'actions', header: 'Actions', align: 'center' as const, cellStyle: { whiteSpace: 'nowrap' },
      render: (conn: ConnectionProfile) => {
        const isTesting = testingIds.has(conn.id);
        return (
          <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <IconButton size="sm" icon={isTesting ? 'refresh' : 'play'}
              label={isTesting ? 'Testing…' : 'Test connection'}
              disabled={isTesting}
              onClick={() => !isTesting && handleRowTest(conn.id)} />
            {conn.status === 'CONNECTED' && (
              <IconButton size="sm" icon="search" label="Discover assets" onClick={() => handleDiscover(conn)} />
            )}
            <IconButton size="sm" icon="edit" label="Edit" onClick={() => openEdit(conn)} />
            <IconButton size="sm" icon="copy" label="Duplicate" onClick={() => openDuplicate(conn)} />
            <IconButton size="sm" icon="trash" label="Delete" variant="danger" onClick={() => setConfirmDelete(conn.id)} />
          </div>
        );
      },
    },
  ].filter(Boolean) as DataTableColumn<ConnectionProfile>[]);

  return (
    <div>
      {/* Header */}
      <EmbeddablePageHeader
        embedded={embedded}
        actionsPortal={actionsPortal}
        title="Data Connections"
        subtitle={filterSystem
          ? <>Showing connections for <strong>{filterSystem.name}</strong>. <button onClick={() => setSystemFilter('')} style={{ background: 'none', border: 'none', color: 'var(--color-primary)', cursor: 'pointer', padding: 0, fontSize: 13, textDecoration: 'underline' }}>Show all</button></>
          : 'Connect to external data sources. Test verifies reachability (TCP or HTTP probe); credential validation happens when real drivers are wired in.'}
        actions={
          <>
            <SavedViewsMenu
              pageKey="connections"
              currentFilters={{ filterConnType, searchQuery }}
              onApply={(f) => {
                setFilterConnType((f.filterConnType as string) || '');
                setSearchQuery((f.searchQuery as string) || '');
              }}
            />
            <ExportMenu
              disabled={visibleConnections.length === 0}
              build={() => ({
                filenameBase: 'connections',
                sheetName: 'Connections',
                headers: ['Name', 'Type', 'Status', 'Systems', 'Last Tested', 'Last Test Result'],
                rows: visibleConnections.map((c) => {
                  const ids = c.systemIds ?? [];
                  const sysNames = ids.map((id) => systemNameMap[id]).filter(Boolean).join('; ');
                  return [
                    c.name,
                    c.connectionType,
                    c.status,
                    sysNames,
                    c.lastTestedAt ? new Date(c.lastTestedAt).toLocaleString() : '',
                    c.lastTestResult || '',
                  ];
                }),
              })}
            />
            <ColumnPicker state={connCols} />
            <IconButton icon="plus" label="Add connection" variant="primary" onClick={openAdd} />
          </>
        }
      />

      {/* Two-column layout: Type sidebar + content */}
      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16, alignItems: 'start' }}>
        {/* Connection Types Sidebar */}
        <div style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          padding: 10,
          position: 'sticky',
          top: 12,
          maxHeight: 'calc(100vh - 180px)',
          overflowY: 'auto',
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6, padding: '0 4px' }}>
            Connection Types
          </div>
          <div
            {...clickable(() => setFilterConnType(''), { pressed: !filterConnType })}
            style={{
              padding: '5px 8px', fontSize: 12, borderRadius: 4, cursor: 'pointer', marginBottom: 2,
              fontWeight: !filterConnType ? 600 : 400,
              background: !filterConnType ? 'var(--color-primary-light)' : 'transparent',
              color: !filterConnType ? 'var(--color-primary)' : 'var(--color-text)',
            }}
            onMouseEnter={(e) => { if (filterConnType) e.currentTarget.style.background = 'var(--color-bg)'; }}
            onMouseLeave={(e) => { if (filterConnType) e.currentTarget.style.background = 'transparent'; }}
          >
            All Connections ({connections.length})
          </div>
          {connectionTypes.map((t) => {
            const count = connections.filter((c) => c.connectionType === t).length;
            if (count === 0) return null;
            const isActive = filterConnType === t;
            const label = t.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
            return (
              <div
                key={t}
                {...clickable(() => setFilterConnType(isActive ? '' : t), { pressed: isActive })}
                style={{
                  padding: '5px 8px', fontSize: 12, borderRadius: 4, cursor: 'pointer', marginBottom: 2,
                  fontWeight: isActive ? 600 : 400,
                  background: isActive ? 'var(--color-primary-light)' : 'transparent',
                  color: isActive ? 'var(--color-primary)' : 'var(--color-text)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--color-bg)'; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
              >
                <span>{label}</span>
                <span style={{ fontSize: 10, color: 'var(--color-text-muted)', background: 'var(--color-bg)', padding: '0 5px', borderRadius: 8, fontWeight: 500 }}>{count}</span>
              </div>
            );
          })}
        </div>

        {/* Content Area */}
        <div>
          {/* Filters (left-aligned, mirrors Data Assets) */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', width: 200 }}>
              <input
                type="text"
                aria-label="Search connections" placeholder="Search connections..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape' && searchQuery) setSearchQuery(''); }}
                style={{ border: '1px solid var(--color-border)', borderRadius: 4, padding: '5px 28px 5px 10px', fontSize: 12, background: 'var(--color-surface)', width: '100%', boxSizing: 'border-box' }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                  title="Clear search (Esc)"
                  style={{
                    position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--color-text-muted)', fontSize: 14, lineHeight: 1,
                    padding: '2px 6px', borderRadius: 3,
                  }}
                >
                  &times;
                </button>
              )}
            </div>
            <select aria-label="Filter by system" style={{ ...selectStyle, width: 'auto', minWidth: 160 }} value={systemFilter} onChange={(e) => setSystemFilter(e.target.value)}>
              <option value="">All Systems</option>
              {systems.map((s) => <option key={s.id} value={s.id}>{s.name}{s.systemType ? ` (${s.systemType})` : ''}</option>)}
            </select>
            {(searchQuery || systemFilter || filterConnType) && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { setSearchQuery(''); setSystemFilter(''); setFilterConnType(''); }}
                >
                  Clear Filters
                </Button>
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                  Showing {visibleConnections.length} of {connections.length}
                </span>
              </>
            )}
          </div>

      {/* Add/Edit Form */}
      {showForm && (
        <Card padding={20} marginBottom={20}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>
            {editingId ? 'Edit Connection' : 'Add New Connection'}
          </h3>

          {/* Core fields */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Connection Name *</label>
              <input autoFocus
                aria-label="Connection Name"
                style={{ ...inputStyle, border: validation.fieldError('name') ? inputErrorBorder : inputStyle.border }}
                value={form.name}
                onChange={(e) => { const v = e.target.value; setForm({ ...form, name: v }); if (validation.touched.name) validation.validateField('name', v, form); }}
                onBlur={() => { validation.touch('name'); validation.validateField('name', form.name, form); }}
                placeholder="e.g. Production DB, CRM API" />
              {validation.fieldError('name') && <div style={fieldErrorStyle}>{validation.fieldError('name')}</div>}
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>
                Systems served
                <span style={{ fontWeight: 400, color: 'var(--color-text-muted)', marginLeft: 6 }}>
                  one connection can serve several systems — leave empty if not yet assigned
                </span>
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6, minHeight: 24 }}>
                {form.systemIds.length === 0 && (
                  <span style={{ fontSize: 12, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                    No systems served yet.
                  </span>
                )}
                {form.systemIds.map((sid) => {
                  const s = systems.find((sys) => sys.id === sid);
                  return (
                    <span key={sid} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                      background: '#dbeafe', color: '#1e40af',
                    }}>
                      {s?.name || sid}
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, systemIds: form.systemIds.filter((id) => id !== sid) })}
                        aria-label={`Remove ${s?.name || sid}`}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, fontSize: 14, lineHeight: 1 }}
                      >
                        &times;
                      </button>
                    </span>
                  );
                })}
              </div>
              <select
                aria-label="Systems served"
                style={selectStyle}
                value=""
                onChange={(e) => {
                  const sid = e.target.value;
                  if (sid && !form.systemIds.includes(sid)) {
                    setForm({ ...form, systemIds: [...form.systemIds, sid] });
                  }
                }}
              >
                <option value="">-- Add a system --</option>
                {systems
                  .filter((s) => !form.systemIds.includes(s.id))
                  .map((s) => <option key={s.id} value={s.id}>{s.name}{s.systemType ? ` (${s.systemType})` : ''}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Connection Type *</label>
              <select
                aria-label="Connection Type"
                style={selectStyle}
                value={form.connectionType}
                onChange={(e) => setForm({ ...form, connectionType: e.target.value, config: {}, credentials: {} })}
              >
                {(connectionTypes.length > 0 ? connectionTypes : ['DATABASE', 'FILE_STORAGE', 'API', 'DATA_WAREHOUSE', 'SPREADSHEET']).map((t) => (
                  <option key={t} value={t}>{TYPE_LABELS[t] || t}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Type-specific fields */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16, padding: 16, background: 'var(--color-bg)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
            <SectionLabel marginBottom={4} style={{ gridColumn: '1 / -1' }}>
              {TYPE_LABELS[form.connectionType] || form.connectionType} Configuration
            </SectionLabel>
            {renderTypeFields()}
          </div>

          {/* Test result */}
          {formTestResult && (
            <div style={{
              marginBottom: 12, padding: '10px 14px', borderRadius: 'var(--radius-md)',
              background: formTestResult.success ? '#f0fdf4' : '#fef2f2',
              border: `1px solid ${formTestResult.success ? '#86efac' : '#fca5a5'}`,
              fontSize: 13, color: formTestResult.success ? '#166534' : '#991b1b',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ fontSize: 16 }}>{formTestResult.success ? '\u2713' : '\u2717'}</span>
              {formTestResult.message}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={handleCancel} disabled={uploading || formTesting}>Cancel</Button>
            <Button
              variant="secondary"
              disabled={!form.name.trim() || uploading || formTesting}
              title={!form.name.trim() ? 'Enter a connection name first.' : ''}
              onClick={handleTest}
            >
              {formTesting ? 'Testing\u2026' : 'Test'}
            </Button>
            <Button
              variant="primary"
              disabled={!form.name.trim() || uploading}
              onClick={handleSave}
            >
              {uploading ? 'Uploading\u2026' : editingId ? 'Save Changes' : 'Add Connection'}
            </Button>
          </div>
        </Card>
      )}

      {/* Confirm dialogs */}
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete Connection?"
        message="This will permanently delete this connection profile. This cannot be undone."
        confirmLabel="Delete"
        onConfirm={async () => { const id = confirmDelete; setConfirmDelete(null); if (id) await handleDelete(id); }}
        onCancel={() => setConfirmDelete(null)}
      />

      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete Selected Connections?"
        message={`Delete ${sel.count} selected connections? This cannot be undone.`}
        confirmLabel="Delete Selected"
        onConfirm={async () => { setConfirmBulkDelete(false); await handleBulkDelete(); }}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      {/* Bulk Action Bar */}
      <BulkActionBar count={sel.count} onClear={sel.clear} clearLabel="Clear Selection">
        <BulkActionButton variant="danger" onClick={() => setConfirmBulkDelete(true)}>Delete Selected</BulkActionButton>
      </BulkActionBar>

      {/* Table */}
      <div style={{ background: 'var(--color-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', overflow: 'auto' }}>
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => { setLoadError(null); setLoading(true); fetchData(); }} />
        ) : loading ? (
          <SkeletonRows rows={5} columnWidths={[32, null, null, null, null, null, null, null]} />
        ) : visibleConnections.length === 0 && !showForm ? (
          <EmptyState
            icon={renderNavIcon('/connections')}
            title={filterSystem ? `No connections for ${filterSystem.name} yet` : 'No connections configured yet'}
            description="Connections are the bridge between a system and its actual data — a database, a file, a warehouse. Add one, test it, and then discover and link assets from it."
            action={{ label: '+ Add Connection', onClick: openAdd }}
          />
        ) : (
          <DataTable
            rows={sorted}
            columns={connectionColumns}
            rowKey={(c) => c.id}
            selection={sel}
            sort={{ sortKey, sortDir, onSort: toggleSort }}
            selectAllLabel="Select all connections"
            emptyMessage="No connections match the current filters."
          />
        )}
      </div>

      {/* Discover Modal */}
      {discoverModal && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}
          onClick={closeDiscover}
        >
          <div
            ref={discoverModalRef}
            role="dialog"
            aria-modal="true"
            aria-label="Discover data assets"
            style={{ background: '#fff', borderRadius: 12, boxShadow: 'var(--shadow-xl)', padding: 24, maxWidth: 640, width: '100%', maxHeight: '80vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ fontSize: 16, fontWeight: 600 }}>Discovered Assets — {discoverModal.systemName}</h3>
              <button
                onClick={closeDiscover}
                aria-label="Close"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--color-text-muted)', padding: '0 4px' }}
              >
                &times;
              </button>
            </div>

            {reconcileMode ? (
              <div>
                {reconcileLoading ? (
                  <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--color-text-muted)' }}>Loading reconciliation…</div>
                ) : (
                  <>
                    <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
                      Confirm the suggested Data Asset for each discovered table, link it to a different one, or create a new Bronze asset. Already-linked tables are left as they are.
                    </p>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: 'var(--color-bg)' }}>
                            <th scope="col" style={thStyle}>Discovered</th>
                            <th scope="col" style={thStyle}>Reconcile to</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reconcileItems.map((it) => {
                            const d = reconcileDecisions[it.sourceAsset];
                            const value = it.status === 'linked' ? '' : (d?.action === 'link' ? (d.dataAssetId || '') : (d?.action || 'create'));
                            return (
                              <tr key={it.sourceAsset}>
                                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                                  <span style={{ fontWeight: 500 }}>{it.sourceAsset}</span>
                                  <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--color-text-muted)' }}>{it.columns.length} col{it.columns.length === 1 ? '' : 's'}</span>
                                </td>
                                <td style={tdStyle}>
                                  {it.status === 'linked' ? (
                                    <StatusBadge variant="success" size="md">Linked to {it.linkedAssetName}</StatusBadge>
                                  ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                      <select
                                        aria-label={`Reconcile ${it.sourceAsset}`}
                                        value={value}
                                        onChange={(e) => setDecision(it.sourceAsset, e.target.value)}
                                        style={{ fontSize: 12, padding: '4px 6px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', maxWidth: 320 }}
                                      >
                                        <option value="create">＋ Create new asset</option>
                                        <option value="skip">Skip</option>
                                        <optgroup label="Link to existing asset">
                                          {catalogAssets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                                        </optgroup>
                                      </select>
                                      {it.suggestion && (
                                        <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                                          Suggested: {it.suggestion.dataAssetName} ({it.suggestion.score}% name match)
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                      <Button variant="secondary" onClick={() => setReconcileMode(false)}>Back</Button>
                      <Button onClick={() => discoverModal && applyReconcile(discoverModal.connId)} disabled={reconcileApplying}>
                        {reconcileApplying ? 'Applying…' : 'Apply'}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ) : (<>

            {!discoveringId && discoverSimulated && (
              <div style={{
                display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', marginBottom: 16,
                background: 'var(--color-warning-light)', border: '1px solid var(--color-warning)',
                borderRadius: 'var(--radius-md)', fontSize: 12, color: 'var(--color-text-secondary)',
              }}>
                <span aria-hidden style={{ color: 'var(--color-warning)', fontWeight: 600 }}>{'⚠'}</span>
                <span>
                  <strong style={{ color: 'var(--color-warning)' }}>Simulated results.</strong>{' '}
                  Direct-connect discovery for this source type is not wired to a live driver yet, so
                  these tables and columns are representative sample metadata, not a live read of the
                  source. Uploaded-file connections return real parsed structure.
                </span>
              </div>
            )}

            {discoveringId ? (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--color-text-muted)' }}>
                Discovering assets...
              </div>
            ) : discoveredAssets.length === 0 ? (
              <EmptyState
                icon={'\u{1F50D}'}
                title="No assets discovered"
                description="This connection didn't return any tables, files, or objects. Check that it points at a populated source and try testing it again."
              />
            ) : (
              <>
                <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
                  {'Click an asset to drill into its columns. To link a column to a Data Asset, go to Data Assets \u2192 Link.'}
                </p>
                <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'var(--color-bg)' }}>
                      <th scope="col" style={{ ...thStyle, width: 28 }}></th>
                      <th scope="col" style={thStyle}>Name</th>
                      <th scope="col" style={thStyle}>Type</th>
                      <th scope="col" style={thStyle}>Rows</th>
                      <th scope="col" style={thStyle}>Columns</th>
                    </tr>
                  </thead>
                  <tbody>
                    {discoveredAssets.map((asset) => {
                      const isExpanded = expandedAssets.has(asset.name);
                      const columns = asset.columns || [];
                      const hasColumns = columns.length > 0;
                      return (
                        <React.Fragment key={asset.name}>
                          <tr
                            onClick={() => hasColumns && toggleAssetExpanded(asset.name)}
                            style={{ cursor: hasColumns ? 'pointer' : 'default' }}
                          >
                            <td style={{ ...tdStyle, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 10, userSelect: 'none' }}>
                              {hasColumns ? (isExpanded ? '\u25BC' : '\u25B6') : ''}
                            </td>
                            <td style={{ ...tdStyle, fontWeight: 500, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{asset.name}</td>
                            <td style={tdStyle}>
                              <StatusBadge variant="neutral" size="md">{asset.type}</StatusBadge>
                            </td>
                            <td style={{ ...tdStyle, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                              {asset.rowCount != null ? asset.rowCount.toLocaleString() : '--'}
                            </td>
                            <td style={{ ...tdStyle, fontSize: 12, color: 'var(--color-text-muted)' }}>
                              {hasColumns ? columns.length : '--'}
                            </td>
                          </tr>
                          {isExpanded && columns.map((col) => (
                            <tr key={`${asset.name}.${col}`} style={{ background: '#fafafa' }}>
                              <td style={{ ...tdStyle, border: 'none' }}></td>
                              <td
                                style={{ ...tdStyle, fontFamily: 'var(--font-mono)', fontSize: 12, paddingLeft: 24, color: 'var(--color-text)', border: 'none' }}
                                colSpan={4}
                              >
                                <span style={{ color: 'var(--color-text-muted)', marginRight: 6 }}>{'\u21B3'}</span>
                                <strong>{col}</strong>
                                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--color-text-muted)' }}>column</span>
                              </td>
                            </tr>
                          ))}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <Button variant="secondary" onClick={closeDiscover}>Close</Button>
              {!discoveringId && !discoverSimulated && discoveredAssets.length > 0 && (
                <Button onClick={() => discoverModal && openReconcile(discoverModal.connId)}>Reconcile to catalog</Button>
              )}
            </div>
            </>)}
          </div>
        </div>
      )}
        </div>
      </div>
    </div>
  );
}
