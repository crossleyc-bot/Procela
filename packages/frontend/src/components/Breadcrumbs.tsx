import { Link, useLocation } from 'react-router-dom';

// Segment → label. Where a segment is a top-level nav destination the
// label MUST match the sidebar item exactly — a breadcrumb that
// disagrees with the menu the user just clicked ("Roles" in the nav,
// "Governance Roles" in the trail) is disorienting. Sub-route-only
// segments (wizard, visualization…) have no sidebar entry and are
// labelled here freely.
const ROUTE_LABELS: Record<string, string> = {
  '': 'Dashboard',
  'processes': 'Processes',
  'wizard': 'Wizard',
  'visualization': 'Visualization',
  'compare': 'Compare',
  'organizations': 'Organizations',
  'people': 'People',
  'agents': 'Agents',
  'connections': 'Connections',
  'systems': 'Systems',
  'systems-and-data': 'Systems & Data',
  'data-assets': 'Data Assets',
  'mappings': 'Data Mapping',
  'gap-detection': 'Gap Detection',
  'governance': 'Governance',
  'governance-groups': 'Groups',
  'governance-program': 'Program',
  'data-domains': 'Domains',
  'dama-roles': 'Roles',
  'analyze': 'Analyze',
  'scorecard': 'Scorecard',
  'report': 'Executive Report',
  'raci': 'RACI Matrix',
  'data-lineage': 'Lineage',
  'data-quality': 'Data Quality',
  'control-tower': 'Control Tower',
  'governance-policies': 'Policies',
  'governance-work': 'Tasks & Issues',
  'enterprise-view': 'Enterprise View',
  'reports': 'Reports',
  'branding': 'Branding',
  'settings': 'Settings',
  'help': 'Help',
  'operations-manual': 'Operations Manual',
  'governance-calendar': 'Calendar',
  'decision-rights': 'Decision Rights',
  'sops': 'Procedures',
  'business-glossary': 'Glossary',
};

const containerStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#6b7280',
  marginBottom: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

const linkStyle: React.CSSProperties = {
  color: '#6b7280',
  textDecoration: 'none',
};

const currentStyle: React.CSSProperties = {
  fontWeight: 600,
  color: '#6b7280',
};

const separatorStyle: React.CSSProperties = {
  color: '#d1d5db',
  userSelect: 'none',
};

export default function Breadcrumbs() {
  const location = useLocation();
  const pathname = location.pathname;

  // Don't render on dashboard
  if (pathname === '/') return null;

  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // Build breadcrumb items: always start with Dashboard
  const crumbs: Array<{ label: string; path: string; isLast: boolean }> = [
    { label: 'Dashboard', path: '/', isLast: false },
  ];

  let builtPath = '';
  segments.forEach((segment, idx) => {
    builtPath += `/${segment}`;
    const label = ROUTE_LABELS[segment] || segment.charAt(0).toUpperCase() + segment.slice(1);
    crumbs.push({
      label,
      path: builtPath,
      isLast: idx === segments.length - 1,
    });
  });

  return (
    <nav style={containerStyle} aria-label="Breadcrumb">
      {crumbs.map((crumb, idx) => (
        <span key={crumb.path} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {idx > 0 && <span style={separatorStyle}>{'>'}</span>}
          {crumb.isLast ? (
            <span style={currentStyle}>{crumb.label}</span>
          ) : (
            <Link to={crumb.path} style={linkStyle}>{crumb.label}</Link>
          )}
        </span>
      ))}
    </nav>
  );
}
