import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiClient } from '@/api/client';
import { useAuthStore } from '@/stores/authStore';
import { useOrgContext } from '../stores/orgContext';

// The four gap-signal categories the weekly digest can notify on. Labels are
// user-facing; the keys match the backend (services/digest-preferences).
const DIGEST_CATEGORIES: Array<{ key: string; label: string }> = [
  { key: 'orphans', label: 'New orphan data assets' },
  { key: 'coverage', label: 'Mapping-coverage drops' },
  { key: 'ungoverned', label: 'Ungoverned assets in use' },
  { key: 'ownerless', label: 'Ownerless processes' },
];

interface DigestPreference {
  frequency: 'weekly' | 'off';
  categories: string[];
  emailEnabled: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// NotificationsMenu — the bell button in the top bar + its dropdown.
//
// Extracted from Layout.tsx so the shell isn't dragging around ~160 lines
// of dropdown state, count-fetching, mark-all / clear-all / dismiss
// handlers, click-outside management, and per-row interaction code. The
// menu owns all of that internally; it just needs the auth store + router
// (it re-fetches the unread count on route change so a notification
// arriving while you're on another page surfaces when you come back).
// ──────────────────────────────────────────────────────────────────────────

interface Notification {
  id: string;
  orgId: string;
  userId: string | null;
  type: 'INFO' | 'WARNING' | 'ACTION';
  title: string;
  message: string;
  link: string;
  read: boolean;
  createdAt: string;
}

export default function NotificationsMenu() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated } = useAuthStore();
  const { activeOrgId } = useOrgContext();

  const [notifCount, setNotifCount] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifList, setNotifList] = useState<Notification[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const notifWrapperRef = useRef<HTMLDivElement>(null);

  // ── Weekly-digest preferences (per user) ──
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [pref, setPref] = useState<DigestPreference | null>(null);
  const [prefsBusy, setPrefsBusy] = useState(false);
  const [prefsSaved, setPrefsSaved] = useState(false);

  const fetchPrefs = useCallback(async () => {
    if (!activeOrgId) return;
    setPrefsBusy(true);
    try {
      const res = await apiClient.get<{ success: boolean; data: DigestPreference }>(
        `/digest/preferences?orgId=${encodeURIComponent(activeOrgId)}`,
      );
      setPref({
        frequency: res.data.frequency === 'off' ? 'off' : 'weekly',
        categories: Array.isArray(res.data.categories) ? res.data.categories : [],
        emailEnabled: !!res.data.emailEnabled,
      });
    } catch { /* leave prefs null; the panel shows a retry-friendly empty state */ }
    finally { setPrefsBusy(false); }
  }, [activeOrgId]);

  const savePrefs = async () => {
    if (!activeOrgId || !pref) return;
    setPrefsBusy(true);
    setPrefsSaved(false);
    try {
      await apiClient.put('/digest/preferences', { orgId: activeOrgId, ...pref });
      setPrefsSaved(true);
      setTimeout(() => setPrefsSaved(false), 2000);
    } catch { /* keep the form as-is so the user can retry */ }
    finally { setPrefsBusy(false); }
  };

  const toggleCategory = (key: string) => {
    setPref((p) => p && ({
      ...p,
      categories: p.categories.includes(key)
        ? p.categories.filter((c) => c !== key)
        : [...p.categories, key],
    }));
  };

  const handlePrefsToggle = () => {
    if (!prefsOpen && !pref) fetchPrefs();
    setPrefsOpen((v) => !v);
  };

  // Fetch unread count on mount and route change.
  const fetchNotifCount = useCallback(async () => {
    try {
      const res = await apiClient.get<{ success: boolean; data: { unread: number } }>('/notifications/count');
      setNotifCount(res.data.unread);
    } catch { /* */ }
  }, []);

  useEffect(() => {
    if (isAuthenticated) fetchNotifCount();
  }, [isAuthenticated, fetchNotifCount, location.pathname]);

  // Fetch list lazily when the panel is opened.
  const fetchNotifList = useCallback(async () => {
    setNotifLoading(true);
    try {
      const res = await apiClient.get<{ success: boolean; data: Notification[] }>('/notifications');
      setNotifList(res.data);
    } catch { /* */ }
    finally { setNotifLoading(false); }
  }, []);

  const handleNotifToggle = () => {
    if (!notifOpen) fetchNotifList();
    setNotifOpen((v) => !v);
  };

  const handleNotifClick = async (notif: Notification) => {
    if (!notif.read) {
      await apiClient.put(`/notifications/${notif.id}/read`);
      setNotifCount((c) => Math.max(0, c - 1));
      setNotifList((list) => list.map((n) => n.id === notif.id ? { ...n, read: true } : n));
    }
    setNotifOpen(false);
    navigate(notif.link);
  };

  const handleMarkAllRead = async () => {
    disarmClearAll();
    await apiClient.put('/notifications/read-all');
    setNotifCount(0);
    setNotifList((list) => list.map((n) => ({ ...n, read: true })));
  };

  // "Clear all" deletes every notification with no undo, so it's a
  // two-click action: the first click arms the button, the second
  // actually clears. The armed state shows a live countdown so a
  // paused user isn't surprised by a silent no-op when the window
  // lapses. Avoids a full modal for a minor action.
  const [clearAllCountdown, setClearAllCountdown] = useState(0);
  const clearAllTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clearAllArmed = clearAllCountdown > 0;
  const disarmClearAll = () => {
    if (clearAllTimerRef.current) clearInterval(clearAllTimerRef.current);
    clearAllTimerRef.current = null;
    setClearAllCountdown(0);
  };
  const handleClearAllNotifications = async () => {
    if (!clearAllArmed) {
      setClearAllCountdown(3);
      if (clearAllTimerRef.current) clearInterval(clearAllTimerRef.current);
      clearAllTimerRef.current = setInterval(() => {
        setClearAllCountdown((n) => {
          if (n <= 1) { disarmClearAll(); return 0; }
          return n - 1;
        });
      }, 1000);
      return;
    }
    disarmClearAll();
    await apiClient.delete('/notifications/all');
    setNotifCount(0);
    setNotifList([]);
  };

  // Abort an armed "Clear all" whenever the panel closes (toggle,
  // outside-click, Escape, or following a notification) — so an
  // accidental first click is cancelled by any normal interaction.
  useEffect(() => { if (!notifOpen) { disarmClearAll(); setPrefsOpen(false); } }, [notifOpen]);

  const handleDismissNotification = async (id: string) => {
    setNotifList((list) => list.filter((n) => n.id !== id));
    setNotifCount((c) => Math.max(0, c - 1));
    try { await apiClient.delete(`/notifications/${id}`); }
    catch { /* optimistic — already removed from UI */ }
  };

  // Close on outside click or Escape.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (notifWrapperRef.current && !notifWrapperRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setNotifOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <div ref={notifWrapperRef} style={{ position: 'relative' }}>
      <button
        onClick={handleNotifToggle}
        aria-label="Notifications"
        aria-expanded={notifOpen}
        style={{
          background: notifOpen ? 'var(--color-bg)' : 'none',
          border: 'none', cursor: 'pointer',
          position: 'relative', padding: 6,
          color: 'var(--color-text-secondary)',
          borderRadius: 'var(--radius-md)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}
        title="Notifications"
      >
        {/* Outline bell — inherits currentColor from the button so it
            matches the rest of the header text, and stays crisp on
            high-DPI screens where a Unicode glyph would go fuzzy. */}
        <svg
          width="20" height="20" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true" focusable="false"
        >
          <path d="M15 17h5l-1.4-1.9a2 2 0 0 1-.4-1.2V10a6.2 6.2 0 0 0-5-6.08V3.5a1.2 1.2 0 1 0-2.4 0v.42A6.2 6.2 0 0 0 5.8 10v3.9a2 2 0 0 1-.4 1.2L4 17h5" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
        {notifCount > 0 && (
          <span style={{
            position: 'absolute', top: -2, right: -2,
            background: '#ef4444', color: '#fff', fontSize: 9,
            fontWeight: 700, borderRadius: '50%',
            minWidth: 16, height: 16, padding: '0 4px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            lineHeight: 1, boxShadow: '0 0 0 2px var(--color-surface)',
          }}>
            {notifCount > 99 ? '99+' : notifCount}
          </span>
        )}
      </button>
      {notifOpen && (
        <div
          role="dialog"
          aria-label="Notifications"
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 4,
            width: 380, maxHeight: 440, overflowY: 'auto',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 800,
          }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 14px', borderBottom: '1px solid var(--color-border)',
          }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>Notifications</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                onClick={handlePrefsToggle}
                aria-label="Digest settings"
                aria-expanded={prefsOpen}
                title="Weekly digest settings"
                style={{
                  background: prefsOpen ? 'var(--color-bg)' : 'none',
                  border: 'none', cursor: 'pointer', padding: 2, borderRadius: 4,
                  color: prefsOpen ? 'var(--color-primary)' : 'var(--color-text-muted)',
                  display: 'inline-flex', alignItems: 'center',
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
              {notifList.some((n) => !n.read) && (
                <button onClick={handleMarkAllRead} style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 11, color: 'var(--color-primary)', fontWeight: 500,
                }}>
                  Mark all read
                </button>
              )}
              {notifList.length > 0 && (
                <button onClick={handleClearAllNotifications} style={{
                  background: clearAllArmed ? 'var(--color-error, #dc2626)' : 'none',
                  border: 'none', cursor: 'pointer', borderRadius: 4, padding: '2px 6px',
                  fontSize: 11, color: clearAllArmed ? '#fff' : 'var(--color-error, #dc2626)', fontWeight: 500,
                }}>
                  {clearAllArmed ? `Click again to confirm (${clearAllCountdown})` : 'Clear all'}
                </button>
              )}
            </div>
          </div>
          {prefsOpen && (
            <div style={{
              padding: '12px 14px', borderBottom: '1px solid var(--color-border)',
              background: 'var(--color-bg)',
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-muted)', marginBottom: 8 }}>
                Weekly digest
              </div>
              {!pref && prefsBusy && (
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Loading…</div>
              )}
              {!pref && !prefsBusy && (
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Preferences unavailable.</div>
              )}
              {pref && (
                <>
                  {/* Frequency */}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text)', cursor: 'pointer', marginBottom: 8 }}>
                    <input
                      type="checkbox"
                      checked={pref.frequency === 'weekly'}
                      onChange={(e) => setPref({ ...pref, frequency: e.target.checked ? 'weekly' : 'off' })}
                    />
                    Send me a weekly digest
                  </label>
                  {/* Categories — only meaningful when the digest is on. */}
                  <div style={{ opacity: pref.frequency === 'weekly' ? 1 : 0.5, pointerEvents: pref.frequency === 'weekly' ? 'auto' : 'none', marginLeft: 4 }}>
                    {DIGEST_CATEGORIES.map((c) => (
                      <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text-secondary)', cursor: 'pointer', marginBottom: 5 }}>
                        <input
                          type="checkbox"
                          checked={pref.categories.includes(c.key)}
                          onChange={() => toggleCategory(c.key)}
                        />
                        {c.label}
                      </label>
                    ))}
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text)', cursor: 'pointer', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--color-border)' }}>
                      <input
                        type="checkbox"
                        checked={pref.emailEnabled}
                        onChange={(e) => setPref({ ...pref, emailEnabled: e.target.checked })}
                      />
                      Also email it to me
                    </label>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                    <button
                      onClick={savePrefs}
                      disabled={prefsBusy}
                      style={{
                        background: 'var(--color-primary)', color: '#fff', border: 'none',
                        borderRadius: 'var(--radius-md)', padding: '5px 14px', fontSize: 12,
                        fontWeight: 500, cursor: prefsBusy ? 'not-allowed' : 'pointer', opacity: prefsBusy ? 0.6 : 1,
                      }}
                    >
                      Save
                    </button>
                    {prefsSaved && <span style={{ fontSize: 11, color: 'var(--color-success, #16a34a)' }}>Saved</span>}
                  </div>
                </>
              )}
            </div>
          )}
          {notifLoading && (
            <div style={{ padding: 16, textAlign: 'center', fontSize: 13, color: 'var(--color-text-muted)' }}>Loading...</div>
          )}
          {!notifLoading && notifList.length === 0 && (
            <div style={{ padding: 16, textAlign: 'center', fontSize: 13, color: 'var(--color-text-muted)' }}>No notifications</div>
          )}
          {!notifLoading && notifList.map((n) => {
            const typeColor = n.type === 'WARNING' ? '#d97706' : n.type === 'ACTION' ? '#0f766e' : '#2563eb';
            const typeIcon = n.type === 'WARNING' ? '⚠' : n.type === 'ACTION' ? '▶' : 'ℹ';
            const ago = (() => {
              const diff = Date.now() - new Date(n.createdAt).getTime();
              const mins = Math.floor(diff / 60000);
              if (mins < 1) return 'just now';
              if (mins < 60) return `${mins}m ago`;
              const hrs = Math.floor(mins / 60);
              if (hrs < 24) return `${hrs}h ago`;
              return `${Math.floor(hrs / 24)}d ago`;
            })();
            return (
              // role="button" + tabIndex + key handler instead of
              // wrapping in <button>, because the dismiss control
              // nested inside is already a button and we can't
              // nest interactive elements. Enter/Space activate
              // the notification the same as a click.
              <div
                key={n.id}
                role="button"
                tabIndex={0}
                aria-label={`${n.title}. ${n.read ? 'Read.' : 'Unread.'}`}
                onClick={() => handleNotifClick(n)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleNotifClick(n);
                  }
                }}
                style={{
                  display: 'flex', gap: 10, padding: '10px 14px',
                  cursor: 'pointer', borderBottom: '1px solid var(--color-border)',
                  background: n.read ? 'transparent' : 'var(--color-bg)',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = n.read ? 'transparent' : 'var(--color-bg)'; }}
              >
                <span style={{
                  width: 24, height: 24, borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, background: typeColor + '18', color: typeColor,
                  flexShrink: 0, marginTop: 2,
                }}>
                  {typeIcon}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: n.read ? 400 : 600, color: 'var(--color-text)' }}>{n.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 1 }}>{n.message}</div>
                  <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 3 }}>{ago}</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  {!n.read && (
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%', background: '#2563eb',
                    }} />
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDismissNotification(n.id); }}
                    aria-label="Dismiss notification"
                    title="Dismiss"
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--color-text-muted)', fontSize: 14, lineHeight: 1,
                      padding: '2px 4px', borderRadius: 4,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-error, #dc2626)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)'; }}
                  >&times;</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
