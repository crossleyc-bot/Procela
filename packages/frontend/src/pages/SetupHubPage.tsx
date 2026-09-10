import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '@/api/client';
import { useOrgContext } from '@/stores/orgContext';
import { useSetupStore } from '@/stores/setupStore';
import { useToastStore } from '@/stores/toastStore';
import { usePermissions } from '@/hooks/usePermissions';
import Page from '@/components/Page';
import PageHeader from '@/components/PageHeader';
import Spinner from '@/components/Spinner';
import ConfirmDialog from '@/components/ConfirmDialog';

// ──────────────────────────────────────────────────────────────────────────
// SetupHubPage — "Set up Procela". A single four-stage journey from an empty
// org to a running governance program:
//
//   ① Capture  → ② Assign → ③ Govern → ④ Operate
//
// Onboarding the organization (Capture, Assign) and standing up the
// governance program (Govern, Operate) are one spine, not two tracks:
// onboarding IS the first half of standing up governance. The program's
// lifecycle (Planning → Active → Paused → Completed) lives at the top and
// governs the whole arc.
//
// There is deliberately NO overall percentage — a single number that mixes
// "have I added my systems" with "is the program launched" is meaningless and
// oscillates. Each stage carries its own count instead. Every item's status is
// DERIVED from live data (dashboard stats + governance-program status), so the
// page is accurate each time it opens. The one number published back to
// setupStore (for the sidebar ring + auto-hide) spans the full journey —
// all four stages (Capture/Assign/Govern/Operate) — so the ring only fills,
// and the guide only auto-hides, once the program is actually stood up.
// ──────────────────────────────────────────────────────────────────────────

const COVERAGE_DONE_THRESHOLD = 80;

interface DashStats {
  people: number;
  valueStreams: number;
  processes: number;
  activities: number;
  systems: number;
  dataAssets: number;
  dataDomains: number;
  coverage: { mapped: number; unmapped: number; percentage: number };
  governance: { bronze: number; silver: number; gold: number };
  gaps: {
    unmappedActivities: number;
    ungovernedAssets: number;
    ownerlessItems: number;
    ownerlessSystems: number;
    ownerlessAssets: number;
    ungovernedDomains: number;
  };
}

interface ProgPhase { name: string; completed: boolean; progress: number; checks: { done: boolean }[] }
interface ProgStatus {
  currentPhase: 1 | 2 | 3 | 4;
  phases: { phase1: ProgPhase; phase2: ProgPhase; phase3: ProgPhase; phase4: ProgPhase };
  overallProgress: number;
}
type ProgramStatus = 'PLANNING' | 'ACTIVE' | 'PAUSED' | 'COMPLETED';
interface Prog { id: string; status: ProgramStatus; launchedAt?: string | null }
interface IncompletePhase { phase: number; name: string; missing: string[] }

// Client mirror of the backend lifecycle state machine — the backend is
// authoritative; this only decides which transition buttons to show. Ported
// from the (removed) Governance Program page, whose governed lifecycle
// transitions now live on the Get Started lifecycle bar.
const VALID_TRANSITIONS: Record<ProgramStatus, ProgramStatus[]> = {
  PLANNING: ['ACTIVE'],
  ACTIVE: ['PAUSED', 'COMPLETED'],
  PAUSED: ['ACTIVE', 'COMPLETED'],
  COMPLETED: ['ACTIVE'],
};
const STATUS_ACTION_LABEL: Record<string, string> = {
  'PLANNING>ACTIVE': 'Launch program',
  'PAUSED>ACTIVE': 'Resume program',
  'COMPLETED>ACTIVE': 'Reopen program',
  'ACTIVE>PAUSED': 'Pause program',
  'ACTIVE>COMPLETED': 'Complete program',
  'PAUSED>COMPLETED': 'Complete program',
};
// Next Actions priority palette. Board-derived: items in the current stage
// are HIGH (do these now), items in later stages are NEXT.
const PRIORITY_PALETTE = {
  HIGH: { bg: '#fef2f2', color: '#b91c1c', label: 'HIGH' },
  NEXT: { bg: '#eff6ff', color: '#1d4ed8', label: 'NEXT' },
} as const;

type Src = 'here' | 'auto';
// `detail` is a quantified sub-line for Next Actions ("4 processes need an
// owner"), derived from stats.gaps; `cta` is the verb-specific button label
// ("Assign owners") that replaces a generic "Go". Both are only surfaced for
// un-done items in the Next Actions list.
interface StageItem { label: string; done: boolean; to: string; src: Src; detail?: string; cta?: string }

// "3 assets" / "1 asset" — count with a correctly-pluralised noun.
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
interface Stage { num: number; name: string; color: string; blurb: string; items: StageItem[] }

// Per-stage accent — Capture blue, Assign purple, Govern green, Operate amber.
// The four flow left→right through the stepper and the board.
const STAGE_COLOR = ['#3b82f6', '#8b5cf6', '#22c55e', '#f59e0b'];

const LIFECYCLE: Array<{ key: Prog['status']; label: string }> = [
  { key: 'PLANNING', label: 'Planning' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'PAUSED', label: 'Paused' },
  { key: 'COMPLETED', label: 'Completed' },
];
const STATUS_PILL: Record<Prog['status'], { bg: string; fg: string }> = {
  PLANNING: { bg: '#e0edff', fg: '#1d4ed8' },
  ACTIVE: { bg: '#dcfce7', fg: '#15803d' },
  PAUSED: { bg: '#fef3c7', fg: '#b45309' },
  COMPLETED: { bg: '#ede9fe', fg: '#6d28d9' },
};

export default function SetupHubPage() {
  const navigate = useNavigate();
  const { activeOrgId, activeOrgName, orgs, refreshKey } = useOrgContext();
  const { setProgress, setVisibility } = useSetupStore();
  const { isAdmin } = usePermissions();
  const addToast = useToastStore((s) => s.addToast);
  const hideGuide = () => {
    setVisibility('hidden');
    addToast('info', 'Get Started hidden from the sidebar. Turn it back on in Settings → Get Started guide.');
  };

  const [stats, setStats] = useState<DashStats | null>(null);
  const [prog, setProg] = useState<Prog | null>(null);
  const [status, setStatus] = useState<ProgStatus | null>(null);
  const [loading, setLoading] = useState(true);
  // Locally bump to re-run the loader after a governed lifecycle transition.
  const [reload, setReload] = useState(0);
  // Next Actions collapses the later-stage (NEXT) items behind a "show more"
  // so the current-stage (HIGH) work leads; this toggles the full list.
  const [showAllLater, setShowAllLater] = useState(false);

  // Governed status-transition dialog state (ported from the Program page).
  const [statusTarget, setStatusTarget] = useState<ProgramStatus | null>(null);
  const [statusReason, setStatusReason] = useState('');
  const [earlyLaunchInfo, setEarlyLaunchInfo] = useState<IncompletePhase[] | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);

  useEffect(() => {
    if (!activeOrgId) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    Promise.all([
      // Process-side counts reflect only the operational domain, so the canned
      // governance value stream never masquerades as business-process progress.
      apiClient.get<{ success: boolean; data: DashStats }>(`/dashboard/stats?orgId=${activeOrgId}&domain=OPERATIONAL`),
      apiClient.get<{ success: boolean; data: Prog | null }>(`/governance-program?orgId=${activeOrgId}`).catch(() => ({ data: null as Prog | null })),
    ]).then(async ([statsRes, progRes]) => {
      if (!alive) return;
      setStats(statsRes.data);
      const p = progRes.data;
      setProg(p);
      if (p) {
        try {
          const s = await apiClient.get<{ success: boolean; data: ProgStatus }>(`/governance-program/${p.id}/status`);
          if (alive) setStatus(s.data);
        } catch { /* status may not be available yet */ }
      } else if (alive) {
        setStatus(null);
      }
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeOrgId, refreshKey, reload]);

  // Governed status change. The backend enforces role, valid transitions, the
  // Phase-1 hard prerequisite, and the early-launch soft gate:
  //   400 blockingPhase   → hard-blocked, show what's missing
  //   409 requiresConfirm → open the early-launch confirm, retry with force
  const changeStatus = async (to: ProgramStatus, opts: { force?: boolean; reason?: string } = {}) => {
    if (!prog) return;
    setStatusBusy(true);
    try {
      const res = await apiClient.put<{ success: boolean; data: Prog }>(
        `/governance-program/${prog.id}`,
        { status: to, ...(opts.force ? { force: true } : {}), ...(opts.reason ? { reason: opts.reason } : {}) },
      );
      if (res.data) setProg(res.data);
      addToast('success', `Program ${to.toLowerCase()}.`);
      setStatusTarget(null);
      setStatusReason('');
      setEarlyLaunchInfo(null);
      setReload((n) => n + 1);
    } catch (e: any) {
      const body = (e && typeof e === 'object' && 'body' in e ? e.body : null) || {};
      if (body?.requiresConfirmation && Array.isArray(body.incompletePhases)) {
        setEarlyLaunchInfo(body.incompletePhases);
        setStatusTarget(to);
      } else if (body?.blockingPhase) {
        addToast('error', `${body.error} Missing: ${(body.missing || []).join(', ')}`);
        setStatusTarget(null);
      } else {
        addToast('error', body?.error || e?.message || 'Status change failed');
        setStatusTarget(null);
      }
    } finally {
      setStatusBusy(false);
    }
  };

  const startTransition = (to: ProgramStatus) => {
    if (!activeOrgId || !prog) { addToast('error', 'Select an organization first.'); return; }
    setStatusReason('');
    setEarlyLaunchInfo(null);
    if (to === 'ACTIVE' && prog.status === 'PLANNING') changeStatus('ACTIVE');
    else setStatusTarget(to);
  };

  const orgCount = orgs.length;

  const stages: Stage[] = useMemo(() => {
    const s = stats;
    const gt = (n?: number) => (n ?? 0) > 0;
    const ph = status?.phases;

    const capture: StageItem[] = [
      { label: 'Organization', done: orgCount > 0, to: '/organizations', src: 'here', detail: 'No organization yet', cta: 'Add organization' },
      { label: 'People', done: gt(s?.people), to: '/people', src: 'here', detail: 'No people added yet', cta: 'Add people' },
      { label: 'Processes', done: gt(s?.valueStreams), to: '/processes', src: 'here', detail: 'No value streams yet', cta: 'Add processes' },
      { label: 'Systems', done: gt(s?.systems), to: '/systems', src: 'here', detail: 'No systems yet', cta: 'Add systems' },
      { label: 'Data assets', done: gt(s?.dataAssets), to: '/data-assets', src: 'here', detail: 'No data assets yet', cta: 'Add data assets' },
    ];
    // One row per ownable entity type (Process, System, Domain, Data asset).
    // Each deep-links to that type's own page — the Process Catalog, Systems,
    // Data Domains, Data Assets — where you assign owners in context, and each
    // is "done" only once that type exists and none of its items are ownerless.
    // `detail` quantifies what's left from stats.gaps; when the type doesn't
    // exist yet the count is meaningless, so point back to Capture instead.
    const assign: StageItem[] = [
      { label: 'Process ownership', done: !!s && s.valueStreams > 0 && s.gaps.ownerlessItems === 0, to: '/processes', src: 'auto', cta: 'Assign owners',
        detail: !s ? undefined : s.valueStreams === 0 ? 'Add processes first' : `${plural(s.gaps.ownerlessItems, 'item')} need an owner` },
      { label: 'System ownership', done: !!s && s.systems > 0 && s.gaps.ownerlessSystems === 0, to: '/systems', src: 'auto', cta: 'Assign owners',
        detail: !s ? undefined : s.systems === 0 ? 'Add systems first' : `${plural(s.gaps.ownerlessSystems, 'system')} need an owner` },
      { label: 'Domain ownership', done: !!s && s.dataDomains > 0 && s.gaps.ungovernedDomains === 0, to: '/data-domains', src: 'auto', cta: 'Assign owners',
        detail: !s ? undefined : s.dataDomains === 0 ? 'Add domains first' : `${plural(s.gaps.ungovernedDomains, 'domain')} need an owner` },
      { label: 'Data asset ownership', done: !!s && s.dataAssets > 0 && s.gaps.ownerlessAssets === 0, to: '/data-assets', src: 'auto', cta: 'Assign owners',
        detail: !s ? undefined : s.dataAssets === 0 ? 'Add data assets first' : `${plural(s.gaps.ownerlessAssets, 'asset')} need an owner` },
    ];
    const govern: StageItem[] = [
      { label: 'Connect data to processes', done: !!s && s.activities > 0 && s.coverage.percentage >= COVERAGE_DONE_THRESHOLD, to: '/mappings', src: 'here', cta: 'Connect data',
        detail: !s ? undefined : s.activities === 0 ? 'Add activities first' : `${plural(s.gaps.unmappedActivities, 'activity', 'activities')} need data linked (${s.coverage.percentage}% covered)` },
      { label: 'Tier & grade assets', done: !!s && s.dataAssets > 0 && s.gaps.ungovernedAssets === 0, to: '/data-assets', src: 'here', cta: 'Grade assets',
        detail: !s ? undefined : s.dataAssets === 0 ? 'Add data assets first' : `${plural(s.gaps.ungovernedAssets, 'asset')} need a governance tier` },
      { label: 'Governance foundation', done: !!ph?.phase1.completed, to: '/governance/foundation', src: 'here', cta: 'Set up',
        detail: ph ? `Foundation ${ph.phase1.progress}% complete` : 'Set scope, principles & operating model' },
    ];
    // Operate reads strictly top-to-bottom: "Program launched" is gated
    // behind the structure and roles/policies it depends on, so it never
    // checks ahead of them even when the program's lifecycle is already
    // ACTIVE (the lifecycle badge at the top still shows the true status).
    const structureDone = !!ph?.phase2.completed;
    const rolesPoliciesDone = !!(ph?.phase3.completed && ph?.phase4.completed);
    const launched = prog?.status === 'ACTIVE' || prog?.status === 'COMPLETED';
    const operate: StageItem[] = [
      { label: 'Governance structure', done: structureDone, to: '/governance-groups', src: 'auto', cta: 'Set up',
        detail: ph ? `Structure ${ph.phase2.progress}% complete` : 'Create governance groups' },
      { label: 'Roles & policies', done: rolesPoliciesDone, to: '/dama-roles', src: 'auto', cta: 'Set up',
        detail: 'Assign DAMA roles & publish policies' },
      // Launch happens on this page's lifecycle bar — empty `to` scrolls there.
      { label: 'Program launched', done: launched && structureDone && rolesPoliciesDone, to: '', src: 'auto', cta: 'Launch',
        detail: 'Finish the steps above, then launch' },
    ];

    return [
      { num: 1, name: 'Capture', color: STAGE_COLOR[0], blurb: 'Tell Procela about your business.', items: capture },
      { num: 2, name: 'Assign', color: STAGE_COLOR[1], blurb: 'Give everything a clear owner.', items: assign },
      { num: 3, name: 'Govern', color: STAGE_COLOR[2], blurb: 'Wrap governance around the data.', items: govern },
      { num: 4, name: 'Operate', color: STAGE_COLOR[3], blurb: 'Run the program day to day.', items: operate },
    ];
  }, [stats, orgCount, prog, status]);

  const counts = useMemo(
    () => stages.map((st) => ({ done: st.items.filter((i) => i.done).length, total: st.items.length })),
    [stages],
  );
  // Current stage = the first that isn't fully done (else the last).
  const currentIdx = useMemo(() => {
    const idx = counts.findIndex((c) => c.done < c.total);
    return idx === -1 ? stages.length - 1 : idx;
  }, [counts, stages.length]);

  // Next Actions are derived directly from the board's unchecked items, in
  // stage order, so the two always agree. Items in the current stage are HIGH
  // (do these now); items in later stages are NEXT.
  const nextActions = useMemo(() => {
    const out: { stage: Stage; item: StageItem; priority: 'HIGH' | 'NEXT' }[] = [];
    stages.forEach((st, i) => {
      st.items.forEach((it) => {
        if (!it.done) out.push({ stage: st, item: it, priority: i === currentIdx ? 'HIGH' : 'NEXT' });
      });
    });
    return out;
  }, [stages, currentIdx]);

  // Lead with the current stage (HIGH) shown in full; the later-stage (NEXT)
  // items are collapsed behind a "show more" so the list reads as "do this
  // now" rather than a flat wall of everything outstanding.
  const highActions = useMemo(() => nextActions.filter((a) => a.priority === 'HIGH'), [nextActions]);
  const laterActions = useMemo(() => nextActions.filter((a) => a.priority === 'NEXT'), [nextActions]);
  const LATER_PREVIEW = 3;
  const shownLater = showAllLater ? laterActions : laterActions.slice(0, LATER_PREVIEW);

  // Sidebar ring / auto-hide track the full journey — all four stages
  // (Capture/Assign/Govern/Operate) — so the ring only fills, and the guide
  // only auto-hides, once the program is actually stood up and running.
  useEffect(() => {
    if (!activeOrgId || loading || !stats) return;
    let done = 0, total = 0;
    for (let i = 0; i < counts.length; i++) { done += counts[i].done; total += counts[i].total; }
    setProgress(activeOrgId, total > 0 ? Math.round((done / total) * 100) : 0);
  }, [activeOrgId, loading, stats, counts, setProgress]);

  if (!activeOrgId) {
    return (
      <Page width="narrow" padding="48px 0">
        <div style={{ textAlign: 'center', color: 'var(--color-text-secondary)' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-text)', marginBottom: 8 }}>Set up Procela</h1>
          <p>Select or create an organization from the header to begin.</p>
          <button onClick={() => navigate('/organizations')} style={primaryBtn}>Go to Organizations</button>
        </div>
      </Page>
    );
  }

  const progStatus: Prog['status'] = prog?.status ?? 'PLANNING';
  const pill = STATUS_PILL[progStatus];
  const launchedLabel = prog?.launchedAt
    ? new Date(prog.launchedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  return (
    <Page padding="8px 0 64px">
      <PageHeader
        title="Set up Procela"
        subtitle={`One journey from an empty org to a running governance program for ${activeOrgName}.`}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="button" onClick={hideGuide} style={textBtnStyle}
              title="Hide the Get Started guide from the sidebar. Turn it back on any time in Settings.">
              Hide guide
            </button>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, padding: '5px 12px', borderRadius: 20, background: pill.bg, color: pill.fg }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: pill.fg }} />
              {LIFECYCLE.find((l) => l.key === progStatus)?.label}
            </span>
          </div>
        }
      />

      {loading ? (
        <Spinner center label="Loading your setup status…" />
      ) : (
        <>
          {/* Lifecycle strip — the program status the whole arc drives toward. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            {LIFECYCLE.map((l, i) => (
              <span key={l.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600,
                  padding: '5px 12px', borderRadius: 999,
                  border: `1px solid ${l.key === progStatus ? pill.fg : 'var(--color-border)'}`,
                  background: l.key === progStatus ? pill.bg : 'transparent',
                  color: l.key === progStatus ? pill.fg : 'var(--color-text-muted)',
                }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: l.key === progStatus ? pill.fg : 'var(--color-border)' }} />
                  {l.label}
                </span>
                {i < LIFECYCLE.length - 1 && <span style={{ color: 'var(--color-text-muted)' }}>→</span>}
              </span>
            ))}
            {launchedLabel && (
              <span style={{ fontSize: 12.5, color: 'var(--color-text-muted)', marginLeft: 4 }}>
                Launched <strong style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>{launchedLabel}</strong>
              </span>
            )}
            {!prog ? (
              <button onClick={() => navigate('/governance/foundation')} style={{ ...primaryBtn, marginLeft: 'auto' }}>Set up program &rarr;</button>
            ) : (
              // Governed lifecycle transitions (role-gated + audited), moved here
              // from the removed Governance Program page.
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(VALID_TRANSITIONS[progStatus] || []).map((to) => {
                  const label = STATUS_ACTION_LABEL[`${progStatus}>${to}`] || `Set ${to}`;
                  const isPrimary = to === 'ACTIVE';
                  const isDanger = to === 'COMPLETED';
                  // Foundation (Phase 1) is a hard prerequisite for going ACTIVE
                  // — the backend rejects it, so disable the button rather than
                  // let it fail. Later phases stay allowed (audited early launch).
                  const needsFoundation = to === 'ACTIVE' && !status?.phases.phase1.completed;
                  const disabled = !isAdmin || statusBusy || needsFoundation;
                  const title = !isAdmin ? 'Only an admin / program owner can change the program status'
                    : needsFoundation ? 'Complete the Foundation (Phase 1) — scope, principles, and operating model — before launching.'
                    : undefined;
                  return (
                    <button
                      key={to}
                      disabled={disabled}
                      title={title}
                      onClick={() => startTransition(to)}
                      style={{
                        ...primaryBtn,
                        background: disabled ? 'var(--color-border)' : isDanger ? '#b91c1c' : isPrimary ? 'var(--color-primary)' : 'var(--color-surface)',
                        color: disabled ? 'var(--color-text-muted)' : (isPrimary || isDanger) ? '#fff' : 'var(--color-text)',
                        border: isPrimary || isDanger ? 'none' : '1px solid var(--color-border)',
                        cursor: disabled ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Stage line — the single honest summary, no overall %. The board
              below carries the per-stage detail, so the redundant stepper that
              used to sit here has been removed. */}
          <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', marginBottom: 16 }}>
            <strong style={{ color: 'var(--color-text)' }}>Stage {currentIdx + 1} of 4 · {stages[currentIdx].name}</strong>
            {' — '}{counts[currentIdx].done} of {counts[currentIdx].total} done. Each stage carries its own count; there’s no overall %.
          </div>

          {/* Board — one column per stage. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            {stages.map((st, i) => {
              const c = counts[i];
              return (
                <div key={st.num} style={{ border: '1px solid var(--color-border)', borderRadius: 10, padding: 14, background: 'var(--color-surface)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ width: 22, height: 22, borderRadius: '50%', background: c.done >= c.total ? '#22c55e' : st.color, color: '#fff', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800, flexShrink: 0 }}>{c.done >= c.total ? '✓' : st.num}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.name}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600 }}>{c.done}/{c.total}</span>
                  </div>
                  {/* segmented progress */}
                  <div style={{ display: 'flex', gap: 2, height: 5, marginBottom: 12 }}>
                    {st.items.map((it, k) => (
                      <span key={k} style={{ flex: 1, borderRadius: 2, background: it.done ? '#22c55e' : 'var(--color-border)' }} />
                    ))}
                  </div>
                  {/* checklist */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {st.items.map((it) => (
                      <button
                        key={it.label}
                        type="button"
                        onClick={() => it.to ? navigate(it.to) : window.scrollTo({ top: 0, behavior: 'smooth' })}
                        title={it.src === 'here' ? 'You define this here in Procela' : 'Derived automatically from your catalog'}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                          background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit',
                          padding: '5px 2px', fontFamily: 'inherit', borderRadius: 6,
                        }}
                      >
                        <span style={{
                          width: 15, height: 15, flexShrink: 0, borderRadius: 4,
                          border: it.done ? 'none' : '1.5px solid var(--color-border)',
                          background: it.done ? '#22c55e' : 'transparent',
                          color: '#fff', display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 800,
                        }}>{it.done ? '✓' : ''}</span>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: it.done ? 'var(--color-text)' : 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                        <span style={{
                          flexShrink: 0, fontSize: 9, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase',
                          padding: '1px 5px', borderRadius: 4,
                          background: it.src === 'here' ? 'var(--color-primary-light)' : 'var(--color-bg)',
                          color: it.src === 'here' ? 'var(--color-primary)' : 'var(--color-text-muted)',
                          border: it.src === 'here' ? 'none' : '1px solid var(--color-border)',
                        }}>{it.src === 'here' ? 'Here' : 'Auto'}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Legend */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 14, fontSize: 11, color: 'var(--color-text-muted)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', padding: '1px 5px', borderRadius: 4, background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}>Here</span>
              you define it in Procela
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', padding: '1px 5px', borderRadius: 4, background: 'var(--color-bg)', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)' }}>Auto</span>
              derived from your catalog
            </span>
          </div>

          {/* Next Actions — derived from the board's unchecked items so the two
              always agree. Current-stage items (HIGH) render in full with a
              quantified sub-line + a verb CTA; later-stage items (NEXT) collapse
              behind a "show more". When nothing's left, a done state stands in
              instead of the section simply vanishing. */}
          <div style={{ marginTop: 28, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, padding: 20 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Next Actions</h3>

            {nextActions.length === 0 ? (
              // #4 — all board items checked (and, for Operate, the program is
              // launched). Affirm it instead of hiding the section.
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', border: '1px solid var(--color-success)', borderRadius: 'var(--radius-md)', background: 'color-mix(in srgb, var(--color-success) 8%, transparent)' }}>
                <span style={{ fontSize: 18, color: 'var(--color-success)', flexShrink: 0 }}>✓</span>
                <span style={{ fontSize: 13, color: 'var(--color-text)' }}>
                  <strong>You're all set.</strong> Every setup step is complete and your governance program is live.
                </span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* HIGH — the current stage, in full detail. */}
                {highActions.map(({ stage, item, priority }, idx) => {
                  const pr = PRIORITY_PALETTE[priority];
                  return (
                    <div key={`hi-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg)' }}>
                      <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', background: pr.bg, color: pr.color, flexShrink: 0, minWidth: 38, textAlign: 'center' }}>{pr.label}</span>
                      <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600, background: stage.color + '20', color: stage.color, flexShrink: 0 }}>{stage.name}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>
                          {item.label}
                          {item.src === 'auto' && (
                            <span title="Checks off automatically as you do the underlying work" style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', padding: '1px 5px', borderRadius: 4, background: 'var(--color-bg)', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)' }}>Auto</span>
                          )}
                        </span>
                        {item.detail && <span style={{ display: 'block', fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>{item.detail}</span>}
                      </span>
                      <button
                        onClick={() => item.to ? navigate(item.to) : window.scrollTo({ top: 0, behavior: 'smooth' })}
                        style={{ background: 'none', border: 'none', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', cursor: 'pointer', flexShrink: 0, padding: 0, whiteSpace: 'nowrap' }}
                      >{item.cta || 'Go'} &rarr;</button>
                    </div>
                  );
                })}

                {/* NEXT — later stages, compact and collapsed by default. */}
                {laterActions.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-muted)', marginTop: 8, marginBottom: 2 }}>Coming up</div>
                    {shownLater.map(({ stage, item }, idx) => (
                      <div key={`lt-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'var(--color-surface)' }}>
                        <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600, background: stage.color + '20', color: stage.color, flexShrink: 0 }}>{stage.name}</span>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--color-text-secondary)' }}>{item.label}</span>
                        <button
                          onClick={() => item.to ? navigate(item.to) : window.scrollTo({ top: 0, behavior: 'smooth' })}
                          style={{ background: 'none', border: 'none', fontSize: 12, fontWeight: 500, color: 'var(--color-primary)', cursor: 'pointer', flexShrink: 0, padding: 0, whiteSpace: 'nowrap' }}
                        >{item.cta || 'Go'} &rarr;</button>
                      </div>
                    ))}
                    {laterActions.length > LATER_PREVIEW && (
                      <button
                        onClick={() => setShowAllLater((v) => !v)}
                        style={{ alignSelf: 'flex-start', background: 'none', border: 'none', fontSize: 12, fontWeight: 500, color: 'var(--color-text-muted)', cursor: 'pointer', padding: '4px 0' }}
                      >{showAllLater ? 'Show less' : `Show ${laterActions.length - LATER_PREVIEW} more`}</button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Early-launch confirmation — phases incomplete; backend returned the
          list, admin confirms to force it. Ported from the Program page. */}
      <ConfirmDialog
        open={!!earlyLaunchInfo}
        title="Launch with incomplete phases?"
        message="The program isn't fully set up. Launching now marks it active in the scorecard and dashboards with these gaps:"
        confirmLabel="Launch anyway"
        variant="danger"
        onConfirm={() => statusTarget && changeStatus(statusTarget, { force: true, reason: statusReason })}
        onCancel={() => { setEarlyLaunchInfo(null); setStatusTarget(null); setStatusReason(''); }}
      >
        <div style={{ marginTop: 8, marginBottom: 12 }}>
          {(earlyLaunchInfo || []).map((p) => (
            <div key={p.phase} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Phase {p.phase} — {p.name}</div>
              <ul style={{ margin: '2px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                {p.missing.map((m) => <li key={m}>{m}</li>)}
              </ul>
            </div>
          ))}
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginTop: 8, marginBottom: 4 }}>Reason (recorded in the audit log)</label>
          <input
            aria-label="Reason (recorded in the audit log)"
            value={statusReason}
            onChange={(e) => setStatusReason(e.target.value)}
            placeholder="e.g. running a 30-day pilot ahead of full rollout"
            style={{ width: '100%', padding: '6px 10px', fontSize: 12, border: '1px solid var(--color-border)', borderRadius: 6, boxSizing: 'border-box' }}
          />
        </div>
      </ConfirmDialog>

      {/* Plain transition confirmation — Pause / Resume / Complete / Reopen.
          (Launch from PLANNING goes direct; the backend may bounce it into the
          early-launch dialog above.) */}
      <ConfirmDialog
        open={statusTarget !== null && !earlyLaunchInfo}
        title={
          statusTarget === 'COMPLETED' ? 'Complete this program?'
          : statusTarget === 'PAUSED' ? 'Pause this program?'
          : statusTarget === 'ACTIVE' && prog?.status === 'COMPLETED' ? 'Reopen this completed program?'
          : statusTarget === 'ACTIVE' ? 'Resume this program?'
          : 'Change program status?'
        }
        message={
          statusTarget === 'COMPLETED' ? 'Completed marks the program as closed out. Reopening later is possible but is an explicit, audited action.'
          : statusTarget === 'PAUSED' ? 'Pausing keeps all configuration but signals the program is not actively operating (e.g. a reorg or budget freeze).'
          : statusTarget === 'ACTIVE' && prog?.status === 'COMPLETED' ? 'This moves a closed program back to active. The reopen is recorded in the audit log.'
          : 'This resumes active operations.'
        }
        confirmLabel={statusTarget ? (STATUS_ACTION_LABEL[`${prog?.status}>${statusTarget}`] || `Set ${statusTarget}`) : 'Confirm'}
        variant={statusTarget === 'COMPLETED' ? 'danger' : 'primary'}
        onConfirm={() => statusTarget && changeStatus(statusTarget, { reason: statusReason })}
        onCancel={() => { setStatusTarget(null); setStatusReason(''); }}
      >
        <div style={{ marginTop: 8 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Reason (optional — recorded in the audit log)</label>
          <input
            aria-label="Reason (optional — recorded in the audit log)"
            value={statusReason}
            onChange={(e) => setStatusReason(e.target.value)}
            placeholder="Why is the status changing?"
            style={{ width: '100%', padding: '6px 10px', fontSize: 12, border: '1px solid var(--color-border)', borderRadius: 6, boxSizing: 'border-box' }}
          />
        </div>
      </ConfirmDialog>
    </Page>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: '7px 16px', background: 'var(--color-primary)', color: '#fff', border: 'none',
  borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
};
const textBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', padding: '2px 4px',
  color: 'var(--color-primary)', cursor: 'pointer',
  fontSize: 12, fontFamily: 'inherit',
};
