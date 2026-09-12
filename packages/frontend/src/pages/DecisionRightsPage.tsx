import { useEffect, useState, useCallback } from 'react';
import { apiClient } from '../api/client';
import { errorMessage } from '../lib/errorToast';
import PageHeader from '../components/PageHeader';
import SectionLabel from '../components/SectionLabel';
import Card from '../components/Card';
import Button from '../components/Button';
import TruncatedText from '../components/TruncatedText';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import { useRowSelection } from '../hooks/useRowSelection';
import BulkActionBar, { BulkActionButton } from '../components/BulkActionBar';
import { useOrgContext } from '../stores/orgContext';
import { usePermissions } from '../hooks/usePermissions';
import { useToastStore } from '../stores/toastStore';
import IconButton from '../components/IconButton';
import ConfirmDialog from '../components/ConfirmDialog';
import EmptyState from '../components/EmptyState';
import ErrorState from '../components/ErrorState';
import { renderNavIcon } from '../components/navIcons';
import { SkeletonRows } from '../components/Skeleton';
import { useColumnPicker } from '../hooks/useColumnPicker';
import ColumnPicker from '../components/ColumnPicker';
import { useSortedList } from '../hooks/useSortedList';
import SavedViewsMenu from '../components/SavedViewsMenu';

// ── Types ──

type DeciderType = 'PERSON' | 'ROLE' | 'GROUP';

type DecisionCategory =
  | 'POLICY' | 'EXCEPTION' | 'ISSUE' | 'CLASSIFICATION'
  | 'ACCESS' | 'SCOPE' | 'ROLE' | 'OTHER';

interface DecisionRight {
  id: string;
  orgId: string;
  decision: string;
  category: DecisionCategory;
  description: string;
  decider: string | null;
  deciderType: DeciderType;
  deciderName?: string | null;
  recommends: string[];
  approves: string[];
  informed: string[];
  escalationPath: string;
  createdAt: string;
  updatedAt: string;
}

interface Person { id: string; name: string; }

interface GovernanceGroup { id: string; name: string; }

interface DecisionForm {
  decision: string;
  category: DecisionCategory;
  description: string;
  decider: string;
  deciderType: DeciderType;
  recommends: string[];
  approves: string[];
  informed: string[];
  escalationPath: string;
}

const emptyForm: DecisionForm = {
  decision: '',
  category: 'POLICY',
  description: '',
  decider: '',
  deciderType: 'ROLE',
  recommends: [],
  approves: [],
  informed: [],
  escalationPath: '',
};

const CATEGORIES: DecisionCategory[] = [
  'POLICY', 'EXCEPTION', 'ISSUE', 'CLASSIFICATION', 'ACCESS', 'SCOPE', 'ROLE', 'OTHER',
];

const CATEGORY_LABELS: Record<DecisionCategory, string> = {
  POLICY: 'Policy',
  EXCEPTION: 'Exception',
  ISSUE: 'Issue',
  CLASSIFICATION: 'Classification',
  ACCESS: 'Access',
  SCOPE: 'Scope',
  ROLE: 'Role',
  OTHER: 'Other',
};

const CATEGORY_COLORS: Record<DecisionCategory, { bg: string; color: string }> = {
  POLICY:         { bg: '#dbeafe', color: '#1e40af' },
  EXCEPTION:      { bg: '#fef3c7', color: '#92400e' },
  ISSUE:          { bg: '#fee2e2', color: '#991b1b' },
  CLASSIFICATION: { bg: '#fce7f3', color: '#9d174d' },
  ACCESS:         { bg: '#ccfbf1', color: '#115e59' },
  SCOPE:          { bg: '#ede9fe', color: '#5b21b6' },
  ROLE:           { bg: '#e0e7ff', color: '#3730a3' },
  OTHER:          { bg: '#f3f4f6', color: '#6b7280' },
};

const DAMA_ROLES = [
  'CDO', 'DATA_GOVERNANCE_LEAD', 'DATA_OWNER', 'BUSINESS_DATA_STEWARD',
  'TECHNICAL_DATA_STEWARD', 'DATA_QUALITY_ANALYST', 'DATA_CUSTODIAN',
  'DATA_ARCHITECT', 'DATA_ENGINEER', 'DATABASE_ADMINISTRATOR',
];

const ROLE_LABELS: Record<string, string> = {
  CDO: 'Chief Data Officer',
  DATA_GOVERNANCE_LEAD: 'Data Governance Lead',
  DATA_OWNER: 'Data Owner',
  BUSINESS_DATA_STEWARD: 'Business Data Steward',
  TECHNICAL_DATA_STEWARD: 'Technical Data Steward',
  DATA_QUALITY_ANALYST: 'Data Quality Analyst',
  DATA_CUSTODIAN: 'Data Custodian',
  DATA_ARCHITECT: 'Data Architect',
  DATA_ENGINEER: 'Data Engineer',
  DATABASE_ADMINISTRATOR: 'Database Administrator',
};

// ── Styles ──

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)', borderRadius: 4,
  padding: '6px 10px', fontSize: 13, width: '100%', background: 'var(--color-surface)',
};
const selectStyle: React.CSSProperties = { ...inputStyle, appearance: 'auto' as any };
const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 };

function badgeStyle(colors: { bg: string; color: string }): React.CSSProperties {
  return {
    display: 'inline-block', padding: '2px 8px', borderRadius: 4,
    fontSize: 11, fontWeight: 600, background: colors.bg, color: colors.color, whiteSpace: 'nowrap',
  };
}

const textBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', padding: '2px 4px',
  color: 'var(--color-primary)', cursor: 'pointer',
  fontSize: 12, fontFamily: 'inherit',
};

const chipStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 6px',
  borderRadius: 3,
  fontSize: 10,
  fontWeight: 500,
  background: '#eef2ff',
  color: '#3730a3',
  marginRight: 4,
  marginBottom: 2,
  whiteSpace: 'nowrap',
};

// ── Helpers ──

function labelFor(value: string, people: Person[], groups: GovernanceGroup[]): string {
  if (ROLE_LABELS[value]) return ROLE_LABELS[value];
  const person = people.find((p) => p.id === value);
  if (person) return person.name;
  const group = groups.find((g) => g.id === value);
  if (group) return group.name;
  return value;
}

function Chips({ values, people, groups }: { values: string[]; people: Person[]; groups: GovernanceGroup[] }) {
  if (!values || values.length === 0) {
    return <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic', fontSize: 12 }}>--</span>;
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
      {values.map((v) => (
        <span key={v} style={chipStyle}>{labelFor(v, people, groups)}</span>
      ))}
    </div>
  );
}

// Expanded RACI panel - the recommends/approves/informed/escalation
// detail revealed when a row is expanded. ColumnPicker toggles still
// control which of the four sections render, so users who hide one
// permanently won't see it even when expanded.
function ExpandedRaciDetails({ row, people, groups, showRecommends, showApproves, showInformed, showEscalation }: {
  row: DecisionRight;
  people: Person[];
  groups: GovernanceGroup[];
  showRecommends: boolean;
  showApproves: boolean;
  showInformed: boolean;
  showEscalation: boolean;
}) {
  const Item = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <SectionLabel marginBottom={4}>
        {label}
      </SectionLabel>
      <div style={{ fontSize: 12 }}>{children}</div>
    </div>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
      {showRecommends && <Item label="Recommends">  <Chips values={row.recommends} people={people} groups={groups} /></Item>}
      {showApproves   && <Item label="Approves">    <Chips values={row.approves}   people={people} groups={groups} /></Item>}
      {showInformed   && <Item label="Informed">    <Chips values={row.informed}   people={people} groups={groups} /></Item>}
      {showEscalation && (
        <Item label="Escalation Path">
          {row.escalationPath
            ? <span style={{ color: 'var(--color-text-secondary)' }}>{row.escalationPath}</span>
            : <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>--</span>}
        </Item>
      )}
    </div>
  );
}

// Multi-select component that lets the user check multiple roles/people
function MultiSelect({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (v: string) => {
    if (value.includes(v)) onChange(value.filter((x) => x !== v));
    else onChange([...value, v]);
  };
  return (
    <div style={{
      border: '1px solid var(--color-border)',
      borderRadius: 4,
      padding: 6,
      maxHeight: 140,
      overflowY: 'auto',
      background: 'var(--color-surface)',
      fontSize: 12,
    }}>
      {options.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)', padding: 4 }}>No options</div>
      )}
      {options.map((opt) => (
        <label key={opt.value} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px', cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={value.includes(opt.value)}
            onChange={() => toggle(opt.value)}
          />
          <span>{opt.label}</span>
        </label>
      ))}
    </div>
  );
}

type DecisionColId = 'decision' | 'category' | 'decides' | 'recommends' | 'approves' | 'informed' | 'escalation';
const DECISION_COLUMN_DEFS: Array<{ id: DecisionColId; label: string; defaultVisible: boolean }> = [
  { id: 'decision',   label: 'Decision',    defaultVisible: true  },
  { id: 'category',   label: 'Category',    defaultVisible: true  },
  { id: 'decides',    label: 'Decides',     defaultVisible: true  },
  { id: 'recommends', label: 'Recommends',  defaultVisible: false },
  { id: 'approves',   label: 'Approves',    defaultVisible: true  },
  { id: 'informed',   label: 'Informed',    defaultVisible: false },
  { id: 'escalation', label: 'Escalation',  defaultVisible: false },
];

// ── Component ──

export default function DecisionRightsPage() {
  const { activeOrgId } = useOrgContext();
  const { canWrite } = usePermissions();
  const { addToast } = useToastStore();

  const decisionCols = useColumnPicker<DecisionColId>('procela.decisionRights.visibleCols.v1', DECISION_COLUMN_DEFS);
  const [rows, setRows] = useState<DecisionRight[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [groups, setGroups] = useState<GovernanceGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [categoryFilter, setCategoryFilter] = useState<'ALL' | DecisionCategory>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<DecisionForm>(emptyForm);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setLoadError(null);
      const query = activeOrgId ? `?orgId=${activeOrgId}` : '';
      const [rowsRes, pplRes, grpRes] = await Promise.all([
        apiClient.get<{ success: boolean; data: DecisionRight[] }>(`/decision-rights${query}`),
        apiClient.get<{ success: boolean; data: Person[] }>('/people'),
        apiClient.get<{ success: boolean; data: GovernanceGroup[] }>(`/governance-groups${query}`).catch(() => ({ success: true, data: [] as GovernanceGroup[] })),
      ]);
      setRows(rowsRes.data || []);
      setPeople(pplRes.data || []);
      setGroups(grpRes.data || []);
    } catch (err) { setLoadError(errorMessage(err, 'Failed to load decision rights.')); }
    finally { setLoading(false); }
  }, [activeOrgId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const openAdd = () => {
    if (!activeOrgId) { addToast('error', 'Select an organization from the header first.'); return; } setForm(emptyForm); setEditingId(null); setShowForm(true); };
  const openEdit = (r: DecisionRight) => {
    setForm({
      decision: r.decision,
      category: r.category,
      description: r.description,
      decider: r.decider || '',
      deciderType: r.deciderType,
      recommends: [...r.recommends],
      approves: [...r.approves],
      informed: [...r.informed],
      escalationPath: r.escalationPath,
    });
    setEditingId(r.id);
    setShowForm(true);
  };
  const closeForm = () => { setShowForm(false); setEditingId(null); setForm(emptyForm); };

  const handleSave = async () => {
    if (!form.decision.trim()) return;
    try {
      const payload = {
        ...form,
        decider: form.decider || null,
        ...(activeOrgId ? { orgId: activeOrgId } : {}),
      };
      if (editingId) {
        await apiClient.put(`/decision-rights/${editingId}`, payload);
        addToast('success', 'Decision right updated');
      } else {
        await apiClient.post('/decision-rights', payload);
        addToast('success', 'Decision right created');
      }
      closeForm();
      fetchData();
    } catch (err) {
      addToast('error', errorMessage(err, 'Failed to save decision right'));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiClient.delete(`/decision-rights/${id}`);
      addToast('success', 'Decision right deleted');
      fetchData();
    } catch (err) {
      addToast('error', errorMessage(err, 'Failed to delete decision right'));
    }
  };

  const handleSeed = async () => {
    if (!activeOrgId) {
      addToast('error', 'Please select an organization first');
      return;
    }
    setSeeding(true);
    try {
      const res = await apiClient.post<{
        success: boolean; created: number; skipped: number;
      }>('/decision-rights/seed', { orgId: activeOrgId });
      addToast('success', `Seeded ${res.created} standard decisions${res.skipped ? ` (${res.skipped} already existed)` : ''}`);
      fetchData();
    } catch (err) {
      addToast('error', errorMessage(err, 'Failed to seed decisions'));
    } finally {
      setSeeding(false);
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(sel.selectedIds);
    await Promise.all(ids.map((id) => apiClient.delete(`/decision-rights/${id}`)));
    addToast('success', `Deleted ${ids.length} decision right${ids.length === 1 ? '' : 's'}`);
    sel.clear();
    fetchData();
  };

  const filteredRows = rows.filter((r) => {
    if (categoryFilter !== 'ALL' && r.category !== categoryFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const hay = `${r.decision} ${r.description} ${r.deciderName || ''} ${r.escalationPath || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Sort — URL-persisted via ?sort=&dir=. Category sorts by the resolved
  // display label; "Decides" sorts by the resolved decider label (what the
  // cell shows), with unassigned rows last regardless of direction. The
  // RACI detail (Recommends / Approves / Informed / Escalation) lives in the
  // row expansion, not as sortable columns.
  const { sorted, sortKey, sortDir, toggleSort } = useSortedList(
    filteredRows,
    {
      decision: (a, b) => (a.decision || '').localeCompare(b.decision || ''),
      category: (a, b) => (CATEGORY_LABELS[a.category] || '').localeCompare(CATEGORY_LABELS[b.category] || ''),
      decides: (a, b) => {
        const al = a.deciderName || (a.decider ? labelFor(a.decider, people, groups) : '');
        const bl = b.deciderName || (b.decider ? labelFor(b.decider, people, groups) : '');
        if (!al && !bl) return 0;
        if (!al) return 1;
        if (!bl) return -1;
        return al.localeCompare(bl);
      },
    },
    'decision',
  );

  const sel = useRowSelection(sorted, (r) => r.id);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const expandAll = () => setExpandedIds(new Set(filteredRows.map((r) => r.id)));
  const collapseAll = () => setExpandedIds(new Set());

  const categoryCounts: Record<DecisionCategory | 'ALL', number> = { ALL: rows.length } as any;
  for (const c of CATEGORIES) categoryCounts[c] = 0;
  for (const r of rows) categoryCounts[r.category] = (categoryCounts[r.category] || 0) + 1;

  // Build multi-select option list based on decider type (for recommends/approves/informed we allow any)
  const allParticipantOptions: { value: string; label: string }[] = [
    ...DAMA_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] || r })),
    ...people.map((p) => ({ value: p.id, label: p.name + ' (Person)' })),
    ...groups.map((g) => ({ value: g.id, label: g.name + ' (Group)' })),
  ];

  const deciderOptions = (() => {
    switch (form.deciderType) {
      case 'PERSON':
        return people.map((p) => ({ value: p.id, label: p.name }));
      case 'GROUP':
        return groups.map((g) => ({ value: g.id, label: g.name }));
      case 'ROLE':
      default:
        return DAMA_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] || r }));
    }
  })();

  const decisionColumns = ([
    decisionCols.isVisible('decision') && {
      key: 'decision', header: 'Decision', sortable: true, cellStyle: { fontWeight: 500, verticalAlign: 'top' },
      render: (r: DecisionRight) => (
        <>
          <button
            type="button"
            onClick={() => toggleExpand(r.id)}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-text)', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}
          >
            {r.decision}
          </button>
          {r.description && (
            <TruncatedText text={r.description} style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2, maxWidth: 480 }} />
          )}
        </>
      ),
    },
    decisionCols.isVisible('category') && {
      key: 'category', header: 'Category', sortable: true, cellStyle: { verticalAlign: 'top' },
      render: (r: DecisionRight) => (
        <span style={badgeStyle(CATEGORY_COLORS[r.category] || CATEGORY_COLORS.OTHER)}>
          {CATEGORY_LABELS[r.category]}
        </span>
      ),
    },
    decisionCols.isVisible('decides') && {
      key: 'decides', header: 'Decides', sortable: true, cellStyle: { verticalAlign: 'top' },
      render: (r: DecisionRight) => {
        const decidesLabel = r.deciderName || (r.decider ? labelFor(r.decider, people, groups) : null);
        return decidesLabel ? (
          <div>
            <span style={chipStyle}>{decidesLabel}</span>
            <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>
              {r.deciderType.toLowerCase()}
            </div>
          </div>
        ) : (
          <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic', fontSize: 12 }}>Unassigned</span>
        );
      },
    },
    {
      key: 'actions', header: 'Actions', align: 'center' as const, width: 100, cellStyle: { verticalAlign: 'top' },
      render: (r: DecisionRight) => (
        <div style={{ display: 'inline-flex', gap: 4 }}>
          {canWrite && <IconButton size="sm" icon="edit" label="Edit" onClick={() => openEdit(r)} />}
          {canWrite && <IconButton size="sm" icon="trash" label="Delete" variant="danger" onClick={() => setConfirmDelete(r.id)} />}
        </div>
      ),
    },
  ].filter(Boolean) as DataTableColumn<DecisionRight>[]);

  return (
    <div>

      {/* Header */}
      <PageHeader
        title="Decision Rights"
        subtitle="Who has authority to decide, recommend, approve, and be informed for governance decisions."
        actions={
          <>
            {canWrite && rows.length === 0 && (
              <Button
                variant="secondary"
                disabled={seeding}
                onClick={handleSeed}
              >
                {seeding ? 'Seeding...' : 'Seed Standard Decisions'}
              </Button>
            )}
            <SavedViewsMenu
              pageKey="decision-rights"
              currentFilters={{ categoryFilter, searchQuery }}
              onApply={(f) => {
                setCategoryFilter(((f.categoryFilter as 'ALL' | DecisionCategory) || 'ALL'));
                setSearchQuery((f.searchQuery as string) || '');
              }}
            />
            <ColumnPicker state={decisionCols} />
            {canWrite && <IconButton icon="plus" label="Add decision" variant="primary" onClick={openAdd} />}
          </>
        }
      />

      {/* Search + row-expansion controls. Category filter moved into the
       *  sidebar; expand/collapse-all replaces the visual noise of always
       *  rendering every RACI column. */}
      {rows.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="search"
            aria-label="Search decisions" placeholder="Search decisions, decider, escalation..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              flex: '1 1 280px', maxWidth: 420,
              fontSize: 13, padding: '6px 10px',
              border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
              background: 'var(--color-surface)',
            }}
          />
          <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
            <button onClick={expandAll}  style={textBtnStyle}>Expand all</button>
            <span style={{ color: 'var(--color-border)' }}>·</span>
            <button onClick={collapseAll} style={textBtnStyle}>Collapse all</button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
            {filteredRows.length} of {rows.length} decisions
            {categoryFilter !== 'ALL' && ` · ${CATEGORY_LABELS[categoryFilter]}`}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete Decision Right?"
        message="This will permanently delete this decision right entry."
        confirmLabel="Delete"
        onConfirm={async () => { const id = confirmDelete; setConfirmDelete(null); if (id) await handleDelete(id); }}
        onCancel={() => setConfirmDelete(null)}
      />

      {/* Add/Edit Form */}
      {showForm && (
        <Card padding={20} marginBottom={20}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>{editingId ? 'Edit Decision Right' : 'Add Decision Right'}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Decision *</label>
              <input
                autoFocus
                aria-label="Decision"
                style={inputStyle}
                value={form.decision}
                onChange={(e) => setForm({ ...form, decision: e.target.value })}
                placeholder="e.g. Approve a new data policy"
              />
            </div>
            <div>
              <label style={labelStyle}>Category</label>
              <select
                aria-label="Category"
                style={selectStyle}
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value as DecisionCategory })}
              >
                {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Decider Type</label>
              <div style={{ display: 'flex', gap: 12, paddingTop: 6 }}>
                {(['PERSON', 'ROLE', 'GROUP'] as DeciderType[]).map((t) => (
                  <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="deciderType"
                      checked={form.deciderType === t}
                      onChange={() => setForm({ ...form, deciderType: t, decider: '' })}
                    />
                    {t.charAt(0) + t.slice(1).toLowerCase()}
                  </label>
                ))}
              </div>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Description</label>
              <textarea
                aria-label="Description"
                style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="What this decision entails..."
              />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Decider ({form.deciderType.toLowerCase()})</label>
              <select
                aria-label="Decider"
                style={selectStyle}
                value={form.decider}
                onChange={(e) => setForm({ ...form, decider: e.target.value })}
              >
                <option value="">-- Select --</option>
                {deciderOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Recommends</label>
              <MultiSelect
                options={allParticipantOptions}
                value={form.recommends}
                onChange={(next) => setForm({ ...form, recommends: next })}
              />
            </div>
            <div>
              <label style={labelStyle}>Approves</label>
              <MultiSelect
                options={allParticipantOptions}
                value={form.approves}
                onChange={(next) => setForm({ ...form, approves: next })}
              />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Informed</label>
              <MultiSelect
                options={allParticipantOptions}
                value={form.informed}
                onChange={(next) => setForm({ ...form, informed: next })}
              />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Escalation Path</label>
              <textarea
                aria-label="Escalation Path"
                style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
                value={form.escalationPath}
                onChange={(e) => setForm({ ...form, escalationPath: e.target.value })}
                placeholder="Describe how this decision escalates if not resolved..."
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={closeForm}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!form.decision.trim()}
              onClick={handleSave}
            >
              {editingId ? 'Save Changes' : 'Add Decision Right'}
            </Button>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={confirmBulkDelete}
        title={`Delete ${sel.count} decision right${sel.count === 1 ? '' : 's'}?`}
        message="This cannot be undone."
        confirmLabel={`Delete ${sel.count}`}
        onConfirm={async () => { setConfirmBulkDelete(false); await handleBulkDelete(); }}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      <BulkActionBar count={sel.count} onClear={sel.clear}>
        <BulkActionButton variant="danger" onClick={() => setConfirmBulkDelete(true)}>Delete selected</BulkActionButton>
      </BulkActionBar>

      {/* Full-width content — Categories is now a top facet (was a left-rail
       *  tree) so it matches the chip filters used across the app. */}
      <div>
        {rows.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {([
              { key: 'ALL' as 'ALL' | DecisionCategory, label: 'All', count: rows.length },
              ...CATEGORIES.map((c) => ({ key: c as 'ALL' | DecisionCategory, label: CATEGORY_LABELS[c], count: categoryCounts[c] || 0 })),
            ]).filter((o) => o.key === 'ALL' || o.count > 0).map((o) => {
              const active = categoryFilter === o.key;
              return (
                <button
                  key={o.key}
                  onClick={() => setCategoryFilter(o.key === 'ALL' ? 'ALL' : (active ? 'ALL' : o.key))}
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
        )}

        <div style={{ background: 'var(--color-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', overflow: 'auto' }}>
          {loadError ? (
            <ErrorState message={loadError} onRetry={() => { setLoadError(null); setLoading(true); fetchData(); }} />
          ) : loading ? (
            <SkeletonRows rows={5} columns={6} />
          ) : rows.length === 0 && !showForm ? (
            <EmptyState
              icon={renderNavIcon('/decision-rights')}
              title="No decision rights defined yet"
              description="Decision rights document who has authority to decide, recommend, approve, and be informed for governance decisions. Start by seeding the standard set or add your own."
              action={canWrite ? { label: 'Seed Standard Decisions', onClick: handleSeed } : undefined}
            />
          ) : filteredRows.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
              {searchQuery.trim() ? 'No decisions match your search.' : 'No decisions match the selected category.'}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <DataTable
                rows={sorted}
                columns={decisionColumns}
                rowKey={(r) => r.id}
                selection={sel}
                sort={{ sortKey, sortDir, onSort: toggleSort }}
                expansion={{
                  expandedIds,
                  onToggleExpanded: toggleExpand,
                  renderExpandedRow: (r) => (
                    <div style={{ padding: '12px 18px 16px' }}>
                      <ExpandedRaciDetails
                        row={r}
                        people={people}
                        groups={groups}
                        showRecommends={decisionCols.isVisible('recommends')}
                        showApproves={decisionCols.isVisible('approves')}
                        showInformed={decisionCols.isVisible('informed')}
                        showEscalation={decisionCols.isVisible('escalation')}
                      />
                    </div>
                  ),
                }}
                selectAllLabel="Select all decision rights"
                emptyMessage="No decisions match the current filters."
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
