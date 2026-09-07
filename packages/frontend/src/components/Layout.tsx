import { useEffect, useCallback, useState, useRef } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import styles from './Layout.module.css';
import Breadcrumbs from './Breadcrumbs';
import ChatPanel from './ChatPanel';
import SessionTimeout from './SessionTimeout';
import IdleTimeout from './IdleTimeout';
import ToastContainer from './ToastContainer';
import RoleDetailDrawer from './RoleDetailDrawer';
import ShortcutsModal from './ShortcutsModal';
import ShortcutsHint from './ShortcutsHint';
import OnboardingWizard from './OnboardingWizard';
import CommandPalette from './CommandPalette';
import MobileNavDrawer from './MobileNavDrawer';
import NotificationsMenu from './NotificationsMenu';
import UserMenu from './UserMenu';
import SupportModal from './SupportModal';
import Sidebar from './Sidebar';
import {
  navSections,
  bottomNavItems,
  GET_STARTED_ITEM,
  openHelpWindow,
  type NavItem,
} from './navConfig';

import { useAuthStore } from '@/stores/authStore';
import { useOrgContext } from '@/stores/orgContext';
import { signOutLocal } from '@/lib/signOut';
import { useBrandingStore } from '@/stores/brandingStore';
import { useAiConfigStore } from '@/stores/aiConfigStore';
import { apiClient } from '@/api/client';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';
import { useIsMobile } from '@/hooks/useMediaQuery';


export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated } = useAuthStore();
  const { activeOrgId, setActiveOrg, setOrgs, clearActiveOrg, refreshKey, triggerRefresh } = useOrgContext();
  const { branding, fetch: fetchBranding } = useBrandingStore();
  const aiEnabled = useAiConfigStore((s) => s.aiEnabled);
  const fetchAiConfig = useAiConfigStore((s) => s.fetch);

  // Apply the customer's theme (company name, logo, colors) as early as
  // possible. The store also fetches from /login via brandingStore bootstrap;
  // re-fetching on mount here keeps the shell in sync when an admin updates
  // branding without requiring a full reload.
  useEffect(() => { fetchBranding(); }, [fetchBranding]);
  // Learn whether AI integration features are on for this deployment so the
  // shell can hide every AI surface when they're off.
  useEffect(() => { fetchAiConfig(); }, [fetchAiConfig]);
  const [orgOptions, setOrgOptions] = useState<Array<{ id: string; name: string; type: string; parentId: string | null; label: string }>>([]);

  const isMobile = useIsMobile();
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  // Close the mobile nav drawer on navigation.
  useEffect(() => { setMobileDrawerOpen(false); }, [location.pathname]);



  // Search state
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Re-run guided tour. Triggered from Help / Settings via a window
  // event so the buttons don't have to plumb a setter through React
  // context. Distinct from the first-run wizard mount below — this one
  // is "tour-only" and never tries to create another org.
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    const handler = () => setTourOpen(true);
    window.addEventListener('procela:start-tour', handler);
    return () => window.removeEventListener('procela:start-tour', handler);
  }, []);

  // Mirror the ChatPanel's open state so the top-bar "Ask AI" button
  // can reflect it (aria-expanded + active styling). The ChatPanel
  // dispatches procela:chat-state whenever its internal open state
  // or message list changes; we track both so the top-bar button
  // can render a count badge when a conversation is paused and
  // waiting to be resumed — that signalling used to live on the
  // now-retired floating bubble.
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessageCount, setChatMessageCount] = useState(0);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ open: boolean; messageCount?: number }>).detail;
      if (!detail) return;
      if (typeof detail.open === 'boolean') setChatOpen(detail.open);
      if (typeof detail.messageCount === 'number') setChatMessageCount(detail.messageCount);
    };
    window.addEventListener('procela:chat-state', handler);
    return () => window.removeEventListener('procela:chat-state', handler);
  }, []);

  // Shortcuts modal state
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);

  // Window-event opener for the keyboard shortcuts modal, so any page
  // (Help, in particular) can pop it without holding a setter handle.
  useEffect(() => {
    const handler = () => setShortcutsOpen(true);
    window.addEventListener('procela:open-shortcuts', handler);
    return () => window.removeEventListener('procela:open-shortcuts', handler);
  }, []);

  // Per-page browser tab title. Without this, every Procela tab in the
  // browser bar reads "Procela" and a user with several tabs open
  // cannot tell them apart. Derived from the matching nav item label so
  // each page automatically picks up the right title with no per-page
  // wiring needed.
  useEffect(() => {
    const path = location.pathname;
    const allItems: NavItem[] = [
      GET_STARTED_ITEM,
      ...navSections.flatMap((s) => s.items),
      ...bottomNavItems,
    ];
    // Prefer the most specific match (longest route prefix).
    const match = allItems
      .filter((i) => path === i.to || path.startsWith(i.to + '/'))
      .sort((a, b) => b.to.length - a.to.length)[0];
    // Append a sub-route label so deep pages aren't all "Processes ·
    // Procela". Keyed by the trailing path segment after the matched
    // nav route.
    let suffix = '';
    if (match && path.length > match.to.length) {
      const tail = path.slice(match.to.length).replace(/^\/+/, '').split('/')[0];
      const SUBROUTE_LABELS: Record<string, string> = {
        wizard: 'Wizard',
        visualization: 'Map',
        compare: 'Compare',
        new: 'New',
        edit: 'Edit',
      };
      // Use a colon, not " — ": brandingStore appends the customer's
      // company name with " — " and derives the base via split(' — '),
      // so an em-dash here would be swallowed when branding re-applies.
      if (tail) suffix = `: ${SUBROUTE_LABELS[tail] || tail.charAt(0).toUpperCase() + tail.slice(1)}`;
    }
    document.title = match ? `${match.titleLabel || match.label}${suffix} · Procela` : 'Procela';
  }, [location.pathname]);

  // Global keyboard shortcuts. Cmd/Ctrl+K and `/` both open the command
  // palette. `?` opens the shortcuts modal. `g` followed by a letter goes
  // somewhere (handled separately so the second key isn't a chord).
  useKeyboardShortcut('k', () => setPaletteOpen(true), { mod: true });
  useKeyboardShortcut('/', () => setPaletteOpen(true));
  useKeyboardShortcut('?', () => setShortcutsOpen(true), { shift: true });

  // Two-key "go to" sequences. Track the timestamp of the last `g` press;
  // if a navigation key arrives within 1.5s, treat it as a chord.
  const lastGRef = useRef<number>(0);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const now = Date.now();
      const chordActive = now - lastGRef.current < 1500;
      if (e.key === 'g' && !e.shiftKey && !chordActive) {
        // First `g` — arm the chord. A second `g` within the window
        // is NOT re-armed here so that "g g" can resolve to the
        // Governance Program shortcut below.
        lastGRef.current = now;
        return;
      }
      if (chordActive) {
        const map: Record<string, string> = {
          d: '/', o: '/organizations', p: '/people', c: '/processes', a: '/data-assets',
          s: '/systems', q: '/data-quality', l: '/data-lineage', m: '/mappings',
          g: '/governance/foundation', r: '/reports', e: '/enterprise-view', h: '/help',
        };
        const route = map[e.key];
        if (route) {
          e.preventDefault();
          lastGRef.current = 0;
          navigate(route);
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate]);



  const fetchOrgs = useCallback(async () => {
    try {
      // Fetch accessible orgs for the current user (filtered by role/assignment).
      // parentId is included so the header dropdown can group divisions under
      // their parent company without a second round-trip.
      const accessRes = await apiClient.get<{ success: boolean; data: Array<{ id: string; name: string; type: string; parentId?: string | null }> }>('/auth/accessible-orgs');
      const accessible = accessRes.data || [];

      const options = accessible.map((o) => {
        const typeLabel = o.type.charAt(0).toUpperCase() + o.type.slice(1);
        return { id: o.id, name: o.name, type: o.type, parentId: o.parentId ?? null, label: `${o.name} (${typeLabel})` };
      });
      // Sort so company comes first, then divisions — ensures the broadest scope is the default
      const typeOrder: Record<string, number> = { company: 0, division: 1, department: 2, team: 3, unit: 4 };
      options.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));

      setOrgOptions(options);
      setOrgs(options.map((o) => ({ id: o.id, name: o.name, type: o.type })));

      // If the active org is no longer accessible, fall back to any reachable
      // org (preferring a company so the user lands on the broadest scope).
      // The old behaviour fell back only to companies, which broke users who
      // genuinely only have a division-level grant.
      const reachable = options;
      if (activeOrgId && !reachable.find((o) => o.id === activeOrgId)) {
        const fallback = reachable.find((o) => o.type === 'company') || reachable[0];
        if (fallback) {
          setActiveOrg(fallback.id, fallback.name, fallback.type);
        } else {
          clearActiveOrg();
        }
      }

      // Auto-select the broadest reachable org if none is selected yet.
      if (!activeOrgId && reachable.length > 0) {
        const first = reachable.find((o) => o.type === 'company') || reachable[0];
        setActiveOrg(first.id, first.name, first.type);
      }
    } catch { /* */ }
  }, [activeOrgId, setOrgs, clearActiveOrg, setActiveOrg, refreshKey]);

  useEffect(() => {
    if (isAuthenticated) fetchOrgs();
  }, [isAuthenticated, fetchOrgs]);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/login');
    }
  }, [isAuthenticated, navigate]);

  if (!isAuthenticated) {
    return null;
  }

  const handleSignOut = async () => {
    // Tell the backend to revoke the refresh token + look up the
    // OIDC RP-initiated-logout URL. When the session came from an
    // OIDC flow AND the IdP advertises an end_session_endpoint, the
    // response carries a logoutUrl we should redirect to — otherwise
    // the IdP still considers the user signed in and the next "Sign
    // in" click silently logs them right back in.
    let logoutUrl: string | null = null;
    try {
      const refreshToken = useAuthStore.getState().refreshToken;
      if (refreshToken) {
        const res = await apiClient.post<{ success: boolean; data: { logoutUrl?: string } }>(
          '/auth/logout',
          { refreshToken },
        );
        logoutUrl = res.data?.logoutUrl || null;
      }
    } catch { /* always clear local session even when the backend call fails */ }
    signOutLocal();
    if (logoutUrl) {
      window.location.href = logoutUrl;
    } else {
      navigate('/login');
    }
  };

  const handleOrgChange = (id: string) => {
    if (!id) return; // Don't allow clearing — must always have an org selected
    const org = orgOptions.find((o) => o.id === id);
    if (org) {
      setActiveOrg(id, org.name, org.type);
      // Toast feedback
      try {
        const { addToast } = require('@/stores/toastStore').useToastStore.getState();
        addToast('info', `Now working in ${org.name}`);
      } catch { /* */ }
    }
  };

  // Focused reading mode for the Help guide *and* the Training Guide:
  // when the route is /help or /help/training we strip the sidebar,
  // header, chat panel and every other bit of app chrome so the user
  // gets a clean, single-purpose reading view. Only a thin top bar
  // remains, with the Procela logo, a context label, and a Close
  // button. Close prefers window.close() (these pages are opened in
  // their own popup), then history.back(), then falls back to "/"
  // for deep links.
  const isReadingMode = location.pathname === '/help' || location.pathname === '/help/training' || location.pathname === '/roadmap';
  const readingModeLabel = location.pathname === '/help/training' ? 'Training Guide'
    : location.pathname === '/roadmap' ? 'Product Roadmap'
    : 'Help Guide';
  if (isReadingMode) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--color-bg)', display: 'flex', flexDirection: 'column' }}>
        <header style={{
          height: 56, background: 'var(--color-surface)',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 24px', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img
              src={branding.logoUrl || '/procela-icon.png'}
              alt={branding.companyName || 'Procela'}
              style={{ height: 32, width: 'auto' }}
            />
            <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{readingModeLabel}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              // The Help guide is opened by openHelpWindow() in its
              // own browser window via window.open, so closing it
              // should close that window — not just navigate inside
              // it. window.close() works for script-opened windows
              // in every modern browser even with noopener, but if
              // it's somehow blocked (deep link in the same tab, an
              // odd embedded context) fall back to in-app navigation
              // so the user isn't stranded on a content-only page
              // with no chrome.
              window.close();
              setTimeout(() => {
                if (!window.closed) {
                  if (window.history.length > 1) navigate(-1);
                  else navigate('/');
                }
              }, 100);
            }}
            style={{
              padding: '6px 14px', fontSize: 13, fontWeight: 500,
              background: 'var(--color-surface)', color: 'var(--color-text)',
              border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
            }}
            title={`Close the ${readingModeLabel.toLowerCase()} window`}
          >
            × Close
          </button>
        </header>
        <main id="main-content" style={{ flex: 1, padding: 24, overflowY: 'auto', scrollbarGutter: 'stable' }}>
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      {/* Skip-to-content - first focusable element so Tab from the
        * URL bar lands here. Lets keyboard users jump past the sidebar
        * and header straight to the page body. */}
      <a href="#main-content" className="skip-to-content">Skip to main content</a>
      {/* Sidebar */}
      <Sidebar onOpenMobileMenu={() => setMobileDrawerOpen(true)} mobileDrawerOpen={mobileDrawerOpen} />

      {/* Main content area */}
      <div className={styles.main}>
        <header className={styles.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', minWidth: 0 }}>
            {/* Organization picker — placed FIRST so the active-scope
                control sits at the leading edge of the header, the
                same position users instinctively check for context. */}
            {(() => {
              if (orgOptions.length === 0) return (
                <span style={{ fontSize: 12, color: 'var(--color-error)', fontWeight: 500 }}>No organization defined</span>
              );
              // Single-tier setup (one company, no divisions accessible): show
              // a static label, no picker — there's nowhere else to switch to.
              if (orgOptions.length === 1) return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 500 }}>Organization:</span>
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text)' }}>{orgOptions[0].name}</span>
                </div>
              );
              // Multi-org picker. Group divisions under their parent company
              // so a multi-division enterprise (Tidewater Utilities ▸
              // Electric / Water) is selectable from a single dropdown
              // rather than needing a separate place to pick the division.
              // Companies appear as both an <optgroup> header (label) and
              // the first selectable option inside that group; orphan
              // divisions whose parent the user can't see go into an
              // "Other" group at the end.
              const companies = orgOptions.filter((o) => o.type === 'company');
              const divisionsByParent = new Map<string, typeof orgOptions>();
              for (const o of orgOptions) {
                if (o.type !== 'division') continue;
                const key = o.parentId || '__orphan__';
                if (!divisionsByParent.has(key)) divisionsByParent.set(key, []);
                divisionsByParent.get(key)!.push(o);
              }
              const orphanDivisions = divisionsByParent.get('__orphan__') || [];
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 500 }}>Organization:</span>
                  <select
                    value={activeOrgId}
                    onChange={(e) => handleOrgChange(e.target.value)}
                    aria-label="Active organization scope"
                    style={{
                      padding: '4px 10px', fontSize: 13, fontWeight: 500,
                      border: '1px solid var(--color-border)', borderRadius: 4,
                      background: 'var(--color-surface)',
                      color: 'var(--color-text)',
                      // Cap at the available width so the picker doesn't push
                      // the rest of the header off-screen on narrow viewports.
                      // The min keeps it usable when there's room.
                      width: 'min(220px, 100%)',
                      maxWidth: '100%',
                      cursor: 'pointer',
                    }}
                  >
                    {companies.map((co) => {
                      const childDivs = (divisionsByParent.get(co.id) || []).filter((d) => d.parentId === co.id);
                      // If the company has no accessible divisions, render
                      // it as a plain top-level option so the dropdown
                      // doesn't show a one-item optgroup.
                      if (childDivs.length === 0) {
                        return <option key={co.id} value={co.id}>{co.name}</option>;
                      }
                      return (
                        <optgroup key={co.id} label={co.name}>
                          <option value={co.id}>{co.name} (all)</option>
                          {childDivs.map((d) => (
                            <option key={d.id} value={d.id}>{d.name}</option>
                          ))}
                        </optgroup>
                      );
                    })}
                    {orphanDivisions.length > 0 && (
                      <optgroup label="Other divisions">
                        {orphanDivisions.map((d) => (
                          <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>
              );
            })()}
            {/* Command palette trigger — full search lives in the Cmd-K modal. */}
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px', borderRadius: 'var(--radius-md)',
                background: 'var(--color-bg)', border: '1px solid var(--color-border)',
                cursor: 'pointer', color: 'var(--color-text-muted)',
                fontSize: 13, width: 'min(280px, 40vw)', textAlign: 'left',
              }}
              title="Search (press / or Ctrl+K)"
            >
              <span className={styles.searchIcon}>{'\uD83D\uDD0D'}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                Search anything...
              </span>
              <span style={{
                display: 'inline-block', padding: '1px 5px', fontSize: 10,
                fontFamily: 'var(--font-mono, monospace)',
                background: 'var(--color-surface)', border: '1px solid var(--color-border)',
                borderRadius: 3,
              }}>
                {navigator.platform.toUpperCase().includes('MAC') ? '⌘K' : 'Ctrl+K'}
              </span>
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {/* Ask AI — the only entry point to the ChatPanel. Hidden
                entirely when AI integration features are turned off for
                the deployment. The floating bottom-right bubble was
                retired: two affordances for the same thing was clutter,
                and the button here is always visible in the same place.
                The message-count badge appears when a conversation is
                minimized and waiting to be resumed. */}
            {aiEnabled && (
            <button
              onClick={() => window.dispatchEvent(new Event('procela:toggle-chat'))}
              aria-label={
                chatOpen
                  ? 'Minimize the AI assistant'
                  : chatMessageCount > 0
                    ? `Resume AI conversation (${chatMessageCount} messages)`
                    : 'Ask the AI assistant'
              }
              aria-expanded={chatOpen}
              title={
                chatOpen
                  ? 'Minimize the AI assistant (conversation is kept)'
                  : chatMessageCount > 0
                    ? 'Resume your AI conversation'
                    : 'Ask the AI assistant'
              }
              style={{
                position: 'relative',
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', fontSize: 12, fontWeight: 500,
                background: chatOpen ? 'var(--color-primary)' : 'var(--color-surface)',
                color: chatOpen ? '#fff' : 'var(--color-text)',
                border: '1px solid ' + (chatOpen ? 'var(--color-primary)' : 'var(--color-border)'),
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer', transition: 'background 0.15s, color 0.15s, border-color 0.15s',
              }}
            >
              <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>💬</span>
              <span>Ask AI</span>
              {!chatOpen && chatMessageCount > 0 && (
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: -6, right: -6,
                    minWidth: 18, height: 18, padding: '0 5px',
                    borderRadius: 999,
                    background: 'var(--color-primary)',
                    color: '#fff',
                    fontSize: 10, fontWeight: 700, lineHeight: 1,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
                  }}
                >
                  {chatMessageCount > 99 ? '99+' : chatMessageCount}
                </span>
              )}
            </button>
            )}
            {/* Help — opens the Help guide in a separate window so the
                user can keep it open beside whatever they're doing. A
                named target means repeated clicks focus the same Help
                window instead of spawning duplicates. */}
            <button
              onClick={openHelpWindow}
              aria-label="Open the Help guide in a new window"
              title="Open the Help guide in a new window"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', fontSize: 12, fontWeight: 500,
                background: 'var(--color-surface)', color: 'var(--color-text)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer', transition: 'background 0.15s, color 0.15s',
              }}
            >
              <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>{'⍰'}</span>
              <span>Help</span>
            </button>
            {/* Report a problem — opens the in-app support form. Sits next
                to Help so "I'm stuck" and "something's broken" live in the
                same corner. */}
            <button
              onClick={() => setSupportOpen(true)}
              aria-label="Report a problem"
              title="Report a problem"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', fontSize: 12, fontWeight: 500,
                background: 'var(--color-surface)', color: 'var(--color-text)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer', transition: 'background 0.15s, color 0.15s',
              }}
            >
              <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>{'⚑'}</span>
              <span>Report a problem</span>
            </button>
            {/* Notifications bell + dropdown */}
            <NotificationsMenu />
            <UserMenu onSignOut={handleSignOut} />
          </div>
        </header>
        <main id="main-content" className={styles.content}>
          <Breadcrumbs />
          {!activeOrgId && location.pathname !== '/organizations' && location.pathname !== '/help' && location.pathname !== '/settings' && location.pathname !== '/setup' ? (
            <div style={{
              textAlign: 'center', padding: '4rem 2rem',
              background: 'var(--color-surface)', border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
            }}>
              <div style={{ fontSize: 36, marginBottom: 12, color: 'var(--color-text-muted)' }}>&#x2616;</div>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Organization Required</h2>
              <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 16, maxWidth: 440, marginLeft: 'auto', marginRight: 'auto' }}>
                You need to create an organization before you can use this feature.
                Open Organizations from the sidebar to set up your company.
              </p>
              <button
                onClick={() => navigate('/organizations')}
                style={{
                  padding: '8px 20px', background: 'var(--color-primary)', color: '#fff',
                  border: 'none', borderRadius: 'var(--radius-md)', fontSize: 13,
                  fontWeight: 500, cursor: 'pointer',
                }}
              >
                Set Up Organization
              </button>
            </div>
          ) : (
            <Outlet />
          )}
        </main>
        {aiEnabled && <ChatPanel />}
        {isMobile && mobileDrawerOpen && (
          <MobileNavDrawer
            bottomItems={bottomNavItems}
            pathname={location.pathname}
            onClose={() => setMobileDrawerOpen(false)}
          />
        )}
        <SessionTimeout />
        <IdleTimeout />
        <ToastContainer />
        <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        <SupportModal open={supportOpen} onClose={() => setSupportOpen(false)} />
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        <RoleDetailDrawer />
        <ShortcutsHint onOpenShortcuts={() => setShortcutsOpen(true)} />
        {!activeOrgId && !localStorage.getItem('procela:onboarding-complete') && (
          <OnboardingWizard onComplete={() => { triggerRefresh(); navigate('/setup'); }} />
        )}
        {tourOpen && (
          <OnboardingWizard mode="tour-only" onComplete={() => setTourOpen(false)} />
        )}
      </div>
    </div>
  );
}
