import { useState, useRef, useEffect, Fragment } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useIsMobile } from '../hooks/useMediaQuery';
import { useOrgContext } from '../stores/orgContext';
import { useAuthStore } from '../stores/authStore';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// A saved conversation as summarised by GET /chat/threads (no transcript).
interface ThreadSummary {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
}

// Context-aware starter prompts. The assistant is grounded in the org's
// whole catalog, but the page the user is standing on is a strong signal
// of what they're about to ask — so the empty-state suggestions lead with
// prompts relevant to the current surface, then fall back to the
// cross-catalog staples. Keyed by route prefix, longest-match first.
const PAGE_PROMPTS: Array<{ prefix: string; prompts: string[] }> = [
  { prefix: '/data-assets/orphans', prompts: ['Which data assets do we have that no process uses?', 'Which orphan assets are ungoverned (Bronze tier)?'] },
  { prefix: '/data-assets', prompts: ['Which assets are below 80% health and linked to critical processes?', 'Which data assets are still on the Bronze tier?'] },
  { prefix: '/gap-detection', prompts: ['Where are our data gaps?', 'Which critical process steps have no data coverage?'] },
  { prefix: '/processes/data-map', prompts: ['Which systems run our customer-facing processes?', 'Which processes depend on our least-governed data?'] },
  { prefix: '/processes', prompts: ['Which processes have no owner assigned?', 'Where are our data gaps across the process catalog?'] },
  { prefix: '/systems', prompts: ['Which systems support the most processes?', 'Which systems have no data assets registered?'] },
  { prefix: '/data-quality', prompts: ['Which assets are failing their data-quality rules?', 'Which critical assets have no quality rules at all?'] },
  { prefix: '/data-domains', prompts: ['Which data domains have the weakest governance?', 'Which domains own our lowest-health assets?'] },
  { prefix: '/people', prompts: ['Who owns the most processes and data assets?', 'Which owners have ungoverned assets?'] },
  { prefix: '/reports', prompts: ['What should an executive governance summary cover?', 'Where are our biggest coverage and governance gaps?'] },
];

const DEFAULT_PROMPTS = [
  'Where are our data gaps?',
  'Which assets are below 80% health and linked to critical processes?',
  'Which data assets do we have that no process uses?',
  'Which systems run our customer-facing processes?',
];

// Pick the starter prompts for a route: the most specific matching page
// set, padded out to four with the cross-catalog defaults (de-duplicated).
function promptsForPath(pathname: string): string[] {
  const match = PAGE_PROMPTS
    .filter((p) => pathname === p.prefix || pathname.startsWith(p.prefix + '/') || pathname.startsWith(p.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  const lead = match ? match.prompts : [];
  const out: string[] = [];
  for (const p of [...lead, ...DEFAULT_PROMPTS]) {
    if (!out.includes(p)) out.push(p);
    if (out.length >= 4) break;
  }
  return out;
}

interface Entity {
  name: string;
  kind: 'activity' | 'process' | 'system' | 'asset' | 'person';
  url: string;
}

// Escape regex special characters in entity names so a system called
// "SAP Finance (EU)" doesn't try to compile its parentheses as a
// capture group.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Allowlist of Procela page paths the assistant is permitted to link
// to via markdown. Anything else in a `[name](/path)` block is left
// as plain text — keeps a hallucinated route from rendering as a
// broken navigation chip. Kept in sync with the list embedded in the
// system prompt on the backend (see ai.service.ts → buildChatSystemPrompt).
const NAVIGABLE_PATHS = new Set<string>([
  '/', '/processes', '/processes/data-map', '/data-assets', '/data-assets/orphans',
  '/systems', '/data-domains', '/data-quality', '/mappings', '/gap-detection',
  '/people', '/dama-roles', '/governance-groups', '/reports', '/audit-log',
]);

// Pass A: extract markdown navigation links `[name](/path)` and
// render each as a navigation chip. Surrounding text is returned as
// segments so Pass B (entity-name linking) only runs on plain text.
function splitOnMarkdownLinks(text: string): Array<string | { kind: 'nav'; name: string; url: string }> {
  const out: Array<string | { kind: 'nav'; name: string; url: string }> = [];
  const re = /\[([^\]]+)\]\((\/[^\s)]*)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (NAVIGABLE_PATHS.has(m[2])) {
      out.push({ kind: 'nav', name: m[1], url: m[2] });
    } else {
      // Unknown path — render as plain text rather than a broken link.
      out.push(m[0]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Pass B: within a plain-text segment, replace entity-name mentions
// with React Router links. Longest-first sort on the entity list
// (done backend-side) means "Customer Billing Master" matches before
// "Customer" — important because regex alternation is leftmost-first.
function linkEntitiesInSegment(text: string, entities: Entity[]): React.ReactNode[] {
  if (entities.length === 0 || !text) return [text];
  const byName = new Map(entities.map((e) => [e.name, e]));
  const pattern = new RegExp(`\\b(${entities.map((e) => escapeRegex(e.name)).join('|')})\\b`, 'g');
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const entity = byName.get(m[1]);
    if (entity) {
      out.push(
        <Link
          key={`e-${m.index}-${entity.name}`}
          to={entity.url}
          style={{ color: 'var(--color-primary)', textDecoration: 'underline', fontWeight: 500 }}
          title={`${entity.kind}: ${entity.name}`}
        >
          {entity.name}
        </Link>,
      );
    } else {
      out.push(m[1]);
    }
    last = m.index + m[1].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Render an assistant message with two kinds of inline links:
//   - Markdown-style navigation links the model can emit to point the
//     user at a specific Procela page ([Orphan Assets](/data-assets/orphans))
//   - Entity-name mentions automatically linked to their catalog page
//     based on the entity index the backend ships at the end of each stream.
function renderAssistantText(text: string, entities: Entity[]): React.ReactNode {
  if (!text) return text;
  const segments = splitOnMarkdownLinks(text);
  const out: React.ReactNode[] = [];
  segments.forEach((seg, i) => {
    if (typeof seg === 'string') {
      const linked = linkEntitiesInSegment(seg, entities);
      linked.forEach((node, j) => out.push(<Fragment key={`s${i}-${j}`}>{node}</Fragment>));
    } else {
      out.push(
        <Link
          key={`n${i}`}
          to={seg.url}
          title={`Open ${seg.name}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '1px 8px',
            margin: '0 1px',
            background: 'var(--color-primary)',
            color: '#fff',
            textDecoration: 'none',
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 600,
            verticalAlign: 'baseline',
          }}
        >
          {seg.name} <span aria-hidden="true">→</span>
        </Link>,
      );
    }
  });
  return out;
}

export default function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  // The persisted thread this conversation is being saved to. null until
  // the first exchange creates a row; cleared by "New chat" and on org
  // switch so a fresh conversation starts a fresh thread.
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  // Entities for inline citations, scoped to the current conversation
  // mount. The streaming /chat/stream endpoint sends one entities
  // frame at the end of each reply; we keep them around so the
  // rendered assistant turn (and any subsequent ones) can swap
  // entity-name mentions for links back to the catalog.
  const [entities, setEntities] = useState<Entity[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const { activeOrgId, activeOrgName } = useOrgContext();
  const location = useLocation();

  // Authenticated JSON headers for the thread-persistence endpoints.
  function authHeaders(): Record<string, string> {
    const token = useAuthStore.getState().accessToken;
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  // Load the current user's saved conversations for the active org. Best
  // effort — a failure just leaves the history list empty.
  async function loadThreads() {
    if (!activeOrgId) { setThreads([]); return; }
    try {
      const res = await fetch(`/api/v1/chat/threads?orgId=${encodeURIComponent(activeOrgId)}`, { headers: authHeaders() });
      if (!res.ok) return;
      const j = await res.json();
      if (Array.isArray(j?.data)) setThreads(j.data);
    } catch { /* history is a convenience; ignore load failures */ }
  }

  // Re-open a saved conversation: pull its full transcript and make it the
  // active thread. Entities aren't persisted, so inline links re-appear
  // only on the next reply — the text itself is intact.
  async function openThread(id: string) {
    try {
      const res = await fetch(`/api/v1/chat/threads/${id}`, { headers: authHeaders() });
      if (!res.ok) return;
      const j = await res.json();
      if (Array.isArray(j?.data?.messages)) {
        setMessages(j.data.messages);
        setThreadId(j.data.id);
        setEntities([]);
        setShowHistory(false);
      }
    } catch { /* ignore */ }
  }

  async function deleteThread(id: string) {
    try {
      await fetch(`/api/v1/chat/threads/${id}`, { method: 'DELETE', headers: authHeaders() });
    } catch { /* ignore */ }
    if (id === threadId) { setMessages([]); setEntities([]); setThreadId(null); }
    loadThreads();
  }

  // Save the conversation after each completed exchange. First exchange
  // creates the thread; later ones update it in place. Persistence is
  // best-effort — a save failure never interrupts the chat.
  async function persistConversation(finalMessages: Message[]) {
    if (!activeOrgId) return;
    try {
      if (threadId) {
        await fetch(`/api/v1/chat/threads/${threadId}`, {
          method: 'PUT', headers: authHeaders(), body: JSON.stringify({ messages: finalMessages }),
        });
      } else {
        const res = await fetch('/api/v1/chat/threads', {
          method: 'POST', headers: authHeaders(),
          body: JSON.stringify({ orgId: activeOrgId, messages: finalMessages }),
        });
        if (res.ok) { const j = await res.json(); if (j?.data?.id) setThreadId(j.data.id); }
      }
      loadThreads();
    } catch { /* ignore */ }
  }

  function newChat() {
    setMessages([]);
    setEntities([]);
    setThreadId(null);
    setShowHistory(false);
  }
  // Panel positioning. Mobile pins the panel with margins, riding
  // above the ~60px fixed bottom nav strip; desktop pins a 400x520
  // card to the bottom-right corner. The floating bubble that used
  // to occupy this corner is gone — the panel now sits where the
  // bubble was.
  const panelStyle = isMobile
    ? { left: 8, right: 8, bottom: 80, top: 56, width: 'auto' as const, height: 'auto' as const }
    : { right: 24, bottom: 24, width: 400, height: 520 };

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  // Allow the top-bar "Ask AI" button (and any future entry point) to
  // open the panel without lifting state into Layout. The event is a
  // simple toggle so the same button can also close the panel. Each
  // change also broadcasts procela:chat-state so external buttons can
  // reflect open/closed in their aria-expanded and active styling.
  useEffect(() => {
    const handler = () => setOpen((o) => !o);
    window.addEventListener('procela:toggle-chat', handler);
    return () => window.removeEventListener('procela:toggle-chat', handler);
  }, []);

  // Refresh the saved-conversation list whenever the panel opens (so a
  // thread saved on a previous visit shows up) and whenever the active
  // org changes.
  useEffect(() => {
    if (open) loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeOrgId]);

  // Chat threads are org-scoped. Switching orgs starts a clean
  // conversation so a reply is never saved against the wrong tenant.
  useEffect(() => {
    setMessages([]);
    setEntities([]);
    setThreadId(null);
    setShowHistory(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrgId]);

  // Broadcast open + message count so the top-bar "Ask AI" button
  // can render its own message-count badge and active styling. This
  // replaced the floating bottom-right bubble — one entry point in
  // the top bar, one signalling channel here. The meaningful-count
  // filter drops the trailing empty assistant turn from an in-flight
  // stream so a fresh restart doesn't show "1".
  useEffect(() => {
    const meaningful = messages.filter(
      (m) => (m.role === 'user') || (m.content && m.content.length > 0),
    ).length;
    window.dispatchEvent(new CustomEvent('procela:chat-state', {
      detail: { open, messageCount: meaningful },
    }));
  }, [open, messages]);

  async function send(text: string) {
    if (!text || loading) return;
    const userMsg: Message = { role: 'user', content: text };
    const updated = [...messages, userMsg];
    // Seed the assistant turn empty so chunks have somewhere to land
    // as they arrive. The render loop reads `messages[i].content`
    // directly, so each chunk-append re-renders the bubble incrementally.
    const assistantIndex = updated.length;
    setMessages([...updated, { role: 'assistant', content: '' }]);
    setInput('');
    setLoading(true);

    let assistantText = '';
    let streamOk = false;
    try {
      const token = useAuthStore.getState().accessToken;
      const res = await fetch('/api/v1/chat/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          messages: updated,
          orgContext: { orgId: activeOrgId, orgName: activeOrgName },
        }),
      });
      if (!res.ok || !res.body) throw new Error(`stream failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      // SSE frames are separated by a blank line. Hold partial frames
      // in `buf` across reads — a single chunk can split mid-event.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let event = 'message';
          let dataStr = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) dataStr += line.slice(6);
          }
          if (dataStr) {
            let parsed: any;
            try { parsed = JSON.parse(dataStr); } catch { parsed = dataStr; }
            if (event === 'chunk' && parsed?.text) {
              assistantText += parsed.text;
              // Functional setState so concurrent chunks don't race —
              // each update reads the latest array.
              setMessages((prev) => {
                const next = [...prev];
                next[assistantIndex] = { role: 'assistant', content: assistantText };
                return next;
              });
            } else if (event === 'entities' && Array.isArray(parsed)) {
              setEntities(parsed);
            } else if (event === 'error') {
              throw new Error(parsed?.error || 'stream error');
            }
          }
          sep = buf.indexOf('\n\n');
        }
      }
      streamOk = true;
    } catch {
      // On any stream failure, replace the empty assistant placeholder
      // with a friendly error so the user isn't left staring at a
      // half-rendered bubble.
      setMessages((prev) => {
        const next = [...prev];
        next[assistantIndex] = {
          role: 'assistant',
          content: assistantText || 'Sorry, something went wrong. Please try again.',
        };
        return next;
      });
    } finally {
      setLoading(false);
    }

    // Persist the completed exchange so it survives a reload and shows up
    // in history. Only on a clean stream with real content — a failed turn
    // isn't worth saving.
    if (streamOk && assistantText) {
      persistConversation([...updated, { role: 'assistant', content: assistantText }]);
    }
  }

  async function handleSend() {
    await send(input.trim());
  }

  // Starter prompts shown when the chat is empty. Lead with prompts
  // relevant to the page the user is on, then fall back to the
  // cross-catalog staples (see promptsForPath / PAGE_PROMPTS above).
  const SUGGESTED_PROMPTS = promptsForPath(location.pathname);

  return (
    <>
      {/* The floating bottom-right bubble was retired. The top-bar
          "Ask AI" button (Layout.tsx) is the single entry point and
          carries the message-count badge; the in-panel "\u2013" button
          handles minimize from inside. Two intents, two buttons in
          predictable places \u2014 no duplicate affordance sitting on
          top of every page's UI. */}

      {/* Chat window. On phones it expands edge-to-edge with margins,
          riding above the mobile nav strip; on desktop it's a 400×520
          floating card in the corner. */}
      {open && (
        <div
          style={{
            position: 'fixed',
            ...panelStyle,
            backgroundColor: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-lg)',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 1000,
            overflow: 'hidden',
          }}
        >
          {/* Header. "History" opens the list of saved conversations;
              "New chat" starts a fresh thread (the current one is already
              saved). Minimize keeps state — three intents, three buttons. */}
          <div
            style={{
              padding: '12px 16px',
              backgroundColor: 'var(--color-primary)',
              color: '#fff',
              fontWeight: 600,
              fontSize: 14,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <span>AI Assistant</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {threads.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowHistory((s) => !s)}
                  title="Saved conversations"
                  aria-label="Saved conversations"
                  aria-expanded={showHistory}
                  style={{
                    background: showHistory ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.15)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 'var(--radius-md)',
                    padding: '4px 10px',
                    fontSize: 11, fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  History
                </button>
              )}
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={newChat}
                  disabled={loading}
                  title="Start a new conversation (the current one is saved)"
                  aria-label="Start a new conversation"
                  style={{
                    background: 'rgba(255,255,255,0.15)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 'var(--radius-md)',
                    padding: '4px 10px',
                    fontSize: 11, fontWeight: 500,
                    cursor: loading ? 'not-allowed' : 'pointer',
                    opacity: loading ? 0.5 : 1,
                  }}
                >
                  New chat
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Minimize (conversation is kept)"
                aria-label="Minimize chat"
                style={{
                  background: 'transparent',
                  color: '#fff',
                  border: 'none',
                  padding: '4px 8px',
                  fontSize: 18, lineHeight: 1,
                  cursor: 'pointer',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                –
              </button>
            </div>
          </div>

          {/* Saved-conversation history. A dismissible list that sits over
              the message area; picking a row re-opens that conversation. */}
          {showHistory && (
            <div
              style={{
                borderBottom: '1px solid var(--color-border)',
                backgroundColor: 'var(--color-bg)',
                maxHeight: 220,
                overflowY: 'auto',
              }}
            >
              {threads.length === 0 ? (
                <div style={{ padding: 16, fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center' }}>
                  No saved conversations yet.
                </div>
              ) : (
                threads.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 12px',
                      borderBottom: '1px solid var(--color-border)',
                      background: t.id === threadId ? 'var(--color-surface)' : 'transparent',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => openThread(t.id)}
                      title={t.title}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        textAlign: 'left',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--color-text)',
                        padding: 0,
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {t.title}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
                        {t.messageCount} message{t.messageCount === 1 ? '' : 's'} · {new Date(t.updatedAt).toLocaleDateString()}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteThread(t.id)}
                      title="Delete this conversation"
                      aria-label={`Delete conversation: ${t.title}`}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--color-text-muted)',
                        fontSize: 14,
                        lineHeight: 1,
                        padding: '2px 4px',
                        flexShrink: 0,
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Messages */}
          <div
            ref={listRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {messages.length === 0 && (
              <div
                style={{
                  color: 'var(--color-text-muted)',
                  fontSize: 13,
                  textAlign: 'center',
                  marginTop: 24,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <div>Ask me anything about your processes, data assets, or governance.</div>
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Try one of these:</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: 280 }}>
                  {SUGGESTED_PROMPTS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => send(p)}
                      disabled={loading}
                      style={{
                        textAlign: 'left',
                        padding: '8px 12px',
                        fontSize: 12, lineHeight: 1.4,
                        background: 'var(--color-bg)',
                        color: 'var(--color-text)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-md)',
                        cursor: loading ? 'wait' : 'pointer',
                      }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div
                key={i}
                style={{
                  alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '80%',
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-md)',
                  fontSize: 13,
                  lineHeight: 1.5,
                  backgroundColor:
                    msg.role === 'user' ? 'var(--color-primary)' : 'var(--color-bg)',
                  color: msg.role === 'user' ? '#fff' : 'var(--color-text)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {msg.role === 'assistant'
                  ? renderAssistantText(msg.content, entities)
                  : msg.content}
              </div>
            ))}
            {loading && (
              <div
                style={{
                  alignSelf: 'flex-start',
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: 'var(--color-bg)',
                  color: 'var(--color-text-muted)',
                  fontSize: 13,
                }}
              >
                Thinking...
              </div>
            )}
          </div>

          {/* Input */}
          <div
            style={{
              display: 'flex',
              borderTop: '1px solid var(--color-border)',
              padding: 8,
              gap: 8,
            }}
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Ask about a process, asset, gap, or owner…"
              style={{
                flex: 1,
                padding: '8px 12px',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                fontSize: 13,
                outline: 'none',
              }}
              disabled={loading}
            />
            <button
              onClick={handleSend}
              disabled={loading || !input.trim()}
              style={{
                padding: '8px 16px',
                backgroundColor: 'var(--color-primary)',
                color: '#fff',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                fontSize: 13,
                fontWeight: 500,
                cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                opacity: loading || !input.trim() ? 0.6 : 1,
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
