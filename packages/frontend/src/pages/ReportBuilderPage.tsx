import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiClient } from '../api/client';
import { errorMessage } from '../lib/errorToast';
import { useOrgContext } from '../stores/orgContext';
import { useToastStore } from '../stores/toastStore';
import Page from '../components/Page';
import PageHeader from '../components/PageHeader';
import Spinner from '../components/Spinner';
import ExportMenu from '../components/ExportMenu';
import type { Cell, ExportPayload } from '../lib/export';

// ──────────────────────────────────────────────────────────────────────────
// Report Builder — Phase 2 of the Reports rebuild.
//
// Three sections, top-down:
//   1. Setup    — pick the primary entity (drives everything below).
//   2. Columns  — multi-select of direct + joined fields from the LDM.
//   3. Filters  — direct-field filters with op + value.
//   4. Preview  — live `POST /reports/preview` against the current spec.
//   5. Save     — name + description + visibility + persist.
//
// New mode lives at /reports/builder; edit mode at /reports/builder/:id.
// ──────────────────────────────────────────────────────────────────────────

interface LdmField {
  id: string;
  label: string;
  description: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'enum' | 'id';
  enumValues?: string[];
  filterable?: boolean;
  groupable?: boolean;
  advanced?: boolean;
}
interface LdmRelationship {
  id: string;
  label: string;
  description: string;
  target: string;
  via: string;
  cardinality: 'one' | 'many';
}
interface LdmEntity {
  id: string;
  label: string;
  singular: string;
  description: string;
  nameField: string;
  fields: LdmField[];
  relationships: LdmRelationship[];
}

type FilterOp =
  | 'eq' | 'ne' | 'in' | 'contains'
  | 'gt' | 'lt' | 'gte' | 'lte'
  | 'isNull' | 'isNotNull';

interface ReportColumn { field: string; label?: string }
interface ReportFilter { field: string; op: FilterOp; value?: string | number | boolean }
interface ReportSort   { field: string; direction: 'asc' | 'desc' }

interface ReportDefinition {
  entity: string;
  columns: ReportColumn[];
  filters: ReportFilter[];
  sort?: ReportSort;
  limit?: number;
}

interface ReportSchedule {
  frequency: 'off' | 'weekly';
  recipients: string[];
}

interface StoredReport {
  id: string; orgId: string; name: string; description: string;
  ownerId: string | null; visibility: 'private' | 'org';
  definition: ReportDefinition;
  schedule?: ReportSchedule | null;
  createdAt: string; updatedAt: string;
}

interface RunResult {
  columns: Array<{ field: string; label: string }>;
  rows: Array<Record<string, unknown>>;
  totalMatched: number;
}

const cardStyle: React.CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  padding: 16,
  marginBottom: 16,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--color-text-secondary)',
  marginBottom: 6, display: 'block',
};

const inputStyle: React.CSSProperties = {
  fontSize: 13, padding: '6px 10px',
  border: '1px solid var(--color-border)', borderRadius: 4,
  background: 'var(--color-surface)',
};

const FILTER_OPS: Array<{ value: FilterOp; label: string; takesValue: boolean }> = [
  { value: 'eq',         label: 'equals',          takesValue: true },
  { value: 'ne',         label: 'does not equal',  takesValue: true },
  { value: 'contains',   label: 'contains',        takesValue: true },
  { value: 'gt',         label: 'greater than',    takesValue: true },
  { value: 'gte',        label: 'greater or equal',takesValue: true },
  { value: 'lt',         label: 'less than',       takesValue: true },
  { value: 'lte',        label: 'less or equal',   takesValue: true },
  { value: 'isNull',     label: 'is empty',        takesValue: false },
  { value: 'isNotNull',  label: 'is not empty',    takesValue: false },
];

export default function ReportBuilderPage() {
  const navigate = useNavigate();
  const { id: reportId } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const cloneFrom = searchParams.get('cloneFrom');
  const { activeOrgId } = useOrgContext();
  const addToast = useToastStore((s) => s.addToast);

  const [entities, setEntities] = useState<LdmEntity[]>([]);
  const [entitiesLoaded, setEntitiesLoaded] = useState(false);

  // Saved-report metadata (only meaningful in edit mode).
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'org'>('org');

  // The live spec.
  const [def, setDef] = useState<ReportDefinition>({
    entity: '',
    columns: [],
    filters: [],
  });

  const [preview, setPreview] = useState<RunResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Scheduled email delivery (edit mode only — an unsaved report can't be
  // scheduled). `scheduleOn` toggles frequency weekly/off; recipients is a
  // comma/newline-separated textarea parsed on save.
  const [scheduleOn, setScheduleOn] = useState(false);
  const [scheduleRecipients, setScheduleRecipients] = useState('');

  // Load LDM up front.
  useEffect(() => {
    apiClient.get<{ success: boolean; data: { version: string; entities: LdmEntity[] } }>('/data-model')
      .then((r) => { setEntities(r.data.entities); })
      .catch(() => { addToast('error', 'Failed to load the data model.'); })
      .finally(() => setEntitiesLoaded(true));
  }, [addToast]);

  // Load an existing report (edit) or a clone source (new from clone).
  useEffect(() => {
    const sourceId = reportId || cloneFrom;
    if (!sourceId || !entitiesLoaded) return;
    apiClient.get<{ success: boolean; data: StoredReport }>(`/reports/${sourceId}`)
      .then((r) => {
        const src = r.data;
        setDef(src.definition);
        if (reportId) {
          setName(src.name);
          setDescription(src.description);
          setVisibility(src.visibility);
          setScheduleOn(src.schedule?.frequency === 'weekly');
          setScheduleRecipients((src.schedule?.recipients || []).join(', '));
        } else {
          setName(`Copy of ${src.name}`);
          setDescription(src.description);
          setVisibility(src.visibility);
        }
      })
      .catch(() => addToast('error', 'Failed to load the report.'));
  }, [reportId, cloneFrom, entitiesLoaded, addToast]);

  const entity = useMemo(() => entities.find((e) => e.id === def.entity) || null, [entities, def.entity]);

  // ── Live preview ───────────────────────────────────────────────────────
  // Run a preview whenever the spec changes meaningfully. Debounced so we
  // don't hammer the server when the user is typing in a filter value.
  useEffect(() => {
    if (!activeOrgId || !def.entity || def.columns.length === 0) {
      setPreview(null); setPreviewError(null);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const res = await apiClient.post<{ success: boolean; data: RunResult }>(`/reports/preview`, {
          orgId: activeOrgId, definition: { ...def, limit: 50 },
        });
        setPreview(res.data); setPreviewError(null);
      } catch (err: any) {
        setPreviewError(err?.response?.data?.error || 'Preview failed');
        setPreview(null);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [def, activeOrgId]);

  // ── Spec mutators ──────────────────────────────────────────────────────
  const pickEntity = (entityId: string) => {
    setDef({
      entity: entityId,
      // Seed with the canonical name column so the empty state isn't useless.
      columns: entityId
        ? [{ field: entities.find((e) => e.id === entityId)?.nameField || 'name' }]
        : [],
      filters: [],
    });
  };

  const toggleColumn = (fieldId: string) => {
    setDef((d) => {
      const has = d.columns.some((c) => c.field === fieldId);
      return {
        ...d,
        columns: has
          ? d.columns.filter((c) => c.field !== fieldId)
          : [...d.columns, { field: fieldId }],
      };
    });
  };

  const addFilter = () => {
    if (!entity) return;
    const first = entity.fields.find((f) => f.filterable !== false);
    if (!first) return;
    setDef((d) => ({ ...d, filters: [...d.filters, { field: first.id, op: 'eq', value: '' }] }));
  };

  const updateFilter = (idx: number, patch: Partial<ReportFilter>) => {
    setDef((d) => ({
      ...d,
      filters: d.filters.map((f, i) => (i === idx ? { ...f, ...patch } : f)),
    }));
  };

  const removeFilter = (idx: number) => {
    setDef((d) => ({ ...d, filters: d.filters.filter((_, i) => i !== idx) }));
  };

  const setSort = (field: string, direction: 'asc' | 'desc' | '') => {
    setDef((d) => ({
      ...d,
      sort: direction === '' ? undefined : { field, direction },
    }));
  };

  // ── Save ───────────────────────────────────────────────────────────────
  const canSave = activeOrgId && name.trim() && def.entity && def.columns.length > 0;

  const save = useCallback(async () => {
    if (!canSave || !activeOrgId) return;
    setSaving(true);
    try {
      if (reportId) {
        const recipients = scheduleRecipients.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
        const schedule = scheduleOn
          ? { frequency: 'weekly', recipients }
          : { frequency: 'off', recipients };
        const res = await apiClient.put<{ success: boolean; data: StoredReport }>(`/reports/${reportId}`, {
          name: name.trim(), description: description.trim(), visibility, definition: def, schedule,
        });
        addToast('success', `Saved "${res.data.name}".`);
      } else {
        const res = await apiClient.post<{ success: boolean; data: StoredReport }>('/reports', {
          orgId: activeOrgId, name: name.trim(), description: description.trim(), visibility, definition: def,
        });
        addToast('success', `Created "${res.data.name}".`);
        navigate(`/reports/builder/${res.data.id}`, { replace: true });
      }
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      addToast('error', e?.response?.data?.error || errorMessage(err, 'Save failed.'));
    } finally {
      setSaving(false);
    }
  }, [canSave, activeOrgId, reportId, name, description, visibility, def, scheduleOn, scheduleRecipients, addToast, navigate]);

  // ── Export ───────────────────────────────────────────────────────────────
  // The on-screen preview is capped at 50 rows; an export must carry the whole
  // result set. So the builder re-runs the current spec at the server's hard
  // cap (10 000) at click time — no separate saved report needed — and maps
  // the rendered rows straight into the shared export payload. Async so the
  // ExportMenu shows its busy state while the fetch runs.
  const buildExport = useCallback(async (): Promise<ExportPayload | null> => {
    if (!activeOrgId || !def.entity || def.columns.length === 0) return null;
    const res = await apiClient.post<{ success: boolean; data: RunResult }>(`/reports/preview`, {
      orgId: activeOrgId, definition: { ...def, limit: 10_000 },
    });
    const result = res.data;
    if (result.rows.length === 0) {
      addToast('info', 'No rows match the current filters — nothing to export.');
      return null;
    }
    if (result.totalMatched > result.rows.length) {
      addToast('info', `Export capped at ${result.rows.length.toLocaleString()} of ${result.totalMatched.toLocaleString()} matched rows.`);
    }
    const headers = result.columns.map((c) => c.label);
    const rows: Cell[][] = result.rows.map((row) =>
      result.columns.map((c) => toExportCell(row[c.field])),
    );
    const base = (name.trim() || entity?.label || 'report')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
    return { filenameBase: base, headers, rows, sheetName: name.trim() || entity?.label || 'Report' };
  }, [activeOrgId, def, name, entity, addToast]);

  const canExport = Boolean(activeOrgId && def.entity && def.columns.length > 0);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <Page>
      <PageHeader
        title={reportId ? 'Edit Report' : 'New Report'}
        subtitle="Build a report against the Procela data model. Pick a starting entity, add columns and filters, preview live."
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Link to="/reports?tab=user" style={{ ...inputStyle, color: 'var(--color-text-secondary)', textDecoration: 'none', display: 'inline-block' }}>
              Cancel
            </Link>
            <button
              onClick={save}
              disabled={!canSave || saving}
              style={{
                ...inputStyle,
                background: canSave ? 'var(--color-primary)' : '#e5e7eb',
                color: canSave ? '#fff' : 'var(--color-text-muted)',
                fontWeight: 600, border: 'none', cursor: canSave ? 'pointer' : 'default',
              }}
            >
              {saving ? 'Saving…' : reportId ? 'Save changes' : 'Save report'}
            </button>
          </div>
        }
      />

      {/* Save metadata */}
      <div style={cardStyle}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 200px', gap: 12 }}>
          <div>
            <label style={labelStyle}>Name</label>
            <input
              aria-label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Activities by Risk Level"
              style={{ ...inputStyle, width: '100%' }}
            />
          </div>
          <div>
            <label style={labelStyle}>Description</label>
            <input
              aria-label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this report shows…"
              style={{ ...inputStyle, width: '100%' }}
            />
          </div>
          <div>
            <label style={labelStyle}>Visibility</label>
            <select
              aria-label="Visibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as 'private' | 'org')}
              style={{ ...inputStyle, width: '100%' }}
            >
              <option value="org">Shared with org</option>
              <option value="private">Private to me</option>
            </select>
          </div>
        </div>
      </div>

      {/* Scheduled delivery — edit mode only (an unsaved report can't be
          scheduled). Emails the rendered report (CSV attachment) to the
          listed recipients on the weekly sweep. */}
      {reportId && (
        <div style={cardStyle}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={scheduleOn}
              onChange={(e) => setScheduleOn(e.target.checked)}
            />
            Email this report weekly
          </label>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '4px 0 0 24px' }}>
            Delivered on the weekly sweep as a CSV attachment. Requires email to be configured for the deployment.
          </div>
          {scheduleOn && (
            <div style={{ marginTop: 10, marginLeft: 24 }}>
              <label style={labelStyle}>Recipients</label>
              <textarea
                aria-label="Schedule recipients"
                value={scheduleRecipients}
                onChange={(e) => setScheduleRecipients(e.target.value)}
                placeholder="alice@example.com, bob@example.com"
                rows={2}
                style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
              />
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
                Comma- or newline-separated email addresses.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Entity picker */}
      <div style={cardStyle}>
        <label style={labelStyle}>Starting entity</label>
        {!entitiesLoaded ? (
          <Spinner label="Loading…" />
        ) : (
          <select
            aria-label="Starting entity"
            value={def.entity}
            onChange={(e) => pickEntity(e.target.value)}
            style={{ ...inputStyle, minWidth: 280 }}
          >
            <option value="">— pick an entity —</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>{e.label}</option>
            ))}
          </select>
        )}
        {entity && (
          <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '8px 0 0' }}>{entity.description}</p>
        )}
      </div>

      {entity && (
        <>
          {/* Columns */}
          <div style={cardStyle}>
            <label style={labelStyle}>Columns</label>
            <p style={{ fontSize: 11, color: 'var(--color-text-muted)', margin: '0 0 10px' }}>
              Direct fields on {entity.singular}, plus joined fields via its relationships.
            </p>

            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>Fields</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {entity.fields.filter((f) => !f.advanced).map((f) => {
                  const selected = def.columns.some((c) => c.field === f.id);
                  return (
                    <button
                      key={f.id}
                      onClick={() => toggleColumn(f.id)}
                      title={f.description}
                      style={{
                        fontSize: 11, padding: '4px 10px', borderRadius: 12,
                        border: '1px solid ' + (selected ? 'var(--color-primary)' : 'var(--color-border)'),
                        background: selected ? 'var(--color-primary)' : 'var(--color-surface)',
                        color: selected ? '#fff' : 'var(--color-text)',
                        cursor: 'pointer',
                      }}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {entity.relationships.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>Joined fields</div>
                {entity.relationships.map((rel) => {
                  const targetEntity = entities.find((e) => e.id === rel.target);
                  if (!targetEntity) return null;
                  return (
                    <div key={rel.id} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 }}>
                        {rel.label} ({rel.cardinality === 'one' ? 'one' : 'many'})
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {targetEntity.fields.filter((f) => !f.advanced).map((f) => {
                          const fieldKey = `${rel.id}.${f.id}`;
                          const selected = def.columns.some((c) => c.field === fieldKey);
                          return (
                            <button
                              key={fieldKey}
                              onClick={() => toggleColumn(fieldKey)}
                              title={`${rel.label} → ${f.label}: ${f.description}`}
                              style={{
                                fontSize: 11, padding: '4px 10px', borderRadius: 12,
                                border: '1px solid ' + (selected ? 'var(--color-primary)' : 'var(--color-border)'),
                                background: selected ? 'var(--color-primary)' : 'var(--color-surface)',
                                color: selected ? '#fff' : 'var(--color-text)',
                                cursor: 'pointer',
                              }}
                            >
                              {f.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Filters */}
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>Filters</label>
              <button onClick={addFilter} style={{ ...inputStyle, padding: '4px 10px', cursor: 'pointer', background: 'var(--color-bg)' }}>
                + Add filter
              </button>
            </div>
            {def.filters.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>
                No filters. The report returns every {entity.singular} in this org.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {def.filters.map((f, idx) => {
                  const field = entity.fields.find((x) => x.id === f.field);
                  const opSpec = FILTER_OPS.find((o) => o.value === f.op);
                  return (
                    <div key={idx} style={{ display: 'grid', gridTemplateColumns: '200px 180px 1fr 32px', gap: 8 }}>
                      <select
                        aria-label="Filter field"
                        value={f.field}
                        onChange={(e) => updateFilter(idx, { field: e.target.value })}
                        style={inputStyle}
                      >
                        {entity.fields.filter((x) => x.filterable !== false).map((x) => (
                          <option key={x.id} value={x.id}>{x.label}</option>
                        ))}
                      </select>
                      <select
                        aria-label="Filter operator"
                        value={f.op}
                        onChange={(e) => updateFilter(idx, { op: e.target.value as FilterOp })}
                        style={inputStyle}
                      >
                        {FILTER_OPS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      {opSpec?.takesValue ? (
                        field?.type === 'enum' ? (
                          <select
                            aria-label="Filter value"
                            value={String(f.value ?? '')}
                            onChange={(e) => updateFilter(idx, { value: e.target.value })}
                            style={inputStyle}
                          >
                            <option value="">—</option>
                            {(field.enumValues || []).map((v) => (
                              <option key={v} value={v}>{v}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            aria-label="Filter value"
                            value={String(f.value ?? '')}
                            onChange={(e) => {
                              const raw = e.target.value;
                              const v = field?.type === 'number' || field?.type === 'integer'
                                ? (raw === '' ? '' : Number(raw))
                                : raw;
                              updateFilter(idx, { value: v });
                            }}
                            placeholder="value"
                            style={inputStyle}
                          />
                        )
                      ) : <div />}
                      <button onClick={() => removeFilter(idx)}
                        title="Remove filter"
                        style={{ ...inputStyle, cursor: 'pointer', background: 'var(--color-bg)' }}>×</button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Sort */}
          <div style={cardStyle}>
            <label style={labelStyle}>Sort by</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                aria-label="Sort field"
                value={def.sort?.field || ''}
                onChange={(e) => setSort(e.target.value, def.sort?.direction || 'asc')}
                style={inputStyle}
              >
                <option value="">— no sort —</option>
                {entity.fields.filter((x) => x.groupable !== false || x.id === entity.nameField).map((x) => (
                  <option key={x.id} value={x.id}>{x.label}</option>
                ))}
              </select>
              <select
                aria-label="Sort direction"
                value={def.sort?.direction || 'asc'}
                onChange={(e) => def.sort && setSort(def.sort.field, e.target.value as 'asc' | 'desc')}
                disabled={!def.sort}
                style={inputStyle}
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
              {def.sort && (
                <button onClick={() => setSort('', '')} style={{ ...inputStyle, background: 'var(--color-bg)', cursor: 'pointer' }}>
                  Clear sort
                </button>
              )}
            </div>
          </div>

          {/* Preview */}
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>Preview</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {preview && (
                  <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                    Showing {preview.rows.length} of {preview.totalMatched} rows
                  </span>
                )}
                <ExportMenu
                  build={buildExport}
                  disabled={!canExport}
                  label="Export report"
                  formats={['csv', 'xlsx', 'json', 'pdf', 'clipboard']}
                />
              </div>
            </div>

            {previewError && (
              <div style={{ fontSize: 12, color: '#b91c1c', padding: '8px 10px', background: '#fee2e2', borderRadius: 4 }}>
                {previewError}
              </div>
            )}

            {!previewError && (!preview || preview.rows.length === 0) && (
              <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>
                {def.columns.length === 0 ? 'Pick at least one column to preview.' : 'No rows match the current filters.'}
              </p>
            )}

            {preview && preview.rows.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--color-bg)' }}>
                      {preview.columns.map((c) => (
                        <th key={c.field} style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600, borderBottom: '1px solid var(--color-border)' }}>
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--color-border)' }}>
                        {preview.columns.map((c) => (
                          <td key={c.field} style={{ padding: '6px 10px' }}>
                            {formatCell(row[c.field])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </Page>
  );
}

function formatCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

// Map a rendered report cell to the export layer's Cell. Scalars pass through
// so numbers stay numeric in XLSX/JSON; arrays and objects flatten to text.
function toExportCell(v: unknown): Cell {
  if (v == null) return '';
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}
