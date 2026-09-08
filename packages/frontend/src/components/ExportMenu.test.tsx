import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ExportMenu from './ExportMenu';
import { exportData, type ExportPayload } from '../lib/export';

// Mock the export layer so we assert what ExportMenu hands it, without
// touching the DOM download / clipboard side effects.
vi.mock('../lib/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/export')>();
  return { ...actual, exportData: vi.fn(async () => {}) };
});

const addToast = vi.fn();
vi.mock('../stores/toastStore', () => ({
  useToastStore: (sel: (s: { addToast: typeof addToast }) => unknown) => sel({ addToast }),
}));

const payload: ExportPayload = { filenameBase: 'r', headers: ['A'], rows: [['1']] };

function openAndPick(format: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(format, 'i') }));
}

describe('ExportMenu', () => {
  beforeEach(() => {
    vi.mocked(exportData).mockClear();
    addToast.mockClear();
  });

  it('exports the payload from a synchronous build', async () => {
    render(<ExportMenu build={() => payload} formats={['csv']} />);
    openAndPick('CSV');
    await waitFor(() => expect(exportData).toHaveBeenCalledWith('csv', payload));
  });

  it('awaits an async build before exporting (fetch-then-export)', async () => {
    let resolve!: (p: ExportPayload) => void;
    const build = vi.fn(() => new Promise<ExportPayload | null>((r) => { resolve = r; }));
    render(<ExportMenu build={build} formats={['csv']} />);
    openAndPick('CSV');
    // Build is in flight; nothing exported until it resolves.
    expect(exportData).not.toHaveBeenCalled();
    resolve(payload);
    await waitFor(() => expect(exportData).toHaveBeenCalledWith('csv', payload));
  });

  it('cancels the export when build returns null', async () => {
    render(<ExportMenu build={() => null} formats={['csv']} />);
    openAndPick('CSV');
    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: /CSV/i })).not.toBeInTheDocument(),
    );
    expect(exportData).not.toHaveBeenCalled();
  });

  it('toasts on a build/export failure instead of throwing', async () => {
    render(<ExportMenu build={() => { throw new Error('boom'); }} formats={['csv']} />);
    openAndPick('CSV');
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith('error', expect.stringContaining('boom')),
    );
  });
});
