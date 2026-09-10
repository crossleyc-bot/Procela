import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Check } from 'lucide-react';
import { apiClient } from '../api/client';
import { formatPersonLabel } from '../lib/personLabel';

// ──────────────────────────────────────────────────────────────────────────
// PersonPicker — one shared control for assigning people anywhere in the
// app (process owner, stakeholders, data-asset owner/steward, system
// owner/deputy, group members, role holders, …).
//
// Replaces the flat name-only dropdowns. Three ways to find someone, in
// one popover:
//   • Search   — typeahead over name / title / org path
//   • Org tree — browse the Company → Division → Department hierarchy
//                with people nested under the orgs they belong to
//   • By group — browse governance bodies (Council, Stewardship Team…)
//                with their members  (enable with showGroups)
//
// Every row shows Name — Title · Org path so two people with the same
// name are distinguishable. Single or multi select.
//
// Value model: defaults to person ids (`valueMode="id"`). Some legacy
// fields store comma-free *names* (e.g. ProcessNode.stakeholders) —
// pass `valueMode="name"` and the picker maps to/from names so those
// fields don't need a data migration.
//
// The three datasets (people, orgs, groups) are fetched once and shared
// across every PersonPicker instance on the page via a module cache,
// keyed by org scope, so a page with many pickers doesn't storm the API.
// ──────────────────────────────────────────────────────────────────────────

interface PickerPerson {
  id: string;
  name: string;
  title?: string;
  jobRole?: string;
  orgIds: string[];
  orgNames?: string[];
  orgPaths?: string[];
}

interface PickerOrg {
  id: string;
  parentId: string | null;
  name: string;
  type: string;
}

interface PickerGroup {
  id: string;
  name: string;
  type: string;
  members: Array<{ personId: string; personName?: string; groupRole?: string }>;
}

interface CacheEntry {
  people: PickerPerson[];
  orgs: PickerOrg[];
  groups: PickerGroup[];
}

// Module-level cache keyed by org scope. A promise so concurrent pickers
// share the in-flight request rather than each firing their own.
const dataCache = new Map<string, Promise<CacheEntry>>();

function loadPickerData(orgId: string | undefined, withGroups: boolean): Promise<CacheEntry> {
  const key = `${orgId || 'all'}:${withGroups ? 'g' : ''}`;
  const hit = dataCache.get(key);
  if (hit) return hit;
  const q = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
  const p = (async () => {
    const [peopleRes, orgRes, groupRes] = await Promise.all([
      // Scope people to the same org as the orgs/groups — without `q` the
      // picker returned every person the caller could see (all tenants for a
      // super-admin), letting you assign someone from a sibling company.
      apiClient.get<{ success: boolean; data: PickerPerson[] }>(`/people${q}`),
      apiClient.get<{ success: boolean; data: PickerOrg[] }>(`/organizations${q}`),
      withGroups
        ? apiClient.get<{ success: boolean; data: PickerGroup[] }>(`/governance-groups${q}`)
        : Promise.resolve({ data: [] as PickerGroup[] }),
    ]);
    return {
      people: peopleRes.data || [],
      orgs: orgRes.data || [],
      groups: (groupRes as any).data || [],
    };
  })();
  dataCache.set(key, p);
  return p;
}

/** Drop the cache so the next mount refetches — call after a write that
 *  adds/edits people, orgs, or group membership. */
export function invalidatePersonPickerCache() {
  dataCache.clear();
}

type Tab = 'search' | 'tree' | 'group';

interface PersonPickerProps {
  mode?: 'single' | 'multi';
  /** What the parent stores. 'id' (default) or 'name' for legacy
   *  name-string fields. */
  valueMode?: 'id' | 'name';
  value: string | string[] | null | undefined;
  onChange: (next: any) => void;
  orgId?: string;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Show the "By group" tab. Needs the extra /governance-groups
   *  fetch; on by default. */
  showGroups?: boolean;
  /** Audience hint from the surrounding entity. GOVERNANCE opens the
   *  picker on the "By group" tab (governance bodies first);
   *  OPERATIONAL opens it on the org tree. Selection is never
   *  restricted by this prop — it only sets the default lens. */
  domain?: 'GOVERNANCE' | 'OPERATIONAL';
  /** If provided, only people whose key (id or name, matching valueMode)
   *  is in this set can appear in the picker. Used to gate selection
   *  by role-holder eligibility — e.g. an activity with Responsible
   *  Role "Business Data Steward" only allows picking people who hold
   *  that role on the Governance Roles page. */
  eligibleKeys?: Set<string>;
}

export default function PersonPicker({
  mode = 'single',
  valueMode = 'id',
  value,
  onChange,
  orgId,
  label,
  placeholder = 'Select person…',
  disabled,
  showGroups = true,
  domain,
  eligibleKeys,
}: PersonPickerProps) {
  const [open, setOpen] = useState(false);
  // Default lens follows the entity's domain: governance work opens on
  // the governance bodies, operational work on the org tree. Plain
  // 'search' when there's no domain hint.
  const [tab, setTab] = useState<Tab>(
    domain === 'GOVERNANCE' && showGroups ? 'group'
      : domain === 'OPERATIONAL' ? 'tree'
      : 'search',
  );
  const [query, setQuery] = useState('');
  const [data, setData] = useState<CacheEntry | null>(null);
  const [expandedOrgs, setExpandedOrgs] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Load on mount so the trigger can resolve the current selection's
  // label without the user opening the popover. The module-level cache
  // dedupes — a page with 50 pickers still fires exactly one request
  // per (orgScope, withGroups) key.
  useEffect(() => {
    let alive = true;
    loadPickerData(orgId, showGroups).then((d) => { if (alive) setData(d); });
    return () => { alive = false; };
  }, [orgId, showGroups]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Apply the eligibility gate before any of the search / tree / group
  // views derive from it, so all three tabs see the same restricted
  // set. The currently-selected value(s) pass through even if they
  // aren't in the eligible set, so removing/displaying a stale pick
  // still works without it disappearing from the trigger label.
  const rawPeople = data?.people || [];
  const people = useMemo(() => {
    if (!eligibleKeys) return rawPeople;
    const selKeys = new Set(
      value == null ? [] : Array.isArray(value) ? value : value === '' ? [] : [value],
    );
    return rawPeople.filter((p) => {
      const key = valueMode === 'name' ? p.name : p.id;
      return eligibleKeys.has(key) || selKeys.has(key);
    });
  }, [rawPeople, eligibleKeys, value, valueMode]);

  // Resolve the selected value(s) to person records for the trigger label.
  const selectedKeys: string[] = useMemo(() => {
    if (value == null) return [];
    return Array.isArray(value) ? value : value === '' ? [] : [value];
  }, [value]);

  const personByKey = useMemo(() => {
    const m = new Map<string, PickerPerson>();
    for (const p of people) {
      m.set(valueMode === 'name' ? p.name : p.id, p);
    }
    return m;
  }, [people, valueMode]);

  const keyOf = (p: PickerPerson) => (valueMode === 'name' ? p.name : p.id);

  const isSelected = (p: PickerPerson) => selectedKeys.includes(keyOf(p));

  const commit = (p: PickerPerson) => {
    const k = keyOf(p);
    if (mode === 'single') {
      onChange(valueMode === 'name' ? k : k);
      setOpen(false);
    } else {
      const cur = new Set(selectedKeys);
      if (cur.has(k)) cur.delete(k); else cur.add(k);
      onChange(Array.from(cur));
    }
  };

  const clearSingle = () => onChange(valueMode === 'name' ? '' : null);

  // ── Trigger label ──
  const triggerText = (() => {
    if (selectedKeys.length === 0) return placeholder;
    if (mode === 'single') {
      const p = personByKey.get(selectedKeys[0]);
      return p ? formatPersonLabel(p) : selectedKeys[0];
    }
    return `${selectedKeys.length} selected`;
  })();

  // ── Search results ──
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = people;
    if (q) {
      list = people.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.title || '').toLowerCase().includes(q) ||
        (p.jobRole || '').toLowerCase().includes(q) ||
        (p.orgPaths || p.orgNames || []).some((o) => o.toLowerCase().includes(q)),
      );
    }
    return list.slice(0, 100);
  }, [people, query]);

  // ── Org tree ──
  const orgChildren = useMemo(() => {
    const m = new Map<string | null, PickerOrg[]>();
    for (const o of data?.orgs || []) {
      const arr = m.get(o.parentId) || [];
      arr.push(o);
      m.set(o.parentId, arr);
    }
    return m;
  }, [data]);

  const peopleByOrg = useMemo(() => {
    const m = new Map<string, PickerPerson[]>();
    for (const p of people) {
      for (const oid of p.orgIds || []) {
        const arr = m.get(oid) || [];
        arr.push(p);
        m.set(oid, arr);
      }
    }
    return m;
  }, [people]);

  const rootOrgs = orgChildren.get(null) || [];

  const renderOrgNode = (org: PickerOrg, depth: number): React.ReactNode => {
    const kids = orgChildren.get(org.id) || [];
    const orgPeople = peopleByOrg.get(org.id) || [];
    const expanded = expandedOrgs.has(org.id);
    return (
      <div key={org.id}>
        <button
          onClick={() => setExpandedOrgs((prev) => {
            const n = new Set(prev); n.has(org.id) ? n.delete(org.id) : n.add(org.id); return n;
          })}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, width: '100%',
            padding: '5px 8px', paddingLeft: 8 + depth * 14,
            background: 'transparent', border: 'none', cursor: 'pointer',
            fontSize: 12, textAlign: 'left', color: 'var(--color-text)',
          }}
        >
          <span style={{ fontSize: 9, color: 'var(--color-text-muted)', width: 8 }}>
            {kids.length > 0 || orgPeople.length > 0 ? (expanded ? '▾' : '▸') : ''}
          </span>
          <span style={{ fontWeight: 600 }}>{org.name}</span>
          <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
            {org.type?.toLowerCase()}{orgPeople.length > 0 ? ` · ${orgPeople.length}` : ''}
          </span>
        </button>
        {expanded && (
          <>
            {kids.map((k) => renderOrgNode(k, depth + 1))}
            {orgPeople.map((p) => (
              <PersonRow key={`${org.id}-${p.id}`} person={p} depth={depth + 1}
                selected={isSelected(p)} multi={mode === 'multi'} onPick={() => commit(p)} />
            ))}
          </>
        )}
      </div>
    );
  };

  // ── Render ──
  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      {label && (
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 4 }}>
          {label}
        </div>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          width: '100%', padding: '7px 10px', fontSize: 13,
          background: 'var(--color-surface)', border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)', cursor: disabled ? 'not-allowed' : 'pointer',
          color: selectedKeys.length === 0 ? 'var(--color-text-muted)' : 'var(--color-text)',
          opacity: disabled ? 0.6 : 1, textAlign: 'left',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {triggerText}
        </span>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>▾</span>
      </button>

      {/* Multi-select chips below the trigger */}
      {mode === 'multi' && selectedKeys.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
          {selectedKeys.map((k) => {
            const p = personByKey.get(k);
            return (
              <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999, background: 'var(--color-bg)', border: '1px solid var(--color-border)', fontSize: 11 }}>
                {p ? p.name : k}
                <button
                  onClick={() => onChange(selectedKeys.filter((x) => x !== k))}
                  aria-label={`Remove ${p?.name || k}`}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--color-text-muted)', display: 'inline-flex' }}
                ><X size={12} strokeWidth={2.4} /></button>
              </span>
            );
          })}
        </div>
      )}

      {open && (
        <div
          role="dialog"
          aria-label={label || 'Select person'}
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 200,
            width: 360, maxWidth: '90vw',
            background: 'var(--color-surface)', border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.18))',
            overflow: 'hidden',
          }}
        >
          {/* Tab strip */}
          <div role="tablist" style={{ display: 'flex', borderBottom: '1px solid var(--color-border)' }}>
            {([['search', 'Search'], ['tree', 'Org tree'], ...(showGroups ? [['group', 'By group']] : [])] as Array<[Tab, string]>).map(([id, lbl]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                style={{
                  flex: 1, padding: '8px 4px', fontSize: 12, fontWeight: tab === id ? 600 : 500,
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  borderBottom: `2px solid ${tab === id ? 'var(--color-primary)' : 'transparent'}`,
                  color: tab === id ? 'var(--color-primary)' : 'var(--color-text-muted)', marginBottom: -1,
                }}
              >
                {lbl}
              </button>
            ))}
          </div>

          {!data ? (
            <div style={{ padding: 20, fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center' }}>Loading…</div>
          ) : (
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              {tab === 'search' && (
                <>
                  <div style={{ padding: 8, position: 'sticky', top: 0, background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)' }}>
                    <input
                      autoFocus
                      aria-label="Search people"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search name, title, or org…"
                      style={{ width: '100%', padding: '6px 10px', fontSize: 12, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', boxSizing: 'border-box' }}
                    />
                  </div>
                  {mode === 'single' && selectedKeys.length > 0 && (
                    <button onClick={clearSingle}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', fontSize: 12, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)' }}>
                      ✕ Clear selection
                    </button>
                  )}
                  {searchResults.length === 0 ? (
                    <div style={{ padding: 16, fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center' }}>No matching people.</div>
                  ) : (
                    searchResults.map((p) => (
                      <PersonRow key={p.id} person={p} depth={0}
                        selected={isSelected(p)} multi={mode === 'multi'} onPick={() => commit(p)} />
                    ))
                  )}
                </>
              )}

              {tab === 'tree' && (
                <div style={{ padding: '6px 0' }}>
                  {rootOrgs.length === 0
                    ? <div style={{ padding: 16, fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center' }}>No organizations.</div>
                    : rootOrgs.map((o) => renderOrgNode(o, 0))}
                </div>
              )}

              {tab === 'group' && showGroups && (
                <div style={{ padding: '6px 0' }}>
                  {(data.groups || []).length === 0 ? (
                    <div style={{ padding: 16, fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center' }}>No governance groups.</div>
                  ) : (
                    data.groups.map((g) => {
                      const expanded = expandedGroups.has(g.id);
                      return (
                        <div key={g.id}>
                          <button
                            onClick={() => setExpandedGroups((prev) => {
                              const n = new Set(prev); n.has(g.id) ? n.delete(g.id) : n.add(g.id); return n;
                            })}
                            style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '5px 8px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, textAlign: 'left', color: 'var(--color-text)' }}
                          >
                            <span style={{ fontSize: 9, color: 'var(--color-text-muted)', width: 8 }}>{g.members.length > 0 ? (expanded ? '▾' : '▸') : ''}</span>
                            <span style={{ fontWeight: 600 }}>{g.name}</span>
                            <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{g.type?.toLowerCase().replace(/_/g, ' ')} · {g.members.length}</span>
                          </button>
                          {expanded && g.members.map((m) => {
                            const p = people.find((x) => x.id === m.personId);
                            if (!p) return null;
                            return (
                              <PersonRow key={`${g.id}-${p.id}`} person={p} depth={1}
                                selected={isSelected(p)} multi={mode === 'multi'} onPick={() => commit(p)}
                                suffix={m.groupRole ? m.groupRole.toLowerCase() : undefined} />
                            );
                          })}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}

          {mode === 'multi' && (
            <div style={{ padding: 8, borderTop: '1px solid var(--color-border)', textAlign: 'right' }}>
              <button onClick={() => setOpen(false)}
                style={{ padding: '5px 14px', fontSize: 12, fontWeight: 600, background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>
                Done
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── PersonRow — one selectable person, enriched with title + org path ──
function PersonRow({
  person, depth, selected, multi, onPick, suffix,
}: {
  person: PickerPerson; depth: number; selected: boolean; multi: boolean;
  onPick: () => void; suffix?: string;
}) {
  const orgs = (person.orgPaths && person.orgPaths.length > 0 ? person.orgPaths : person.orgNames || []).filter(Boolean);
  const title = person.title?.trim() || person.jobRole?.trim() || '';
  return (
    <button
      onClick={onPick}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%',
        padding: '6px 10px', paddingLeft: 10 + depth * 14,
        background: selected ? 'var(--color-bg)' : 'transparent',
        border: 'none', borderLeft: `2px solid ${selected ? 'var(--color-primary)' : 'transparent'}`,
        cursor: 'pointer', textAlign: 'left',
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'var(--color-bg)'; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      {multi && (
        <span style={{
          width: 14, height: 14, marginTop: 1, flexShrink: 0, borderRadius: 3,
          border: `1.5px solid ${selected ? 'var(--color-primary)' : 'var(--color-border)'}`,
          background: selected ? 'var(--color-primary)' : 'transparent',
          color: '#fff',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>{selected ? <Check size={10} strokeWidth={3} /> : null}</span>
      )}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 500, display: 'block' }}>
          {person.name}
          {suffix && <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--color-text-muted)', marginLeft: 6 }}>{suffix}</span>}
        </span>
        {(title || orgs.length > 0) && (
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}{title && orgs.length > 0 ? ' · ' : ''}{orgs[0] || ''}
          </span>
        )}
      </span>
    </button>
  );
}
