import { useEffect, useState, useCallback, useRef, lazy, Suspense } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiClient } from '../api/client';
import { errorMessage } from '../lib/errorToast';
import EmbeddablePageHeader from '../components/EmbeddablePageHeader';
import CreateScopeNotice from '../components/CreateScopeNotice';
import TruncatedText from '../components/TruncatedText';
import Card from '../components/Card';
import SectionLabel from '../components/SectionLabel';
import { useOrgContext } from '../stores/orgContext';
import { useOrgNameLookup } from '../hooks/useOrgNameLookup';
import { OwnerBadge, isInheritedAsset } from '../components/OwnerBadge';
import ExportMenu from '../components/ExportMenu';
import SavedViewsMenu from '../components/SavedViewsMenu';
import { useTerm } from '../lib/terminology';
import { formatPersonLabel } from '../lib/personLabel';
import { useColumnPicker } from '../hooks/useColumnPicker';
import ColumnPicker from '../components/ColumnPicker';
import { usePolling } from '../hooks/usePolling';
import ConfirmDialog from '../components/ConfirmDialog';
import IconButton from '../components/IconButton';
import Button from '../components/Button';
import PersonPicker from '../components/PersonPicker';
import EmptyState from '../components/EmptyState';
import ErrorState from '../components/ErrorState';
import { renderNavIcon } from '../components/navIcons';
import StatusBadge, { type StatusBadgeVariant } from '../components/StatusBadge';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import { useRowSelection } from '../hooks/useRowSelection';
import BulkActionBar, { BulkActionButton } from '../components/BulkActionBar';
import { SkeletonRows } from '../components/Skeleton';
import { useSortedList } from '../hooks/useSortedList';
import { useToastStore } from '../stores/toastStore';
import { activateOnKeyStop } from '../lib/a11y';
import { useFormValidation, fieldErrorStyle, inputErrorBorder } from '../hooks/useFormValidation';
import HelpPopover from '../components/HelpPopover';
import UnsavedBanner from '../components/UnsavedBanner';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
// Lazy: only renders when the user opens the corresponding modal.
const SyncConnectionWizard = lazy(() => import('../components/SyncConnectionWizard'));
const SystemDetailModal = lazy(() => import('../components/SystemDetailModal'));

type Connectivity = 'INTEGRATED' | 'MANUAL' | 'EXTERNAL';

type IntegrationMechanism =
  | 'REST_API' | 'SOAP' | 'GRAPHQL' | 'MESSAGE_QUEUE' | 'EVENT_STREAM'
  | 'FILE_DROP' | 'ETL_BATCH' | 'DATABASE_REPLICATION' | 'MANUAL_EXPORT';
type IntegrationFrequency =
  | 'REAL_TIME' | 'EVENT_DRIVEN' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ON_DEMAND';
type IntegrationDirection = 'INBOUND' | 'OUTBOUND' | 'BIDIRECTIONAL';

/** One declared interface from this system to another catalog system.
 *  Mirrors the backend SystemIntegration; `id` is absent on rows the
 *  user just added in the form and is assigned server-side on save. */
interface IntegrationDraft {
  id?: string;
  targetSystemId: string;
  interfaceType: IntegrationMechanism | '';
  frequency: IntegrationFrequency | '';
  direction: IntegrationDirection;
}

const MECHANISM_LABEL: Record<IntegrationMechanism, string> = {
  REST_API:             'REST API',
  SOAP:                 'SOAP',
  GRAPHQL:              'GraphQL',
  MESSAGE_QUEUE:        'Message Queue',
  EVENT_STREAM:         'Event Stream',
  FILE_DROP:            'File Drop',
  ETL_BATCH:            'ETL Batch',
  DATABASE_REPLICATION: 'DB Replication',
  MANUAL_EXPORT:        'Manual Export',
};
const FREQUENCY_LABEL: Record<IntegrationFrequency, string> = {
  REAL_TIME:    'Real-time',
  EVENT_DRIVEN: 'Event-driven',
  HOURLY:       'Hourly',
  DAILY:        'Daily',
  WEEKLY:       'Weekly',
  MONTHLY:      'Monthly',
  ON_DEMAND:    'On-demand',
};
const DIRECTION_LABEL: Record<IntegrationDirection, string> = {
  OUTBOUND:      'Sends to →',
  INBOUND:       'Receives from ←',
  BIDIRECTIONAL: 'Two-way ⇄',
};
const MECHANISM_VALUES: IntegrationMechanism[] = Object.keys(MECHANISM_LABEL) as IntegrationMechanism[];
const FREQUENCY_VALUES: IntegrationFrequency[] = Object.keys(FREQUENCY_LABEL) as IntegrationFrequency[];
const DIRECTION_VALUES: IntegrationDirection[] = Object.keys(DIRECTION_LABEL) as IntegrationDirection[];

interface SystemEntity {
  id: string;
  name: string;
  description: string;
  systemType: string;
  businessCriticality?: string;
  vendor?: string;
  integrationPoints?: string;
  /** Backend-enriched: each row carries the resolved target name. */
  integrations?: Array<IntegrationDraft & { targetSystemName?: string | null }>;
  integrationCount?: number;
  ownerPersonId?: string | null;
  deputyOwnerId?: string | null;
  custodianIds?: string[];
  /** Resolved by the backend so the table can render names without a per-row join. */
  ownerName?: string | null;
  deputyOwnerName?: string | null;
  custodianNames?: string[];
  connectivity?: Connectivity;
  /** Rolled-up status from backend: profile health if connectivity is
   *  INTEGRATED, otherwise mirrors the connectivity intent. */
  connectionStatus?: 'CONNECTED' | 'ERROR' | 'UNTESTED' | 'NOT_CONNECTED' | 'MANUAL' | 'EXTERNAL';
  connectionCount?: number;
  // Owning org. System is editable only when this matches the active
  // "Working in..." scope; otherwise the row renders an OwnerBadge
  // and gates every edit surface with isInheritedAsset.
  orgId?: string;
  createdAt: string;
  updatedAt: string;
}

interface ConnectionSummary {
  id: string;
  /** Legacy single-system field, kept for back-compat. Use systemIds. */
  systemId: string;
  /** All systems this connection serves (many-to-many). */
  systemIds?: string[];
  name?: string;
  connectionType?: string;
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'UNTESTED';
  config?: { host?: string; port?: number; database?: string; baseUrl?: string };
}

/** Connection's effective set of system links — prefer systemIds, fall
 *  back to the legacy single field, and treat empty as unassigned. */
function connSystemIds(c: ConnectionSummary): string[] {
  if (c.systemIds && c.systemIds.length > 0) return c.systemIds;
  return c.systemId ? [c.systemId] : [];
}

const CONNECTIVITY_LABEL: Record<Connectivity, string> = {
  INTEGRATED: 'Integrated',
  MANUAL: 'Manual',
  EXTERNAL: 'Vendor-managed',
};

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)', borderRadius: 4,
  padding: '6px 10px', fontSize: 13, width: '100%', background: 'var(--color-surface)',
};

const selectStyle: React.CSSProperties = { ...inputStyle, appearance: 'auto' as any };

const btnSecondary: React.CSSProperties = {
  padding: '8px 16px', background: 'var(--color-bg)', color: 'var(--color-text)',
  border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 500, cursor: 'pointer',
};



const typeBadge: React.CSSProperties = {
  display: 'inline-block', padding: '2px 8px', borderRadius: 4,
  fontSize: 11, fontWeight: 500, background: 'var(--color-primary-light)', color: 'var(--color-primary)',
};

// Business-criticality badge palette. Hex pairs (bg + companion colour) so the
// semantic-badge palette stays stable if the semantic vars are retuned.
const CRITICALITY_BADGE: Record<string, { bg: string; color: string }> = {
  HIGH:   { bg: '#fee2e2', color: '#dc2626' }, // red
  MEDIUM: { bg: '#fef3c7', color: '#92400e' }, // amber
  LOW:    { bg: '#f1f5f9', color: '#64748b' }, // neutral
};

interface FormData {
  name: string;
  description: string;
  systemType: string;
  businessCriticality: string;
  vendor: string;
  integrationPoints: string;
  integrations: IntegrationDraft[];
  ownerPersonId: string;
  deputyOwnerId: string;
  custodianIds: string[];
  connectivity: Connectivity;
  /** Connections the user wants this system linked to. Diffed against
   *  the system's existing links on save and reconciled via
   *  POST/DELETE /connections/:cid/systems. */
  connectionIds: string[];
}

const emptyForm: FormData = {
  name: '', description: '', systemType: '', businessCriticality: '',
  vendor: '', integrationPoints: '',
  integrations: [],
  ownerPersonId: '', deputyOwnerId: '', custodianIds: [],
  connectivity: 'INTEGRATED',
  connectionIds: [],
};

function InlineCellEdit({ value, onSave, type = 'text', options }: {
  value: string; onSave: (v: string) => void; type?: 'text' | 'select' | 'number'; options?: string[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <span
        role="button"
        tabIndex={0}
        aria-label="Edit field"
        onClick={(e) => { e.stopPropagation(); setDraft(value); setEditing(true); }}
        onKeyDown={activateOnKeyStop(() => { setDraft(value); setEditing(true); })}
        style={{ cursor: 'pointer', borderBottom: '1px dashed var(--color-border)' }}
        title="Click to edit"
      >
        {value || '—'}
      </span>
    );
  }

  if (type === 'select' && options) {
    return (
      <select
        autoFocus
        aria-label="Edit field"
        value={draft}
        onChange={(e) => { onSave(e.target.value); setEditing(false); }}
        onBlur={() => setEditing(false)}
        onClick={(e) => e.stopPropagation()}
        style={{ fontSize: 'inherit', padding: '2px 4px', border: '1px solid var(--color-primary)', borderRadius: 3 }}
      >
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }

  return (
    <input
      autoFocus
      aria-label="Edit field"
      type={type}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onSave(draft); setEditing(false); }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { if (draft !== value) onSave(draft); setEditing(false); }
        if (e.key === 'Escape') setEditing(false);
      }}
      style={{ fontSize: 'inherit', padding: '2px 4px', width: type === 'number' ? 60 : '100%', border: '1px solid var(--color-primary)', borderRadius: 3 }}
    />
  );
}

// "+ Connect" CTA shares the badge's pill shape but uses the brand
// primary colour — semantically a call-to-action, not a status, so it
// can't fold into StatusBadge.
const pillBase: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500,
};

// Connectivity status → shared StatusBadge variant. NOT_CONNECTED reads
// as a placeholder (no connection configured yet) so it picks up the
// dashed-border treatment to look open rather than asserting a state.
const CONNECTIVITY_TO_VARIANT: Record<NonNullable<SystemEntity['connectionStatus']>, { variant: StatusBadgeVariant; dashed?: boolean }> = {
  CONNECTED:     { variant: 'success' },
  ERROR:         { variant: 'danger' },
  UNTESTED:      { variant: 'warning' },
  NOT_CONNECTED: { variant: 'neutral', dashed: true },
  MANUAL:        { variant: 'info' },
  EXTERNAL:      { variant: 'agent' },
};

function renderConnectivityCell(
  sys: SystemEntity,
  configuredCount: number,
  connectedCount: number,
  navigate: (to: string) => void,
  onOpenPicker: (sys: SystemEntity) => void,
) {
  const connectivity: Connectivity = sys.connectivity || 'INTEGRATED';
  const status = sys.connectionStatus
    || (connectivity === 'MANUAL' ? 'MANUAL'
       : connectivity === 'EXTERNAL' ? 'EXTERNAL'
       : configuredCount === 0 ? 'NOT_CONNECTED'
       : connectedCount > 0 ? 'CONNECTED'
       : 'UNTESTED');

  if (connectivity !== 'INTEGRATED') {
    const v = CONNECTIVITY_TO_VARIANT[status];
    return <StatusBadge variant={v.variant} dashed={v.dashed} size="md">{CONNECTIVITY_LABEL[connectivity]}</StatusBadge>;
  }

  if (configuredCount === 0) {
    return (
      <button
        onClick={() => onOpenPicker(sys)}
        style={{ ...pillBase, background: 'var(--color-primary)', color: '#fff', border: 'none', cursor: 'pointer' }}
        title="Attach an existing connection or configure a new one"
      >
        + Connect
      </button>
    );
  }

  const v = CONNECTIVITY_TO_VARIANT[status];
  return (
    <StatusBadge
      variant={v.variant}
      dashed={v.dashed}
      size="md"
      onClick={() => navigate(`/connections?systemId=${encodeURIComponent(sys.id)}`)}
      title="View connections for this system"
    >
      {configuredCount} configured{connectedCount > 0 ? ` · ${connectedCount} live` : ''}
    </StatusBadge>
  );
}

function ConnectPickerModal({
  sys, connections, systems, orgId, onClose, onAttached, onCreateNew, addToast,
}: {
  sys: SystemEntity;
  connections: ConnectionSummary[];
  systems: SystemEntity[];
  orgId: string | undefined | null;
  onClose: () => void;
  onAttached: () => void;
  onCreateNew: () => void;
  addToast: (level: 'success' | 'error' | 'info', msg: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const orgConnections = orgId
    ? connections.filter((c) => !(c as any).orgId || (c as any).orgId === orgId)
    : connections;

  // Connections are partitioned by their relationship to *this* system.
  // With many-to-many, "on other systems" no longer means mutually
  // exclusive — a connection can already serve System A and also be
  // attached here without losing A. So we only really care about whether
  // this system is already in the link set.
  const alreadyOnThis = orgConnections.filter((c) => connSystemIds(c).includes(sys.id));
  const unassigned = orgConnections.filter((c) => connSystemIds(c).length === 0);
  const onOtherSystems = orgConnections.filter((c) => {
    const ids = connSystemIds(c);
    return ids.length > 0 && !ids.includes(sys.id);
  });
  const systemNameById = (id: string) => systems.find((s) => s.id === id)?.name || id;

  const attach = async (conn: ConnectionSummary) => {
    setBusy(conn.id);
    try {
      // Use the additive endpoint so attaching to this system doesn't
      // unlink the connection from any other systems it already serves.
      await apiClient.post(`/connections/${conn.id}/systems`, { systemId: sys.id });
      addToast('success', `Linked "${conn.name || conn.id}" to ${sys.name}`);
      onAttached();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      addToast('error', e?.response?.data?.error || errorMessage(err, 'Failed to attach connection'));
    } finally {
      setBusy(null);
    }
  };

  const renderConn = (c: ConnectionSummary, allowAttach: boolean) => {
    const detail = c.config?.host
      ? `${c.config.host}${c.config.port ? `:${c.config.port}` : ''}${c.config.database ? `/${c.config.database}` : ''}`
      : c.config?.baseUrl || '';
    const otherSystems = connSystemIds(c).filter((id) => id !== sys.id).map(systemNameById);
    return (
      <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderTop: '1px solid var(--color-border)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{c.name || c.id}</div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {c.connectionType || 'Connection'}{detail ? ` · ${detail}` : ''}
            {otherSystems.length > 0 ? ` · also serves ${otherSystems.join(', ')}` : ''}
          </div>
        </div>
        {allowAttach ? (
          <button
            onClick={() => attach(c)}
            disabled={busy === c.id}
            style={{ padding: '5px 12px', fontSize: 12, fontWeight: 500, background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: busy === c.id ? 'not-allowed' : 'pointer', opacity: busy === c.id ? 0.6 : 1 }}
          >
            {busy === c.id ? 'Attaching…' : 'Use'}
          </button>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>already linked</span>
        )}
      </div>
    );
  };

  const empty = alreadyOnThis.length === 0 && unassigned.length === 0 && onOtherSystems.length === 0;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'var(--color-surface)', borderRadius: 'var(--radius-md)', width: '100%', maxWidth: 540, maxHeight: '85vh', overflow: 'auto', padding: 20, boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 2 }}>Connect to a source</h2>
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Pick a connection to serve <strong>{sys.name}</strong>, or create a new one. A connection can serve several systems at once.</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close system detail" style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: 'var(--color-text-muted)', padding: 4 }}><span aria-hidden="true">&times;</span></button>
        </div>

        {empty && (
          <div style={{ padding: 16, fontSize: 12, color: 'var(--color-text-muted)', background: 'var(--color-bg)', borderRadius: 'var(--radius-md)' }}>
            No connections defined yet. Create the first one and Procela will offer it as a reusable option next time.
          </div>
        )}

        {alreadyOnThis.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <SectionLabel marginBottom={4}>Already on this system</SectionLabel>
            <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
              {alreadyOnThis.map((c) => renderConn(c, false))}
            </div>
          </div>
        )}

        {unassigned.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <SectionLabel marginBottom={4}>Unassigned ({unassigned.length})</SectionLabel>
            <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
              {unassigned.map((c) => renderConn(c, true))}
            </div>
          </div>
        )}

        {onOtherSystems.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <SectionLabel marginBottom={4}>Already on other systems ({onOtherSystems.length})</SectionLabel>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 }}>Linking adds this system without unlinking it from the others.</div>
            <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
              {onOtherSystems.map((c) => renderConn(c, true))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--color-border)' }}>
          <button onClick={onClose} aria-label="Close" style={{ padding: '8px 16px', background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 13, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={onCreateNew} style={{ padding: '8px 16px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
            + Create new connection
          </button>
        </div>
      </div>
    </div>
  );
}

// 'description' is no longer a toggleable column — it renders as a
// single-line sub-label under the system name (see the Name cell), so
// the row reads name-over-description like a directory entry, matching
// the Data Assets page.
type SystemColId = 'type' | 'criticality' | 'owner' | 'connections';
const SYSTEM_COLUMN_DEFS: Array<{ id: SystemColId; label: string; defaultVisible: boolean }> = [
  { id: 'type',        label: 'Type',        defaultVisible: true  },
  { id: 'criticality', label: 'Criticality', defaultVisible: true  },
  { id: 'owner',       label: 'Owner',       defaultVisible: true  },
  { id: 'connections', label: 'Connections', defaultVisible: true  },
];

export default function SystemsPage({
  embedded = false,
  actionsPortal,
}: {
  embedded?: boolean;
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
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight');
  const systemCols = useColumnPicker<SystemColId>('procela.systems.visibleCols.v1', SYSTEM_COLUMN_DEFS);
  const [systems, setSystems] = useState<SystemEntity[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [systemTypes, setSystemTypes] = useState<string[]>([]);
  const [peopleList, setPeopleList] = useState<{ id: string; name: string; title?: string; orgPaths?: string[]; orgNames?: string[] }[]>([]);
  const [filterType, setFilterType] = useState('');
  const [filterCriticality, setFilterCriticality] = useState('');
  const [filterOwner, setFilterOwner] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);
  const validation = useFormValidation({ name: (v) => !(v as string)?.trim() ? 'Name is required' : null });
  const [showImport, setShowImport] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [connectingSystem, setConnectingSystem] = useState<SystemEntity | null>(null);
  const [importText, setImportText] = useState('');
  const [importFormat, setImportFormat] = useState<'csv' | 'json'>('csv');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<{ assets: number; connections: number; mappings: number } | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [viewingSystemId, setViewingSystemId] = useState<string | null>(null);
  const custodiansLabel = useTerm('custodians');
  const custodianLabel = useTerm('custodian');

  const fetchData = useCallback(async () => {
    try {
      setLoadError(null);
      const query = activeOrgId ? `?orgId=${activeOrgId}` : '';
      const [sysRes, connRes, peopleRes] = await Promise.all([
        apiClient.get<{ success: boolean; data: SystemEntity[]; systemTypes: string[] }>(`/systems${query}`),
        // Connections power the per-row count + shortcut; this fetch is
        // best-effort — a failure here must not block the systems list.
        apiClient.get<{ success: boolean; data: ConnectionSummary[] }>(`/connections${query}`).catch(() => ({ data: [] as ConnectionSummary[] })),
        apiClient.get<{ success: boolean; data: typeof peopleList }>(`/people${query}`).catch(() => ({ data: [] as typeof peopleList })),
      ]);
      setSystems(sysRes.data || []);
      setSystemTypes(sysRes.systemTypes || []);
      setConnections(connRes.data || []);
      setPeopleList(peopleRes.data || []);
    } catch (err) { setLoadError(errorMessage(err, 'Failed to load systems.')); }
    finally { setLoading(false); }
  }, [activeOrgId]);

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

  const openAdd = () => {
    if (!activeOrgId) { addToast('error', 'Select an organization from the header first.'); return; } setForm(emptyForm); setEditingId(null); setShowForm(true); };

  // Deep-link create intent: /systems?new=1 (from the Setup Hub) opens the
  // add form, then strips the param so refresh/back doesn't re-open it.
  useEffect(() => {
    if (searchParams.get('new') !== '1' || !activeOrgId || showForm) return;
    openAdd();
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, activeOrgId]); // eslint-disable-line react-hooks/exhaustive-deps

  const openEdit = (sys: SystemEntity) => {
    // Pre-select the connections currently linked to this system so the
    // user can add or remove them inline alongside the other fields.
    const linkedConnIds = connections
      .filter((c) => connSystemIds(c).includes(sys.id))
      .map((c) => c.id);
    setForm({
      name: sys.name, description: sys.description, systemType: sys.systemType,
      businessCriticality: sys.businessCriticality || '',
      vendor: sys.vendor || '',
      integrationPoints: sys.integrationPoints || '',
      integrations: (sys.integrations || []).map((i) => ({
        id: i.id,
        targetSystemId: i.targetSystemId || '',
        interfaceType: i.interfaceType || '',
        frequency: i.frequency || '',
        direction: i.direction || 'BIDIRECTIONAL',
      })),
      ownerPersonId: sys.ownerPersonId || '',
      deputyOwnerId: sys.deputyOwnerId || '',
      custodianIds: sys.custodianIds || [],
      connectivity: sys.connectivity || 'INTEGRATED',
      connectionIds: linkedConnIds,
    });
    setEditingId(sys.id); setShowForm(true);
  };

  const { isDirty, markDirty, markClean, confirmIfDirty } = useUnsavedChanges();

  const closeForm = () => { markClean(); setShowForm(false); setEditingId(null); setForm(emptyForm); validation.clearErrors(); };
  const setFormDirty = (update: FormData | ((prev: FormData) => FormData)) => { markDirty(); setForm(update); };

  const handleSave = async (keepOpen: boolean = false) => {
    if (!validation.validateAll(form)) return;

    // Save the system itself, then reconcile the connection links.
    // Strip connectionIds from the body — the systems route doesn't
    // know about them; they're applied via the connection-system join
    // routes below.
    const { connectionIds: requestedConnIds, ...systemBody } = form;
    let savedId: string | null = editingId;
    try {
      if (editingId) {
        await apiClient.put(`/systems/${editingId}`, systemBody);
      } else {
        const res = await apiClient.post<{ success: boolean; data: { id: string } }>(
          '/systems',
          { ...systemBody, ...(activeOrgId ? { orgId: activeOrgId } : {}) },
        );
        savedId = res?.data?.id || null;
      }
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Failed to save system');
      return;
    }

    if (savedId && form.connectivity === 'INTEGRATED') {
      // Diff against what's currently linked so we only POST/DELETE the
      // changes, not the full set. For new systems the existing set is
      // empty, so every selection becomes an add.
      const existing = editingId
        ? connections.filter((c) => connSystemIds(c).includes(editingId)).map((c) => c.id)
        : [];
      const toAdd = requestedConnIds.filter((id) => !existing.includes(id));
      const toRemove = existing.filter((id) => !requestedConnIds.includes(id));
      try {
        await Promise.all([
          ...toAdd.map((cid) => apiClient.post(`/connections/${cid}/systems`, { systemId: savedId })),
          ...toRemove.map((cid) => apiClient.delete(`/connections/${cid}/systems/${savedId}`)),
        ]);
      } catch (err: any) {
        addToast('error', err?.message ? `Some links failed: ${err.message}` : 'Some connection links failed to apply');
      }
    }

    addToast('success', editingId ? 'System updated' : 'System created');
    markClean();
    if (keepOpen && !editingId) {
      setForm(emptyForm);
      fetchData();
      return;
    }
    setShowForm(false); setEditingId(null); setForm(emptyForm);
    fetchData();
  };

  const handleDelete = async (id: string) => {
    const sys = systems.find((s) => s.id === id);
    try {
      await apiClient.delete(`/systems/${id}`);
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Failed to delete system');
      return;
    }
    fetchData();
    if (sys) {
      addToast('success', `"${sys.name}" deleted`, {
        action: {
          label: 'Undo',
          handler: async () => {
            await apiClient.post('/systems', {
              name: sys.name, description: sys.description,
              systemType: sys.systemType,
              businessCriticality: sys.businessCriticality,
              vendor: sys.vendor,
              integrationPoints: sys.integrationPoints,
              integrations: (sys.integrations || []).map((i) => ({
                targetSystemId: i.targetSystemId || '',
                interfaceType: i.interfaceType || '',
                frequency: i.frequency || '',
                direction: i.direction || 'BIDIRECTIONAL',
              })),
              ownerPersonId: sys.ownerPersonId,
              deputyOwnerId: sys.deputyOwnerId,
              custodianIds: sys.custodianIds,
              connectivity: sys.connectivity,
              ...(activeOrgId ? { orgId: activeOrgId } : {}),
            });
            addToast('success', `"${sys.name}" restored`);
            fetchData();
          },
        },
        duration: 6000,
      });
    } else {
      addToast('success', 'System deleted');
    }
  };

  const inlineSaveField = async (systemId: string, field: string, value: string) => {
    try {
      await apiClient.put(`/systems/${systemId}`, { [field]: value });
      addToast('success', `Updated ${field === 'systemType' ? 'system type' : field}`);
      fetchData();
    } catch {
      addToast('error', `Failed to update ${field}`);
    }
  };

  const handleCancel = () => { confirmIfDirty(closeForm); };

  const handleImport = async () => {
    if (!importText.trim()) return;
    if (!activeOrgId) { addToast('error', 'Select an organization from the "Working in" dropdown first.'); return; }
    try {
      const body: any = { orgId: activeOrgId };
      if (importFormat === 'csv') { body.csv = importText; } else { body.systems = JSON.parse(importText); }
      const result = await apiClient.post<{ success: boolean; message?: string; skipped?: number }>('/systems/import', body);
      if (result.skipped && result.skipped > 0 && result.message) {
        addToast('info', result.message);
      } else {
        addToast('success', 'Systems imported');
      }
      setShowImport(false); setImportText(''); fetchData();
    } catch (e) { addToast('error', e instanceof Error ? e.message : 'Import failed'); }
  };

  const handleFileRead = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImportText(reader.result as string);
      if (file.name.endsWith('.json')) setImportFormat('json');
      if (file.name.endsWith('.csv')) setImportFormat('csv');
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleBulkDelete = async () => {
    if (sel.count === 0) return;
    // Snapshot the systems we're about to delete so we can offer Undo.
    const toDelete = systems.filter((s) => sel.isSelected(s.id));
    const count = toDelete.length;
    try {
      await Promise.all(toDelete.map((s) => apiClient.delete(`/systems/${s.id}`)));
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Bulk delete failed');
      fetchData();
      return;
    }
    sel.clear();
    fetchData();
    addToast('success', `Deleted ${count} system${count === 1 ? '' : 's'}`, {
      action: {
        label: 'Undo',
        // Restore by POSTing each record back. Since deletes cascade
        // connections in some backends, Undo only revives the systems
        // themselves — callers can reconnect afterwards.
        handler: async () => {
          await Promise.all(toDelete.map((s) =>
            apiClient.post('/systems', {
              name: s.name, description: s.description, systemType: s.systemType,
              connectivity: s.connectivity,
              ...(activeOrgId ? { orgId: activeOrgId } : {}),
            }).catch(() => {}),
          ));
          fetchData();
          addToast('success', 'Restored.');
        },
      },
    });
  };

  const filteredSystems = systems.filter((s) => {
    if (filterType === '__none__' && s.systemType) return false;
    if (filterType && filterType !== '__none__' && s.systemType !== filterType) return false;
    if (filterCriticality && (s.businessCriticality || '') !== filterCriticality) return false;
    if (filterOwner) {
      if (filterOwner === '__none__') { if (s.ownerName) return false; }
      else if ((s.ownerName || '') !== filterOwner) return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      if (
        !s.name.toLowerCase().includes(q) &&
        !(s.description || '').toLowerCase().includes(q) &&
        !(s.vendor || '').toLowerCase().includes(q) &&
        !(s.systemType || '').toLowerCase().includes(q)
      ) return false;
    }
    return true;
  });

  // Distinct owner names for the Owner filter (sorted; blank owners excluded —
  // the "No owner" option covers those).
  const ownerOptions = Array.from(new Set(systems.map((s) => s.ownerName).filter(Boolean))).sort() as string[];

  // Sort: comparators keyed by column name; URL persists ?sort=&dir=
  const { sorted, sortKey, sortDir, toggleSort } = useSortedList(
    filteredSystems,
    {
      name: (a, b) => a.name.localeCompare(b.name),
      type: (a, b) => (a.systemType || '').localeCompare(b.systemType || ''),
      // Rank by severity (High > Medium > Low), not alphabetically.
      criticality: (a, b) => {
        const rank: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
        return (rank[a.businessCriticality || ''] || 0) - (rank[b.businessCriticality || ''] || 0);
      },
      description: (a, b) => (a.description || '').localeCompare(b.description || ''),
      owner: (a, b) => (a.ownerName || '').localeCompare(b.ownerName || ''),
      // Sort by the number of connections serving the system (what the
      // Connections cell shows as "N configured").
      connections: (a, b) => {
        const ca = connections.filter((c) => connSystemIds(c).includes(a.id)).length;
        const cb = connections.filter((c) => connSystemIds(c).includes(b.id)).length;
        return ca - cb;
      },
      updated: (a, b) => +new Date(a.updatedAt) - +new Date(b.updatedAt),
    },
    'name',
  );

  // Only rows the user can actually tick are selectable — inherited
  // (cross-org) rows have disabled checkboxes — so select-all governs the
  // visible, selectable set (fixes select-all comparing against the full
  // unfiltered `systems` list).
  const selectableSystems = sorted.filter((s) => !isInheritedAsset(s.orgId, activeOrgId));
  const sel = useRowSelection(selectableSystems, (s) => s.id);

  const inheritedHintFor = (sys: SystemEntity) =>
    isInheritedAsset(sys.orgId, activeOrgId)
      ? `Owned at ${getOrgName(sys.orgId)}. Switch the "Working in..." scope to ${getOrgName(sys.orgId)} to edit.`
      : '';

  const systemColumns = ([
    {
      key: 'name', header: 'Name', sortable: true, cellStyle: { fontWeight: 500, maxWidth: 340 },
      render: (sys: SystemEntity) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <button
              type="button"
              onClick={() => setViewingSystemId(sys.id)}
              title={sys.name}
              style={{
                background: 'none', border: 'none', padding: 0,
                color: 'var(--color-primary)', cursor: 'pointer',
                font: 'inherit', fontWeight: 500, textAlign: 'left',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                minWidth: 0, flexShrink: 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
              onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
            >
              {sys.name}
            </button>
            <OwnerBadge assetOrgId={sys.orgId} activeOrgId={activeOrgId} getOrgName={getOrgName} />
          </div>
          <TruncatedText
            text={sys.description}
            emptyPlaceholder="--"
            style={{
              fontSize: 12, fontWeight: 400, marginTop: 2,
              ...(sys.description?.trim() ? { color: 'var(--color-text-secondary)' } : null),
            }}
          />
        </div>
      ),
    },
    systemCols.isVisible('type') && {
      key: 'type', header: 'Type', sortable: true,
      render: (sys: SystemEntity) => {
        const inherited = isInheritedAsset(sys.orgId, activeOrgId);
        return systemTypes.length > 0 && !inherited ? (
          <InlineCellEdit
            value={sys.systemType || ''}
            onSave={(v) => inlineSaveField(sys.id, 'systemType', v)}
            type="select"
            options={systemTypes}
          />
        ) : (
          sys.systemType ? <span style={typeBadge}>{sys.systemType}</span> : <span style={{ color: 'var(--color-text-muted)' }}>--</span>
        );
      },
    },
    systemCols.isVisible('criticality') && {
      key: 'criticality', header: 'Criticality', sortable: true, width: 120,
      render: (sys: SystemEntity) => {
        const level = sys.businessCriticality;
        if (!level) return <span style={{ color: 'var(--color-text-muted)' }}>—</span>;
        const pal = CRITICALITY_BADGE[level] || CRITICALITY_BADGE.LOW;
        const label = level.charAt(0) + level.slice(1).toLowerCase();
        return (
          <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 500, background: pal.bg, color: pal.color }}>
            {label}
          </span>
        );
      },
    },
    systemCols.isVisible('owner') && {
      key: 'owner', header: 'Owner', sortable: true,
      render: (sys: SystemEntity) => sys.ownerName ? (
        <div>
          <div>{sys.ownerName}</div>
          {sys.deputyOwnerName && (
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }} title="Deputy owner — backup when the primary is unavailable">
              Deputy: {sys.deputyOwnerName}
            </div>
          )}
        </div>
      ) : (sys.connectivity || 'INTEGRATED') === 'INTEGRATED' ? (
        <span style={{ color: '#b45309', fontStyle: 'italic' }} title="No business owner assigned — surfaces in gap detection">
          Unassigned
        </span>
      ) : (
        <span style={{ color: 'var(--color-text-muted)' }}>—</span>
      ),
    },
    systemCols.isVisible('connections') && {
      key: 'connections', header: 'Connections', sortable: true, width: 140,
      render: (sys: SystemEntity) => {
        const sysConnections = connections.filter((c) => connSystemIds(c).includes(sys.id));
        const connectedCount = sysConnections.filter((c) => c.status === 'CONNECTED').length;
        return renderConnectivityCell(sys, sysConnections.length, connectedCount, navigate, setConnectingSystem);
      },
    },
    {
      key: 'actions', header: 'Actions', align: 'center' as const, width: 80,
      render: (sys: SystemEntity) => {
        const inherited = isInheritedAsset(sys.orgId, activeOrgId);
        const hint = inheritedHintFor(sys);
        return (
          <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <IconButton size="sm" icon="eye" label="View details" onClick={() => setViewingSystemId(sys.id)} />
            <IconButton size="sm" icon="edit" label={hint || 'Edit'} disabled={inherited} onClick={() => openEdit(sys)} />
            <IconButton size="sm" icon="trash" label={hint || 'Delete'} variant="danger" disabled={inherited} onClick={async () => {
              try {
                const res = await apiClient.get<{ success: boolean; data: { assets: number; connections: number; mappings: number } }>(`/systems/${sys.id}/impact`);
                setDeleteImpact(res.data || null);
              } catch { setDeleteImpact(null); }
              setConfirmDelete(sys.id);
            }} />
          </div>
        );
      },
    },
  ].filter(Boolean) as DataTableColumn<SystemEntity>[]);

  return (
    <div>
      <style>{`@keyframes highlightPulse { 0% { background: #fef3c7; } 100% { background: transparent; } }`}</style>
      {/* Header */}
      <EmbeddablePageHeader
        embedded={embedded}
        actionsPortal={actionsPortal}
        title="Systems"
        subtitle="Applications and platforms where your organization's data lives."
        actions={
          <>
            <SavedViewsMenu
              pageKey="systems"
              currentFilters={{ filterType, filterCriticality, filterOwner, searchQuery }}
              onApply={(f) => {
                setFilterType((f.filterType as string) || '');
                setFilterCriticality((f.filterCriticality as string) || '');
                setFilterOwner((f.filterOwner as string) || '');
                setSearchQuery((f.searchQuery as string) || '');
              }}
            />
            <ExportMenu
              disabled={systems.length === 0}
              build={() => ({
                filenameBase: 'systems',
                sheetName: 'Systems',
                headers: ['Name', 'Type', 'Vendor', 'Criticality', 'Connectivity', 'Connection Status', 'Owner', 'Deputy Owner', custodiansLabel, 'Description'],
                rows: systems.map((s) => [
                  s.name,
                  s.systemType,
                  s.vendor || '',
                  s.businessCriticality || '',
                  s.connectivity ? CONNECTIVITY_LABEL[s.connectivity] : '',
                  s.connectionStatus || '',
                  s.ownerName || '',
                  s.deputyOwnerName || '',
                  (s.custodianNames || []).join('; '),
                  s.description,
                ]),
              })}
            />
            <IconButton icon="upload" label="Import systems" onClick={() => setShowImport(true)} />
            <IconButton icon="link" label="Connect to source" onClick={() => setShowSync(true)} />
            <ColumnPicker state={systemCols} />
            {canOwnHere && (
              <IconButton icon="plus" label="Add system" variant="primary" onClick={openAdd} />
            )}
          </>
        }
      >
        <HelpPopover id="systems-intro" title="Systems">
          Register the applications and platforms your organization uses. Include business
          criticality, vendor, and integration points so you can assess the impact of changes.
        </HelpPopover>
      </EmbeddablePageHeader>

      {/* Wrong-level banner. Systems can only be owned by companies
          or divisions; if the active scope is a department or team
          the Add button is hidden and this banner explains why.
          The list itself still renders so users can read inherited
          rows from above. */}
      {activeOrgId && !canOwnHere && <CreateScopeNotice noun="systems" />}

      {/* Full-width content — System Types is now a top facet (was a left-rail tree) */}
      <div>

        {/* Content Area */}
        <div>
          {/* System Types chips — only rendered when the facet actually splits
              the list (≥2 populated values), to save vertical space. */}
          {(() => {
            const chips = [
              { key: '', label: 'All', count: systems.length },
              ...systemTypes.map((t) => ({ key: t, label: t, count: systems.filter((s) => s.systemType === t).length })),
              { key: '__none__', label: 'Untyped', count: systems.filter((s) => !s.systemType).length },
            ].filter((o) => o.key === '' || o.count > 0);
            if (chips.filter((o) => o.key !== '').length < 2) return null;
            return (
              <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {chips.map((o) => {
                  const active = filterType === o.key;
                  return (
                    <button
                      key={o.key || 'all'}
                      onClick={() => setFilterType(o.key)}
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
          {/* Filters (left-aligned, mirrors Data Assets) */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              aria-label="Search systems" placeholder="Search systems..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ border: '1px solid var(--color-border)', borderRadius: 4, padding: '5px 10px', fontSize: 12, background: 'var(--color-surface)', width: 200 }}
            />
            <select aria-label="Filter by criticality" style={{ ...selectStyle, width: 'auto', minWidth: 130 }} value={filterCriticality} onChange={(e) => setFilterCriticality(e.target.value)}>
              <option value="">All Criticality</option>
              <option value="HIGH">High ({systems.filter((s) => s.businessCriticality === 'HIGH').length})</option>
              <option value="MEDIUM">Medium ({systems.filter((s) => s.businessCriticality === 'MEDIUM').length})</option>
              <option value="LOW">Low ({systems.filter((s) => s.businessCriticality === 'LOW').length})</option>
            </select>
            <select aria-label="Filter by owner" style={{ ...selectStyle, width: 'auto', minWidth: 140 }} value={filterOwner} onChange={(e) => setFilterOwner(e.target.value)}>
              <option value="">All Owners</option>
              {ownerOptions.map((o) => <option key={o} value={o}>{o}</option>)}
              <option value="__none__">No owner ({systems.filter((s) => !s.ownerName).length})</option>
            </select>
            {(filterCriticality || searchQuery || filterType || filterOwner) && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { setFilterCriticality(''); setSearchQuery(''); setFilterType(''); setFilterOwner(''); }}
              >
                Clear Filters
              </Button>
            )}
            {(filterCriticality || searchQuery || filterType || filterOwner) && (
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                Showing {filteredSystems.length} of {systems.length}
              </span>
            )}
          </div>

      {/* Import Panel */}
      {showImport && (
        <Card padding={16} marginBottom={16}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div>
              <h3 style={{ fontSize: 14, fontWeight: 600 }}>Import Systems</h3>
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Paste CSV or JSON, or browse a file. Format is auto-detected.</span>
            </div>
            <button onClick={() => { setShowImport(false); setImportText(''); }} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', color: 'var(--color-text-muted)' }}>&times;</button>
          </div>
          {!activeOrgId && (
            <div style={{ background: '#fef3c7', padding: '8px 12px', borderRadius: 4, fontSize: 12, color: '#92400e', marginBottom: 10 }}>
              Select an organization from the "Working in" dropdown before importing.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
            <input ref={fileInputRef} aria-label="Import file" type="file" accept=".csv,.json,.txt" onChange={handleFileRead} style={{ display: 'none' }} />
            <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>Browse File</Button>
          </div>
          <textarea
            aria-label="Import data"
            style={{ ...inputStyle, width: '100%', minHeight: 80, fontFamily: 'var(--font-mono)', fontSize: 11 }}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={'Name,Description,Type\nSAP ERP,Enterprise resource planning,ERP\nSalesforce,Customer relationship management,CRM'}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--color-text-muted)', flex: 1 }}>CSV columns: Name (required), Description, Type</span>
            <Button variant="secondary" onClick={() => { setShowImport(false); setImportText(''); }}>Cancel</Button>
            <Button variant="primary" disabled={!importText.trim() || !activeOrgId} onClick={handleImport}>Import</Button>
          </div>
        </Card>
      )}

      {/* Add/Edit Form */}
      {showForm && (
        <Card padding={20} marginBottom={20}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>
            {editingId ? 'Edit System' : 'Add New System'}
          </h3>
          <UnsavedBanner visible={isDirty()} onSave={() => handleSave(false)} onDiscard={closeForm} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Name *</label>
              <input autoFocus
                aria-label="Name"
                style={{ ...inputStyle, border: validation.fieldError('name') ? inputErrorBorder : inputStyle.border }}
                value={form.name}
                onChange={(e) => { const v = e.target.value; setFormDirty({ ...form, name: v }); if (validation.touched.name) validation.validateField('name', v, form); }}
                onBlur={() => { validation.touch('name'); validation.validateField('name', form.name, form); }}
                placeholder="e.g. SAP ERP, Salesforce CRM" />
              {validation.fieldError('name') && <div style={fieldErrorStyle}>{validation.fieldError('name')}</div>}
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>System Type</label>
              <select aria-label="System Type" style={selectStyle} value={form.systemType} onChange={(e) => setFormDirty({ ...form, systemType: e.target.value })}>
                <option value="">-- Select type --</option>
                {systemTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Description</label>
              <input aria-label="Description" style={inputStyle} value={form.description} onChange={(e) => setFormDirty({ ...form, description: e.target.value })} placeholder="Brief description of what this system does" />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>Business Criticality <HelpPopover id="sys-criticality" title="Business Criticality">How critical is this system to daily operations? High = outage stops the business. Medium = workarounds exist. Low = minimal operational impact.</HelpPopover></label>
              <select aria-label="Business Criticality" style={selectStyle} value={form.businessCriticality} onChange={(e) => setFormDirty({ ...form, businessCriticality: e.target.value })}>
                <option value="">-- Select --</option>
                <option value="HIGH">High</option>
                <option value="MEDIUM">Medium</option>
                <option value="LOW">Low</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Vendor / Platform</label>
              <input aria-label="Vendor / Platform" style={inputStyle} value={form.vendor} onChange={(e) => setFormDirty({ ...form, vendor: e.target.value })} placeholder="e.g. SAP, Salesforce, Custom" />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                Owner
                <HelpPopover id="sys-owner" title="System Owner">
                  Single accountable business owner — the CDO of this system. Drives the roadmap, signs off on changes and decommissioning, escalation point when it breaks. Required for Integrated systems; optional for Manual/Vendor-managed.
                </HelpPopover>
              </label>
              <PersonPicker
                mode="single"
                valueMode="id"
                value={form.ownerPersonId || null}
                onChange={(pid) => setFormDirty({ ...form, ownerPersonId: pid || '' })}
                placeholder="-- Unassigned --"
              />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                Deputy Owner
                <HelpPopover id="sys-deputy" title="Deputy Owner">
                  Optional backup for the primary Owner. Same authority when the primary is unavailable — for coverage, succession, or matrix-org co-ownership. Must be a different person from the primary; only one is in charge at a time.
                </HelpPopover>
              </label>
              <div style={form.deputyOwnerId && form.deputyOwnerId === form.ownerPersonId
                ? { outline: '1px solid #ef4444', borderRadius: 'var(--radius-md)' } : undefined}>
                <PersonPicker
                  mode="single"
                  valueMode="id"
                  value={form.deputyOwnerId || null}
                  onChange={(pid) => setFormDirty({ ...form, deputyOwnerId: pid || '' })}
                  placeholder="-- None --"
                />
              </div>
              {form.deputyOwnerId && form.deputyOwnerId === form.ownerPersonId && (
                <span style={{ fontSize: 11, color: '#991b1b', display: 'block', marginTop: 4 }}>
                  Deputy must differ from the primary Owner.
                </span>
              )}
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                {custodiansLabel}
                <HelpPopover id="sys-custodians" title={`Technical ${custodiansLabel}`}>
                  Day-to-day technical caretakers — SREs, application admins, DBAs. Multiple is the rule for shared infrastructure. Distinct from the business Owner.
                </HelpPopover>
                <span style={{ fontWeight: 400, color: 'var(--color-text-muted)', marginLeft: 6 }}>
                  one or more — leave empty if unassigned
                </span>
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6, minHeight: 24 }}>
                {form.custodianIds.length === 0 && (
                  <span style={{ fontSize: 12, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                    No {custodiansLabel.toLowerCase()} assigned yet.
                  </span>
                )}
                {form.custodianIds.map((cid) => {
                  const p = peopleList.find((pp) => pp.id === cid);
                  return (
                    <span key={cid} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                      background: '#dbeafe', color: '#1e40af',
                    }}>
                      {p ? formatPersonLabel(p) : cid}
                      <button
                        type="button"
                        onClick={() => setFormDirty({ ...form, custodianIds: form.custodianIds.filter((id) => id !== cid) })}
                        aria-label={`Remove ${custodianLabel.toLowerCase()} ${p?.name || cid}`}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, fontSize: 14, lineHeight: 1 }}
                      >
                        &times;
                      </button>
                    </span>
                  );
                })}
              </div>
              <select
                aria-label={`Add ${custodianLabel.toLowerCase()}`}
                style={selectStyle}
                value=""
                onChange={(e) => {
                  const cid = e.target.value;
                  if (cid && !form.custodianIds.includes(cid)) {
                    setFormDirty({ ...form, custodianIds: [...form.custodianIds, cid] });
                  }
                }}
              >
                <option value="">-- Add a custodian --</option>
                {peopleList
                  .filter((p) => !form.custodianIds.includes(p.id))
                  .map((p) => <option key={p.id} value={p.id}>{formatPersonLabel(p)}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                Connectivity
                <HelpPopover id="sys-connectivity" title="Connectivity">
                  How this system is reached. <strong>Integrated</strong>: a connection profile will be (or has been) configured. <strong>Manual</strong>: paper, spreadsheet, or human handoff — won't show as a connection gap. <strong>Vendor-managed</strong>: vendor owns the data; no API expected.
                </HelpPopover>
              </label>
              <select aria-label="Connectivity" style={selectStyle} value={form.connectivity} onChange={(e) => setFormDirty({ ...form, connectivity: e.target.value as Connectivity })}>
                <option value="INTEGRATED">Integrated (will connect)</option>
                <option value="MANUAL">Manual (no integration)</option>
                <option value="EXTERNAL">Vendor-managed</option>
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                Integrations
                <HelpPopover id="sys-integrations" title="Integrations">
                  Each row is one interface to another system in the catalog — its own type (REST API, file drop, …), cadence, and direction. Add a row per distinct interface, e.g. "sends to Billing via REST hourly" and "drops a nightly file to the Data Lake" are two rows. You only declare it from one side; the other system shows it automatically.
                </HelpPopover>
              </label>
              {(() => {
                const targetable = systems.filter((s) => s.id !== editingId);
                const update = (idx: number, patch: Partial<IntegrationDraft>) =>
                  setFormDirty({
                    ...form,
                    integrations: form.integrations.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
                  });
                const remove = (idx: number) =>
                  setFormDirty({ ...form, integrations: form.integrations.filter((_, i) => i !== idx) });
                const add = () =>
                  setFormDirty({
                    ...form,
                    integrations: [
                      ...form.integrations,
                      { targetSystemId: '', interfaceType: '', frequency: '', direction: 'BIDIRECTIONAL' },
                    ],
                  });
                return (
                  <>
                    {form.integrations.length === 0 && (
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', fontStyle: 'italic', marginBottom: 6 }}>
                        No integrations yet — add one for each system this connects to.
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {form.integrations.map((row, idx) => {
                        const incomplete = !row.targetSystemId || !row.interfaceType;
                        return (
                          <div key={row.id || idx} style={{
                            display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
                            padding: 8, borderRadius: 'var(--radius-md)',
                            border: `1px solid ${incomplete ? '#fde68a' : 'var(--color-border)'}`,
                            background: incomplete ? '#fffbeb' : 'var(--color-bg)',
                          }}>
                            <select
                              style={{ ...selectStyle, flex: '2 1 160px', width: 'auto' }}
                              value={row.direction}
                              onChange={(e) => update(idx, { direction: e.target.value as IntegrationDirection })}
                              aria-label="Direction"
                            >
                              {DIRECTION_VALUES.map((d) => <option key={d} value={d}>{DIRECTION_LABEL[d]}</option>)}
                            </select>
                            <select
                              style={{ ...selectStyle, flex: '3 1 180px', width: 'auto' }}
                              value={row.targetSystemId}
                              onChange={(e) => update(idx, { targetSystemId: e.target.value })}
                              aria-label="Target system"
                            >
                              <option value="">-- Select system --</option>
                              {targetable.map((s) => (
                                <option key={s.id} value={s.id}>{s.name}{s.systemType ? ` (${s.systemType})` : ''}</option>
                              ))}
                            </select>
                            <select
                              style={{ ...selectStyle, flex: '2 1 150px', width: 'auto' }}
                              value={row.interfaceType}
                              onChange={(e) => update(idx, { interfaceType: e.target.value as IntegrationMechanism | '' })}
                              aria-label="Interface type"
                            >
                              <option value="">-- Interface --</option>
                              {MECHANISM_VALUES.map((m) => <option key={m} value={m}>{MECHANISM_LABEL[m]}</option>)}
                            </select>
                            <select
                              style={{ ...selectStyle, flex: '2 1 130px', width: 'auto' }}
                              value={row.frequency}
                              onChange={(e) => update(idx, { frequency: e.target.value as IntegrationFrequency | '' })}
                              aria-label="Frequency"
                            >
                              <option value="">Any cadence</option>
                              {FREQUENCY_VALUES.map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
                            </select>
                            <button
                              type="button"
                              onClick={() => remove(idx)}
                              aria-label="Remove integration"
                              title="Remove integration"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: '4px 6px', fontSize: 16, lineHeight: 1 }}
                            >
                              &times;
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={add}
                      style={{ marginTop: 8 }}
                    >
                      + Add integration
                    </Button>
                    {form.connectivity === 'INTEGRATED' && form.integrations.length === 0 && (
                      <div style={{
                        marginTop: 6, padding: '6px 10px', fontSize: 11, lineHeight: 1.4,
                        background: '#fef3c7', color: '#92400e', borderRadius: 'var(--radius-sm, 4px)',
                        border: '1px solid #fde68a',
                      }}>
                        This system is marked <strong>Integrated</strong> but has no integrations declared. You can save without them, but the connection map and impact reports won't see how it links to other systems.
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
            {/* Integration Notes (free-text integrationPoints) removed:
                the structured Integration rows below capture interfaces;
                the free-text field was written but rendered on no read
                surface. Stored values are retained on the record. */}
            {form.connectivity === 'INTEGRATED' && (
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                  Served by connections
                  <span style={{ fontWeight: 400, color: 'var(--color-text-muted)', marginLeft: 6 }}>
                    one or more — a connection can serve several systems at once
                  </span>
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6, minHeight: 24 }}>
                  {form.connectionIds.length === 0 && (
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                      No connections serving this system yet — pick one below or create a new one.
                    </span>
                  )}
                  {form.connectionIds.map((cid) => {
                    const c = connections.find((cc) => cc.id === cid);
                    const detail = c?.connectionType ? ` · ${c.connectionType}` : '';
                    return (
                      <span key={cid} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                        background: '#dbeafe', color: '#1e40af',
                      }}>
                        {c?.name || cid}{detail}
                        <button
                          type="button"
                          onClick={() => setFormDirty({ ...form, connectionIds: form.connectionIds.filter((id) => id !== cid) })}
                          aria-label={`Remove ${c?.name || cid}`}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, fontSize: 14, lineHeight: 1 }}
                        >
                          &times;
                        </button>
                      </span>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <select
                    aria-label="Add an existing connection"
                    style={{ ...selectStyle, flex: 1 }}
                    value=""
                    onChange={(e) => {
                      const cid = e.target.value;
                      if (cid && !form.connectionIds.includes(cid)) {
                        setFormDirty({ ...form, connectionIds: [...form.connectionIds, cid] });
                      }
                    }}
                  >
                    <option value="">-- Add an existing connection --</option>
                    {connections
                      .filter((c) => !form.connectionIds.includes(c.id))
                      .map((c) => {
                        const otherSystems = connSystemIds(c).filter((sid) => sid !== editingId).map((sid) => systems.find((s) => s.id === sid)?.name).filter(Boolean);
                        const suffix = otherSystems.length > 0 ? ` (also serves ${otherSystems.join(', ')})` : '';
                        return <option key={c.id} value={c.id}>{c.name}{c.connectionType ? ` — ${c.connectionType}` : ''}{suffix}</option>;
                      })}
                  </select>
                  <a
                    href="/connections?open=1"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ ...btnSecondary, textDecoration: 'none', fontSize: 12, padding: '6px 12px', whiteSpace: 'nowrap' }}
                    title="Open the Connections page in a new tab to register a new data source"
                  >
                    + Create new
                  </a>
                </div>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={handleCancel}>Cancel</Button>
            {!editingId && (
              <Button
                variant="secondary"
                disabled={!form.name.trim()}
                onClick={() => handleSave(true)}
                title="Save this system and keep the form open to add another"
              >
                Save & Add Another
              </Button>
            )}
            <Button variant="primary" disabled={!form.name.trim()} onClick={() => handleSave(false)}>
              {editingId ? 'Save Changes' : 'Add System'}
            </Button>
          </div>
        </Card>
      )}

      <BulkActionBar count={sel.count} onClear={sel.clear}>
        <BulkActionButton variant="danger" onClick={() => setConfirmBulkDelete(true)}>Delete selected</BulkActionButton>
      </BulkActionBar>

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete System?"
        message={
          deleteImpact && (deleteImpact.assets > 0 || deleteImpact.connections > 0 || deleteImpact.mappings > 0)
            ? `This will permanently delete this system. Affected: ${deleteImpact.assets} data asset${deleteImpact.assets !== 1 ? 's' : ''}, ${deleteImpact.connections} connection${deleteImpact.connections !== 1 ? 's' : ''}, ${deleteImpact.mappings} mapping${deleteImpact.mappings !== 1 ? 's' : ''}. This cannot be undone.`
            : 'This will permanently delete this system. This cannot be undone.'
        }
        confirmLabel="Delete"
        onConfirm={async () => {
          const id = confirmDelete;
          setConfirmDelete(null);
          setDeleteImpact(null);
          if (id) await handleDelete(id);
        }}
        onCancel={() => { setConfirmDelete(null); setDeleteImpact(null); }}
      />

      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete Selected Systems?"
        message={`Delete ${sel.count} selected items? This cannot be undone.`}
        confirmLabel="Delete Selected"
        onConfirm={async () => {
          setConfirmBulkDelete(false);
          await handleBulkDelete();
        }}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      {/* Table */}
      <div style={{ background: 'var(--color-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', overflow: 'auto' }}>
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => { setLoadError(null); setLoading(true); fetchData(); }} />
        ) : loading ? (
          <SkeletonRows rows={5} columnWidths={[40, null, null, null, 140, 80]} />
        ) : systems.length === 0 && !showForm ? (
          <EmptyState
            icon={renderNavIcon('/systems')}
            title="No systems defined yet"
            description="Systems are the applications and platforms where your data lives — ERP, CRM, GIS, and so on. Define them first so you can connect and map data assets to each one."
            action={canOwnHere ? { label: '+ Add System', onClick: openAdd } : undefined}
            secondaryAction={{ label: 'Import from CSV', onClick: () => setShowImport(true) }}
          />
        ) : (
          <DataTable
            rows={sorted}
            columns={systemColumns}
            rowKey={(s) => s.id}
            rowId={(s) => `row-${s.id}`}
            selection={sel}
            isRowDisabled={(s) => isInheritedAsset(s.orgId, activeOrgId)}
            sort={{ sortKey, sortDir, onSort: toggleSort }}
            selectAllLabel="Select all systems"
            emptyMessage="No systems match the current filters."
            pageSize={15}
            countNoun={['system', 'systems']}
          />
        )}
      </div>
        </div>
      </div>
      {showSync && (
        <Suspense fallback={null}>
          <SyncConnectionWizard open={showSync} onClose={() => setShowSync(false)} targetEntity="systems" orgId={activeOrgId || ''} onCreated={fetchData} />
        </Suspense>
      )}
      {viewingSystemId && (
        <Suspense fallback={null}>
          <SystemDetailModal
            systemId={viewingSystemId}
            onClose={() => setViewingSystemId(null)}
          />
        </Suspense>
      )}
      {connectingSystem && (
        <ConnectPickerModal
          sys={connectingSystem}
          connections={connections}
          systems={systems}
          orgId={activeOrgId}
          addToast={addToast}
          onClose={() => setConnectingSystem(null)}
          onAttached={() => { setConnectingSystem(null); fetchData(); }}
          onCreateNew={() => {
            const id = connectingSystem.id;
            setConnectingSystem(null);
            navigate(`/connections?systemId=${encodeURIComponent(id)}&open=1`);
          }}
        />
      )}
    </div>
  );
}
