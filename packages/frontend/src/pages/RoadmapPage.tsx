import { useEffect, useRef, useState } from 'react';
import PageHeader from '../components/PageHeader';
import Page from '../components/Page';

// The product roadmap has a single source of truth: the markdown at
// docs/ROADMAP.md (repo root), rendered server-side at
// /api/v1/docs/roadmap.html — the same file engineering edits directly.
// This page embeds that one rendered document (rather than maintaining a
// second, drifting hand-written copy), exactly the way /help embeds the
// help guide. Edit the markdown and this view follows on the next load.
// Deep links like /roadmap#track-a are forwarded into the embedded
// document's own heading anchors (the markdown renderer slugifies every
// heading).
const ROADMAP_DOC_URL = '/api/v1/docs/roadmap.html';

export default function RoadmapPage() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Seed the src from the current hash so a saved deep link
  // (/roadmap#track-c) lands on the right heading on first paint.
  const [src] = useState(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    return ROADMAP_DOC_URL + (hash || '');
  });

  // Keep the embedded doc in sync if the app hash changes while /roadmap is open.
  useEffect(() => {
    function onHashChange() {
      const frame = frameRef.current;
      if (frame) frame.src = ROADMAP_DOC_URL + (window.location.hash || '');
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <Page width="default">
      <PageHeader
        title="Product Roadmap"
        subtitle="The post-cutover roadmap, rendered live from docs/ROADMAP.md — the single source of truth."
      />
      <iframe
        ref={frameRef}
        title="Procela Product Roadmap"
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
