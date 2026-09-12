import { useEffect, useRef, useState } from 'react';
import PageHeader from '../components/PageHeader';
import Page from '../components/Page';
import { openTrainingWindow, openRoadmapWindow } from '../components/navConfig';

// The help guide has a single source of truth: the markdown at
// packages/backend/src/docs/HELP.md, rendered server-side at
// /api/v1/docs/help.html — the same document the top-bar Help button opens
// in a popup. This page embeds that one rendered document (rather than
// maintaining a second, drifting hand-written copy) and keeps only the
// app-integration chrome the standalone HTML can't provide: the Training
// Guide launcher and the "Replay intro" tour trigger. Deep links like
// /help#connectors are forwarded into the embedded document's own heading
// anchors (the markdown renderer slugifies every heading).
const HELP_DOC_URL = '/api/v1/docs/help.html';

export default function HelpPage() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Seed the src from the current hash so a saved deep link
  // (/help#connectors) lands on the right heading on first paint.
  const [src] = useState(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    return HELP_DOC_URL + (hash || '');
  });

  // Keep the embedded doc in sync if the app hash changes while /help is open.
  useEffect(() => {
    function onHashChange() {
      const frame = frameRef.current;
      if (frame) frame.src = HELP_DOC_URL + (window.location.hash || '');
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <Page width="default">
      <PageHeader
        title="Help Guide"
        subtitle="Feature-by-feature reference for the platform. The top-bar Help button opens this same guide in its own window."
        actions={
          <div style={{ display: 'inline-flex', gap: 8 }}>
            <button
              type="button"
              onClick={openTrainingWindow}
              style={{
                padding: '8px 16px', background: 'var(--color-primary)',
                color: '#fff', border: 'none',
                borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 600,
                cursor: 'pointer', flexShrink: 0,
              }}
              title="Opens in a new window — 90-minute walkthrough using the Tidewater Utilities fixture data"
            >
              Open Training Guide ↗
            </button>
            <button
              type="button"
              onClick={openRoadmapWindow}
              style={{
                padding: '8px 16px', background: 'var(--color-surface)',
                color: 'var(--color-primary)', border: '1px solid var(--color-primary)',
                borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                flexShrink: 0,
              }}
              title="Opens the status & roadmap doc — rendered live from docs/STATUS.md"
            >
              Status &amp; roadmap ↗
            </button>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event('procela:start-tour'))}
              style={{
                padding: '8px 16px', background: 'var(--color-surface)',
                color: 'var(--color-primary)', border: '1px solid var(--color-primary)',
                borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                flexShrink: 0,
              }}
              title="Show the three-phase Define / Connect / Discover intro again"
            >
              Replay intro
            </button>
          </div>
        }
      />
      <iframe
        ref={frameRef}
        title="Procela Help Guide"
        src={src}
        style={{
          width: '100%',
          height: 'calc(100vh - 150px)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-surface)',
        }}
      />
    </Page>
  );
}
