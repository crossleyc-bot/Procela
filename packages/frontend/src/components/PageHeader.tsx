import type { ReactNode } from 'react';

// ──────────────────────────────────────────────────────────────────────────
// PageHeader — the band at the top of every page. Establishes hierarchy
// (kicker → title → subtitle → meta row), keeps actions right-aligned,
// and separates the header from page content with a faint divider so
// the page reads as a clear "section break" rather than a floating title.
//
//   <PageHeader
//     kicker="Policy · POL-007"
//     title="Data Retention Policy"
//     subtitle="Defines how long each data class is retained."
//     meta={<StatusBadge variant="success">Active</StatusBadge>}
//     actions={<Button>Edit</Button>}
//   />
//
// `children` renders inline next to the title (legacy slot used for
// inline ? help-tips); `actions` is the right-aligned button cluster.
// ──────────────────────────────────────────────────────────────────────────

interface PageHeaderProps {
  /** Small uppercase muted eyebrow line above the title — useful for
   *  detail / drill-in pages (e.g., "Policy · POL-007"). Optional. */
  kicker?: ReactNode;
  title: string;
  /** Sentence describing the page. Accepts inline JSX (<em>, links, etc.). */
  subtitle?: ReactNode;
  /** Inline next to the H1 — used for HelpPopover (?) buttons etc. */
  children?: ReactNode;
  /** Right-aligned action cluster (buttons, menus). */
  actions?: ReactNode;
  /** Row below the subtitle for status chips, counts, badges, etc. */
  meta?: ReactNode;
}

export default function PageHeader({ kicker, title, subtitle, children, actions, meta }: PageHeaderProps) {
  return (
    <div
      className="procela-stack-on-mobile"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 16,
        marginBottom: '1rem',
        paddingBottom: 10,
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        {kicker && (
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--color-text-muted)',
              marginBottom: 4,
            }}
          >
            {kicker}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: '1.375rem', fontWeight: 700, lineHeight: 1.25, margin: 0 }}>{title}</h1>
          {children}
        </div>
        {subtitle && (
          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4, marginBottom: 0, lineHeight: 1.5 }}>{subtitle}</p>
        )}
        {meta && <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>{meta}</div>}
      </div>
      {actions && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>{actions}</div>
      )}
    </div>
  );
}
