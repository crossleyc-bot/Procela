import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PersonPicker from '../../components/PersonPicker';
import { GOVERNANCE_ROLES } from '../../types';
import { inputStyle, ROLE_OPTIONS, type SystemRef } from '../ProcessCatalogPage';
import { clickable } from '../../lib/a11y';

// ── Inline Edit ──

export function InlineEdit({ value, onSave, fontSize = 13, fontWeight = 400, placeholder = 'Click to edit...', disabled = false }: {
  value: string; onSave: (v: string) => void; fontSize?: number; fontWeight?: number; placeholder?: string; disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing || disabled) {
    return (
      <span {...clickable(() => { setDraft(value); setEditing(true); }, { label: 'Edit field', disabled })}
        style={{ cursor: disabled ? 'default' : 'pointer', fontSize, fontWeight, opacity: disabled ? 0.7 : 1 }}
        title={disabled ? 'Locked — change status to Draft to edit' : 'Click to edit'}>
        {value || <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>{placeholder}</span>}
      </span>
    );
  }
  return (
    <div>
      <input autoFocus aria-label="Value" style={{ ...inputStyle, fontSize, fontWeight, width: '100%' }} value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft.trim() && draft !== value) onSave(draft.trim()); setEditing(false); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { if (draft.trim() && draft !== value) onSave(draft.trim()); setEditing(false); }
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <div style={{ fontSize: 9, color: 'var(--color-text-muted)', marginTop: 1 }}>Enter to save &middot; Esc to cancel</div>
    </div>
  );
}

// ── Documentation Field (label + inline edit in a compact row) ──

export function DocField({ label, value, onSave, disabled, placeholder }: {
  label: string; value: string; onSave: (v: string) => void; disabled: boolean; placeholder: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(false);
  const doSave = () => {
    if (draft !== value) { onSave(draft); setSaved(true); setTimeout(() => setSaved(false), 1500); }
    setEditing(false);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11 }}>
      <span style={{ color: 'var(--color-text-muted)', fontWeight: 500, minWidth: 100, flexShrink: 0 }}>{label}:</span>
      {editing && !disabled ? (
        <div style={{ flex: 1 }}>
          <input autoFocus aria-label={label} style={{ ...inputStyle, fontSize: 11, padding: '2px 6px', width: '100%' }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={doSave}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doSave();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
          <div style={{ fontSize: 8, color: 'var(--color-text-muted)', marginTop: 1 }}>Enter to save &middot; Esc to cancel</div>
        </div>
      ) : (
        <>
          <span
            {...clickable(() => { setDraft(value); setEditing(true); }, { label: `Edit ${label}`, disabled })}
            style={{ cursor: disabled ? 'default' : 'pointer', color: value ? 'var(--color-text)' : 'var(--color-text-muted)', fontStyle: value ? 'normal' : 'italic', opacity: disabled ? 0.6 : 1 }}
            title={disabled ? 'Locked' : 'Click to edit'}
          >
            {value || placeholder}
          </span>
          {saved && <span style={{ color: 'var(--color-success)', fontSize: 9, fontWeight: 600 }}>Saved</span>}
        </>
      )}
    </div>
  );
}

// ── Documentation Dropdown (single select from predefined list) ──

export function DocDropdown({ label, value, options, onSave, disabled, placeholder }: {
  label: string; value: string; options: string[]; onSave: (v: string) => void; disabled: boolean; placeholder: string;
}) {
  const [saved, setSaved] = useState(false);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
      <span style={{ color: 'var(--color-text-muted)', fontWeight: 500, minWidth: 100, flexShrink: 0 }}>{label}:</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => { onSave(e.target.value); setSaved(true); setTimeout(() => setSaved(false), 1500); }}
        disabled={disabled}
        style={{
          fontSize: 11, border: `1px solid ${saved ? '#22c55e' : 'var(--color-border)'}`, borderRadius: 4,
          background: saved ? '#f0fdf4' : 'var(--color-surface)', cursor: disabled ? 'default' : 'pointer',
          color: value ? 'var(--color-text)' : 'var(--color-text-muted)', padding: '2px 6px',
          opacity: disabled ? 0.6 : 1, transition: 'border-color 0.2s, background 0.2s',
        }}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {saved && <span style={{ color: 'var(--color-success)', fontSize: 9, fontWeight: 600 }}>Saved</span>}
    </div>
  );
}

// ── Criticality Tier + RTO Hours — BCM attributes on activities.
//    Tier maps between the stored enum ("TIER_1") and the display
//    label ("Tier 1 — Mission critical"); RTO stores hours as a
//    number. Both accept null / empty to clear. ──

const TIER_LABELS: Record<string, string> = {
  '': 'Not rated',
  TIER_1: 'Tier 1 — Mission critical',
  TIER_2: 'Tier 2 — Business critical',
  TIER_3: 'Tier 3 — Standard',
  TIER_4: 'Tier 4 — Non-critical',
};

export function TierField({ value, onSave, disabled }: {
  value: string;
  onSave: (v: string) => void;
  disabled: boolean;
}) {
  const [saved, setSaved] = useState(false);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
      <span style={{ color: 'var(--color-text-muted)', fontWeight: 500, minWidth: 100, flexShrink: 0 }}>Criticality:</span>
      <select
        aria-label="Criticality"
        value={value}
        onChange={(e) => { onSave(e.target.value); setSaved(true); setTimeout(() => setSaved(false), 1500); }}
        disabled={disabled}
        style={{ ...inputStyle, fontSize: 11, padding: '2px 6px', width: 260, appearance: 'auto' as any }}
      >
        {Object.entries(TIER_LABELS).map(([v, label]) => (
          <option key={v} value={v}>{label}</option>
        ))}
      </select>
      {saved && <span style={{ color: 'var(--color-success)', fontSize: 9, fontWeight: 600 }}>Saved</span>}
    </div>
  );
}

export function RtoField({ value, onSave, disabled }: {
  value: number | undefined;
  onSave: (v: number | null) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<string>(value !== undefined ? String(value) : '');
  const [saved, setSaved] = useState(false);
  useEffect(() => { setDraft(value !== undefined ? String(value) : ''); }, [value]);
  const commit = () => {
    if (draft.trim() === '') {
      if (value !== undefined) { onSave(null); setSaved(true); setTimeout(() => setSaved(false), 1500); }
      return;
    }
    const n = Number(draft);
    if (!Number.isFinite(n) || n < 0) { setDraft(value !== undefined ? String(value) : ''); return; }
    if (n !== value) { onSave(n); setSaved(true); setTimeout(() => setSaved(false), 1500); }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
      <span style={{ color: 'var(--color-text-muted)', fontWeight: 500, minWidth: 100, flexShrink: 0 }}>RTO (hours):</span>
      <input
        type="number"
        aria-label="RTO (hours)"
        min={0}
        step={0.5}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        disabled={disabled}
        placeholder="e.g. 4"
        style={{ ...inputStyle, fontSize: 11, padding: '2px 6px', width: 90 }}
      />
      {saved && <span style={{ color: 'var(--color-success)', fontSize: 9, fontWeight: 600 }}>Saved</span>}
    </div>
  );
}

export function RpoField({ value, onSave, disabled }: {
  value: number | undefined;
  onSave: (v: number | null) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<string>(value !== undefined ? String(value) : '');
  const [saved, setSaved] = useState(false);
  useEffect(() => { setDraft(value !== undefined ? String(value) : ''); }, [value]);
  const commit = () => {
    if (draft.trim() === '') {
      if (value !== undefined) { onSave(null); setSaved(true); setTimeout(() => setSaved(false), 1500); }
      return;
    }
    const n = Number(draft);
    if (!Number.isFinite(n) || n < 0) { setDraft(value !== undefined ? String(value) : ''); return; }
    if (n !== value) { onSave(n); setSaved(true); setTimeout(() => setSaved(false), 1500); }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
      <span style={{ color: 'var(--color-text-muted)', fontWeight: 500, minWidth: 100, flexShrink: 0 }}>RPO (hours):</span>
      <input
        type="number"
        aria-label="RPO (hours)"
        min={0}
        step={0.5}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        disabled={disabled}
        placeholder="e.g. 1"
        style={{ ...inputStyle, fontSize: 11, padding: '2px 6px', width: 90 }}
        title="Recovery Point Objective — how much data loss (in time) is tolerable"
      />
      {saved && <span style={{ color: 'var(--color-success)', fontSize: 9, fontWeight: 600 }}>Saved</span>}
    </div>
  );
}

// ── Controls Picker — multi-select for the governance controls this
//    activity implements or is subject to. Options come from the
//    governance-controls store; selection is stored as controlIds on
//    the node. ──

export function ControlsPicker({ selected, options, onChange, disabled }: {
  selected: string[];
  options: Array<{ id: string; code: string; name: string; policyId: string }>;
  onChange: (ids: string[]) => void;
  disabled: boolean;
}) {
  const [adding, setAdding] = useState('');
  const toggle = (id: string) => onChange(selected.filter((x) => x !== id));
  const optionById = new Map(options.map((o) => [o.id, o]));
  const add = (id: string) => {
    if (!id || selected.includes(id)) return;
    onChange([...selected, id]);
    setAdding('');
  };
  const available = options.filter((o) => !selected.includes(o.id));

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11 }}>
      <span style={{ color: 'var(--color-text-muted)', fontWeight: 500, minWidth: 100, flexShrink: 0, paddingTop: 3 }}>Controls:</span>
      <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
        {selected.map((id) => {
          const opt = optionById.get(id);
          if (!opt) {
            return (
              <span key={id} title="Referenced control has been deleted" style={{ background: '#fef3c7', border: '1px solid #fbbf24', color: '#92400e', padding: '1px 6px', borderRadius: 3, fontSize: 10 }}>
                Unknown control
                {!disabled && (
                  <button onClick={() => toggle(id)} aria-label="Remove control" style={{ background: 'transparent', border: 'none', color: '#92400e', cursor: 'pointer', marginLeft: 4, padding: 0 }}><span aria-hidden="true">×</span></button>
                )}
              </span>
            );
          }
          return (
            <span key={id} title={opt.name} style={{ background: '#e0e7ff', color: '#3730a3', padding: '1px 6px', borderRadius: 3, fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <strong>{opt.code}</strong> {opt.name}
              {!disabled && (
                <button onClick={() => toggle(id)} aria-label={`Remove ${opt.name}`} style={{ background: 'transparent', border: 'none', color: '#3730a3', cursor: 'pointer', padding: 0 }}><span aria-hidden="true">×</span></button>
              )}
            </span>
          );
        })}
        {selected.length === 0 && <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>None</span>}
        {!disabled && (
          available.length > 0 ? (
            <select
              aria-label="Add control"
              value={adding}
              onChange={(e) => add(e.target.value)}
              style={{ fontSize: 10, padding: '2px 4px', border: '1px solid var(--color-border)', borderRadius: 3, background: 'var(--color-surface)' }}
            >
              <option value="">+ Add control…</option>
              {available.map((o) => (
                <option key={o.id} value={o.id}>{o.code} — {o.name}</option>
              ))}
            </select>
          ) : (
            options.length === 0 && <span style={{ color: 'var(--color-text-muted)', fontSize: 9, fontStyle: 'italic' }}>Define controls on Governance Documents first</span>
          )
        )}
      </div>
    </div>
  );
}

// ── Person field — inline label + shared PersonPicker. Replaces the
//    flat name-only Owner dropdown / Stakeholders multiselect so users
//    get org-tree / group / search context and name disambiguation.
//    Owner stores ownerId (valueMode="id"); Stakeholders keeps the
//    legacy comma-joined *name* string (valueMode="name") so no data
//    migration is needed. ──

export function DocPersonField({ label, mode, valueMode, value, onChange, disabled, domain, eligibleKeys, disabledHint, disabledHintLink, placeholder, orgId }: {
  label: string;
  mode: 'single' | 'multi';
  valueMode: 'id' | 'name';
  value: string | string[] | null;
  onChange: (v: any) => void;
  disabled: boolean;
  domain?: 'GOVERNANCE' | 'OPERATIONAL';
  /** Scope the picker to this org's tree (the active "Working in…" org).
   *  Without it the picker lists every person the caller can see — which
   *  for a super-admin spans sibling tenants. */
  orgId?: string;
  /** If provided, restrict the picker's options to these keys (ids or
   *  names, matching valueMode). Used to gate selection to role-holders
   *  on governance work. */
  eligibleKeys?: Set<string>;
  /** Hint rendered next to the picker when `disabled` is true — e.g.
   *  explains why a Responsible Person picker is locked until a role
   *  is set or until someone holds that role. */
  disabledHint?: string;
  /** Optional in-place link rendered next to the disabled hint so the
   *  user can resolve the gap (open Governance Roles, etc.) without
   *  hunting through the sidebar. */
  disabledHintLink?: { to: string; label: string };
  /** Overrides the default trigger placeholder. */
  placeholder?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11 }}>
      <span style={{ color: 'var(--color-text-muted)', fontWeight: 500, minWidth: 100, flexShrink: 0, paddingTop: 7 }}>{label}:</span>
      <div style={{ flex: 1, maxWidth: 320 }}>
        <PersonPicker
          mode={mode}
          valueMode={valueMode}
          value={value}
          onChange={onChange}
          disabled={disabled}
          domain={domain}
          eligibleKeys={eligibleKeys}
          orgId={orgId}
          placeholder={placeholder || (mode === 'single' ? 'Select owner…' : 'Select stakeholders…')}
        />
        {disabled && (disabledHint || disabledHintLink) && (
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 3, fontStyle: 'italic' }}>
            {disabledHint}
            {disabledHintLink && (
              <>
                {disabledHint ? ' ' : ''}
                <Link to={disabledHintLink.to} style={{ color: 'var(--color-primary)', textDecoration: 'underline', fontStyle: 'normal', fontWeight: 500 }}>
                  {disabledHintLink.label} →
                </Link>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Domain-scoped Responsible Role selector ──
// Governance nodes only offer the DAMA governance roles; operational
// nodes offer the generic business roles. A "show all" toggle reveals
// the other set for genuine cross-overs; picking a role from the other
// domain tags the field with a visible cross-domain marker. A legacy
// free-text value that's in neither catalog is preserved as a selectable
// option until the user re-picks.
export function DocRoleField({ value, onSave, disabled, domain }: {
  value: string;
  onSave: (v: string) => void;
  disabled: boolean;
  domain: 'GOVERNANCE' | 'OPERATIONAL';
}) {
  const [showAll, setShowAll] = useState(false);
  const govLabels = GOVERNANCE_ROLES.map((r) => r.label);
  const primary = domain === 'GOVERNANCE' ? govLabels : ROLE_OPTIONS;
  const secondary = domain === 'GOVERNANCE' ? ROLE_OPTIONS : govLabels;

  const inPrimary = !!value && primary.includes(value);
  const inSecondary = !!value && secondary.includes(value);
  const isLegacy = !!value && !inPrimary && !inSecondary;
  // Auto-reveal the full set if the saved value belongs to the other
  // domain (or is legacy) so it stays visible and editable.
  const effectiveShowAll = showAll || inSecondary || isLegacy;

  const options = [
    ...primary,
    ...(effectiveShowAll ? secondary : []),
    ...(isLegacy ? [value] : []),
  ];
  const crossDomain = inSecondary;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, flexWrap: 'wrap' }}>
      <span style={{ color: 'var(--color-text-muted)', fontWeight: 500, minWidth: 100, flexShrink: 0 }}>Responsible Role:</span>
      <select
        aria-label="Responsible Role"
        value={value}
        onChange={(e) => onSave(e.target.value)}
        disabled={disabled}
        style={{
          fontSize: 11, border: '1px solid var(--color-border)', borderRadius: 4,
          background: 'var(--color-surface)', cursor: disabled ? 'default' : 'pointer',
          color: value ? 'var(--color-text)' : 'var(--color-text-muted)', padding: '2px 6px',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <option value="">Select role...</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {crossDomain && (
        <span title="This role is outside this process's domain"
          style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3, background: '#fef3c7', color: '#92400e', textTransform: 'uppercase' }}>
          Cross-domain
        </span>
      )}
      {/* Two-way toggle between the primary (domain-matching) role set
         and the full set. The "less" direction is suppressed when the
         currently-saved value lives in the secondary set or is legacy —
         collapsing would hide it from the dropdown. */}
      {!disabled && !effectiveShowAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: 'var(--color-primary)', padding: 0, textDecoration: 'underline' }}
        >
          show all roles
        </button>
      )}
      {!disabled && effectiveShowAll && !inSecondary && !isLegacy && (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: 'var(--color-primary)', padding: 0, textDecoration: 'underline' }}
        >
          show {domain === 'GOVERNANCE' ? 'governance' : 'business'} roles only
        </button>
      )}
    </div>
  );
}

// ── Documentation Multi-Select (chips with add dropdown) ──

export function DocMultiSelect({ label, selected, options, onSave, disabled, placeholder }: {
  label: string; selected: string[]; options: string[]; onSave: (vals: string[]) => void; disabled: boolean; placeholder: string;
}) {
  const available = options.filter((o) => !selected.includes(o));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11 }}>
      <span style={{ color: 'var(--color-text-muted)', fontWeight: 500, minWidth: 100, flexShrink: 0, paddingTop: 2 }}>{label}:</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center', flex: 1 }}>
        {selected.map((v) => (
          <span key={v} style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '1px 6px', borderRadius: 10, fontSize: 10, fontWeight: 500,
            background: '#dbeafe', color: '#1e40af', border: '1px solid #93c5fd',
          }}>
            {v}
            {!disabled && (
              <button onClick={() => onSave(selected.filter((s) => s !== v))}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: '#1e40af', padding: 0, lineHeight: 1 }}>&times;</button>
            )}
          </span>
        ))}
        {!disabled && available.length > 0 && (
          <select
            aria-label={`Add ${label}`}
            value=""
            onChange={(e) => { if (e.target.value) onSave([...selected, e.target.value]); }}
            style={{
              fontSize: 10, border: '1px solid var(--color-border)', borderRadius: 4,
              background: 'var(--color-surface)', cursor: 'pointer',
              color: 'var(--color-text-muted)', padding: '2px 6px',
            }}
          >
            <option value="">{selected.length === 0 ? placeholder : '+ Add...'}</option>
            {available.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
        {!disabled && available.length === 0 && selected.length === 0 && (
          <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic', fontSize: 10 }}>No options available</span>
        )}
        {selected.length === 0 && disabled && (
          <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic', opacity: 0.6 }}>{placeholder}</span>
        )}
      </div>
    </div>
  );
}

// ── Systems picker — selects from registered Systems by id ─────────────────
// Distinct from DocMultiSelect because options are id/name pairs, not
// flat strings. Same visual treatment so it nests naturally with the
// other Doc* fields in the node panel.
export function DocSystemsField({ selected, options, onSave, disabled }: {
  selected: string[]; options: SystemRef[]; onSave: (ids: string[]) => void; disabled: boolean;
}) {
  const byId = new Map(options.map((o) => [o.id, o]));
  const available = options.filter((o) => !selected.includes(o.id));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11 }}>
      <span style={{ color: 'var(--color-text-muted)', fontWeight: 500, minWidth: 100, flexShrink: 0, paddingTop: 2 }}>Systems:</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center', flex: 1 }}>
        {selected.map((id) => {
          const s = byId.get(id);
          return (
            <span key={id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding: '1px 6px', borderRadius: 10, fontSize: 10, fontWeight: 500,
              background: '#dbeafe', color: '#1e40af', border: '1px solid #93c5fd',
            }}>
              <Link to={`/systems?highlight=${id}`} title={`Open ${s?.name || 'system'}`}
                style={{ color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 2 }}>
                {s?.name || id}
              </Link>
              {!disabled && (
                <button onClick={() => onSave(selected.filter((sid) => sid !== id))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: '#1e40af', padding: 0, lineHeight: 1 }}>&times;</button>
              )}
            </span>
          );
        })}
        {!disabled && available.length > 0 && (
          <select
            aria-label="Add system"
            value=""
            onChange={(e) => { if (e.target.value) onSave([...selected, e.target.value]); }}
            style={{
              fontSize: 10, border: '1px solid var(--color-border)', borderRadius: 4,
              background: 'var(--color-surface)', cursor: 'pointer',
              color: 'var(--color-text-muted)', padding: '2px 6px',
            }}
          >
            <option value="">{selected.length === 0 ? 'Pick systems this runs on...' : '+ Add system'}</option>
            {available.map((o) => <option key={o.id} value={o.id}>{o.name}{o.systemType ? ` (${o.systemType})` : ''}</option>)}
          </select>
        )}
        {selected.length === 0 && disabled && (
          <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic', opacity: 0.6 }}>No systems linked</span>
        )}
      </div>
    </div>
  );
}
