import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PageHeader from './PageHeader';

describe('PageHeader', () => {
  it('renders the title as an h1 with the 22px polish treatment', () => {
    render(<PageHeader title="Data Assets" />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('Data Assets');
    expect(h1.style.fontSize).toBe('1.375rem');
    expect(h1.style.fontWeight).toBe('700');
  });

  it('omits the kicker when not provided', () => {
    render(<PageHeader title="X" />);
    // Kicker is the only uppercase 11px muted line in the header.
    expect(screen.queryByText(/POLICY/)).not.toBeInTheDocument();
  });

  it('renders the kicker above the title when provided', () => {
    render(<PageHeader kicker="POLICY · POL-007" title="Data Retention" />);
    expect(screen.getByText('POLICY · POL-007')).toBeInTheDocument();
  });

  it('renders the subtitle when provided', () => {
    render(<PageHeader title="X" subtitle="Sub" />);
    expect(screen.getByText('Sub')).toBeInTheDocument();
  });

  it('renders meta and actions in distinct slots', () => {
    render(
      <PageHeader
        title="X"
        meta={<span data-testid="meta">meta</span>}
        actions={<button data-testid="action">act</button>}
      />,
    );
    expect(screen.getByTestId('meta')).toBeInTheDocument();
    expect(screen.getByTestId('action')).toBeInTheDocument();
  });

  it('renders children inline next to the title', () => {
    render(
      <PageHeader title="X">
        <span data-testid="help">?</span>
      </PageHeader>,
    );
    // The help slot lives in the same flex row as the h1, not in actions.
    const help = screen.getByTestId('help');
    expect(help.parentElement?.querySelector('h1')).not.toBeNull();
  });
});
