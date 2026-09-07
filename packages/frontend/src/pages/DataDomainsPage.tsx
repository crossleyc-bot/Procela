import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { apiClient } from '../api/client';
import PageHeader from '../components/PageHeader';
import Card from '../components/Card';
import Button from '../components/Button';
import Spinner from '../components/Spinner';
import { INDUSTRIES } from '../types';
import { clickable } from '../lib/a11y';
import { useOrgContext } from '../stores/orgContext';
import { useRoleDrawerStore } from '../stores/roleDrawerStore';
import { usePermissions } from '../hooks/usePermissions';
import { useAiEnabled } from '../stores/aiConfigStore';
import { useToastStore } from '../stores/toastStore';
import ExportMenu from '../components/ExportMenu';
import { errorMessage, errorToast } from '../lib/errorToast';
import { getStatusColor } from '../lib/statusBadge';
import ConfirmDialog from '../components/ConfirmDialog';
import IconButton from '../components/IconButton';
import EmptyState from '../components/EmptyState';
import { renderNavIcon } from '../components/navIcons';
import TruncatedText from '../components/TruncatedText';
import HelpPopover from '../components/HelpPopover';
import { SkeletonRows } from '../components/Skeleton';
import PersonPicker from '../components/PersonPicker';
import { formatPersonLabel } from '../lib/personLabel';
import { useRefreshOnFocus } from '../hooks/usePolling';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface DataDomain {
  id: string; orgId: string; name: string; description: string;
  ownerId: string | null; ownerName: string | null;
  stewardIds: string[]; stewards: { id: string; name: string }[];
  dataAssetIds: string[]; assets: { id: string; name: string }[];
  status: string; scopeDefinition?: string; criticality?: string; code?: string;
  // Sub-domain nesting + master/reference governance signals (backend-derived).
  parentDomainId?: string | null; parentDomainName?: string | null; subDomainCount?: number;
  containsMasterData?: boolean; containsReferenceData?: boolean; suggestedCriticality?: string;
  createdAt: string; updatedAt: string;
}
interface Person { id: string; name: string; }
interface DataAssetOption { id: string; name: string; }

// Nodes of the unified generate-and-review tree. Every row is an editable
// name + description, so accepting an AI suggestion, editing it, and
// hand-adding your own are the same gesture. A GenDomain with `existingId`
// is a real catalog domain shown as locked context (branch mode); without
// it, it's a new top-level domain to be created.
interface GenSub { name: string; description: string; selected: boolean; }
interface GenDomain { name: string; description: string; selected: boolean; existingId?: string; subDomains: GenSub[]; }

const inputStyle: React.CSSProperties = { border: '1px solid var(--color-border)', borderRadius: 4, padding: '6px 10px', fontSize: 13, width: '100%', background: 'var(--color-surface)' };
const selectStyle: React.CSSProperties = { ...inputStyle, appearance: 'auto' as any };
const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-muted)' };

interface FormData { name: string; description: string; status: string; criticality: string; parentDomainId: string; code: string; }
const emptyForm: FormData = { name: '', description: '', status: 'DRAFT', criticality: '', parentDomainId: '', code: '' };

const SIMPLE_TRANSITIONS: Record<string, string[]> = { DRAFT: ['ACTIVE'], ACTIVE: ['DRAFT', 'DEPRECATED'], DEPRECATED: ['DRAFT'] };
const ADVANCED_TRANSITIONS: Record<string, string[]> = { DRAFT: ['PROPOSED'], PROPOSED: ['UNDER_REVIEW', 'DRAFT'], UNDER_REVIEW: ['APPROVED', 'DRAFT'], APPROVED: ['ACTIVE', 'DRAFT'], ACTIVE: ['DRAFT', 'DEPRECATED'], DEPRECATED: ['DRAFT'] };

function statusDot(status: string): React.CSSProperties {
  const c = getStatusColor(status);
  return { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: c.color, flexShrink: 0 };
}

function healthDots(domain: DataDomain) {
  const hasOwner = !!domain.ownerId;
  const hasStewards = domain.stewards.length > 0;
  const hasAssets = domain.assets.length > 0;
  return (
    <span style={{ display: 'inline-flex', gap: 3 }}>
      <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: hasOwner ? '#22c55e' : '#d1d5db' }} title={hasOwner ? 'Owner assigned' : 'No owner'} />
      <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: hasStewards ? '#22c55e' : '#d1d5db' }} title={hasStewards ? 'Stewards assigned' : 'No stewards'} />
      <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: hasAssets ? '#22c55e' : '#d1d5db' }} title={hasAssets ? 'Assets linked' : 'No assets'} />
    </span>
  );
}

// Shared style for "Owner" / "Stewards" labels that open the Role Detail
// drawer. Looks like a label, hints clickability with a dotted underline.
const roleLabelBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0,
  color: 'inherit', font: 'inherit', cursor: 'pointer',
  textDecoration: 'underline', textDecorationStyle: 'dotted',
  textUnderlineOffset: 3,
};

export default function DataDomainsPage() {
  const { activeOrgId } = useOrgContext();
  const openRoleDrawer = useRoleDrawerStore((s) => s.open);
  const { canWrite } = usePermissions();
  const aiEnabled = useAiEnabled();
  const { addToast } = useToastStore();
  const [domains, setDomains] = useState<DataDomain[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [allAssets, setAllAssets] = useState<DataAssetOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [selectedDomainId, setSelectedDomainId] = useState<string | null>(null);
  const [statusMode, setStatusMode] = useState<'simple' | 'advanced'>('simple');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<{ assets: number; stewards: number; subDomains?: number; subDomainNames?: string[] } | null>(null);
  const [createStewardshipTeam, setCreateStewardshipTeam] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Left-tree expand/collapse: the set of parent-domain ids whose sub-domains
  // are folded away. Persisted per org so navigation state survives reloads.
  // Default is fully expanded (empty set) — matches the pre-collapse behaviour.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const toggleCollapse = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Bulk selection
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
  const [bulkUpdates, setBulkUpdates] = useState<{ ownerId: string; status: string }>({ ownerId: '', status: '' });
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [applyingBulk, setApplyingBulk] = useState(false);
  const toggleBulkSelect = (id: string) => {
    setBulkSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const clearBulkSelection = () => {
    setBulkSelectedIds(new Set());
    setBulkUpdates({ ownerId: '', status: '' });
  };

  // Detail editing
  const [detailOwnerId, setDetailOwnerId] = useState('');
  const [detailStewardIds, setDetailStewardIds] = useState<string[]>([]);
  const [detailAssetIds, setDetailAssetIds] = useState<string[]>([]);
  const [assetSearch, setAssetSearch] = useState('');

  // AI generate — one nested-tree review. "Generate domains" builds top-level
  // domains each with suggested sub-domains; the per-domain wand seeds the same
  // tree with a single existing (locked) parent. `genBranchMode` distinguishes
  // the two; `pendingGen` remembers the intent when the industry picker has to
  // open first.
  const [generating, setGenerating] = useState(false);
  const [genTree, setGenTree] = useState<GenDomain[]>([]);
  const [showGeneratePreview, setShowGeneratePreview] = useState(false);
  const [generateStewardshipTeams, setGenerateStewardshipTeams] = useState(true);
  const [genBranchMode, setGenBranchMode] = useState(false);
  const [pendingGen, setPendingGen] = useState<{ type: 'tree' } | { type: 'branch'; domain: DataDomain } | null>(null);
  // Industry picker — opens when the active org (and its visible
  // ancestors) carries no `industry`, or when the user explicitly
  // wants to override the auto-detected value.
  const [industryPickerOpen, setIndustryPickerOpen] = useState(false);
  const [pickedIndustry, setPickedIndustry] = useState<string>('');
  const industryPickerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(industryPickerRef, industryPickerOpen);
  useEffect(() => {
    if (!industryPickerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setIndustryPickerOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [industryPickerOpen]);
  const generatePreviewRef = useRef<HTMLDivElement>(null);
  useFocusTrap(generatePreviewRef, showGeneratePreview);
  useEffect(() => {
    if (!showGeneratePreview) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowGeneratePreview(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showGeneratePreview]);

  const fetchData = useCallback(async () => {
    try {
      const query = activeOrgId ? `?orgId=${activeOrgId}` : '';
      const [domainsRes, peopleRes, assetsRes] = await Promise.all([
        apiClient.get<{ success: boolean; data: DataDomain[] }>(`/data-domains${query}`),
        apiClient.get<{ success: boolean; data: Person[] }>('/people'),
        apiClient.get<{ success: boolean; data: DataAssetOption[] }>(`/data-assets${query}`),
      ]);
      setDomains(domainsRes.data || []);
      setPeople(peopleRes.data || []);
      setAllAssets(assetsRes.data || []);
      if (activeOrgId) {
        try {
          const orgRes = await apiClient.get<{ success: boolean; data: { statusMode?: string } }>(`/organizations/${activeOrgId}`);
          setStatusMode((orgRes.data?.statusMode as 'simple' | 'advanced') || 'simple');
        } catch { /* */ }
      }
    } catch { /* */ }
    finally { setLoading(false); }
  }, [activeOrgId]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useRefreshOnFocus(fetchData);

  const filteredDomains = useMemo(() => {
    if (!searchQuery.trim()) return domains.sort((a, b) => a.name.localeCompare(b.name));
    const q = searchQuery.toLowerCase();
    return domains.filter((d) => d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  }, [domains, searchQuery]);

  // Order the (filtered) list so each parent domain is immediately followed by
  // its sub-domains — a flat list the render indents by one level. Children
  // whose parent isn't in the filtered set fall back to top-level position.
  const orderedDomains = useMemo(() => {
    const present = new Set(filteredDomains.map((d) => d.id));
    const byName = (a: DataDomain, b: DataDomain) => a.name.localeCompare(b.name);
    const tops = filteredDomains.filter((d) => !d.parentDomainId || !present.has(d.parentDomainId)).sort(byName);
    const out: DataDomain[] = [];
    for (const t of tops) {
      out.push(t);
      for (const c of filteredDomains.filter((d) => d.parentDomainId === t.id).sort(byName)) out.push(c);
    }
    return out;
  }, [filteredDomains]);

  // Parents that actually have a sub-domain rendered in the current (filtered)
  // list — the only rows that get a collapse caret.
  const parentsWithChildren = useMemo(() => {
    const s = new Set<string>();
    for (const d of orderedDomains) if (d.parentDomainId) s.add(d.parentDomainId);
    return s;
  }, [orderedDomains]);
  const allCollapsed = parentsWithChildren.size > 0 && Array.from(parentsWithChildren).every((id) => collapsedIds.has(id));
  const toggleCollapseAll = () => setCollapsedIds(allCollapsed ? new Set() : new Set(parentsWithChildren));
  // Rows that survive the fold: hide a sub-domain whose parent is collapsed.
  const visibleDomains = useMemo(
    () => orderedDomains.filter((d) => !(d.parentDomainId && collapsedIds.has(d.parentDomainId))),
    [orderedDomains, collapsedIds],
  );

  // Persist the collapsed set per org. The prevKey guard skips the save on the
  // render where the org (and thus the storage key) changed, so the freshly
  // loaded set for the new org isn't clobbered by the previous org's state.
  const collapseKey = activeOrgId ? `procela.dataDomains.collapsed.${activeOrgId}` : 'procela.dataDomains.collapsed';
  const prevCollapseKeyRef = useRef(collapseKey);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(collapseKey);
      setCollapsedIds(raw ? new Set<string>(JSON.parse(raw)) : new Set());
    } catch { setCollapsedIds(new Set()); }
  }, [collapseKey]);
  useEffect(() => {
    if (prevCollapseKeyRef.current !== collapseKey) { prevCollapseKeyRef.current = collapseKey; return; }
    try { localStorage.setItem(collapseKey, JSON.stringify(Array.from(collapsedIds))); } catch { /* */ }
  }, [collapsedIds, collapseKey]);

  const selectedDomain = selectedDomainId ? domains.find((d) => d.id === selectedDomainId) || null : null;
  // Parent of the selected sub-domain (if any) — used to offer an explicit
  // "inherit owner from parent" assignment when a sub-domain has none.
  const selectedParentDomain = selectedDomain?.parentDomainId
    ? (domains.find((d) => d.id === selectedDomain.parentDomainId) || null)
    : null;

  useEffect(() => {
    if (!selectedDomainId && filteredDomains.length > 0) setSelectedDomainId(filteredDomains[0].id);
    else if (selectedDomainId && !filteredDomains.find((d) => d.id === selectedDomainId) && filteredDomains.length > 0) setSelectedDomainId(filteredDomains[0].id);
  }, [filteredDomains, selectedDomainId]);

  const openDetail = (domain: DataDomain) => {
    setSelectedDomainId(domain.id);
    setDetailOwnerId(domain.ownerId || '');
    setDetailStewardIds(domain.stewardIds || []);
    setDetailAssetIds(domain.dataAssetIds || []);
    setAssetSearch('');
    setShowForm(false);
  };

  // Auto-sync detail state when selectedDomain changes
  useEffect(() => {
    if (selectedDomain) {
      setDetailOwnerId(selectedDomain.ownerId || '');
      setDetailStewardIds(selectedDomain.stewardIds || []);
      setDetailAssetIds(selectedDomain.dataAssetIds || []);
    }
  }, [selectedDomain]);

  const openAdd = () => {
    if (!activeOrgId) { addToast('error', 'Select an organization from the header first.'); return; }
    setForm(emptyForm); setEditingId(null); setCreateStewardshipTeam(true); setShowForm(true);
  };
  const openEdit = (domain: DataDomain) => {
    setForm({ name: domain.name, description: domain.description, status: domain.status, criticality: domain.criticality || '', parentDomainId: domain.parentDomainId || '', code: domain.code || '' });
    setEditingId(domain.id); setShowForm(true);
  };
  const closeForm = () => { setShowForm(false); setEditingId(null); setForm(emptyForm); };

  const ensureGovernanceHierarchy = async (): Promise<string | null> => {
    try {
      const query = activeOrgId ? `?orgId=${activeOrgId}` : '';
      const res = await apiClient.get<{ success: boolean; data: Array<{ id: string; type: string }> }>(`/governance-groups${query}`);
      const groups = res.data || [];
      let council = groups.find((g) => g.type === 'COUNCIL');
      let office = groups.find((g) => g.type === 'OFFICE');
      let committee = groups.find((g) => g.type === 'COMMITTEE');
      if (committee) return committee.id;
      if (!council) { const r = await apiClient.post<{ success: boolean; data: { id: string } }>('/governance-groups', { name: 'Data Governance Council', type: 'COUNCIL', status: 'ACTIVE', orgId: activeOrgId }); council = { id: r.data.id, type: 'COUNCIL' }; }
      if (!office) { const r = await apiClient.post<{ success: boolean; data: { id: string } }>('/governance-groups', { name: 'Data Governance Office', type: 'OFFICE', status: 'ACTIVE', orgId: activeOrgId, parentId: council.id }); office = { id: r.data.id, type: 'OFFICE' }; }
      if (!committee) { const r = await apiClient.post<{ success: boolean; data: { id: string } }>('/governance-groups', { name: 'Enterprise Data Committee', type: 'COMMITTEE', status: 'ACTIVE', orgId: activeOrgId, parentId: office.id }); committee = { id: r.data.id, type: 'COMMITTEE' }; }
      return committee.id;
    } catch { return null; }
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    try {
      if (editingId) {
        await apiClient.put(`/data-domains/${editingId}`, form);
        addToast('success', 'Domain updated');
      } else {
        await apiClient.post('/data-domains', { ...form, ...(activeOrgId ? { orgId: activeOrgId } : {}) });
        addToast('success', 'Domain created');
        if (createStewardshipTeam) {
          try {
            const parentId = await ensureGovernanceHierarchy();
            await apiClient.post('/governance-groups', { name: `${form.name.trim()} Stewardship Team`, type: 'STEWARDSHIP_TEAM', description: `Stewardship team for the ${form.name.trim()} domain.`, status: 'ACTIVE', orgId: activeOrgId, parentId });
            addToast('success', `Stewardship team created for ${form.name.trim()}`);
          } catch { addToast('error', 'Domain created, but stewardship team creation failed'); }
        }
      }
      closeForm(); fetchData();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      addToast('error', e?.response?.data?.error || errorMessage(err, 'Failed to save domain'));
    }
  };

  const handleDelete = async (id: string) => {
    await apiClient.delete(`/data-domains/${id}`);
    if (selectedDomainId === id) setSelectedDomainId(null);
    addToast('success', 'Domain deleted'); fetchData();
  };

  const handleDetailSave = async () => {
    if (!selectedDomain) return;
    await apiClient.put(`/data-domains/${selectedDomain.id}`, { ownerId: detailOwnerId || null, stewardIds: detailStewardIds, dataAssetIds: detailAssetIds });
    addToast('success', 'Governance details saved'); fetchData();
  };

  // Explicitly assign the parent domain's owner to this sub-domain. Not a
  // display fallback — it writes a real ownerId so the field never disagrees
  // with the "no owner" gap. Stewardship stays deliberately manual (each
  // sub-domain gets its own steward).
  const inheritOwnerFromParent = async () => {
    if (!selectedDomain) return;
    const parent = selectedDomain.parentDomainId ? domains.find((d) => d.id === selectedDomain.parentDomainId) : null;
    if (!parent?.ownerId) return;
    try {
      await apiClient.put(`/data-domains/${selectedDomain.id}`, { ownerId: parent.ownerId, stewardIds: detailStewardIds, dataAssetIds: detailAssetIds });
      setDetailOwnerId(parent.ownerId);
      addToast('success', `Owner set to ${parent.ownerName || 'the parent owner'} — inherited from ${parent.name}`);
      fetchData();
    } catch (err) { errorToast(err, 'Failed to inherit owner from parent'); }
  };

  const handleBulkApply = async () => {
    const ids = Array.from(bulkSelectedIds);
    if (ids.length === 0) return;
    const updates: Record<string, string | null> = {};
    if (bulkUpdates.ownerId) updates.ownerId = bulkUpdates.ownerId === '__unassign__' ? null : bulkUpdates.ownerId;
    if (bulkUpdates.status) updates.status = bulkUpdates.status;
    if (Object.keys(updates).length === 0) {
      addToast('error', 'Pick at least one field to change.');
      return;
    }
    setApplyingBulk(true);
    try {
      const res = await apiClient.patch<{ success: boolean; updated: number; skipped: Array<{ id: string; reason: string }> }>('/data-domains/bulk', { ids, updates });
      const skippedCount = res.skipped?.length || 0;
      addToast('success', `Updated ${res.updated} domain${res.updated !== 1 ? 's' : ''}${skippedCount ? ` (skipped ${skippedCount})` : ''}`);
      clearBulkSelection();
      fetchData();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      addToast('error', e?.response?.data?.error || errorMessage(err, 'Bulk update failed'));
    } finally {
      setApplyingBulk(false);
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(bulkSelectedIds);
    if (ids.length === 0) return;
    setApplyingBulk(true);
    try {
      const res = await apiClient.post<{ success: boolean; deleted: number }>('/data-domains/bulk-delete', { ids });
      addToast('success', `Deleted ${res.deleted} domain${res.deleted !== 1 ? 's' : ''}`);
      if (selectedDomainId && ids.includes(selectedDomainId)) setSelectedDomainId(null);
      clearBulkSelection();
      fetchData();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      addToast('error', e?.response?.data?.error || errorMessage(err, 'Bulk delete failed'));
    } finally {
      setApplyingBulk(false);
      setConfirmBulkDelete(false);
    }
  };

  const handleStatusChange = async (domainId: string, newStatus: string) => {
    try {
      await apiClient.put(`/data-domains/${domainId}`, { status: newStatus });
      addToast('success', `Status changed to ${newStatus.replace('_', ' ')}`); fetchData();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      addToast('error', e?.response?.data?.error || errorMessage(err, 'Failed to update status')); }
  };

  // Walk the active org and its ancestors to find the first non-empty
  // `industry`. Returns null when nothing is set — common when the
  // user is scoped to a division/department and the parent that holds
  // industry isn't in their visible org list. The picker handles the
  // null case.
  const detectIndustry = async (): Promise<string | null> => {
    try {
      const orgRes = await apiClient.get<{ success: boolean; data: Array<{ id: string; industry: string; parentId?: string }> }>('/organizations');
      const allOrgs = orgRes.data || [];
      let current = allOrgs.find((o) => o.id === activeOrgId);
      let industry = current?.industry || '';
      while (current && !industry) {
        current = allOrgs.find((o: any) => o.id === (current as any).parentId);
        if (current) industry = current.industry || '';
      }
      return industry || null;
    } catch {
      return null;
    }
  };

  // "Generate domains" — the full-tree build. Detect industry (or ask), then
  // build the nested tree.
  const handleGenerate = async () => {
    if (!activeOrgId) { errorToast(null, 'Select an organization first.'); return; }
    const industry = await detectIndustry();
    if (!industry) { setPendingGen({ type: 'tree' }); setPickedIndustry(INDUSTRIES[0]); setIndustryPickerOpen(true); return; }
    await buildTree(industry);
  };

  // Suggest top-level domains, then fan out sub-domains for each (one AI call
  // per domain, in parallel) into a single nested review tree.
  const buildTree = async (industry: string) => {
    setGenerating(true);
    try {
      const res = await apiClient.post<{ success: boolean; data: Array<{ name: string; description: string }> }>('/data-domains/generate', { industry });
      const tops = res.data || [];
      if (tops.length === 0) {
        errorToast(null, 'No suggestions returned. Retry — Claude occasionally returns prose; a retry usually fixes it.');
        return;
      }
      const withSubs = await Promise.all(tops.map(async (t): Promise<GenDomain> => {
        let subDomains: GenSub[] = [];
        try {
          const sr = await apiClient.post<{ success: boolean; data: Array<{ name: string; description: string }> }>(
            '/data-domains/generate-subdomains', { industry, parentName: t.name, parentDescription: t.description });
          subDomains = (sr.data || []).map((s) => ({ name: s.name, description: s.description, selected: true }));
        } catch { subDomains = []; }
        return { name: t.name, description: t.description, selected: true, subDomains };
      }));
      setGenTree(withSubs);
      setGenBranchMode(false);
      setShowGeneratePreview(true);
    } catch (err: any) {
      const snippet = err?.body?.rawSnippet ? `\n\n— AI returned: ${err.body.rawSnippet}` : '';
      errorToast(err, `Generation failed.${snippet}`);
    } finally {
      setGenerating(false);
    }
  };

  // Per-domain "Suggest sub-domains" — the branch build. Opens the same tree
  // seeded with one existing domain as a locked parent.
  const generateSubsForDomain = async (domain: DataDomain) => {
    const industry = await detectIndustry();
    if (!industry) { setPendingGen({ type: 'branch', domain }); setPickedIndustry(INDUSTRIES[0]); setIndustryPickerOpen(true); return; }
    await buildBranch(industry, domain);
  };

  const buildBranch = async (industry: string, domain: DataDomain) => {
    setGenerating(true);
    try {
      const sr = await apiClient.post<{ success: boolean; data: Array<{ name: string; description: string }> }>(
        '/data-domains/generate-subdomains', { industry, parentName: domain.name, parentDescription: domain.description });
      const subDomains: GenSub[] = (sr.data || []).map((s) => ({ name: s.name, description: s.description, selected: true }));
      if (subDomains.length === 0) {
        errorToast(null, 'No sub-domains returned. Retry — Claude occasionally returns prose; a retry usually fixes it.');
        return;
      }
      setGenTree([{ name: domain.name, description: domain.description, selected: true, existingId: domain.id, subDomains }]);
      setGenBranchMode(true);
      setShowGeneratePreview(true);
    } catch (err: any) {
      const snippet = err?.body?.rawSnippet ? `\n\n— AI returned: ${err.body.rawSnippet}` : '';
      errorToast(err, `Sub-domain generation failed.${snippet}`);
    } finally {
      setGenerating(false);
    }
  };

  // ── Tree editing ───────────────────────────────────────────────────────
  const closeGenerate = () => { setShowGeneratePreview(false); setGenTree([]); setGenBranchMode(false); };
  const updateDomain = (di: number, patch: Partial<GenDomain>) => setGenTree((t) => t.map((d, i) => (i === di ? { ...d, ...patch } : d)));
  const updateSub = (di: number, si: number, patch: Partial<GenSub>) => setGenTree((t) => t.map((d, i) => (i === di ? { ...d, subDomains: d.subDomains.map((s, j) => (j === si ? { ...s, ...patch } : s)) } : d)));
  const addSub = (di: number) => setGenTree((t) => t.map((d, i) => (i === di ? { ...d, subDomains: [...d.subDomains, { name: '', description: '', selected: true }] } : d)));
  const removeSub = (di: number, si: number) => setGenTree((t) => t.map((d, i) => (i === di ? { ...d, subDomains: d.subDomains.filter((_, j) => j !== si) } : d)));
  // Reparent a sub-domain onto a different top-level domain in the tree. The
  // sub keeps its name / description / selected state and lands at the end of
  // the target's list (same as a freshly added one). Conflict detection needs
  // no special-casing: subConflict keys off the sub's *current* domain, so a
  // move into a parent that already holds that name lights up the duplicate
  // warning and blocks Apply automatically.
  const moveSub = (fromDi: number, si: number, toDi: number) => setGenTree((t) => {
    if (fromDi === toDi || !t[fromDi] || !t[toDi]) return t;
    const sub = t[fromDi].subDomains[si];
    if (!sub) return t;
    return t.map((d, i) => {
      if (i === fromDi) return { ...d, subDomains: d.subDomains.filter((_, j) => j !== si) };
      if (i === toDi) return { ...d, subDomains: [...d.subDomains, sub] };
      return d;
    });
  });
  const addTopDomain = () => setGenTree((t) => [...t, { name: '', description: '', selected: true, subDomains: [] }]);
  const removeTopDomain = (di: number) => setGenTree((t) => t.filter((_, i) => i !== di));

  // Conflict detection mirrors the backend rule: names are unique among
  // siblings (same parent), not globally. Empty selected names also block.
  const norm = (s: string) => s.trim().toLowerCase();
  const topDomainConflict = (di: number): boolean => {
    const dom = genTree[di];
    if (!dom.selected || dom.existingId) return false;
    const nm = norm(dom.name);
    if (!nm) return false;
    if (genTree.some((o, oi) => oi !== di && o.selected && !o.existingId && norm(o.name) === nm)) return true;
    return domains.some((d) => !d.parentDomainId && norm(d.name) === nm);
  };
  const subConflict = (di: number, si: number): boolean => {
    const dom = genTree[di];
    const sub = dom.subDomains[si];
    if (!sub.selected) return false;
    const nm = norm(sub.name);
    if (!nm) return false;
    if (dom.subDomains.some((o, oj) => oj !== si && o.selected && norm(o.name) === nm)) return true;
    return dom.existingId ? domains.some((d) => d.parentDomainId === dom.existingId && norm(d.name) === nm) : false;
  };
  // Apply is blocked while any selected node is empty-named or conflicts, and
  // when nothing creatable is selected.
  const genHasCreatable = genTree.some((d) => (d.selected && !d.existingId) || d.subDomains.some((s) => s.selected));
  const genHasError = genTree.some((d, di) => {
    if (d.selected && !d.existingId && !d.name.trim()) return true;
    if (topDomainConflict(di)) return true;
    return d.subDomains.some((s, si) => (s.selected && !s.name.trim()) || subConflict(di, si));
  });

  const handleApplyGenerated = async () => {
    const chosen = genTree.filter((d) => d.selected);
    let createdParents = 0; let createdSubs = 0; let failed = 0;
    const newTopNames: string[] = [];
    try {
      for (const dom of chosen) {
        // Create (or reuse) the parent first so children can reference its id.
        let parentId = dom.existingId;
        if (!parentId) {
          const nm = dom.name.trim();
          if (!nm) { failed++; continue; }
          try {
            const r = await apiClient.post<{ success: boolean; data: { id: string } }>('/data-domains', { name: nm, description: dom.description, status: 'DRAFT', ...(activeOrgId ? { orgId: activeOrgId } : {}) });
            parentId = r.data.id; createdParents++; newTopNames.push(nm);
          } catch { failed++; continue; }
        }
        for (const sub of dom.subDomains.filter((s) => s.selected)) {
          const nm = sub.name.trim();
          if (!nm) { failed++; continue; }
          try {
            await apiClient.post('/data-domains', { name: nm, description: sub.description, status: 'DRAFT', parentDomainId: parentId, ...(activeOrgId ? { orgId: activeOrgId } : {}) });
            createdSubs++;
          } catch { failed++; }
        }
      }
      if (generateStewardshipTeams && newTopNames.length > 0) {
        const teamParent = await ensureGovernanceHierarchy();
        await Promise.all(newTopNames.map((n) =>
          apiClient.post('/governance-groups', { name: `${n} Stewardship Team`, type: 'STEWARDSHIP_TEAM', status: 'ACTIVE', orgId: activeOrgId, parentId: teamParent }).catch(() => {})));
      }
      const parts: string[] = [];
      if (createdParents) parts.push(`${createdParents} domain${createdParents === 1 ? '' : 's'}`);
      if (createdSubs) parts.push(`${createdSubs} sub-domain${createdSubs === 1 ? '' : 's'}`);
      addToast(failed > 0 ? 'info' : 'success', `Created ${parts.join(' + ') || 'nothing'}${failed > 0 ? ` · ${failed} failed` : ''}`);
    } catch (err) {
      errorToast(err, 'Failed to create domains');
    }
    closeGenerate();
    fetchData();
  };

  const transitions = statusMode === 'advanced' ? ADVANCED_TRANSITIONS : SIMPLE_TRANSITIONS;
  const unownedCount = domains.filter((d) => !d.ownerId).length;

  return (
    <div>
      {/* Header */}
      <PageHeader
        title="Data Domains"
        subtitle="Organize data assets into governed domains with assigned owners and stewards."
        actions={
          <>
            {canWrite && aiEnabled && (
              <IconButton icon="wand" label={generating ? 'Generating…' : 'Generate domains'} disabled={generating} onClick={handleGenerate} />
            )}
            {domains.length > 0 && (
              <ExportMenu build={() => ({
                filenameBase: 'data-domains',
                sheetName: 'Data Domains',
                headers: ['Name', 'Description', 'Owner', 'Stewards', 'Assets', 'Status'],
                rows: domains.map((d) => [
                  d.name,
                  d.description,
                  d.ownerName || '',
                  d.stewards.map((s) => s.name).join('; '),
                  d.assets.map((a) => a.name).join('; '),
                  d.status,
                ]),
              })} />
            )}
            {canWrite && <IconButton icon="plus" label="Add domain" variant="primary" onClick={openAdd} />}
          </>
        }
      >
        <HelpPopover id="domains-intro" title="Data Domains">
          Domains group related data assets into governed categories (e.g. Customer Data, Financial Data).
          Each domain has an owner, stewards, and a scope definition.
        </HelpPopover>
      </PageHeader>

      {/* Ownership gap warning */}
      {unownedCount > 0 && (
        <div style={{ padding: '8px 14px', marginBottom: 12, borderRadius: 'var(--radius-md)', background: '#fffbeb', border: '1px solid #fcd34d', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#92400e' }}>
          <span style={{ fontWeight: 700 }}>{unownedCount}</span> domain{unownedCount !== 1 ? 's have' : ' has'} no owner assigned
        </div>
      )}

      <ConfirmDialog open={confirmDelete !== null} title="Delete Data Domain?"
        message={(() => {
          const parts: string[] = [];
          if (deleteImpact && (deleteImpact.assets > 0 || deleteImpact.stewards > 0)) {
            parts.push(`This domain has ${deleteImpact.assets} asset${deleteImpact.assets !== 1 ? 's' : ''} and ${deleteImpact.stewards} steward${deleteImpact.stewards !== 1 ? 's' : ''}. This cannot be undone.`);
          } else {
            parts.push('This will permanently delete this data domain.');
          }
          if (deleteImpact?.subDomains) {
            const names = deleteImpact.subDomainNames || [];
            const shown = names.slice(0, 3).join(', ');
            const more = names.length > 3 ? ` +${names.length - 3} more` : '';
            const list = shown ? ` (${shown}${more})` : '';
            parts.push(`It has ${deleteImpact.subDomains} sub-domain${deleteImpact.subDomains !== 1 ? 's' : ''}${list}. ${deleteImpact.subDomains !== 1 ? 'They' : 'It'} won't be deleted — ${deleteImpact.subDomains !== 1 ? 'they' : 'it'}'ll move to the top level.`);
          }
          return parts.join(' ');
        })()}
        confirmLabel="Delete"
        onConfirm={async () => { const id = confirmDelete; setConfirmDelete(null); setDeleteImpact(null); if (id) await handleDelete(id); }}
        onCancel={() => { setConfirmDelete(null); setDeleteImpact(null); }}
      />

      <ConfirmDialog open={confirmBulkDelete}
        title={`Delete ${bulkSelectedIds.size} domain${bulkSelectedIds.size !== 1 ? 's' : ''}?`}
        message={`This will permanently delete the ${bulkSelectedIds.size} selected data domain${bulkSelectedIds.size !== 1 ? 's' : ''}. This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={handleBulkDelete}
        onCancel={() => setConfirmBulkDelete(false)} />

      {/* Add/Edit Form */}
      {showForm && (
        <Card padding={20} marginBottom={16}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>{editingId ? 'Edit Data Domain' : 'Add New Data Domain'}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Name *</label>
              <input autoFocus aria-label="Name" style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Customer Data" /></div>
            <div><label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Code</label>
              <input aria-label="Code" style={{ ...inputStyle, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder={form.parentDomainId ? 'e.g. MFG-02' : 'e.g. MFG'} />
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 3 }}>Structured governance code. Auto-suggested if left blank.</div></div>
            <div><label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Status</label>
              {editingId ? (
                <select aria-label="Status" style={selectStyle} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value={form.status}>{form.status}</option>
                  {(transitions[form.status] || []).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : (
                <select aria-label="Status" style={selectStyle} value="DRAFT" disabled><option value="DRAFT">Draft</option></select>
              )}
            </div>
            <div><label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Criticality</label>
              <select aria-label="Criticality" style={selectStyle} value={form.criticality} onChange={(e) => setForm({ ...form, criticality: e.target.value })}>
                <option value="">Unclassified</option>
                <option value="TIER_1">Tier-1 (critical)</option>
                <option value="TIER_2">Tier-2</option>
                <option value="TIER_3">Tier-3</option>
                <option value="TIER_4">Tier-4</option>
              </select>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 3 }}>Tier-1 domains drive the Council Scorecard's coverage measure.</div>
            </div>
            <div><label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Parent domain</label>
              <select
                aria-label="Parent domain"
                style={selectStyle}
                value={form.parentDomainId}
                onChange={(e) => setForm({ ...form, parentDomainId: e.target.value })}
              >
                <option value="">— None (top-level domain)</option>
                {domains
                  .filter((d) => !d.parentDomainId && d.id !== editingId)
                  .map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 3 }}>Nest this under a parent to make it a sub-domain. One level deep.</div>
            </div>
            {/* Description absorbed the former "Scope Definition" field. */}
            <div style={{ gridColumn: '1 / -1' }}><label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Description</label>
              <input aria-label="Description" style={inputStyle} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Purpose and scope — what this domain is and what data falls in/out of it" /></div>
          </div>
          {!editingId && (
            <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <input type="checkbox" checked={createStewardshipTeam} onChange={(e) => setCreateStewardshipTeam(e.target.checked)} style={{ marginTop: 2 }} />
              <div><div style={{ fontSize: 12, fontWeight: 500 }}>Create a Stewardship Team for this domain</div>
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 1 }}>Assign members later under Governance Groups.</div></div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={closeForm}>Cancel</Button>
            <Button variant="primary" disabled={!form.name.trim()} onClick={handleSave}>{editingId ? 'Save Changes' : 'Add Domain'}</Button>
          </div>
        </Card>
      )}

      {/* Main content: dictionary layout */}
      {loading ? (
        <SkeletonRows rows={5} columns={4} />
      ) : generating && !showGeneratePreview ? (
        /* AI generation is in-flight. Without this card the only
           visible feedback is the header IconButton's tooltip
           changing — invisible on hover-less touch and easy to
           miss anywhere else. Mirrors the ValueStreamWizard's
           spinner pattern so users get the same "AI is working,
           expect 10–30s" signal across both wizards. */
        <Card padding="3rem" shadow="none" borderColor="var(--color-primary)" style={{ textAlign: 'center' }}>
          <Spinner size={28} thickness={3} color="var(--color-primary)" style={{ marginBottom: 12 }} />
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: 'var(--color-primary)' }}>Generating data domains…</h2>
          <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            AI is suggesting domains based on your industry. This usually takes 10–30 seconds.
          </p>
        </Card>
      ) : domains.length === 0 && !showForm ? (
        <EmptyState icon={renderNavIcon('/data-domains')} title="No data domains defined yet"
          description="Data domains group related data assets under a single governance umbrella — owner, stewards, policies."
          action={{ label: 'Add Domain', onClick: openAdd }}
          secondaryAction={canWrite && aiEnabled ? { label: 'Generate from Industry', onClick: handleGenerate, variant: 'secondary' } : undefined} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16, alignItems: 'start' }}>
          {/* Left: Domain index */}
          <Card padding={0} shadow="none" style={{ overflow: 'hidden', position: 'sticky', top: 12, maxHeight: 'calc(100vh - 160px)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--color-border)' }}>
              <input aria-label="Search domains" style={{ ...inputStyle, fontSize: 12, padding: '6px 10px' }} placeholder="Search domains..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
              {parentsWithChildren.size > 0 && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={toggleCollapseAll}
                    aria-expanded={!allCollapsed}
                    style={{ background: 'none', border: 'none', color: 'var(--color-primary)', cursor: 'pointer', fontSize: 11, padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    {allCollapsed ? '▸ Expand all' : '▾ Collapse all'}
                  </button>
                </div>
              )}
              {canWrite && filteredDomains.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11, color: 'var(--color-text-muted)' }}>
                  <input
                    type="checkbox"
                    aria-label="Select all visible domains"
                    checked={filteredDomains.every((d) => bulkSelectedIds.has(d.id))}
                    ref={(el) => {
                      if (el) {
                        const some = filteredDomains.some((d) => bulkSelectedIds.has(d.id));
                        const all = filteredDomains.every((d) => bulkSelectedIds.has(d.id));
                        el.indeterminate = some && !all;
                      }
                    }}
                    onChange={() => {
                      const allSelected = filteredDomains.every((d) => bulkSelectedIds.has(d.id));
                      setBulkSelectedIds((prev) => {
                        const next = new Set(prev);
                        if (allSelected) filteredDomains.forEach((d) => next.delete(d.id));
                        else filteredDomains.forEach((d) => next.add(d.id));
                        return next;
                      });
                    }}
                    style={{ cursor: 'pointer' }}
                  />
                  <span>{bulkSelectedIds.size > 0 ? `${bulkSelectedIds.size} selected` : 'Select all visible'}</span>
                  {bulkSelectedIds.size > 0 && (
                    <button onClick={clearBulkSelection} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--color-primary)', cursor: 'pointer', fontSize: 11, padding: 0 }}>Clear</button>
                  )}
                </div>
              )}
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {filteredDomains.length === 0 ? (
                <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 12 }}>No domains match.</div>
              ) : visibleDomains.map((d) => {
                const isActive = selectedDomainId === d.id;
                const isChecked = bulkSelectedIds.has(d.id);
                const isSub = !!d.parentDomainId;
                const isCollapsible = parentsWithChildren.has(d.id);
                const isCollapsed = collapsedIds.has(d.id);
                return (
                  <div key={d.id} {...clickable(() => openDetail(d), { label: `Open domain ${d.name}` })} style={{
                    padding: '10px 12px', paddingLeft: isSub ? 30 : 12, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 8,
                    background: isActive ? '#dbeafe' : isChecked ? '#f0f9ff' : 'transparent',
                    borderBottom: '1px solid var(--color-border)',
                    borderLeft: isActive ? '3px solid var(--color-primary)' : '3px solid transparent',
                    transition: 'background 0.1s',
                  }}
                    onMouseEnter={(e) => { if (!isActive && !isChecked) e.currentTarget.style.background = 'var(--color-bg)'; }}
                    onMouseLeave={(e) => { if (!isActive && !isChecked) e.currentTarget.style.background = 'transparent'; }}>
                    {canWrite && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${d.name}`}
                        checked={isChecked}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleBulkSelect(d.id)}
                        style={{ cursor: 'pointer' }}
                      />
                    )}
                    {/* Fold caret — only on parents that actually have a
                        sub-domain in view. Every other row gets an equal-width
                        spacer so names stay aligned regardless of caret. */}
                    {isCollapsible ? (
                      <button
                        type="button"
                        aria-label={isCollapsed ? `Expand ${d.name}` : `Collapse ${d.name}`}
                        aria-expanded={!isCollapsed}
                        onClick={(e) => { e.stopPropagation(); toggleCollapse(d.id); }}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', width: 14, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', fontSize: 10 }}
                      >
                        {isCollapsed ? '▸' : '▾'}
                      </button>
                    ) : (
                      <span aria-hidden="true" style={{ width: 14, flexShrink: 0, display: 'inline-block' }} />
                    )}
                    {isSub && <span title="Sub-domain" style={{ color: 'var(--color-text-muted)', fontSize: 11, flexShrink: 0 }}>↳</span>}
                    <span style={statusDot(d.status)} title={d.status} />
                    {d.code && (
                      <span title={`Code: ${d.code}`} style={{ flexShrink: 0, fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10, fontWeight: 600, color: 'var(--color-text-secondary)', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 4, padding: '0 5px' }}>{d.code}</span>
                    )}
                    <TruncatedText
                      text={d.name}
                      style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: isActive ? 600 : 400 }}
                    />
                    {/* Governance signal chips: sub-domain count on parents,
                        master/reference-data markers. Kept compact to preserve
                        the uniform row height. */}
                    {!isSub && (d.subDomainCount ?? 0) > 0 && (
                      <span title={`${d.subDomainCount} sub-domain${d.subDomainCount === 1 ? '' : 's'}`} style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-muted)', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '0 6px', flexShrink: 0 }}>
                        {d.subDomainCount} sub
                      </span>
                    )}
                    {d.containsMasterData && (
                      <span title="Contains master data" style={{ fontSize: 10, fontWeight: 700, color: '#7c2d12', background: '#ffedd5', borderRadius: 8, padding: '0 6px', flexShrink: 0 }}>MD</span>
                    )}
                    {!d.criticality && d.suggestedCriticality === 'TIER_1' && (
                      <span title="Holds master data — suggest Tier-1 criticality" style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-warning)', border: '1px dashed var(--color-warning)', borderRadius: 8, padding: '0 6px', flexShrink: 0 }}>Tier-1?</span>
                    )}
                    {healthDots(d)}
                  </div>
                );
              })}
            </div>
            <div style={{ padding: '8px 12px', borderTop: '1px solid var(--color-border)', fontSize: 11, color: 'var(--color-text-muted)', background: 'var(--color-bg)' }}>
              {filteredDomains.length} of {domains.length} domains
            </div>
          </Card>

          {/* Right: Domain detail (or bulk edit panel) */}
          <Card padding={0} shadow="none" style={{ minHeight: 400 }}>
            {bulkSelectedIds.size > 0 ? (
              <div style={{ padding: '24px 28px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                  <div>
                    <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Bulk edit {bulkSelectedIds.size} domain{bulkSelectedIds.size !== 1 ? 's' : ''}</h2>
                    <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4, margin: 0 }}>
                      Pick the fields to change. Empty fields are left untouched. Status changes that aren't a valid transition for a given domain will be skipped.
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={clearBulkSelection}>Clear selection</Button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                  <div>
                    <label style={labelStyle}>Owner</label>
                    <select aria-label="Owner" style={selectStyle} value={bulkUpdates.ownerId} onChange={(e) => setBulkUpdates({ ...bulkUpdates, ownerId: e.target.value })}>
                      <option value="">— No change —</option>
                      <option value="__unassign__">— Clear owner —</option>
                      {people.map((p) => <option key={p.id} value={p.id}>{formatPersonLabel(p)}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Status</label>
                    <select aria-label="Status" style={selectStyle} value={bulkUpdates.status} onChange={(e) => setBulkUpdates({ ...bulkUpdates, status: e.target.value })}>
                      <option value="">— No change —</option>
                      {(statusMode === 'advanced' ? ['DRAFT', 'PROPOSED', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'DEPRECATED'] : ['DRAFT', 'ACTIVE', 'DEPRECATED']).map((s) => (
                        <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
                  <Button variant="secondary" style={{ color: '#991b1b', borderColor: '#fca5a5' }} disabled={applyingBulk} onClick={() => setConfirmBulkDelete(true)}>
                    Delete {bulkSelectedIds.size} domain{bulkSelectedIds.size !== 1 ? 's' : ''}
                  </Button>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button variant="secondary" disabled={applyingBulk} onClick={clearBulkSelection}>Cancel</Button>
                    <Button variant="primary" disabled={applyingBulk} onClick={handleBulkApply}>
                      {applyingBulk ? 'Applying…' : 'Apply changes'}
                    </Button>
                  </div>
                </div>
              </div>
            ) : selectedDomain ? (
              <div style={{ padding: '24px 28px' }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                      <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{selectedDomain.name}</h2>
                      <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, ...(() => { const c = getStatusColor(selectedDomain.status); return { background: c.bg, color: c.color }; })() }}>{selectedDomain.status}</span>
                    </div>
                    {selectedDomain.description && <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.6, margin: 0 }}>{selectedDomain.description}</p>}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {canWrite && aiEnabled && !selectedDomain.parentDomainId && (
                      <IconButton size="sm" icon="wand" label={generating ? 'Generating…' : 'Suggest sub-domains'} disabled={generating} onClick={() => generateSubsForDomain(selectedDomain)} />
                    )}
                    {canWrite && <IconButton size="sm" icon="edit" label="Edit" onClick={() => openEdit(selectedDomain)} />}
                    {canWrite && (
                      <IconButton size="sm" icon="trash" label="Delete" variant="danger" onClick={async () => {
                        try { const r = await apiClient.get<{ success: boolean; data: { assets: number; stewards: number; subDomains?: number; subDomainNames?: string[] } }>(`/data-domains/${selectedDomain.id}/impact`); setDeleteImpact(r.data || null); } catch { setDeleteImpact(null); }
                        setConfirmDelete(selectedDomain.id);
                      }} />
                    )}
                  </div>
                </div>

                {/* Status lifecycle */}
                {canWrite && (transitions[selectedDomain.status] || []).length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={labelStyle}>Status Transitions</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {(transitions[selectedDomain.status] || []).map((s) => (
                        <Button key={s} variant="secondary" size="sm" onClick={() => handleStatusChange(selectedDomain.id, s)}>{s.replace(/_/g, ' ')}</Button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Owner — the label opens the Role Detail drawer for
                  *  Data Domain Owner so users learn the role's
                  *  responsibilities and typical decision authority. */}
                <div style={{ marginBottom: 20 }}>
                  <div style={labelStyle}>
                    <button
                      type="button"
                      onClick={() => openRoleDrawer('DATA_DOMAIN_OWNER')}
                      title="Learn about this role"
                      style={roleLabelBtnStyle}
                    >
                      Owner (Data Domain Owner)
                    </button>
                  </div>
                  <PersonPicker
                    mode="single"
                    valueMode="id"
                    value={detailOwnerId || null}
                    onChange={(pid) => setDetailOwnerId(pid || '')}
                    placeholder="-- Unassigned --"
                  />
                  {/* One-click explicit inheritance — only for a sub-domain that
                      has no owner of its own but whose parent does. Writes a real
                      ownerId (not a display fallback), so the gap clears honestly. */}
                  {canWrite && !detailOwnerId && selectedParentDomain?.ownerId && selectedParentDomain.ownerName && (
                    <button
                      type="button"
                      onClick={inheritOwnerFromParent}
                      style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--color-primary-light)', color: 'var(--color-primary)', border: '1px solid var(--color-primary)', borderRadius: 4, padding: '4px 10px', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}
                      title={`Assign ${selectedParentDomain.ownerName} — the owner of the parent domain "${selectedParentDomain.name}" — as this sub-domain's owner`}
                    >
                      ↰ Inherit owner from {selectedParentDomain.name}: {selectedParentDomain.ownerName}
                    </button>
                  )}
                </div>

                {/* Stewards */}
                <div style={{ marginBottom: 20 }}>
                  <div style={labelStyle}>
                    <button
                      type="button"
                      onClick={() => openRoleDrawer('DATA_DOMAIN_STEWARD')}
                      title="Learn about this role"
                      style={roleLabelBtnStyle}
                    >
                      Stewards ({detailStewardIds.length})
                    </button>
                  </div>
                  <PersonPicker
                    mode="multi"
                    valueMode="id"
                    value={detailStewardIds}
                    onChange={(ids) => setDetailStewardIds(ids as string[])}
                    placeholder="Add stewards…"
                  />
                </div>

                {/* Data Assets */}
                <div style={{ marginBottom: 20 }}>
                  <div style={labelStyle}>Data Assets ({detailAssetIds.length})</div>
                  <input aria-label="Search assets" style={{ ...inputStyle, fontSize: 12, marginBottom: 6 }} placeholder="Search assets..." value={assetSearch} onChange={(e) => setAssetSearch(e.target.value)} />
                  <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--color-border)', borderRadius: 4, padding: 6, background: 'var(--color-bg)' }}>
                    {allAssets.filter((a) => !assetSearch || a.name.toLowerCase().includes(assetSearch.toLowerCase())).map((a) => (
                      <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 4px', cursor: 'pointer' }}>
                        <input type="checkbox" checked={detailAssetIds.includes(a.id)} onChange={() => setDetailAssetIds((prev) => prev.includes(a.id) ? prev.filter((id) => id !== a.id) : [...prev, a.id])} />
                        {a.name}
                      </label>
                    ))}
                  </div>
                </div>

                {/* Save */}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Button variant="primary" onClick={handleDetailSave}>Save Governance Details</Button>
                </div>

                {/* Timestamps */}
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', borderTop: '1px solid var(--color-border)', paddingTop: 12, marginTop: 16 }}>
                  Created {new Date(selectedDomain.createdAt).toLocaleDateString()} · Updated {new Date(selectedDomain.updatedAt).toLocaleDateString()}
                </div>
              </div>
            ) : (
              <div style={{ padding: '4rem 2rem', textAlign: 'center' }}>
                <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Select a domain from the list to view and edit its governance details.</p>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* AI Generate Preview Modal */}
      {/* Industry picker — opens when the active org and its visible
          ancestors carry no `industry`, so the user can still kick off
          a generation. Common for division/department-scoped admins
          whose parent company isn't in their visible org set. */}
      {industryPickerOpen && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1060, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setIndustryPickerOpen(false)}
        >
          <div
            ref={industryPickerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Select industry"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-xl)', padding: 24,
              maxWidth: 480, width: '92vw',
            }}
          >
            <h3 style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Pick an industry</h3>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 14 }}>
              The active organization doesn't have an industry on file. Choose one for this generation and Procela will ask Claude for standard data domains in that industry. Your org isn't modified.
            </p>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 6 }}>
              Industry
            </label>
            <select
              aria-label="Industry"
              value={pickedIndustry}
              onChange={(e) => setPickedIndustry(e.target.value)}
              autoFocus
              style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface)', marginBottom: 18 }}
            >
              {INDUSTRIES.map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setIndustryPickerOpen(false)}
                style={{ padding: '8px 14px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 4, fontSize: 13, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const chosen = pickedIndustry;
                  const pending = pendingGen;
                  setIndustryPickerOpen(false);
                  setPendingGen(null);
                  if (!chosen) return;
                  if (pending?.type === 'branch') {
                    await buildBranch(chosen, pending.domain);
                  } else {
                    await buildTree(chosen);
                  }
                }}
                disabled={!pickedIndustry || generating}
                style={{
                  padding: '8px 14px',
                  background: pickedIndustry ? 'var(--color-primary)' : '#e5e7eb',
                  color: pickedIndustry ? '#fff' : 'var(--color-text-muted)',
                  border: 'none', borderRadius: 4, fontSize: 13, fontWeight: 600,
                  cursor: pickedIndustry ? 'pointer' : 'default',
                }}
              >
                {generating ? 'Generating…' : (pendingGen?.type === 'branch' ? 'Generate sub-domains' : 'Generate domains')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showGeneratePreview && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1050, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={closeGenerate}>
          <div ref={generatePreviewRef} role="dialog" aria-modal="true" aria-label={genBranchMode ? 'Suggest sub-domains' : 'Generate domains'} onClick={(e) => e.stopPropagation()} style={{ background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-xl)', padding: 24, maxWidth: 640, width: '94vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>{genBranchMode ? 'Suggest sub-domains' : 'Generate domains'}</h3>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 14 }}>
              Review the tree — edit any name, uncheck what you don't need, or add your own. Everything selected is created as DRAFT. Names must be unique within their parent.
            </p>
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 4 }}>
              {genTree.map((dom, di) => {
                const dupTop = topDomainConflict(di);
                return (
                  <div key={di} style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '10px 12px', background: dom.selected ? 'var(--color-bg)' : 'transparent' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {dom.existingId ? (
                        <span title="Existing domain" style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-muted)', border: '1px solid var(--color-border)', borderRadius: 4, padding: '1px 5px', flexShrink: 0 }}>PARENT</span>
                      ) : (
                        <input type="checkbox" aria-label={`Include ${dom.name || 'new domain'}`} checked={dom.selected} onChange={() => updateDomain(di, { selected: !dom.selected })} style={{ flexShrink: 0 }} />
                      )}
                      <input
                        aria-label="Domain name"
                        value={dom.name}
                        readOnly={!!dom.existingId}
                        onChange={(e) => updateDomain(di, { name: e.target.value })}
                        placeholder="Domain name"
                        style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, border: '1px solid var(--color-border)', borderRadius: 4, padding: '5px 8px', background: dom.existingId ? 'var(--color-bg)' : 'var(--color-surface)', color: 'var(--color-text)' }}
                      />
                      {!dom.existingId && (
                        <button type="button" aria-label="Remove domain" onClick={() => removeTopDomain(di)} style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 2, flexShrink: 0 }}>×</button>
                      )}
                    </div>
                    {!dom.existingId && (
                      <input
                        aria-label="Domain description"
                        value={dom.description}
                        onChange={(e) => updateDomain(di, { description: e.target.value })}
                        placeholder="Description (optional)"
                        style={{ width: '100%', marginTop: 6, fontSize: 12, border: '1px solid var(--color-border)', borderRadius: 4, padding: '4px 8px', background: 'var(--color-surface)', color: 'var(--color-text-secondary)' }}
                      />
                    )}
                    {dupTop && <div style={{ fontSize: 11, color: 'var(--color-error)', marginTop: 4 }}>A top-level domain with this name already exists.</div>}
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 22 }}>
                      {dom.subDomains.map((sub, si) => {
                        const dupSub = subConflict(di, si);
                        return (
                          <div key={si}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span aria-hidden="true" style={{ color: 'var(--color-text-muted)', fontSize: 11, flexShrink: 0 }}>↳</span>
                              <input type="checkbox" aria-label={`Include ${sub.name || 'new sub-domain'}`} checked={sub.selected} onChange={() => updateSub(di, si, { selected: !sub.selected })} style={{ flexShrink: 0 }} />
                              <input aria-label="Sub-domain name" value={sub.name} onChange={(e) => updateSub(di, si, { name: e.target.value })} placeholder="Sub-domain name" style={{ flex: 1, minWidth: 0, fontSize: 13, border: '1px solid var(--color-border)', borderRadius: 4, padding: '4px 8px', background: 'var(--color-surface)', color: 'var(--color-text)' }} />
                              {genTree.length > 1 && (
                                <select
                                  aria-label="Move sub-domain to another domain"
                                  title="Move to another domain"
                                  value=""
                                  onChange={(e) => { const to = Number(e.target.value); if (Number.isInteger(to)) moveSub(di, si, to); }}
                                  style={{ flexShrink: 0, fontSize: 11, border: '1px solid var(--color-border)', borderRadius: 4, padding: '3px 4px', background: 'var(--color-surface)', color: 'var(--color-text-muted)', cursor: 'pointer', maxWidth: 130 }}
                                >
                                  <option value="">Move to…</option>
                                  {genTree.map((d2, di2) => (di2 !== di ? (
                                    <option key={di2} value={di2}>{d2.name.trim() || `Untitled domain ${di2 + 1}`}</option>
                                  ) : null))}
                                </select>
                              )}
                              <button type="button" aria-label="Remove sub-domain" onClick={() => removeSub(di, si)} style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 2, flexShrink: 0 }}>×</button>
                            </div>
                            {dupSub && <div style={{ fontSize: 11, color: 'var(--color-error)', marginTop: 2, paddingLeft: 41 }}>Duplicate name under this parent.</div>}
                          </div>
                        );
                      })}
                      <button type="button" onClick={() => addSub(di)} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--color-primary)', cursor: 'pointer', fontSize: 12, padding: '2px 0' }}>+ Add sub-domain</button>
                    </div>
                  </div>
                );
              })}
              {!genBranchMode && (
                <button type="button" onClick={addTopDomain} style={{ alignSelf: 'flex-start', background: 'none', border: '1px dashed var(--color-border)', color: 'var(--color-primary)', cursor: 'pointer', fontSize: 13, padding: '6px 12px', borderRadius: 6 }}>+ Add domain</button>
              )}
            </div>
            {!genBranchMode && (
              <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="checkbox" checked={generateStewardshipTeams} onChange={(e) => setGenerateStewardshipTeams(e.target.checked)} />
                <div style={{ fontSize: 12, fontWeight: 500 }}>Also create Stewardship Teams for new top-level domains</div>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <Button variant="secondary" onClick={closeGenerate}>Cancel</Button>
              <Button variant="primary" disabled={!genHasCreatable || genHasError} onClick={handleApplyGenerated}>Create selected</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
