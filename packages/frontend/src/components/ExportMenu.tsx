import { useEffect, useRef, useState } from 'react';
import IconButton from './IconButton';
import { useToastStore } from '../stores/toastStore';
import { ExportFormat, FORMAT_LABELS, ExportPayload, exportData } from '../lib/export';

// ──────────────────────────────────────────────────────────────────────────
// ExportMenu — drop-in replacement for the old `IconButton icon="download"`
// + bare `exportCsv(...)` onClick pattern. Renders the same download icon
// but, on click, opens a popover with format choices (CSV, Excel, JSON,
// Copy to clipboard).
//
// Call sites supply a single `build` function that returns the payload
// (filenameBase, headers, rows). It runs at click time, never at render
// time, so big tables don't pay the row-building cost until a user
// actually exports. If `build` returns `null` the menu is suppressed —
// useful for empty datasets that shouldn't show export at all.
//
// XLSX support relies on the dynamic-imported `xlsx` bundle inside
// `lib/export.ts`, so the SheetJS payload only loads when someone
// actually picks the Excel option.
// ──────────────────────────────────────────────────────────────────────────

interface ExportMenuProps {
  /** Builds the payload at click time. Returning null cancels the export
   *  (e.g. data not yet loaded). May be async — a surface that has to fetch
   *  the full result set before exporting (e.g. the Report Builder, whose
   *  on-screen table is only a capped preview) returns a Promise, and the
   *  chosen format's "…" busy state shows for the duration. */
  build: () => ExportPayload | null | Promise<ExportPayload | null>;
  /** Tooltip on the trigger button. Defaults to "Export". */
  label?: string;
  /** Which formats to offer. Defaults to all four. */
  formats?: ExportFormat[];
  disabled?: boolean;
}

const DEFAULT_FORMATS: ExportFormat[] = ['csv', 'xlsx', 'json', 'clipboard'];

export default function ExportMenu({
  build,
  label = 'Export',
  formats = DEFAULT_FORMATS,
  disabled,
}: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const addToast = useToastStore((s) => s.addToast);

  // Close on outside click or Escape so the popover never traps focus.
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

  const handlePick = async (format: ExportFormat) => {
    // Mark busy before awaiting build() — an async builder (fetch-then-export)
    // must show the "…" state while it runs, not only during exportData.
    setBusy(format);
    try {
      const payload = await build();
      if (!payload) { setOpen(false); return; }
      await exportData(format, payload);
      if (format === 'clipboard') {
        addToast('success', 'Copied to clipboard.');
      }
    } catch (err) {
      addToast('error', `Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative', display: 'inline-block' }}>
      <IconButton
        icon="download"
        label={label}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div
          role="menu"
          aria-label="Export format"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            minWidth: 180,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-md)',
            padding: 4,
            zIndex: 100,
          }}
        >
          {formats.map((f) => (
            <button
              key={f}
              role="menuitem"
              onClick={() => handlePick(f)}
              disabled={busy !== null}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 10px',
                fontSize: 12,
                background: 'transparent',
                border: 'none',
                borderRadius: 4,
                cursor: busy !== null ? 'default' : 'pointer',
                color: 'var(--color-text)',
                opacity: busy !== null && busy !== f ? 0.5 : 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {busy === f ? `${FORMAT_LABELS[f]} …` : FORMAT_LABELS[f]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
