// ──────────────────────────────────────────────────────────────────────────
// navConfig — the source of truth for sidebar structure.
//
// Lives outside Layout.tsx so the data tables don't bury the shell logic
// (Layout used to be ~1700 lines, most of it lookup tables). The shape
// here is:
//
//   navSections      ordered list of grouped sections rendered as the
//                    accordion in the desktop sidebar.
//   ROUTE_GROUPS     route-prefix aliases used to decide which item is
//                    "active" so /report → /reports highlights Reports.
//   GET_STARTED_ITEM the conditional "Get Started" entry pinned at the
//                    top of the rail while setup is incomplete.
//   bottomNavItems   the Settings cluster pinned to the bottom.
//                    Help was retired in favour of the top-bar Help
//                    button (openHelpWindow) so the guide opens in a
//                    popup without navigating the user away.
//   MOBILE_PRIMARY   the four primary destinations pinned to the mobile
//                    bottom bar; the fifth slot is the Menu button.
//
// `openHelpWindow` lives here because both the sidebar and the top-bar
// Help button call it; keeping it next to the Help nav item makes the
// behavioural contract obvious.
// ──────────────────────────────────────────────────────────────────────────

// `label` is what shows in the sidebar; `titleLabel`, when set,
// overrides the browser tab title so a short sidebar label (e.g.
// "Structure" inside the Organizations section) can still produce a
// meaningful tab title ("Organizations").
export type NavItem = { to: string; label: string; titleLabel?: string };

// `items` is always the flat source of truth (active-state, flyout,
// collapsed icon). `subGroups`, when present, only adds labelled
// dividers in the expanded accordion so a heavy section (Governance)
// reads as Setup / Operate / Analyze instead of an 11-item wall.
export type NavSection = {
  label: string | null;
  items: NavItem[];
  subGroups?: { label: string; itemTos: string[] }[];
  adminOnly?: boolean;
};

// Opens the Help guide in a separate window as styled HTML.
// Native browser rendering means Ctrl-F search, copy/paste, and
// responsive resize all work, and the print stylesheet still
// produces a clean paper copy for users who want one. The named
// target focuses an already-open window instead of spawning
// duplicates.
export function openHelpWindow() {
  window.open('/api/v1/docs/help.html', 'procela-help', 'popup,width=1100,height=900,noopener,noreferrer');
}

// Same pattern for the Training Guide — opens the generated PDF
// directly in the browser's PDF viewer. Distinct named target so the
// two windows can coexist without stealing focus from each other.
export function openTrainingWindow() {
  window.open('/api/v1/docs/training.pdf', 'procela-training', 'popup,width=1100,height=900,noopener,noreferrer');
}

// Same pattern for the Product Roadmap — opens the HTML rendered live from
// docs/ROADMAP.md in its own popup. The in-app /roadmap route embeds the
// same document; this is the popout equivalent of the Help window.
export function openRoadmapWindow() {
  window.open('/api/v1/docs/roadmap.html', 'procela-roadmap', 'popup,width=1100,height=900,noopener,noreferrer');
}

// Plain-noun buckets so users can find things by what they ARE, not
// by which DAMA phase they belong to. The Organizations section is
// the "who" of the platform — the company structure plus the humans
// and AI agents that act within it, along with the skills those
// actors carry. Data / Systems / Governance / Insights follow as the
// other domains.
export const navSections: NavSection[] = [
  {
    label: null,
    items: [
      { to: '/', label: 'Dashboard' },
    ],
  },
  {
    // "Organizations" reads as the cross-cutting "who" of the platform:
    // the structural org tree plus the people, AI agents and skills
    // that live within it. Agents was previously parked next to
    // Settings to avoid being missed under a "People" heading; the
    // broader "Organizations" label makes the AI-bot/human pairing
    // less misleading.
    label: 'Organizations',
    items: [
      // Label is "Structure" inside the Organizations section so it
      // doesn't echo the section title — the destination is still the
      // org tree at /organizations, and the browser tab still reads
      // "Organizations · Procela" via titleLabel.
      { to: '/organizations', label: 'Structure', titleLabel: 'Organizations' },
      { to: '/people', label: 'People' },
      { to: '/agents', label: 'Agents' },
      { to: '/skills', label: 'Skills' },
    ],
  },
  {
    // Processes sits in its own unlabelled row between the "who"
    // (Organizations) and the "what runs through them" (Data /
    // Systems / Governance / Insights). It's the verb that connects
    // the actors above to the artefacts below. Only one destination,
    // so a labelled accordion section would just produce a pointless
    // "Processes › Processes" expand.
    label: null,
    items: [
      { to: '/processes', label: 'Processes' },
    ],
  },
  {
    label: 'Data',
    items: [
      { to: '/data-assets', label: 'Data Assets' },
      { to: '/data-domains', label: 'Domains' },
      { to: '/business-glossary', label: 'Glossary' },
      { to: '/data-lineage', label: 'Lineage' },
    ],
  },
  {
    // Systems + Connections are one tabbed page (SystemsHubPage): a
    // connection feeds a system, so they read as one destination. Single
    // item, so it's an unlabelled row rather than a "Systems › Systems"
    // accordion.
    label: null,
    items: [
      { to: '/systems', label: 'Systems' },
    ],
  },
  {
    label: 'Governance',
    items: [
      { to: '/governance/foundation', label: 'Foundation' },
      { to: '/governance-groups', label: 'Groups' },
      { to: '/dama-roles', label: 'Roles' },
      { to: '/governance-policies', label: 'Documents', titleLabel: 'Governance Documents' },
      { to: '/decision-rights', label: 'Decision Rights' },
      { to: '/documentation', label: 'Documentation' },
      { to: '/governance-calendar', label: 'Calendar' },
      { to: '/governance-work', label: 'Tasks & Issues' },
      { to: '/governance-exceptions', label: 'Exceptions' },
    ],
    subGroups: [
      { label: 'Set up', itemTos: ['/governance/foundation', '/governance-groups', '/dama-roles', '/governance-policies', '/decision-rights'] },
      { label: 'Operate', itemTos: ['/documentation', '/governance-calendar', '/governance-work', '/governance-exceptions'] },
    ],
  },
  {
    // Cross-cutting exploration / reporting surfaces. They read across
    // Data, Systems, People, Processes and Governance — not governance
    // artefacts in their own right — so they live at the top level
    // rather than under Governance where they used to sit.
    label: 'Insights',
    items: [
      { to: '/enterprise-view',   label: 'Enterprise View' },
      { to: '/analysis',          label: 'Analysis' },
      { to: '/processes/data-map', label: 'Process ↔ Data Map' },
      { to: '/reports',           label: 'Reports' },
      { to: '/council-scorecard', label: 'Council Scorecard' },
      { to: '/gap-detection',     label: 'Gap Detection' },
      { to: '/audit-log',         label: 'Audit Log' },
    ],
    subGroups: [
      { label: 'Explore', itemTos: ['/enterprise-view', '/analysis', '/processes/data-map'] },
      { label: 'Review',  itemTos: ['/reports', '/council-scorecard', '/gap-detection', '/audit-log'] },
    ],
  },
];

// "Get Started" — the Setup Hub entry. Lives in its own unlabelled section
// at the very top (above Dashboard) while setup is incomplete, and is hidden
// once the active org reaches 100% so it doesn't clutter the rail forever.
export const GET_STARTED_ITEM: NavItem = { to: '/setup', label: 'Get Started' };

export const bottomNavItems: NavItem[] = [
  // Help was retired from the rail in favour of the top-bar Help
  // button (openHelpWindow above), which opens the same guide in
  // a popup window so the user keeps their current view. The
  // sidebar entry navigated to /help via React Router and put
  // Layout into a chrome-free reading mode — useful, but the
  // popup is a strict superset (can still be maximised) and
  // doesn't destroy the user's in-progress work. The /help route
  // itself stays registered so any existing deep links keep
  // working; the keyboard shortcut Ctrl-K → 'h' still gets
  // there too.
  { to: '/settings', label: 'Settings' },
];

// The four primary destinations pinned to the mobile bottom bar; the
// fifth slot is the "Menu" button that opens the full grouped drawer.
export const MOBILE_PRIMARY: NavItem[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/processes', label: 'Processes' },
  { to: '/data-assets', label: 'Assets' },
  { to: '/people', label: 'People' },
];

export const ROUTE_GROUPS: Record<string, string[]> = {
  '/setup': ['/setup'],
  '/processes': ['/processes'],
  '/data-assets': ['/data-assets', '/data-quality'],
  '/systems': ['/systems', '/connections'],
  '/business-glossary': ['/business-glossary'],
  '/processes/data-map': ['/processes/data-map', '/mappings'],
  '/data-lineage': ['/data-lineage'],
  '/governance/foundation': ['/governance/foundation'],
  '/governance-groups': ['/governance-groups'],
  '/data-domains': ['/data-domains'],
  '/dama-roles': ['/dama-roles', '/roles', '/raci'],
  '/decision-rights': ['/decision-rights'],
  '/governance-policies': ['/governance-policies'],
  '/documentation': ['/documentation', '/operations-manual', '/sops'],
  '/governance-calendar': ['/governance-calendar'],
  '/governance-work': ['/governance-work'],
  '/enterprise-view': ['/enterprise-view', '/control-tower'],
  '/reports': ['/reports', '/report', '/scorecard'],  // /scorecard redirects to /reports
  '/analysis': ['/analysis'],
  '/organizations': ['/organizations'],
  '/people': ['/people'],
  '/agents': ['/agents'],
  '/settings': ['/settings'],
};
