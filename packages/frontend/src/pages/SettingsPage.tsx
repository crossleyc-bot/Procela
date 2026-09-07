import { useState, useEffect, useRef, useCallback } from 'react';
import {
  startRegistration as startWebauthnRegistration,
} from '@simplewebauthn/browser';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiClient } from '../api/client';
import { errorMessage } from '../lib/errorToast';
import Page from '../components/Page';
import PageHeader from '../components/PageHeader';
import Card from '../components/Card';
import Spinner from '../components/Spinner';
import SectionLabel from '../components/SectionLabel';
import ConfirmDialog from '../components/ConfirmDialog';
import ConnectorsSection from '../components/ConnectorsSection';
import AiSettingsPanel from '../components/AiSettingsPanel';
import { useAiEnabled } from '../stores/aiConfigStore';
import { useRegimeStore } from '../stores/regimeStore';
import { useComplianceStore, BUILTIN_COMPLIANCE_FRAMEWORKS } from '../stores/complianceStore';
import ActiveSessionsPanel from '../components/ActiveSessionsPanel';
import ResetAllDataPanel from '../components/ResetAllDataPanel';
import LoadDemoDataPanel from '../components/LoadDemoDataPanel';
import { useAuthStore } from '@/stores/authStore';
import { Link } from 'react-router-dom';
import { useOrgContext } from '../stores/orgContext';
import { useToastStore } from '../stores/toastStore';
import SecondaryButton from '../components/SecondaryButton';
import { useSetupStore, type GetStartedVisibility } from '@/stores/setupStore';

interface AuthConfigData {
  provider: string;
  providerName: string;
  oidcConfigured: boolean;
  issuerUrl: string;
  clientId: string;
}

interface AuthConfigResponse {
  success: boolean;
  data: AuthConfigData;
}

// The form uses "display" provider values (dev, local, microsoft,
// okta) which map to the backend's provider types (dev, local, oidc).
// Local is its own backend type — credentials stored on the Person
// record as Argon2 hashes; no IdP required.
type DisplayProvider = 'dev' | 'local' | 'microsoft' | 'okta';

function displayProviderToBackend(dp: DisplayProvider): string {
  if (dp === 'microsoft' || dp === 'okta') return 'oidc';
  if (dp === 'local') return 'local';
  return 'dev';
}

function backendToDisplayProvider(backendProvider: string, issuerUrl: string): DisplayProvider {
  if (backendProvider === 'local') return 'local';
  if (backendProvider !== 'oidc') return 'dev';
  if (issuerUrl.includes('microsoftonline.com') || issuerUrl.includes('login.microsoft')) return 'microsoft';
  if (issuerUrl.includes('okta.com')) return 'okta';
  // Default to microsoft if OIDC is active but issuer doesn't match known patterns
  return 'microsoft';
}

// Roles allowed to see the Settings page. Settings holds org-wide
// configuration (auth provider, lifecycle mode, branding, MFA, backup
// + reset everything) — none of which a non-admin should touch.
// Per-user concerns (display preferences, sign out) live in the
// top-right user menu instead.
const ADMIN_ROLES = new Set(['SUPER_ADMIN', 'ORG_ADMIN']);

// Shipped Council Scorecard thresholds — the fallback when a tenant hasn't set
// its own bar. Mirrors DEFAULT_TARGETS on the backend.
type ScorecardTargets = { coverage: number; classification: number; openIssues: number; exceptions: number; openIssuesDays: number };
const SCORECARD_TARGET_DEFAULTS: ScorecardTargets = { coverage: 80, classification: 70, openIssues: 0, exceptions: 0, openIssuesDays: 30 };
const SCORECARD_TARGET_FIELDS: Array<{ key: keyof ScorecardTargets; label: string; unit: '%' | 'count' | 'days'; hint: string }> = [
  { key: 'coverage',       label: 'Tier-1 coverage', unit: '%',     hint: 'Min share of Tier-1 domains with a named owner.' },
  { key: 'classification', label: 'Classification',  unit: '%',     hint: 'Min share of data assets carrying a sensitivity classification.' },
  { key: 'openIssues',     label: 'Open issues',     unit: 'count', hint: 'Max aged open issues before the division falls short.' },
  { key: 'exceptions',     label: 'Exceptions',      unit: 'count', hint: 'Max past-expiry exceptions allowed.' },
  { key: 'openIssuesDays', label: 'Open-issue age',  unit: 'days',  hint: 'How old (in days) an open issue must be to count.' },
];

export default function SettingsPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const aiEnabled = useAiEnabled();
  const isAdmin = !!user?.role && ADMIN_ROLES.has(user.role);
  if (!isAdmin) {
    return (
      <Page width="narrow" padding="64px 0">
        <Card padding="32px">
          <div style={{ textAlign: 'center' }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Admins only</h2>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 16 }}>
              The Settings page holds organization-wide configuration that
              only administrators can change. For your personal display
              preferences (Plain / DAMA, Cozy / Compact), click your name
              in the top-right corner of any page.
            </p>
            <Link
              to="/"
              style={{
                display: 'inline-block', padding: '8px 16px',
                fontSize: 13, fontWeight: 600,
                background: 'var(--color-primary)', color: '#fff',
                borderRadius: 'var(--radius-md)', textDecoration: 'none',
              }}
            >
              Back to dashboard
            </Link>
          </div>
        </Card>
      </Page>
    );
  }
  // Which settings group is visible. Grouping the dozen-odd sections into
  // four tabs (General / Sign-in & Security / Integrations / Data) turns a
  // long single-column scroll into roughly one screen per tab. The active
  // tab lives in the URL (?tab=) so it's shareable and survives reload; the
  // groups stay mounted (display-toggled, not remounted), so an in-progress
  // form edit (sign-in branding, SSO config, MFA enrolment) survives a switch.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const settingsTab: 'general' | 'security' | 'integrations' | 'data' =
    tabParam === 'security' || tabParam === 'integrations' || tabParam === 'data' ? tabParam : 'general';
  const setSettingsTab = (t: 'general' | 'security' | 'integrations' | 'data') => {
    const p = new URLSearchParams(searchParams);
    if (t === 'general') p.delete('tab'); else p.set('tab', t);
    setSearchParams(p, { replace: true });
  };
  // Org-level lifecycle mode (Simple = 3 statuses, Advanced = 6).
  // The toggle used to live on the Organizations page but it
  // governs how non-org entities (processes, assets, policies)
  // move through their statuses — wrong page for the audience.
  // It's a one-time configuration so Settings is the right home.
  const { activeOrgId, activeOrgName } = useOrgContext();
  const { addToast } = useToastStore();
  const [lifecycleMode, setLifecycleMode] = useState<'simple' | 'review' | 'advanced'>('simple');
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [confirmLifecycle, setConfirmLifecycle] = useState<'simple' | 'review' | 'advanced' | null>(null);
  const [lifecycleMigrationMsg, setLifecycleMigrationMsg] = useState<string | null>(null);
  // "Get Started" guide visibility — a single global (per-user), client-side
  // preference read and set straight from setupStore (no API; it's a UI nudge,
  // not org data). Not keyed by org: the show/hide choice follows the user.
  const getStartedVisibility = useSetupStore((s) => s.visibility);
  const setGetStartedVisibility = useSetupStore((s) => s.setVisibility);
  const GET_STARTED_OPTIONS: Array<{ key: GetStartedVisibility; label: string }> = [
    { key: 'auto', label: 'Auto' },
    { key: 'shown', label: 'Always' },
    { key: 'hidden', label: 'Hidden' },
  ];
  useEffect(() => {
    if (!activeOrgId) return;
    apiClient
      .get<{ success: boolean; data: { statusMode?: string } }>(`/organizations/${activeOrgId}`)
      .then((res) => setLifecycleMode((res.data?.statusMode as 'simple' | 'review' | 'advanced') || 'simple'))
      .catch(() => { /* leave default */ });
  }, [activeOrgId]);
  const applyLifecycle = async (newMode: 'simple' | 'review' | 'advanced') => {
    if (!activeOrgId || lifecycleBusy) return;
    setLifecycleBusy(true);
    try {
      const res = await apiClient.post<{ success: boolean; message?: string; migrated?: number }>(`/organizations/${activeOrgId}/status-mode`, { mode: newMode });
      setLifecycleMode(newMode);
      setLifecycleMigrationMsg(res.message || null);
    } catch { /* toast handled by client */ }
    finally { setLifecycleBusy(false); setConfirmLifecycle(null); }
  };

  // ── Sign-in branding (per-tenant) ──
  //
  // Populated from the active org's tenantSlug / brand* fields. The
  // Preview panel below the form renders the login-card shell exactly
  // as it'll appear at /login?tenant=<slug>, so a super-admin can
  // eyeball their branding before shipping the URL to a customer.
  const [branding, setBranding] = useState<{
    tenantSlug: string; brandDisplayName: string; brandGlyph: string;
    ssoButtonLabel: string; brandPrimaryColor: string;
  }>({ tenantSlug: '', brandDisplayName: '', brandGlyph: '', ssoButtonLabel: '', brandPrimaryColor: '' });
  const [brandingBusy, setBrandingBusy] = useState(false);
  const [brandingMsg, setBrandingMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!activeOrgId) return;
    apiClient
      .get<{ success: boolean; data: any }>(`/organizations/${activeOrgId}`)
      .then((res) => setBranding({
        tenantSlug: res.data?.tenantSlug || '',
        brandDisplayName: res.data?.brandDisplayName || '',
        brandGlyph: res.data?.brandGlyph || '',
        ssoButtonLabel: res.data?.ssoButtonLabel || '',
        brandPrimaryColor: res.data?.brandPrimaryColor || '',
      }))
      .catch(() => { /* leave defaults */ });
  }, [activeOrgId]);
  const applyBranding = async () => {
    if (!activeOrgId || brandingBusy) return;
    setBrandingBusy(true);
    setBrandingMsg(null);
    try {
      await apiClient.put(`/organizations/${activeOrgId}`, branding);
      setBrandingMsg('Sign-in branding saved.');
    } catch (e) {
      setBrandingMsg(e instanceof Error ? e.message : 'Save failed');
    } finally { setBrandingBusy(false); }
  };

  // ── Data classification regimes (per-tenant) ──
  // Which regulatory / export-control regimes an org admin has turned on.
  // Universal data-sensitivity tags (PII/PHI/…) are always available and not
  // configurable here.
  const [regimes, setRegimes] = useState<string[]>(['CUI', 'ITAR', 'EXPORT_CONTROLLED']);
  const [regimesBusy, setRegimesBusy] = useState(false);
  useEffect(() => {
    if (!activeOrgId) return;
    apiClient
      .get<{ success: boolean; data: { activeSensitivityRegimes?: string[] } }>(`/organizations/${activeOrgId}`)
      .then((res) => {
        const r = res.data?.activeSensitivityRegimes;
        setRegimes(Array.isArray(r) ? r : ['CUI', 'ITAR', 'EXPORT_CONTROLLED']);
      })
      .catch(() => { /* leave defaults */ });
  }, [activeOrgId]);
  const toggleRegime = async (key: string) => {
    if (!activeOrgId || regimesBusy) return;
    const prev = regimes;
    const next = regimes.includes(key) ? regimes.filter((r) => r !== key) : [...regimes, key];
    setRegimes(next);
    setRegimesBusy(true);
    try {
      await apiClient.put(`/organizations/${activeOrgId}`, { activeSensitivityRegimes: next });
      void useRegimeStore.getState().fetch(activeOrgId);
    } catch {
      setRegimes(prev);
    } finally { setRegimesBusy(false); }
  };

  // ── Compliance frameworks (per-tenant) ──
  // Which compliance frameworks (SOX / HIPAA / GDPR / …) are selectable as
  // activity compliance tags. Free-form: the admin toggles the built-in set and
  // can add their own. Unset on the org = the built-in defaults.
  const [frameworks, setFrameworks] = useState<string[]>([...BUILTIN_COMPLIANCE_FRAMEWORKS]);
  const [frameworksBusy, setFrameworksBusy] = useState(false);
  const [frameworkDraft, setFrameworkDraft] = useState('');
  useEffect(() => {
    if (!activeOrgId) return;
    apiClient
      .get<{ success: boolean; data: { activeComplianceFrameworks?: string[] } }>(`/organizations/${activeOrgId}`)
      .then((res) => {
        const r = res.data?.activeComplianceFrameworks;
        setFrameworks(Array.isArray(r) ? r : [...BUILTIN_COMPLIANCE_FRAMEWORKS]);
      })
      .catch(() => { /* leave defaults */ });
  }, [activeOrgId]);
  const saveFrameworks = async (next: string[]) => {
    if (!activeOrgId || frameworksBusy) return;
    const prev = frameworks;
    setFrameworks(next);
    setFrameworksBusy(true);
    try {
      await apiClient.put(`/organizations/${activeOrgId}`, { activeComplianceFrameworks: next });
      void useComplianceStore.getState().fetch(activeOrgId);
    } catch {
      setFrameworks(prev);
    } finally { setFrameworksBusy(false); }
  };
  const addFramework = () => {
    const v = frameworkDraft.trim();
    if (v && !frameworks.some((f) => f.toLowerCase() === v.toLowerCase())) {
      void saveFrameworks([...frameworks, v]);
    }
    setFrameworkDraft('');
  };
  // Built-in frameworks the tenant has turned off — offered as one-click re-add.
  const inactiveBuiltinFrameworks = BUILTIN_COMPLIANCE_FRAMEWORKS.filter((f) => !frameworks.includes(f));

  // ── Council Scorecard targets (per-tenant) ──
  // The thresholds the scorecard grades each division against. Unset on the
  // org = shipped defaults. `saved` tracks what's persisted so we can show a
  // dirty state and a reset-to-defaults affordance.
  const [scorecardTargets, setScorecardTargets] = useState<ScorecardTargets>(SCORECARD_TARGET_DEFAULTS);
  const [scorecardTargetsSaved, setScorecardTargetsSaved] = useState<ScorecardTargets>(SCORECARD_TARGET_DEFAULTS);
  const [scorecardTargetsBusy, setScorecardTargetsBusy] = useState(false);
  const [scorecardTargetsCustom, setScorecardTargetsCustom] = useState(false);
  useEffect(() => {
    if (!activeOrgId) return;
    apiClient
      .get<{ success: boolean; data: { scorecardTargets?: Partial<ScorecardTargets> | null } }>(`/organizations/${activeOrgId}`)
      .then((res) => {
        const t = res.data?.scorecardTargets;
        const merged = t && typeof t === 'object' ? { ...SCORECARD_TARGET_DEFAULTS, ...t } : SCORECARD_TARGET_DEFAULTS;
        setScorecardTargets(merged);
        setScorecardTargetsSaved(merged);
        setScorecardTargetsCustom(!!t && typeof t === 'object');
      })
      .catch(() => { /* leave defaults */ });
  }, [activeOrgId]);
  const scorecardTargetsDirty = SCORECARD_TARGET_FIELDS.some((f) => scorecardTargets[f.key] !== scorecardTargetsSaved[f.key]);
  const setScorecardTarget = (key: keyof ScorecardTargets, value: number) =>
    setScorecardTargets((p) => ({ ...p, [key]: value }));
  const saveScorecardTargets = async () => {
    if (!activeOrgId || scorecardTargetsBusy) return;
    setScorecardTargetsBusy(true);
    try {
      const res = await apiClient.put<{ success: boolean; data: { scorecardTargets?: ScorecardTargets } }>(`/organizations/${activeOrgId}`, { scorecardTargets });
      const saved = res.data?.scorecardTargets ?? scorecardTargets;
      setScorecardTargets(saved);
      setScorecardTargetsSaved(saved);
      setScorecardTargetsCustom(true);
      addToast('success', 'Scorecard targets saved.');
    } catch {
      addToast('error', 'Failed to save scorecard targets.');
    } finally { setScorecardTargetsBusy(false); }
  };
  const resetScorecardTargets = async () => {
    if (!activeOrgId || scorecardTargetsBusy) return;
    setScorecardTargetsBusy(true);
    try {
      await apiClient.put(`/organizations/${activeOrgId}`, { scorecardTargets: null });
      setScorecardTargets(SCORECARD_TARGET_DEFAULTS);
      setScorecardTargetsSaved(SCORECARD_TARGET_DEFAULTS);
      setScorecardTargetsCustom(false);
      addToast('success', 'Scorecard targets reset to the shipped defaults.');
    } catch {
      addToast('error', 'Failed to reset scorecard targets.');
    } finally { setScorecardTargetsBusy(false); }
  };

  // Auth settings state
  const [currentProvider, setCurrentProvider] = useState<DisplayProvider>('dev');
  const [currentIssuerUrl, setCurrentIssuerUrl] = useState<string>('');
  const [currentClientId, setCurrentClientId] = useState<string>('');
  const [authLoading, setAuthLoading] = useState(true);

  // Auth config form state
  const [formProvider, setFormProvider] = useState<DisplayProvider>('dev');
  const [formIssuerUrl, setFormIssuerUrl] = useState('');
  const [formClientId, setFormClientId] = useState('');
  const [authSaving, setAuthSaving] = useState(false);
  const [authSuccess, setAuthSuccess] = useState(false);
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    async function loadAuthConfig() {
      try {
        const res = await apiClient.get<AuthConfigResponse>('/auth/config');
        const config = res.data;
        const dp = backendToDisplayProvider(config.provider, config.issuerUrl || '');
        setCurrentProvider(dp);
        setCurrentIssuerUrl(config.issuerUrl || '');
        setCurrentClientId(config.clientId || '');
        setFormProvider(dp);
        setFormIssuerUrl(config.issuerUrl || '');
        setFormClientId(config.clientId || '');
      } catch {
        // Default to dev mode if config endpoint not available
        setCurrentProvider('dev');
      } finally {
        setAuthLoading(false);
      }
    }
    loadAuthConfig();
  }, []);

  const isOidc = formProvider === 'microsoft' || formProvider === 'okta';

  const handleSaveAuth = async () => {
    setAuthSaving(true);
    setAuthError('');
    setAuthSuccess(false);

    if (isOidc && !formIssuerUrl.trim()) {
      setAuthError('Issuer URL is required for OIDC providers');
      setAuthSaving(false);
      return;
    }
    if (isOidc && !formClientId.trim()) {
      setAuthError('Client ID is required for OIDC providers');
      setAuthSaving(false);
      return;
    }

    try {
      await apiClient.put('/auth/config', {
        provider: displayProviderToBackend(formProvider),
        oidcIssuer: isOidc ? formIssuerUrl.trim() : undefined,
        oidcClientId: isOidc ? formClientId.trim() : undefined,
      });
      setCurrentProvider(formProvider);
      setCurrentIssuerUrl(isOidc ? formIssuerUrl.trim() : '');
      setCurrentClientId(isOidc ? formClientId.trim() : '');
      setAuthSuccess(true);
      setTimeout(() => setAuthSuccess(false), 3000);
    } catch (err) {
      setAuthError(errorMessage(err, 'Failed to save authentication configuration'));
    } finally {
      setAuthSaving(false);
    }
  };

  // Backup & Restore state
  const [exportLoading, setExportLoading] = useState(false);
  const [, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<Record<string, number> | null>(null);
  const [importConfirmOpen, setImportConfirmOpen] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<Record<string, number> | null>(null);
  const [importError, setImportError] = useState('');
  const importParsedData = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExportBackup = async () => {
    setExportLoading(true);
    try {
      const data = await apiClient.get<any>(activeOrgId ? `/backup/export?orgId=${encodeURIComponent(activeOrgId)}` : '/backup/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `procela-backup-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert('Failed to export backup: ' + (err.message || 'Unknown error'));
    } finally {
      setExportLoading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    setImportResult(null);
    setImportError('');
    const file = e.target.files?.[0] || null;
    setImportFile(file);
    setImportPreview(null);
    importParsedData.current = null;

    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result as string);
          if (!parsed.data || typeof parsed.data !== 'object') {
            setImportError('Invalid backup file: missing "data" field.');
            return;
          }
          importParsedData.current = parsed;
          const counts: Record<string, number> = {};
          for (const [key, value] of Object.entries(parsed.data)) {
            if (Array.isArray(value)) {
              counts[key] = value.length;
            }
          }
          if (Array.isArray(parsed.files) && parsed.files.length) counts['attachment files'] = parsed.files.length;
          setImportPreview(counts);
        } catch {
          setImportError('Invalid JSON file. Please select a valid Procela backup file.');
        }
      };
      reader.readAsText(file);
    }
  };

  const handleImportConfirm = async () => {
    setImportConfirmOpen(false);
    setImportLoading(true);
    setImportError('');
    setImportResult(null);
    try {
      const res = await apiClient.post<{ success: boolean; imported: Record<string, number>; filesRestored?: number }>('/backup/import', importParsedData.current);
      setImportResult({ ...res.imported, ...(res.filesRestored ? { 'attachment files': res.filesRestored } : {}) });
      setImportFile(null);
      setImportPreview(null);
      importParsedData.current = null;
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err: any) {
      setImportError('Import failed: ' + (err.message || 'Unknown error'));
    } finally {
      setImportLoading(false);
    }
  };

  const providerDisplayName = (provider: DisplayProvider) => {
    switch (provider) {
      case 'dev': return 'Dev Mode';
      case 'local': return 'Local credentials';
      case 'microsoft': return 'Microsoft Entra ID';
      case 'okta': return 'Okta';
      default: return provider;
    }
  };

  const maskValue = (value: string) => {
    if (!value) return '';
    if (value.length <= 8) return '*'.repeat(value.length);
    return value.slice(0, 4) + '*'.repeat(value.length - 8) + value.slice(-4);
  };

  return (
    <div>
      <PageHeader
        title="Settings"
        actions={
          <button
            onClick={() => window.dispatchEvent(new Event('procela:start-tour'))}
            style={{
              padding: '6px 14px', background: 'var(--color-surface)',
              color: 'var(--color-primary)', border: '1px solid var(--color-primary)',
              borderRadius: 'var(--radius-md)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
            }}
            title="Show the three-phase Define / Connect / Discover intro again"
          >
            Replay intro
          </button>
        }
      />

      {/* Settings are grouped into four tabs so each stays roughly one
          screen instead of a single long scroll. */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border)', marginBottom: 16 }}>
        {([
          { key: 'general', label: 'General' },
          { key: 'security', label: 'Sign-in & Security' },
          { key: 'integrations', label: 'Integrations' },
          { key: 'data', label: 'Data' },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setSettingsTab(t.key)}
            style={{
              padding: '10px 18px', fontSize: 13,
              fontWeight: settingsTab === t.key ? 600 : 500,
              background: 'none', border: 'none', cursor: 'pointer',
              color: settingsTab === t.key ? 'var(--color-primary)' : 'var(--color-text-muted)',
              borderBottom: `2px solid ${settingsTab === t.key ? 'var(--color-primary)' : 'transparent'}`,
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ══ General ══ */}
      <div style={{ display: settingsTab === 'general' ? 'block' : 'none' }}>

      {/* Branding — quick link to the dedicated theming page */}
      <Card padding="1.5rem">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={sectionTitleStyle}>Brand &amp; appearance</h2>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              Company name, logo, and color palette used across the app.
            </p>
          </div>
          <button
            onClick={() => navigate('/settings/branding')}
            style={{ padding: '8px 14px', fontSize: 13, background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 500 }}
          >
            Customize branding
          </button>
        </div>
      </Card>

      {/* Process & Asset Lifecycle — org-level workflow shape.
          Drives the status dropdowns on the Process Catalog, Data
          Assets, Policies / Governance Documents, and anywhere else
          a row carries a Draft / Active / Deprecated status. Simple
          is right for most orgs; Advanced adds Proposed / Under
          Review / Approved gates between Draft and Active for
          highly-regulated environments. */}
      <Card padding="1.5rem">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={sectionTitleStyle}>Process & Asset Lifecycle</h2>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 8 }}>
              Decides which workflow statuses appear on processes, data assets, policies and other governed entities in <strong>{activeOrgName || 'this org'}</strong>. A one-time setup for most organizations — change it carefully because items in statuses the new mode doesn't have will be migrated.
            </p>
            <ul style={{ fontSize: 12, color: 'var(--color-text-secondary)', paddingLeft: 18, listStyle: 'disc', marginBottom: 8 }}>
              <li><strong>Simple</strong> (3 statuses): Draft → Active → Deprecated. The default — right for most teams.</li>
              <li><strong>Review</strong> (4 statuses): Draft → Pending Review → Active → Deprecated. Adds one approver gate with segregation of duties (the submitter can't approve their own change). Sized for enterprise change control that doesn't need the four-step ceremony of Advanced.</li>
              <li><strong>Advanced</strong> (6 statuses): Draft → Proposed → Under Review → Approved → Active → Deprecated. For regulated environments that need explicit review gates before items go live.</li>
            </ul>
            {lifecycleMigrationMsg && (
              <div style={{ fontSize: 12, color: '#065f46', background: '#d1fae5', border: '1px solid #6ee7b7', borderRadius: 4, padding: '6px 10px', marginTop: 4 }}>
                {lifecycleMigrationMsg}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
            <SectionLabel marginBottom={0}>Current mode</SectionLabel>
            <div style={{ display: 'inline-flex', border: '1px solid var(--color-border)', borderRadius: 6, overflow: 'hidden' }}>
              {(['simple', 'review', 'advanced'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => activeOrgId && mode !== lifecycleMode && setConfirmLifecycle(mode)}
                  disabled={!activeOrgId || lifecycleBusy}
                  style={{
                    padding: '6px 14px', fontSize: 13, fontWeight: 500,
                    background: mode === lifecycleMode ? 'var(--color-primary)' : 'var(--color-surface)',
                    color: mode === lifecycleMode ? '#fff' : 'var(--color-text)',
                    border: 'none',
                    borderLeft: mode !== 'simple' ? '1px solid var(--color-border)' : undefined,
                    cursor: !activeOrgId ? 'not-allowed' : mode === lifecycleMode ? 'default' : 'pointer',
                    textTransform: 'capitalize',
                  }}
                >
                  {lifecycleBusy && confirmLifecycle === mode ? '…' : mode}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Get Started guide — user control over the "Get Started with
          Procela" onboarding entry in the sidebar. Auto (default) keeps the
          old behaviour (show while setup is incomplete, step aside at 100%);
          Always pins it; Hidden removes it. Stored as a single global
          preference in setupStore (client-side), so it applies to this
          browser across every org. */}
      <Card padding="1.5rem">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={sectionTitleStyle}>Get Started guide</h2>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 8 }}>
              Controls the <strong>Get Started with Procela</strong> onboarding entry in the sidebar. This preference is global — it applies across all of your organizations.
            </p>
            <ul style={{ fontSize: 12, color: 'var(--color-text-secondary)', paddingLeft: 18, listStyle: 'disc', marginBottom: 0 }}>
              <li><strong>Auto</strong> — show it while setup is incomplete, then hide it once the active org is fully set up. The default.</li>
              <li><strong>Always</strong> — keep it pinned in the sidebar even after setup is complete, so you can revisit the steps.</li>
              <li><strong>Hidden</strong> — remove it from the sidebar entirely.</li>
            </ul>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
            <SectionLabel marginBottom={0}>Sidebar entry</SectionLabel>
            <div style={{ display: 'inline-flex', border: '1px solid var(--color-border)', borderRadius: 6, overflow: 'hidden' }}>
              {GET_STARTED_OPTIONS.map((opt, i) => (
                <button
                  key={opt.key}
                  onClick={() => opt.key !== getStartedVisibility && setGetStartedVisibility(opt.key)}
                  style={{
                    padding: '6px 14px', fontSize: 13, fontWeight: 500,
                    background: opt.key === getStartedVisibility ? 'var(--color-primary)' : 'var(--color-surface)',
                    color: opt.key === getStartedVisibility ? '#fff' : 'var(--color-text)',
                    border: 'none',
                    borderLeft: i > 0 ? '1px solid var(--color-border)' : undefined,
                    cursor: opt.key === getStartedVisibility ? 'default' : 'pointer',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={!!confirmLifecycle}
        title={confirmLifecycle ? `Switch to ${confirmLifecycle.charAt(0).toUpperCase() + confirmLifecycle.slice(1)} lifecycle?` : ''}
        message={
          confirmLifecycle === 'simple'
            ? 'Items currently in Pending Review, Proposed, Under Review, or Approved will be moved to Draft. Active and Deprecated items are unaffected. This setting takes effect immediately across every page that uses status.'
          : confirmLifecycle === 'review'
            ? 'This adds one Pending Review gate between Draft and Active with segregation of duties — the submitter cannot approve their own change. Items currently in Proposed, Under Review, or Approved (from the Advanced flow) will be moved to Draft. Active and Deprecated items are unaffected.'
          : 'This adds Proposed, Under Review, and Approved steps between Draft and Active. Existing Draft / Active / Deprecated / Pending Review items keep or are migrated to a valid state. Once enabled, new items go through the review gates.'
        }
        confirmLabel={confirmLifecycle ? `Switch to ${confirmLifecycle.charAt(0).toUpperCase() + confirmLifecycle.slice(1)}` : ''}
        variant="primary"
        onConfirm={async () => { if (confirmLifecycle) await applyLifecycle(confirmLifecycle); }}
        onCancel={() => setConfirmLifecycle(null)}
      />

      </div>{/* ══ /General ══ */}

      {/* ══ Sign-in & Security ══ */}
      <div style={{ display: settingsTab === 'security' ? 'block' : 'none' }}>

      {/* Sign-in branding (per tenant). Only meaningful on the
          company-level org — divisions inherit the parent's brand at
          the sign-in card. Kept text-only in v1 (emoji glyph +
          display name + button label + primary hex). */}
      <Card padding="1.5rem">
        <h2 style={sectionTitleStyle}>Sign-in page appearance</h2>
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 12 }}>
          Customises the sign-in card for users landing at your tenant URL — <code>/login?tenant=&lt;slug&gt;</code> or your subdomain — so the login page reads as <strong>{branding.brandDisplayName || activeOrgName || 'your company'}</strong> rather than generic Procela. Fields below stay optional; empty ones fall back to platform defaults.
        </p>
        {/* Two-column layout: the editable fields fill column 1, the live
            preview sits alongside in column 2. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 20, alignItems: 'start' }}>
          {/* Column 1 — editable branding fields + save action. */}
          <div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12, marginBottom: 12, alignItems: 'start' }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 500, display: 'block', marginBottom: 3 }}>Tenant slug</label>
            <input
              aria-label="Tenant slug"
              value={branding.tenantSlug}
              onChange={(e) => setBranding((b) => ({ ...b, tenantSlug: e.target.value }))}
              placeholder="e.g. tidewater"
              style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--color-border)', borderRadius: 4, fontSize: 13 }}
            />
            <p style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 3 }}>
              3–64 lowercase letters, digits, or hyphens. Users land here via <code>?tenant=&lt;slug&gt;</code> or a subdomain match. Must be unique.
            </p>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 500, display: 'block', marginBottom: 3 }}>Display name</label>
            <input
              aria-label="Display name"
              value={branding.brandDisplayName}
              onChange={(e) => setBranding((b) => ({ ...b, brandDisplayName: e.target.value }))}
              placeholder="e.g. Tidewater Utilities"
              maxLength={80}
              style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--color-border)', borderRadius: 4, fontSize: 13 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 500, display: 'block', marginBottom: 3 }}>Glyph (emoji)</label>
            <input
              aria-label="Glyph (emoji)"
              value={branding.brandGlyph}
              onChange={(e) => setBranding((b) => ({ ...b, brandGlyph: e.target.value }))}
              placeholder="e.g. ⚡ or 💧"
              maxLength={8}
              style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--color-border)', borderRadius: 4, fontSize: 13 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 500, display: 'block', marginBottom: 3 }}>Primary color (#RRGGBB)</label>
            <input
              aria-label="Primary color (#RRGGBB)"
              value={branding.brandPrimaryColor}
              onChange={(e) => setBranding((b) => ({ ...b, brandPrimaryColor: e.target.value }))}
              placeholder="#1a7a6d"
              maxLength={7}
              style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--color-border)', borderRadius: 4, fontSize: 13 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 500, display: 'block', marginBottom: 3 }}>SSO button label</label>
            <input
              aria-label="SSO button label"
              value={branding.ssoButtonLabel}
              onChange={(e) => setBranding((b) => ({ ...b, ssoButtonLabel: e.target.value }))}
              placeholder="e.g. Sign in with Tidewater SSO"
              maxLength={80}
              style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--color-border)', borderRadius: 4, fontSize: 13 }}
            />
          </div>
        </div>
        <div>
            <button
              onClick={applyBranding}
              disabled={!activeOrgId || brandingBusy}
              style={{
                padding: '8px 14px', fontSize: 13, fontWeight: 500,
                background: 'var(--color-primary)', color: '#fff',
                border: 'none', borderRadius: 6, cursor: 'pointer',
              }}
            >
              {brandingBusy ? 'Saving…' : 'Save branding'}
            </button>
            {brandingMsg && (
              <span style={{ marginLeft: 12, fontSize: 12, color: brandingMsg.includes('saved') ? 'var(--color-success)' : 'var(--color-error)' }}>
                {brandingMsg}
              </span>
            )}
            {branding.tenantSlug && (
              <p style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text-muted)' }}>
                Test URL: <code>/login?tenant={branding.tenantSlug}</code>
              </p>
            )}
          </div>{/* /save block */}
          </div>{/* /column 1 */}
          {/* Column 2 — live preview, a scaled-down mock of the sign-in
              card rendered from the same fields the login page reads. */}
          <div style={{ padding: 14, border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-bg)' }}>
            <SectionLabel>Preview</SectionLabel>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 24 }}>{branding.brandGlyph || '⬛'}</span>
              <span style={{ fontSize: 18, fontWeight: 700 }}>{branding.brandDisplayName || 'Procela'}</span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, textAlign: 'center', marginBottom: 4 }}>Sign in</div>
            <div style={{ fontSize: 10, color: 'var(--color-text-muted)', textAlign: 'center', marginBottom: 10 }}>Choose your authentication method to continue</div>
            <div style={{
              padding: '8px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500, textAlign: 'center',
              background: branding.brandPrimaryColor && /^#[0-9a-fA-F]{6}$/.test(branding.brandPrimaryColor) ? branding.brandPrimaryColor : '#1a7a6d',
              color: '#fff',
            }}>
              {branding.ssoButtonLabel || 'Sign in with SSO'}
            </div>
            <div style={{ fontSize: 9, color: 'var(--color-text-muted)', textAlign: 'center', marginTop: 8 }}>Powered by Procela</div>
          </div>
        </div>
      </Card>

      {/* Authentication + two-step verification in a two-column layout:
          the tall Authentication card fills the left column, and the
          short Two-step verification card sits in the right column.
          Active sessions renders full-width below the row. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '1.5rem', alignItems: 'start' }}>
      <Card padding="1.5rem">
        <h2 style={sectionTitleStyle}>Authentication</h2>

        {authLoading ? (
          <Spinner label="Loading…" />
        ) : (
          <>
            {/* Current Provider Status */}
            <div style={{ marginBottom: '1.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>Current provider:</span>
                <span style={{
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  padding: '2px 10px',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: currentProvider === 'dev' ? '#fffbeb' : '#f0fdf4',
                  color: currentProvider === 'dev' ? '#d97706' : 'var(--color-success)',
                  border: `1px solid ${currentProvider === 'dev' ? '#fde68a' : '#bbf7d0'}`,
                }}>
                  {providerDisplayName(currentProvider)}
                </span>
              </div>

              {currentProvider === 'dev' && (
                <p style={{ fontSize: '0.8125rem', color: 'var(--color-warning)', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 'var(--radius-md)', padding: '0.5rem 0.75rem', marginTop: '0.5rem' }}>
                  Development mode is active. This is not suitable for production use.
                </p>
              )}

              {currentProvider !== 'dev' && currentIssuerUrl && (
                <div style={{ marginTop: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>Issuer URL:</span>
                    <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                      {currentIssuerUrl}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>Client ID:</span>
                    <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                      {maskValue(currentClientId)}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Divider */}
            <div style={{ height: '1px', background: 'var(--color-border)', marginBottom: '1.5rem' }} />

            {/* Configure SSO Form */}
            <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, color: 'var(--color-text)', marginBottom: '1rem' }}>Configure SSO</h3>

            {authError && (
              <div style={{ color: 'var(--color-error)', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--radius-md)', padding: '0.5rem 0.75rem', marginBottom: '1rem', fontSize: '0.8125rem' }}>
                {authError}
              </div>
            )}

            {authSuccess && (
              <div style={{ color: 'var(--color-success)', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 'var(--radius-md)', padding: '0.5rem 0.75rem', marginBottom: '1rem', fontSize: '0.8125rem' }}>
                Authentication configuration saved successfully.
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {/* Provider Dropdown */}
              <div>
                <label style={labelStyle}>Provider</label>
                <select
                  aria-label="Provider"
                  value={formProvider}
                  onChange={(e) => {
                    setFormProvider(e.target.value as DisplayProvider);
                    setAuthError('');
                  }}
                  style={inputStyle}
                >
                  <option value="dev">Dev Mode</option>
                  <option value="local">Local credentials (email + password)</option>
                  <option value="microsoft">Microsoft Entra ID (OIDC)</option>
                  <option value="okta">Okta (OIDC)</option>
                </select>
                {formProvider === 'local' && (
                  <div style={{ marginTop: '0.5rem', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    Procela stores Argon2id password hashes on each Person record. Use{' '}
                    <strong>Migrate to Local</strong> below to generate temporary passwords for
                    everyone, then distribute them out-of-band. Users will be forced to set a
                    new password on first login.
                  </div>
                )}
              </div>

              {/* OIDC Fields */}
              {isOidc && (
                <>
                  <div>
                    <label style={labelStyle}>OIDC Issuer URL</label>
                    <input
                      aria-label="OIDC Issuer URL"
                      type="url"
                      placeholder={formProvider === 'microsoft'
                        ? 'https://login.microsoftonline.com/{tenant-id}/v2.0'
                        : 'https://your-org.okta.com/oauth2/default'
                      }
                      value={formIssuerUrl}
                      onChange={(e) => {
                        setFormIssuerUrl(e.target.value);
                        setAuthError('');
                      }}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>OIDC Client ID</label>
                    <input
                      aria-label="OIDC Client ID"
                      type="text"
                      placeholder="Enter your client ID"
                      value={formClientId}
                      onChange={(e) => {
                        setFormClientId(e.target.value);
                        setAuthError('');
                      }}
                      style={inputStyle}
                    />
                  </div>
                </>
              )}

              {/* Save Button */}
              <div>
                <button
                  onClick={handleSaveAuth}
                  disabled={authSaving}
                  style={{
                    padding: '0.5rem 1.5rem',
                    background: authSaving ? '#6b7280' : 'var(--color-primary)',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: 'var(--radius-md)',
                    fontSize: '0.875rem',
                    fontWeight: 500,
                    cursor: authSaving ? 'not-allowed' : 'pointer',
                  }}
                >
                  {authSaving ? 'Saving…' : 'Save Configuration'}
                </button>
              </div>

              {/* Local credentials: one-time migration. Always
                  available so an admin can pre-stage temp passwords
                  before flipping the provider switch (avoids the
                  lockout where switching to Local with no hashes set
                  blocks every login). */}
              {(formProvider === 'local' || currentProvider === 'local') && (
                <LocalMigrationPanel />
              )}
            </div>
          </>
        )}
      </Card>

      {/* Two-step verification (MFA / TOTP) — the sole occupant of the
          right column beside the taller Authentication card. */}
      <Card padding="1.5rem">
        <h2 style={sectionTitleStyle}>Two-step verification</h2>
        <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', marginBottom: '1rem' }}>
          Use an authenticator app (Google Authenticator, 1Password, Authy)
          to generate a one-time code at sign-in. When enabled, your
          password alone won't be enough to sign in.
        </p>
        <MfaPanel />
      </Card>
      </div>{/* /auth + security two-column */}

      <div style={{ height: '1.5rem' }} />

      {/* Active sessions — full-width below the two-column row so the
          session list has room to breathe across the whole page. */}
      <Card padding="1.5rem">
        <h2 style={sectionTitleStyle}>Active sessions</h2>
        <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', marginBottom: '1rem' }}>
          Every device or browser you're signed in from has its own refresh
          token. Revoke one if you've finished with a public computer, lost a
          device, or want to force a fresh login from somewhere.
        </p>
        <ActiveSessionsPanel />
      </Card>

      </div>{/* ══ /Sign-in & Security ══ */}

      {/* ══ Integrations ══ */}
      <div style={{ display: settingsTab === 'integrations' ? 'block' : 'none' }}>

      {/* AI (Claude) — model + Anthropic-key config. Subsumes the old
          standalone "API Configuration" card, which only restated the same
          key status this panel already surfaces. Hidden when AI integration
          features are turned off for the deployment. */}
      {aiEnabled && <AiSettingsPanel sectionStyle={sectionStyle} sectionTitleStyle={sectionTitleStyle} />}

      {/* Spacer */}
      <div style={{ height: '1.5rem' }} />

      <ConnectorsSection sectionStyle={sectionStyle} sectionTitleStyle={sectionTitleStyle} />

      </div>{/* ══ /Integrations ══ */}

      {/* ══ Data ══ */}
      <div style={{ display: settingsTab === 'data' ? 'block' : 'none' }}>

      {/* Data classification regimes — an org admin chooses which regulatory /
          export-control regimes are active for this tenant. The universal
          data-sensitivity tags (PII/PHI/PCI/…) are always available and not
          listed here. Sits at the top of the Data tab — data-governance policy
          ahead of the operational backup / demo / reset actions below. */}
      <Card padding="1.5rem" marginBottom="1.5rem">
        <h2 style={sectionTitleStyle}>Data classification regimes</h2>
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 4 }}>
          Choose which regulatory / export-control regimes apply to <strong>{activeOrgName || 'this tenant'}</strong>. Only active regimes can be applied to data assets and are suggested by the classifier. Universal data-sensitivity tags (PII, PHI, PCI, Financial, Credential, Confidential, Public) are always available.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
          {[
            { key: 'CUI', label: 'CUI', desc: 'Controlled Unclassified Information — NARA CUI Registry / DFARS 252.204-7012.' },
            { key: 'ITAR', label: 'ITAR', desc: 'Technical data on the US Munitions List, subject to ITAR export control.' },
            { key: 'EXPORT_CONTROLLED', label: 'Export-Controlled', desc: 'Dual-use technical data subject to the EAR / Commerce Control List.' },
          ].map((r) => {
            const on = regimes.includes(r.key);
            return (
              <label key={r.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', cursor: regimesBusy ? 'wait' : 'pointer', background: on ? 'var(--color-primary-light)' : 'var(--color-bg)' }}>
                <input type="checkbox" checked={on} disabled={regimesBusy} onChange={() => toggleRegime(r.key)} style={{ marginTop: 2 }} />
                <span>
                  <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{r.label}</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--color-text-muted)', marginTop: 1 }}>{r.desc}</span>
                </span>
              </label>
            );
          })}
        </div>
        {regimes.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--color-warning)', marginTop: 10 }}>
            No regulatory regimes are active — assets in this tenant can carry only the universal data-sensitivity tags.
          </p>
        )}
      </Card>

      {/* Compliance frameworks — an org admin curates which frameworks are
          selectable as activity compliance tags. Unlike the fixed sensitivity
          regimes above, this list is free-form: toggle the built-in set and add
          your own (e.g. an internal control catalog). Unset on the org = the
          built-in defaults. Drives the activity Compliance picker. */}
      <Card padding="1.5rem" marginBottom="1.5rem">
        <h2 style={sectionTitleStyle}>Compliance frameworks</h2>
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 4 }}>
          Choose which compliance frameworks are selectable as compliance tags on activities in <strong>{activeOrgName || 'this tenant'}</strong>. Add your own frameworks alongside the built-in set. Tags already applied to an activity keep showing even if the framework is later removed here.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
          {frameworks.length === 0 && (
            <span style={{ fontSize: 12, color: 'var(--color-warning)', fontStyle: 'italic' }}>
              No frameworks active — the activity Compliance picker will be empty.
            </span>
          )}
          {frameworks.map((f) => (
            <span key={f} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '3px 10px', borderRadius: 14, fontSize: 12, fontWeight: 500,
              background: 'var(--color-primary-light)', color: 'var(--color-primary)',
              border: '1px solid var(--color-primary)',
            }}>
              {f}
              <button
                type="button"
                onClick={() => saveFrameworks(frameworks.filter((x) => x !== f))}
                disabled={frameworksBusy}
                aria-label={`Remove ${f}`}
                title={`Remove ${f}`}
                style={{ background: 'none', border: 'none', cursor: frameworksBusy ? 'wait' : 'pointer', color: 'var(--color-primary)', padding: 0, lineHeight: 1, fontSize: 14 }}
              >&times;</button>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={frameworkDraft}
            onChange={(e) => setFrameworkDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addFramework(); } }}
            disabled={frameworksBusy}
            placeholder="Add a framework (e.g. FedRAMP)"
            style={{ fontSize: 13, padding: '6px 10px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'var(--color-surface)', minWidth: 220 }}
          />
          <button
            type="button"
            onClick={addFramework}
            disabled={frameworksBusy || !frameworkDraft.trim()}
            style={{ fontSize: 13, fontWeight: 600, padding: '6px 14px', border: '1px solid var(--color-primary)', borderRadius: 'var(--radius-md)', background: 'var(--color-primary)', color: '#fff', cursor: frameworksBusy || !frameworkDraft.trim() ? 'not-allowed' : 'pointer', opacity: frameworksBusy || !frameworkDraft.trim() ? 0.5 : 1 }}
          >
            Add
          </button>
        </div>
        {inactiveBuiltinFrameworks.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)', display: 'block', marginBottom: 6 }}>Add back a built-in framework:</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {inactiveBuiltinFrameworks.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => saveFrameworks([...frameworks, f])}
                  disabled={frameworksBusy}
                  style={{ fontSize: 12, padding: '3px 10px', borderRadius: 14, border: '1px dashed var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text-muted)', cursor: frameworksBusy ? 'wait' : 'pointer' }}
                >
                  + {f}
                </button>
              ))}
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={() => saveFrameworks([...BUILTIN_COMPLIANCE_FRAMEWORKS])}
          disabled={frameworksBusy}
          style={{ marginTop: 14, fontSize: 12, background: 'none', border: 'none', color: 'var(--color-primary)', cursor: frameworksBusy ? 'wait' : 'pointer', padding: 0, textDecoration: 'underline' }}
        >
          Reset to built-in defaults
        </button>
      </Card>

      {/* Council Scorecard targets — an org admin sets the thresholds the
          scorecard grades divisions against. Unset on the org = the shipped
          defaults; changes take effect on the next scorecard load (saved
          snapshots keep the targets they were frozen with). */}
      <Card padding="1.5rem" marginBottom="1.5rem">
        <h2 style={sectionTitleStyle}>Council Scorecard targets</h2>
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 4 }}>
          The thresholds the <strong>{activeOrgName || 'this tenant'}</strong> Council Scorecard grades each division against. Keep the shipped defaults or set your council's own bar — the live scorecard re-derives against these on its next load. {scorecardTargetsCustom ? 'Custom targets are in effect.' : 'Using the shipped defaults.'}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
          {SCORECARD_TARGET_FIELDS.map((f) => (
            <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{f.label}</span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--color-text-muted)', marginTop: 1 }}>{f.hint}</span>
              </span>
              <input
                type="number"
                aria-label={f.label}
                min={f.unit === 'days' ? 1 : 0}
                max={f.unit === '%' ? 100 : undefined}
                value={scorecardTargets[f.key]}
                disabled={scorecardTargetsBusy}
                onChange={(e) => setScorecardTarget(f.key, e.target.value === '' ? 0 : Number(e.target.value))}
                style={{ width: 72, textAlign: 'right', padding: '6px 8px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'var(--color-surface)', color: 'var(--color-text)', fontVariantNumeric: 'tabular-nums' }}
              />
              <span style={{ width: 34, fontSize: 12, color: 'var(--color-text-muted)' }}>{f.unit === '%' ? '%' : f.unit === 'days' ? 'days' : ''}</span>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
          <button
            onClick={saveScorecardTargets}
            disabled={!activeOrgId || scorecardTargetsBusy || !scorecardTargetsDirty}
            style={{ padding: '0.5rem 1.25rem', background: (!scorecardTargetsDirty || scorecardTargetsBusy) ? 'var(--color-border)' : 'var(--color-primary)', color: (!scorecardTargetsDirty || scorecardTargetsBusy) ? 'var(--color-text-muted)' : '#fff', border: 'none', borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 500, cursor: (!activeOrgId || scorecardTargetsBusy || !scorecardTargetsDirty) ? 'not-allowed' : 'pointer' }}
          >
            {scorecardTargetsBusy ? 'Saving…' : 'Save targets'}
          </button>
          <SecondaryButton onClick={resetScorecardTargets} disabled={!activeOrgId || scorecardTargetsBusy || !scorecardTargetsCustom}>Reset to defaults</SecondaryButton>
        </div>
      </Card>

      {/* Backup & Restore */}
      <Card padding="1.5rem">
        <h2 style={sectionTitleStyle}>Backup & Restore</h2>

        {/* Export */}
        <div style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, color: 'var(--color-text)', marginBottom: '0.5rem' }}>Export Backup</h3>
          <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)', marginBottom: '0.75rem' }}>
            Download a full backup of <strong>{activeOrgName || 'this tenant'}</strong> and everything beneath it as a JSON file — records, attachment links, and the contents of uploaded files, so it restores completely on another host.
          </p>
          <button
            onClick={handleExportBackup}
            disabled={exportLoading}
            style={{
              padding: '0.5rem 1.5rem',
              background: exportLoading ? '#6b7280' : 'var(--color-primary)',
              color: '#ffffff',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: exportLoading ? 'not-allowed' : 'pointer',
            }}
          >
            {exportLoading ? 'Exporting…' : 'Export Backup'}
          </button>
        </div>

        {/* Divider */}
        <div style={{ height: '1px', background: 'var(--color-border)', marginBottom: '1.5rem' }} />

        {/* Import */}
        <div>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, color: 'var(--color-text)', marginBottom: '0.5rem' }}>Import Backup</h3>
          <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)', marginBottom: '0.75rem' }}>
            Restore data from a previously exported Procela backup file.
          </p>

          <input
            ref={fileInputRef}
            aria-label="Backup file to import"
            type="file"
            accept=".json"
            onChange={handleFileSelect}
            style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }}
          />

          {importError && (
            <div style={{ color: 'var(--color-error)', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--radius-md)', padding: '0.5rem 0.75rem', marginBottom: '0.75rem', fontSize: '0.8125rem' }}>
              {importError}
            </div>
          )}

          {importPreview && (
            <div style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '0.75rem 1rem', marginBottom: '0.75rem' }}>
              <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--color-text)', marginBottom: '0.5rem' }}>
                This backup contains:
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.25rem 1rem', fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                {Object.entries(importPreview).map(([key, count]) => (
                  <div key={key}>
                    <span style={{ fontWeight: 500 }}>{count}</span> {key}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 'var(--radius-md)', fontSize: '0.8125rem', color: 'var(--color-warning)' }}>
                Warning: This will replace ALL existing data. This cannot be undone.
              </div>
              <button
                onClick={() => setImportConfirmOpen(true)}
                disabled={importLoading}
                style={{
                  marginTop: '0.75rem',
                  padding: '0.5rem 1.5rem',
                  background: importLoading ? '#6b7280' : '#dc2626',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  cursor: importLoading ? 'not-allowed' : 'pointer',
                }}
              >
                {importLoading ? 'Importing…' : 'Import'}
              </button>
            </div>
          )}

          {importResult && (
            <div style={{ color: 'var(--color-success)', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 'var(--radius-md)', padding: '0.75rem 1rem', fontSize: '0.8125rem' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Import successful!</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.25rem 1rem' }}>
                {Object.entries(importResult).map(([key, count]) => (
                  <div key={key}>
                    <span style={{ fontWeight: 500 }}>{count}</span> {key}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={importConfirmOpen}
        title="Restore this backup?"
        message="This restores the backup into its tenant: existing process, data, and governance records in that scope are replaced with the file's contents (organizations and people are updated, not removed). This cannot be undone. Continue?"
        confirmLabel="Yes, Import"
        onConfirm={handleImportConfirm}
        onCancel={() => setImportConfirmOpen(false)}
      />

      {/* Spacer */}
      <div style={{ height: '1.5rem' }} />

      {/* Load demo data and Reset — two data-lifecycle actions paired
          side-by-side to shorten the Data tab. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '1.5rem', alignItems: 'start' }}>

      {/* Load demo data — one-click seed of the Tidewater Utilities
          fixture. Idempotent; a second call wipes the prior seed and
          reseeds so the button always converges on a known state.
          Positioned above Reset so the demo-mode workflow reads top-
          to-bottom: seed → demo → reset. */}
      <LoadDemoDataPanel />

      {/* Reset everything — super-admin only "factory reset" that
          wipes every store on disk + in memory. Lives next to Backup
          & Restore so it's reachable from the same scroll position as
          the Export button, and so the recommended Export-first
          workflow is one click away. */}
      <ResetAllDataPanel onExportFirst={handleExportBackup} />

      </div>{/* end demo + reset grid */}

      </div>{/* ══ /Data ══ */}

    </div>
  );
}

const sectionStyle: React.CSSProperties = {
  background: 'var(--color-surface)',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--color-border)',
  padding: '1.5rem',
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: '1.125rem',
  fontWeight: 600,
  marginBottom: '1rem',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.8125rem',
  fontWeight: 500,
  color: 'var(--color-text-secondary)',
  marginBottom: '0.375rem',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.5rem 0.75rem',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  fontSize: '0.875rem',
  outline: 'none',
  boxSizing: 'border-box',
  background: 'var(--color-surface)',
};


// ──────────────────────────────────────────────────────────────────────────
// LocalMigrationPanel — one-time admin action that moves people without
// a stored credential onto Local auth. Generates a strong temporary
// password for each, hashes it server-side, returns the plaintext
// values ONCE so the admin can distribute them out-of-band. Every
// generated password is marked must-change so the user is forced into
// the change-password flow on first login.
//
// The panel deliberately doesn't ship credentials over email — that
// integration is a separate concern. The download-as-CSV affordance
// is the recommended distribution method until SMTP is wired.
// ──────────────────────────────────────────────────────────────────────────

interface TempCredential {
  personId: string;
  email: string;
  name: string;
  tempPassword: string;
}

function LocalMigrationPanel() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ count: number; message: string; tempPasswords: TempCredential[] } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const res = await apiClient.post<{ success: boolean; data: { count: number; message: string; tempPasswords: TempCredential[] } }>(
        '/auth/migrate-to-local',
        {},
      );
      setResult(res.data);
    } catch { /* toast already shown by client */ }
    finally { setBusy(false); setConfirming(false); }
  };

  const downloadCsv = () => {
    if (!result) return;
    const csv = [
      'Email,Name,Temporary password',
      ...result.tempPasswords.map((p) => `"${p.email}","${p.name}","${p.tempPassword}"`),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `procela-temp-passwords-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{
      marginTop: '1rem', padding: '1rem',
      background: 'var(--color-bg)', border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
        Migrate people to Local auth
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
        Generates a temporary password for every Person without a stored credential.
        Returns the plaintext values <strong>once</strong> — copy or download them now,
        because they aren't stored after this response. Every recipient is required to
        change their password on first login.
      </div>

      {!result && !confirming && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={busy}
          style={{
            padding: '0.4rem 1rem', fontSize: 13, fontWeight: 500,
            background: 'var(--color-surface)', color: 'var(--color-text)',
            border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          Generate temporary passwords…
        </button>
      )}

      {confirming && !result && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12 }}>Run now? The values are only returned once.</span>
          <button
            type="button"
            onClick={run}
            disabled={busy}
            style={{
              padding: '0.4rem 1rem', fontSize: 13, fontWeight: 500,
              background: 'var(--color-primary)', color: '#fff',
              border: 'none', borderRadius: 'var(--radius-md)',
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {busy ? 'Running…' : 'Confirm'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            style={{
              padding: '0.4rem 1rem', fontSize: 13, fontWeight: 500,
              background: 'var(--color-surface)', color: 'var(--color-text-muted)',
              border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {result && (
        <div>
          <div style={{ fontSize: 13, marginBottom: 8 }}>{result.message}</div>
          {result.tempPasswords.length > 0 && (
            <>
              <button
                type="button"
                onClick={downloadCsv}
                style={{
                  padding: '0.4rem 1rem', fontSize: 13, fontWeight: 500,
                  background: 'var(--color-primary)', color: '#fff',
                  border: 'none', borderRadius: 'var(--radius-md)',
                  cursor: 'pointer', marginBottom: 10,
                }}
              >
                Download as CSV
              </button>
              <div style={{
                maxHeight: 220, overflowY: 'auto',
                border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
                fontFamily: 'var(--font-mono, monospace)', fontSize: 11,
                background: 'var(--color-surface)',
              }}>
                {result.tempPasswords.map((p) => (
                  <div key={p.personId} style={{
                    padding: '6px 10px', borderBottom: '1px solid var(--color-border)',
                    display: 'flex', gap: 12, justifyContent: 'space-between',
                  }}>
                    <span>{p.email}</span>
                    <span style={{ fontWeight: 600 }}>{p.tempPassword}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// MfaPanel — enroll / disable TOTP for the current user.
//
// Three states:
//   - loading                 fetching /auth/me to see if already enrolled
//   - enrolled                shows "Enrolled" pill + Disable button
//   - not-enrolled / enrolling  shows the QR + secret + a 6-digit code
//                              prompt. After verify, displays backup
//                              codes ONCE and asks the user to confirm
//                              they've saved them.
//
// MFA is bound to the local-credential auth path. Users signing in via
// OIDC see this panel disabled with a one-line note — their IdP is the
// place to enforce MFA. Dev-mode users see it disabled too.
// ──────────────────────────────────────────────────────────────────────────

interface MeResponse {
  data: {
    sub: string;
    mfaEnrolled?: boolean;
    mfaBackupCodesRemaining?: number;
    role: string;
  };
}

interface WebauthnCredentialView {
  id: string;
  label: string;
  createdAt: string;
  transports?: string[];
}

function MfaPanel() {
  const [loading, setLoading] = useState(true);
  const [enrolled, setEnrolled] = useState(false);
  const [backupRemaining, setBackupRemaining] = useState<number>(0);
  const [webauthnCreds, setWebauthnCreds] = useState<WebauthnCredentialView[]>([]);
  const [enrolling, setEnrolling] = useState<{
    secret: string;
    qrDataUrl: string;
    uri: string;
    replacing: boolean;
  } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  // Disable flow state
  const [disablingOpen, setDisablingOpen] = useState(false);
  // Confirmation state for "Remove security key" — replaces the stray
  // window.confirm() so the rest of the app's ConfirmDialog patterns
  // (focus trap, escape-to-cancel, themed buttons) apply here too.
  const [confirmRemoveCred, setConfirmRemoveCred] = useState<{ id: string; label: string } | null>(null);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  // Regenerate-backup-codes flow state (separate from the
  // post-enrollment one-shot display).
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenCode, setRegenCode] = useState('');

  const refresh = useCallback(async () => {
    try {
      const me = await apiClient.get<MeResponse>('/auth/me');
      const personRes = await apiClient.get<{
        data: {
          mfaEnrolled?: boolean;
          webauthnCredentials?: WebauthnCredentialView[];
        };
      }>(`/people/${me.data.sub}`);
      setEnrolled(!!personRes.data.mfaEnrolled);
      setWebauthnCreds(personRes.data.webauthnCredentials || []);
      setBackupRemaining(me.data.mfaBackupCodesRemaining ?? 0);
    } catch { /* default to not enrolled */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const startEnrollment = async () => {
    setErr('');
    setBusy(true);
    try {
      const res = await apiClient.post<{ data: { secret: string; qrDataUrl: string; uri: string; replacing: boolean } }>(
        '/auth/mfa/start', {});
      setEnrolling(res.data);
      setCode('');
    } catch (e) {
      setErr(errorMessage(e, 'Failed to start enrollment'));
    } finally { setBusy(false); }
  };

  const verifyEnrollment = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const res = await apiClient.post<{ data: { backupCodes: string[] } }>(
        '/auth/mfa/verify', { code });
      setBackupCodes(res.data.backupCodes);
      setEnrolled(true);
      setEnrolling(null);
      setCode('');
    } catch (e) {
      setErr(errorMessage(e, 'Invalid code'));
    } finally { setBusy(false); }
  };

  const disableMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await apiClient.post('/auth/mfa/disable', { currentPassword: disablePassword, code: disableCode });
      setEnrolled(false);
      setDisablingOpen(false);
      setDisablePassword('');
      setDisableCode('');
    } catch (e) {
      setErr(errorMessage(e, 'Could not disable two-step verification'));
    } finally { setBusy(false); }
  };

  const regenerateBackupCodes = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const res = await apiClient.post<{ data: { backupCodes: string[] } }>(
        '/auth/mfa/regenerate-backup-codes', { code: regenCode });
      setBackupCodes(res.data.backupCodes);
      setRegenOpen(false);
      setRegenCode('');
      await refresh();
    } catch (e) {
      setErr(errorMessage(e, 'Could not regenerate backup codes'));
    } finally { setBusy(false); }
  };

  // ── WebAuthn enrollment ──
  const registerWebauthn = async () => {
    setErr('');
    setBusy(true);
    try {
      const startRes = await apiClient.post<{ data: any }>('/auth/mfa/webauthn/register-start', {});
      // Default label takes a sensible guess from the platform; user
      // can rename via the API later. Keep it short so the chip in
      // the credentials list doesn't get unwieldy.
      const label = window.prompt(
        'Name this security key (e.g. "YubiKey 5", "MacBook Touch ID"):',
        'Security key',
      ) || 'Security key';
      const attestation = await startWebauthnRegistration({ optionsJSON: startRes.data });
      await apiClient.post('/auth/mfa/webauthn/register-finish', { response: attestation, label });
      await refresh();
    } catch (e: any) {
      // Browser cancel / user dismissed prompt — silent.
      if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') return;
      setErr(e?.message || 'Could not register security key');
    } finally { setBusy(false); }
  };

  const removeWebauthn = async (credId: string) => {
    setBusy(true);
    try {
      await apiClient.delete(`/auth/mfa/webauthn/credentials/${credId}`);
      await refresh();
    } catch (e) {
      setErr(errorMessage(e, 'Could not remove security key'));
    } finally { setBusy(false); }
  };

  const downloadBackupCodes = () => {
    if (!backupCodes) return;
    const blob = new Blob([
      'Procela backup codes — keep these somewhere safe.\n',
      'Each code is single-use. Use them to sign in if you lose access to your authenticator app.\n\n',
      ...backupCodes.map((c) => c + '\n'),
    ], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `procela-backup-codes-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return <Spinner label="Loading…" />;
  }

  // renderTotp encapsulates the four states the TOTP sub-panel can
  // be in (one-time backup codes display, enrolled, mid-enrollment
  // QR scan, or the default "Set up" button). Wrapped this way so
  // the outer return can stack it next to the WebAuthn subsection
  // without duplicating the auto-layout.
  const renderTotp = (): React.ReactNode => {

  // ── Backup-codes display (post-enrollment, one-time) ──
  if (backupCodes) {
    return (
      <div style={{
        background: 'var(--color-bg)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: '1rem',
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
          Save these backup codes
        </div>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
          Each code is single-use. Save them somewhere you'll be able to
          reach when you don't have your authenticator app — a password
          manager, an offline note, a printout. They aren't stored on
          our side after this and can't be recovered.
        </p>
        <div style={{
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 13,
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          padding: 12,
          marginBottom: 12,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '4px 16px',
        }}>
          {backupCodes.map((c) => <div key={c}>{c}</div>)}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={downloadBackupCodes}
            style={{
              padding: '0.4rem 1rem', fontSize: 13, fontWeight: 500,
              background: 'var(--color-surface)', color: 'var(--color-text)',
              border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
            }}
          >
            Download as text
          </button>
          <button
            type="button"
            onClick={() => setBackupCodes(null)}
            style={{
              padding: '0.4rem 1rem', fontSize: 13, fontWeight: 500,
              background: 'var(--color-primary)', color: '#fff',
              border: 'none', borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
            }}
          >
            I've saved them
          </button>
        </div>
      </div>
    );
  }

  // ── Already enrolled ──
  if (enrolled) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
            background: '#d1fae5', color: '#065f46', textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>Enrolled</span>
          <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
            You'll be asked for a code at sign-in.
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={startEnrollment}
            disabled={busy}
            style={{
              padding: '0.4rem 1rem', fontSize: 13, fontWeight: 500,
              background: 'var(--color-surface)', color: 'var(--color-text)',
              border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            Replace authenticator
          </button>
          <button
            type="button"
            onClick={() => setDisablingOpen(true)}
            disabled={busy}
            style={{
              padding: '0.4rem 1rem', fontSize: 13, fontWeight: 500,
              background: 'var(--color-surface)', color: 'var(--color-error, #dc2626)',
              border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            Disable
          </button>
        </div>

        {disablingOpen && (
          <form onSubmit={disableMfa} style={{
            marginTop: 12, padding: 12,
            background: 'var(--color-bg)', border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
          }}>
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              Confirm with your current password and a code from your authenticator:
            </div>
            {err && <div style={{ fontSize: 12, color: 'var(--color-error)', marginBottom: 6 }}>{err}</div>}
            <input
              aria-label="Current password"
              type="password"
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
              placeholder="Current password"
              required
              autoComplete="current-password"
              style={inputStyle}
            />
            <input
              aria-label="6-digit code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ''))}
              placeholder="6-digit code"
              required
              style={{ ...inputStyle, marginTop: 6 }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => { setDisablingOpen(false); setErr(''); }}
                style={{
                  padding: '0.4rem 1rem', fontSize: 13,
                  background: 'transparent', color: 'var(--color-text-muted)',
                  border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                style={{
                  padding: '0.4rem 1rem', fontSize: 13, fontWeight: 500,
                  background: 'var(--color-error, #dc2626)', color: '#fff',
                  border: 'none', borderRadius: 'var(--radius-md)',
                  cursor: busy ? 'default' : 'pointer',
                }}
              >
                {busy ? 'Disabling…' : 'Disable'}
              </button>
            </div>
          </form>
        )}
      </div>
    );
  }

  // ── Mid-enrollment (QR + code prompt) ──
  if (enrolling) {
    return (
      <div style={{
        background: 'var(--color-bg)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: '1rem',
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
          {enrolling.replacing ? 'Replace your authenticator' : 'Scan with your authenticator'}
        </div>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
          Open Google Authenticator, 1Password, Authy, or another TOTP app and
          scan this QR code. Then enter the 6-digit code it generates.
        </p>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <img src={enrolling.qrDataUrl} alt="MFA QR code" width={180} height={180} style={{ border: '1px solid var(--color-border)', borderRadius: 4, background: '#fff' }} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <SectionLabel marginBottom={4}>
              Can't scan? Type this:
            </SectionLabel>
            <div style={{
              fontFamily: 'var(--font-mono, monospace)', fontSize: 13,
              background: 'var(--color-surface)', border: '1px solid var(--color-border)',
              borderRadius: 4, padding: '6px 8px', marginBottom: 12,
              wordBreak: 'break-all',
            }}>
              {enrolling.secret}
            </div>
            <form onSubmit={verifyEnrollment}>
              {err && <div style={{ fontSize: 12, color: 'var(--color-error)', marginBottom: 6 }}>{err}</div>}
              <input
                aria-label="6-digit code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="6-digit code"
                required
                autoFocus
                style={inputStyle}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  type="submit"
                  disabled={busy || code.length !== 6}
                  style={{
                    padding: '0.4rem 1rem', fontSize: 13, fontWeight: 500,
                    background: 'var(--color-primary)', color: '#fff',
                    border: 'none', borderRadius: 'var(--radius-md)',
                    cursor: (busy || code.length !== 6) ? 'default' : 'pointer',
                    opacity: (busy || code.length !== 6) ? 0.5 : 1,
                  }}
                >
                  {busy ? 'Verifying…' : 'Verify'}
                </button>
                <button
                  type="button"
                  onClick={() => { setEnrolling(null); setErr(''); }}
                  style={{
                    padding: '0.4rem 1rem', fontSize: 13,
                    background: 'transparent', color: 'var(--color-text-muted)',
                    border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // ── Default: not enrolled, offer to start ──
  return (
    <div>
      {err && <div style={{ fontSize: 12, color: 'var(--color-error)', marginBottom: 6 }}>{err}</div>}
      <button
        type="button"
        onClick={startEnrollment}
        disabled={busy}
        style={{
          padding: '0.5rem 1rem', fontSize: 13, fontWeight: 500,
          background: 'var(--color-primary)', color: '#fff',
          border: 'none', borderRadius: 'var(--radius-md)',
          cursor: busy ? 'default' : 'pointer',
        }}
      >
        {busy ? 'Starting…' : 'Set up two-step verification'}
      </button>
    </div>
  );

  }; // end renderTotp

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Authenticator app (TOTP) */}
      <div>
        <SectionLabel>
          Authenticator app
        </SectionLabel>
        {renderTotp()}

        {/* Backup-codes running-low nudge. Shown when enrolled and
            <= 3 codes remain. Each code is single-use; users who
            burn through them on lost-authenticator events end up
            with zero. */}
        {enrolled && !backupCodes && backupRemaining <= 3 && (
          <div style={{
            marginTop: 10, padding: '8px 12px',
            background: '#fffbeb', border: '1px solid #fde68a',
            borderRadius: 'var(--radius-md)', fontSize: 12, color: '#92400e',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span>{backupRemaining} backup code{backupRemaining === 1 ? '' : 's'} remaining — regenerate before you run out.</span>
            <button
              type="button"
              onClick={() => { setRegenOpen(true); setErr(''); }}
              style={{
                marginLeft: 'auto',
                padding: '4px 10px', fontSize: 12, fontWeight: 500,
                background: '#fff', color: '#92400e',
                border: '1px solid #fde68a', borderRadius: 4, cursor: 'pointer',
              }}
            >
              Regenerate
            </button>
          </div>
        )}
        {enrolled && !backupCodes && regenOpen && (
          <form onSubmit={regenerateBackupCodes} style={{
            marginTop: 8, padding: 12,
            background: 'var(--color-bg)', border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
          }}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              Confirm with a code from your authenticator to generate a new set of 10 backup codes. The current set will be invalidated.
            </div>
            <input
              aria-label="6-digit code"
              type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              value={regenCode}
              onChange={(e) => setRegenCode(e.target.value.replace(/\D/g, ''))}
              placeholder="6-digit code" required
              style={inputStyle}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => { setRegenOpen(false); setErr(''); }}
                style={{ padding: '0.4rem 1rem', fontSize: 13, background: 'transparent', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>
                Cancel
              </button>
              <button type="submit" disabled={busy || regenCode.length !== 6}
                style={{ padding: '0.4rem 1rem', fontSize: 13, fontWeight: 500, background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: (busy || regenCode.length !== 6) ? 'default' : 'pointer', opacity: (busy || regenCode.length !== 6) ? 0.5 : 1 }}>
                {busy ? 'Regenerating…' : 'Regenerate'}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Security keys (WebAuthn / FIDO2). Available regardless of
          whether TOTP is set up — they're independent second-factor
          methods, either one (or both) satisfies the login gate. */}
      <div>
        <SectionLabel>
          Security keys
        </SectionLabel>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
          Hardware keys (YubiKey, Titan) or platform authenticators (Touch ID,
          Windows Hello, Android fingerprint). Faster than typing a code; users
          who register a key can sign in by tapping it.
        </p>
        {webauthnCreds.length === 0 ? (
          <div style={{ fontSize: 12, fontStyle: 'italic', color: 'var(--color-text-muted)', marginBottom: 10 }}>
            No security keys registered.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {webauthnCreds.map((c) => (
              <div key={c.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px',
                background: 'var(--color-bg)', border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)', fontSize: 13,
              }}>
                <span style={{ flex: 1 }}>{c.label}</span>
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                  Added {new Date(c.createdAt).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  onClick={() => setConfirmRemoveCred({ id: c.id, label: c.label })}
                  style={{ background: 'transparent', border: 'none', color: 'var(--color-error, #dc2626)', fontSize: 12, cursor: 'pointer', padding: '2px 6px' }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={registerWebauthn}
          disabled={busy}
          style={{
            padding: '0.4rem 1rem', fontSize: 13, fontWeight: 500,
            background: 'var(--color-surface)', color: 'var(--color-text)',
            border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          + Register a security key
        </button>
      </div>
      <ConfirmDialog
        open={!!confirmRemoveCred}
        title="Remove this security key?"
        message={confirmRemoveCred ? `Remove "${confirmRemoveCred.label}"? You won't be able to use this security key to sign in.` : ''}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={async () => {
          const target = confirmRemoveCred;
          setConfirmRemoveCred(null);
          if (target) await removeWebauthn(target.id);
        }}
        onCancel={() => setConfirmRemoveCred(null)}
      />
    </div>
  );
}

