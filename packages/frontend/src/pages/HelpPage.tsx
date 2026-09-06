import PageHeader from '../components/PageHeader';
import SectionLabel from '../components/SectionLabel';
import Page from '../components/Page';
import Card from '../components/Card';
import { openTrainingWindow } from '../components/navConfig';

const h2Style: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 12,
  color: 'var(--color-primary)',
  // Keep the heading clear of the 56px sticky app header when an
  // anchor link from the table of contents jumps to it.
  scrollMarginTop: 72,
};

// Section anchors for the in-page table of contents. id values are
// referenced both by the ToC links and the section <h2> elements.
const HELP_SECTIONS: Array<{ id: string; label: string }> = [
  { id: 'help-getting-started', label: '1. Getting Started' },
  { id: 'help-navigation', label: '2. Navigation' },
  { id: 'help-dashboard', label: '3. Dashboard' },
  { id: 'help-processes', label: '4. Processes' },
  { id: 'help-data', label: '5. Data' },
  { id: 'help-systems', label: '6. Systems' },
  { id: 'help-organizations', label: '7. Organizations' },
  { id: 'help-governance', label: '8. Governance' },
  { id: 'help-insights', label: '9. Insights' },
  { id: 'help-security', label: '10. Security & Account' },
  { id: 'help-cross-cutting', label: '11. Cross-cutting Features' },
  { id: 'help-key-concepts', label: '12. Key Concepts' },
  { id: 'help-faq', label: '13. Frequently Asked Questions' },
  { id: 'help-shortcuts', label: '14. Keyboard shortcuts' },
];

const h3Style: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  marginBottom: 8,
  marginTop: 16,
};

const pStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  color: 'var(--color-text-secondary)',
  marginBottom: 8,
};

const listStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.8,
  color: 'var(--color-text-secondary)',
  paddingLeft: 20,
  listStyle: 'disc',
  marginBottom: 8,
};

const kbdStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 6px',
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  fontSize: 11,
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  color: 'var(--color-text)',
};

export default function HelpPage() {
  return (
    <Page width="narrow">
      <PageHeader
        title="Help Guide"
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
      <p style={{ ...pStyle, marginBottom: 16 }}>
        Procela is a DAMA-aligned governance operating platform that helps organizations design, execute, and mature
        data governance using workflows, accountability models, and structured procedures.
      </p>

      {/* On this page — anchor links so a user can jump straight to a
          section instead of scrolling a 12-section wall of text. */}
      <Card padding={24} marginBottom={24} role="navigation" aria-label="Help contents">
        <SectionLabel marginBottom={10}>
          On this page
        </SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '4px 16px' }}>
          {HELP_SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              style={{ fontSize: 13, color: 'var(--color-primary)', textDecoration: 'none', padding: '2px 0' }}
            >
              {s.label}
            </a>
          ))}
        </div>
      </Card>

      {/* 1. Getting Started */}
      <Card padding={24} marginBottom={20}>
        <h2 id="help-getting-started" style={h2Style}>1. Getting Started</h2>
        <p style={pStyle}>
          The fastest way in is the <strong>Get Started</strong> hub (titled <strong>Set up Procela</strong>) &mdash; a resumable, data-driven journey from an empty org to a running governance program. It sits at the top of the sidebar and at <code>/setup</code>. Onboarding the org and standing up the program are <strong>one spine</strong>, not two separate tracks: onboarding is simply the first half of standing the program up.
        </p>

        <h3 style={h3Style}>The four stages</h3>
        <ul style={listStyle}>
          <li><strong>① Capture</strong> &mdash; tell Procela about your business: organization structure, people, processes, systems, and data assets.</li>
          <li><strong>② Assign</strong> &mdash; give every process, system, data domain, and data asset a clear owner. Each ownable type is its own board item (Process / System / Domain / Data-asset ownership), and each deep-links to that type&rsquo;s own page &mdash; the Process Catalog, Systems, Data Domains, and Data Assets &mdash; where you assign owners in context. A row ticks once that type has no ownerless items.</li>
          <li><strong>③ Govern</strong> &mdash; connect data to processes, tier and grade assets, and define your governance foundation (scope, principles, operating model).</li>
          <li><strong>④ Operate</strong> &mdash; stand up the governance structure and roles &amp; policies, then launch and run the program.</li>
        </ul>

        <h3 style={h3Style}>The lifecycle bar</h3>
        <p style={pStyle}>
          Across the top, the governance program's lifecycle &mdash; <strong>Planning → Active → Paused → Completed</strong> &mdash; governs the whole arc. The valid next transitions (<em>Launch</em>, <em>Pause</em>, <em>Complete</em>, <em>Reopen</em>) are buttons right here on the lifecycle bar; they're role-gated (admin / program owner) and audited, with a reason prompt and an early-launch confirmation when phases are still incomplete. <strong>Launch stays disabled until Foundation (Phase 1) is complete</strong> &mdash; the one hard prerequisite &mdash; and once the program goes live the actual <strong>Launched</strong> date is recorded and shown next to the status.
        </p>

        <h3 style={h3Style}>How progress is shown</h3>
        <ul style={listStyle}>
          <li><strong>No overall %.</strong> A single number mixing "have I added my systems" with "is the program launched" is meaningless and oscillates &mdash; so each stage carries <em>its own</em> count instead. A stage line names the current stage and reads <em>Stage X of 4 · &lt;name&gt; &mdash; n of m done</em>.</li>
          <li><strong>Derived from live data, not checkboxes.</strong> Add five systems and the Systems item flips automatically &mdash; there's no separate to-do list to keep in sync. Statuses come from dashboard stats (operationally scoped) plus the governance-program status.</li>
          <li><strong>HERE / AUTO source badges.</strong> Each board item is tagged <strong>Here</strong> (you define it in Procela &mdash; e.g. adding systems, mapping data, editing the Foundation) or <strong>Auto</strong> (derived from your catalog &mdash; e.g. ownership coverage, program launch). Every row deep-links to the page where the work happens.</li>
          <li><strong>Operationally scoped.</strong> Process-side counts (value streams, steps, ownership gaps, coverage) reflect only your business processes, so the canned <em>Data Governance Management</em> scaffold never masquerades as business-process progress.</li>
          <li><strong>Sidebar progress ring.</strong> The ring next to the <em>Get Started</em> link now spans <strong>all four stages</strong> &mdash; it fills, and the link auto-hides, only once the program is actually stood up and running, not merely when the org is onboarded.</li>
        </ul>

        <h3 style={h3Style}>Reading the board</h3>
        <ul style={listStyle}>
          <li>Below the stage line, a <strong>four-column board</strong> (one column per stage) shows each item as a checklist row with its source badge and a segmented progress bar. Every row's deep-link hands off to the same destination the left nav exposes, so the move from journey to workspace is seamless. <strong>Operate</strong> reads strictly top-to-bottom: <em>Program launched</em> only ticks once the structure and roles &amp; policies it depends on are in place.</li>
          <li>The hub is for setup and check-ins; the left nav is your persistent workspace once you know the app.</li>
        </ul>

        <h3 style={h3Style}>The governance program lives here</h3>
        <p style={pStyle}>
          There is no separate Governance Program page &mdash; it was folded into this journey. The <strong>Govern</strong> and <strong>Operate</strong> stages, the lifecycle bar, and Next Actions together <em>are</em> the program's four-phase tracker (Foundation → Structure → People → Operations) and its governed lifecycle. Authoring the foundation itself &mdash; scope, guiding principles, operating model &mdash; happens on <strong>Governance &rarr; Foundation</strong>, and the individual pieces (domains, groups, roles, policies) live on their own Governance pages, which each board item and Next Action deep-links to. (The old <code>/governance-program</code> URL now redirects here.)
        </p>
      </Card>

      {/* 2. Navigation */}
      <Card padding={24} marginBottom={20}>
        <h2 id="help-navigation" style={h2Style}>2. Navigation</h2>
        <p style={pStyle}>The sidebar opens with <strong>Get Started</strong> for first-run onboarding (it auto-hides at 100%), then the platform's "who" and "what does work" before fanning out into the artefact buckets. Dashboard is a direct link; Organizations and Processes follow as the actors and the verb that connects them; Data / Systems / Governance / Insights cover the artefacts the work runs through. Sections with multiple destinations are accordions you can expand and collapse.</p>
        <ul style={listStyle}>
          <li><strong>Get Started</strong> &mdash; Resumable setup hub: <strong>one journey</strong> (Capture → Assign → Govern → Operate) from an empty org to a running governance program, with the program lifecycle (Planning → Active → Paused → Completed) across the top and HERE/AUTO board items deep-linking to each workspace. No overall %; each stage carries its own count. The progress ring and auto-hide track all four stages. See Section 1 for the mechanics.</li>
          <li><strong>Dashboard</strong> &mdash; Personalized home with your tasks, issues, domains, and KPIs.</li>
          <li><strong>Organizations</strong> &mdash; Accordion covering the "who" of the platform: <strong>Structure</strong> (your company / division / team tree), <strong>People</strong> (the humans on your team), <strong>Agents</strong> (AI agents that hold governance roles and run automation), and <strong>Skills</strong> (the competencies your roles need).</li>
          <li><strong>Processes</strong> &mdash; the Process Catalog, where you define value streams, processes, sub-processes and activities, and connect each node to its owner / responsible role / systems / data assets inline. Direct link, not an accordion. (The cross-process view of activity↔asset mappings lives under <strong>Insights &rarr; Process &harr; Data Map</strong> &mdash; its <em>Table</em> view.)</li>
          <li><strong>Data</strong> &mdash; Data Assets, Glossary, Lineage, Domains, Data Quality.</li>
          <li><strong>Systems</strong> &mdash; Systems and Connections (databases, APIs, files).</li>
          <li><strong>Governance</strong> &mdash; grouped into <strong>Set up</strong> (Foundation, Groups, Roles with RACI Matrix tab, Documents, Decision Rights) and <strong>Operate</strong> (Documentation with Manual + Procedures tabs, Calendar, Tasks &amp; Issues, Exceptions). The sub-labels are visual dividers in the expanded section &mdash; every item still navigates directly. (The program's tracker and lifecycle live on <strong>Get Started</strong> now, not a separate Program page.)</li>
          <li><strong>Insights</strong> &mdash; grouped into <strong>Explore</strong> (Enterprise View, Analysis, Process &harr; Data Map) and <strong>Review</strong> (Reports, Council Scorecard, Gap Detection, Audit Log). Cross-cutting exploration and review surfaces that read across Data, Systems, People, Processes and Governance &mdash; promoted out of Governance so they're easier to find.</li>
        </ul>
        <p style={pStyle}>Settings sits at the bottom of the sidebar; Help is the button in the top bar (next to Ask AI).</p>

        <h3 style={h3Style}>Header controls</h3>
        <ul style={listStyle}>
          <li><strong>Search box (Cmd/Ctrl + K or /)</strong> &mdash; Universal command palette. Searches processes, data assets, systems, people, domains, and groups in your active org. Results are ranked and link directly to the matching item.</li>
          <li><strong>Working in &hellip;</strong> &mdash; Organization selector. Scopes every page to the selected org. Divisions are listed nested under their parent company (Tidewater Utilities ▸ Electric / Water), so you can drop into a division-scoped view without leaving the page. Single-tier companies render as a flat list.</li>
          <li><strong>Display preferences</strong> &mdash; the Plain / DAMA terminology toggle and the Cozy / Compact density toggle live in the <strong>user menu</strong> (click your name / avatar in the top-right corner). Per-user, persisted per browser, applied immediately. The Settings page is admin-only and holds org-wide configuration instead.</li>
        </ul>
      </Card>

      {/* 3. Dashboard */}
      <Card padding={24} marginBottom={20}>
        <h2 id="help-dashboard" style={h2Style}>3. Dashboard</h2>
        <p style={pStyle}>The dashboard is personalized to your login. You must have a People record with your email to see personalized data.</p>
        <ul style={listStyle}>
          <li><strong>My Dashboard</strong> &mdash; Open tasks, issues, domains you own/steward, upcoming events. Each tile is a hyperlink &mdash; <em>Open Tasks</em> jumps to Governance Work (Tasks tab), <em>Open Issues</em> to the Issues tab, <em>My Domains</em> to the Data Domains page, and <em>Upcoming Events</em> to the Governance Calendar. Hover lifts the tile to signal it's interactive; zero-count tiles fade the number but still link through to the destination's empty state.</li>
          <li><strong>Needs My Attention</strong> &mdash; Overdue tasks, critical issues, pending policy reviews</li>
          <li><strong>My Schedule</strong> &mdash; Governance events in the next 14 days</li>
          <li><strong>Overview</strong> &mdash; Organization-wide KPIs (value streams, assets, coverage, health). Each tile is a hyperlink — click <em>Value Streams</em> / <em>Processes</em> to jump into the Process Catalog, <em>Data Assets</em> / <em>Systems</em> to their catalogs, <em>Coverage</em> straight to Data Mapping (where the unmapped-activity and unlinked-asset banners surface), and <em>Avg Health</em> to Data Assets sorted by health ascending so the worst-scoring assets are at the top. Hover lifts the tile to signal it's interactive; zero-count tiles fade the number but still link through to the destination's empty state.</li>
          <li><strong>Program Maturity</strong> &mdash; Current governance phase with next steps to advance</li>
          <li><strong>What&apos;s Next</strong> &mdash; Contextual recommendations based on org maturity</li>
          <li><strong>Skill Gaps</strong> &mdash; Top under-staffed required skills across the org. Each row compares <em>required by activities</em> against <em>held by people</em> as a bar chart; rows where nobody on staff holds the skill are flagged in red ("no coverage"), tight-but-covered rows in amber, healthy in green. The <em>Find people by skill →</em> link jumps straight to the People page's skill filter for staffing backfills.</li>
          <li><strong>Recent Activity</strong> &mdash; Last audit log entries (expandable)</li>
          <li><strong>Quick Actions</strong> &mdash; Shortcuts to common tasks</li>
        </ul>
        <p style={pStyle}>Click <strong>Customize</strong> to reorder or hide dashboard sections. Layout is saved automatically.</p>
      </Card>

      {/* 4. Processes */}
      <Card padding={24} marginBottom={20}>
        <h2 id="help-processes" style={h2Style}>4. Processes</h2>
        <h3 style={h3Style}>Process Catalog</h3>
        <ul style={listStyle}>
          <li>Hierarchical process catalog: Value Stream &rarr; Process &rarr; Activity (with optional Sub-Process and Task levels for detail).</li>
          <li>AI-powered Value Stream Wizard generates process hierarchies tailored to the <strong>active org</strong>, not just the industry. Running the wizard scoped to <em>Tidewater Electric</em> produces electric-utility processes (SCADA, outage management, transmission &amp; distribution); scoping to <em>Tidewater Water</em> produces water-utility processes (treatment, distribution mains, wastewater). The active org's name, type, and description ride along with the industry to the AI prompt so output reflects this specific division rather than generic Utilities content. The result is <strong>cached per (industry + org)</strong> on the server — first user pays the 10–30 second Claude call, every subsequent run for the same org returns the same template instantly, and each division caches independently. A <em>Cached</em> / <em>Fresh from AI</em> badge plus a <em>Specialised: &lt;Org&gt;</em> chip on the review screen tells you what's been tailored; the <em>Regenerate from AI</em> button next to the standard <em>Regenerate</em> bypasses the cache and replaces the stored copy with a brand-new Claude generation.</li>
          <li>Level-specific attributes: frequency, risk level, responsible role, automation level.</li>
          <li><strong>Advanced activity attributes.</strong> Switch the tree view to <strong>Advanced</strong> to expose an activity's business-continuity and sizing fields: <strong>Criticality</strong> tier (Tier&nbsp;1&ndash;4), <strong>RTO</strong> and <strong>RPO</strong> in hours (recovery speed and tolerable data loss &mdash; the BCM pair a DR plan states together), <strong>Trigger</strong> (what initiates the activity &mdash; Scheduled / Event-driven / Upstream completion / Manual / External request), <strong>Volume</strong> (processing throughput / scale, distinct from Frequency&rsquo;s cadence), a free-text <strong>Target / SLA</strong>, and <strong>Controls</strong> (the governance controls the activity implements, linked from Governance Documents).</li>
          <li>Status lifecycle: Draft &rarr; Active &rarr; Deprecated.</li>
          <li><strong>Operational / Governance lens.</strong> A segmented control (<em>All · Operational · Governance</em>) at the top filters which value streams show. Governance value streams (created by the governance template) carry a persisted domain classifier; business value streams are operational. The lens is <strong>per page</strong> — the Process Catalog always opens on <strong>All</strong>, and your choice here is independent of the lens on other pages.</li>
          <li>Assigning an Owner or Stakeholders opens the shared <strong>person picker</strong> &mdash; search by name / title / org, or browse the org tree (Company &rarr; Division &rarr; Department) or governance groups. Every result shows the person's title and org path so two people with the same name are distinguishable. The same picker is used for owners, stewards, deputies, and group members across the app.</li>
          <li><strong>Domain-aware role assignment.</strong> Governance value streams default the person picker to the governance bodies and the <strong>Responsible Role</strong> selector to the DAMA governance roles only; operational (business) processes default to the org tree and the generic business roles, with the DAMA roles hidden. A "show all roles" toggle reveals the other set for genuine cross-overs, and a picked role from the other domain is flagged <em>Cross-domain</em>. Existing free-text role values are preserved until you re-pick.</li>
          <li><strong>Operational vs governance node fields.</strong> Governance nodes (those under a value stream with <code>domain === 'GOVERNANCE'</code>) skip the <em>Where it runs</em> summary and the <em>Systems</em> picker — governance happens in policies, decisions and meetings, not on systems, and showing perpetually-zero system / data-asset counts on a governance activity was just noise. Operational nodes keep the full layout. The <em>Inputs / Outputs</em> note and the data-asset linker stay available on governance nodes too, since edge cases (an Audit Log Review activity consuming the audit log) are still legitimate.</li>
          <li><strong>Inputs / Outputs panel — picker varies by domain.</strong> Operational activities can link a row to a <strong>Data Asset</strong> (operational I/O), a <strong>Governance Document</strong> (a charter or policy the activity references), or an <strong>Attachment</strong> (uploaded file / URL). Governance activities lose the Data Asset tab — their I/O is documents and attachments only, since they don't produce or consume operational data. The <em>+ Add Input / Output</em> picker is segmented across the available kinds; pick what kind first, then the specific target. A row's label is clickable: a data asset opens the asset detail, a document jumps to Governance Documents, an attachment downloads. So <em>Define Data Governance Charter</em> defaults to the Document tab and can link the actual <em>Data Governance Charter</em> policy (CHA-001) as its Output, with the signed PDF uploaded as a separate output row.</li>
          <li><strong>Qualified-person check.</strong> When an activity carries a Responsible person and required skills, Procela compares the person's <code>skillIds</code> against the activity's <code>requiredSkillIds</code>. If anything's missing, an amber chip appears next to the Required Skills picker on the activity panel — <em>"Responsible person lacks N required skill(s)"</em> — with the missing names in the tooltip. The same gap surfaces as a <em>Skill gaps</em> count on the People table, so you can spot under-qualified assignments from either end. The check is per-org and updates live as you change the person or the required-skill list.</li>
          <li><strong>Cross-division link warning.</strong> When you add a data-asset or document link to an activity, Procela checks whether the target's owner org is on the same vertical axis as the activity's value-stream org (i.e. same org, ancestor, or descendant). If it isn't — typically a Tidewater Water activity reaching for a Tidewater Electric asset — a confirm pops first: <em>"&lt;Target&gt; is owned by &lt;Other Division&gt;, but &lt;Activity&gt; sits in &lt;This Division&gt;. Cross-division links usually mean the wrong target was picked — pick again, or confirm if this is genuinely a shared dependency."</em> The default is <strong>warn, not block</strong>: confirming creates the link normally; cancelling drops it. Cross-axis links to shared parent-company targets (a Water activity using the corporate Customer Master, or the enterprise Data Governance Charter) go through silently because the target is in scope by inheritance. Attachments skip the check since they're scoped to the activity directly.</li>
          <li><strong>Where value streams can be created.</strong> Streams attach to the active org in the <em>Working in&hellip;</em> header, but only at the <strong>company</strong> or <strong>division</strong> level. Two cases block the create UI (the <em>+ Add value stream</em> button, the wizard wand, the governance-template wand, and the empty-state buttons all hide; Visualize / Compare / Export stay available):
            <ul style={{ ...listStyle, marginTop: 6, marginBottom: 6 }}>
              <li><strong>Wrong level.</strong> The active org is a department, team, or anything below division. Pick a parent org from <em>Working in&hellip;</em>.</li>
              <li><strong>Multi-division company.</strong> The active org is a company that has at least one division anywhere in its subtree (e.g. Tidewater Utilities → Electric / Water, or Company → Region → Division). Generating at the parent would silently create one shared <em>operational</em> catalog the divisions don't actually share. The banner lists the divisions as one-click <em>Switch to:</em> chips, so you can drop into one without leaving the page. Single-tier companies (no divisions) keep working normally at the company level. <strong>Governance is the exception</strong> — corporate data governance is intentionally one enterprise-wide program (one policy book, one decision-rights matrix, one RACI), so the <em>Generate governance processes</em> wand stays available at the parent and isn't blocked even when divisions exist.</li>
            </ul>
            The same guard applies to both the Process Wizard and the catalog's manual create path so it can't be sidestepped.
          </li>
        </ul>
        <h3 style={h3Style}>Data Mapping (Process ↔ Data Map · Table view)</h3>
        <ul style={listStyle}>
          <li>The <strong>Table</strong> view of <strong>Process ↔ Data Map</strong>: a flat audit / bulk-edit list of every activity ↔ target link in the catalog. Sortable columns, CSV/Excel export, bulk delete, and the Batch Mapping Wizard (matrix interface) for creating many mappings at once. Switch to the <strong>Visual</strong> view for the bipartite bridge that groups activities under their value stream, process and sub-process.</li>
          <li>Day-to-day, you connect an activity to its data assets <strong>inline on the Process Catalog</strong> — each node panel has Owner, Responsible Role, Systems, and Inputs/Outputs (data assets) in one place. This view is the cross-process review surface for those same links; it doesn't introduce a separate model.</li>
          <li>Mappings can be AI-suggested or user-defined; the page tracks which is which so suggestion overrides are auditable.</li>
          <li><strong>Target column.</strong> A mapping can point at one of three things — a <strong>Data Asset</strong>, a <strong>Governance Document</strong> (charter / policy / standard / framework), or an <strong>Attachment</strong>. Each row carries a typed tag (<em>ASSET</em>, <em>DOCUMENT</em>, <em>ATTACHMENT</em>) plus the target's name and a sub-detail (governance tier for assets, code · type for documents, filename for attachments) so the three link kinds are visually distinct at a glance.</li>
          <li><strong>Orphan detection + cleanup.</strong> When the activity, asset, document, or attachment a mapping points at has been deleted (commonly: an agent draft was promoted, then the source activity got regenerated by the Process Wizard with new ids), the row renders the dangling side as an amber "Activity deleted" / "Data asset deleted" / "Governance document deleted" chip with the original id-prefix in the tooltip. A red banner above the table shows the total orphan count and a one-click <strong>Delete all orphans</strong> action — the surviving activities, assets, and documents are untouched. Orphans sort to the end of the table so the active rows stay together at the top.</li>
        </ul>
      </Card>

      {/* 5. Data */}
      <Card padding={24} marginBottom={20}>
        <h2 id="help-data" style={h2Style}>5. Data</h2>
        <h3 style={h3Style}>Data Assets</h3>
        <ul style={listStyle}>
          <li>Register data assets in business terms. Each asset has a Trust Level (Untrusted / Managed / Trusted &mdash; DAMA mode calls these Uncertified / Managed / Certified).</li>
          <li>Sidebar filter by <strong>Data Classification</strong>: Master, Reference, Transactional, Analytical, Metadata. (This is the business kind of data — distinct from a column's SQL data type and from Sensitivity.)</li>
          <li><strong>Filter by rules (DQ coverage).</strong> The toolbar has a rules filter — <em>Has rules</em> / <em>No rules</em> / <em>Rules but unmeasured</em>, each showing a live count. <em>No rules</em> is your coverage gap: assets nothing measures yet. <em>Rules but unmeasured</em> is the false-confidence bucket: assets that carry rules but where none have a real (non-simulated) result, so their health is an <strong>estimate</strong> (badged <em>Est</em>), not a measured reading — the ones to point a connector at next.</li>
          <li>Inline editing for Trust Level directly in the table.</li>
          <li><strong>Health is earned from measured data quality, not hand-set.</strong> The Health column shows an asset&rsquo;s rolled-up score only when at least one <em>measured</em> (non-simulated) quality rule backs it; with no measured rule it reads <strong>0%</strong>. It&rsquo;s read-only in the list &mdash; a connector-freshness or manual number is never surfaced as &ldquo;health&rdquo;. (Per-column health on the 360 view still reads &ldquo;&mdash;&rdquo; for a column whose rule hasn&rsquo;t been measured.)</li>
          <li><strong>Health score</strong> comes from one of three places: a manual score you set here; a weighted roll-up of <em>measured</em> data-quality rules (see Data Quality); or, for an asset a connector discovered that has no rules yet, a freshness signal graded on how recently the table was written &mdash; a table written in the last day scores 95, decaying as it goes stale, and an empty table is capped low. The bar shows whichever applies. (Add supported rules to a connector asset and the connector measures them on-prem, so they drive health like any other measured rule.)</li>
          <li><strong>Link to Source</strong> connects an asset to a database table, file, or API. In the Link-to-connection dialog you can bind the asset to the <em>whole</em> table/file, or tick a <strong>named set of its columns</strong> &mdash; so one physical table can back several business assets, each scoped to its own subset. The Source cell shows the target as <code>table</code>, <code>table.column</code>, or <code>table &middot; N cols</code>.</li>
          <li>Expandable columns show data types and quality rules per column. Binding a column set <strong>materializes those columns as governed columns</strong> automatically, so they are immediately targetable by quality rules and roll their health up to the asset.</li>
          <li><strong>Deleting a column warns when rules reference it.</strong> Removing a column that has data-quality rules pops a confirm (&ldquo;<em>N data-quality rules reference this column</em>&rdquo;). The rules aren&rsquo;t deleted &mdash; they <em>detach</em> from the column: they keep measuring by column name if the source still has it, but no longer appear under the column. A column with <em>no</em> rules deletes without a prompt, and a connector-discovered column re-appears on the next scan anyway.</li>
          <li>Bulk set Trust Level / owner / steward.</li>
          <li><strong>Where Used</strong> in the detail modal shows every process, mapping, and policy referencing the asset.</li>
          <li><strong>Bound columns</strong> panel on the detail (360) view lists the columns the asset is bound to &mdash; each with its rule count and per-column health &mdash; plus which physical table/columns it maps to. A column with a rule that hasn't been measured reads &ldquo;&mdash;&rdquo;, never a fabricated score.</li>
          <li><strong>Sensitivity — Suggest &amp; Review.</strong> The Sensitivity chip row on the Data Asset 360 modal accepts one of the standard tags (PII, PHI, PCI, FINANCIAL, CREDENTIAL, CONFIDENTIAL, PUBLIC), and <em>Suggest sensitivity tags</em> runs an AI classifier over the asset's name + description. Each proposed tag has its own <strong>Accept</strong> / <strong>Reject</strong>; rejected tags stick across re-runs so a subsequent suggest doesn't re-propose the same thing.</li>
          <li><strong>Turning AI off (deployment-wide).</strong> This Suggest classifier and every other AI integration feature &mdash; the Ask AI assistant, industry-template generation, data/asset suggestions, and the AI governance agents &mdash; are gated behind a single switch, <code>AI_FEATURES_ENABLED</code> (default on). Set it to <code>false</code> and the whole AI surface disappears: the backend refuses the AI endpoints and the frontend hides their entry points. It&rsquo;s the one knob an on-prem or FedRAMP deployment flips to run without ever calling an external model; the rest of Procela works unchanged. Existing sensitivity tags stay visible, and the Agents registry stays available (only the AI <em>execution</em> trigger is gated).</li>
          <li><strong>Impact analysis.</strong> The <em>Impact</em> panel below the Sensitivity row answers "if this asset changes, what breaks?" — it counts affected activities, processes, and value streams, and expands to a per-person <em>Notify</em> list with role provenance (Owner, Responsible, Domain steward, etc.). Use it as your change-comms distribution list before deprecating a system or retiring a field.</li>
          <li><strong>Data Assets is operational-only.</strong> Governance documents (charters, policies, standards, frameworks) live under <strong>Governance &rarr; Documents</strong>, not here. The earlier <em>All · Operational · Governance</em> lens was removed from this page when the governance template stopped seeding placeholder data assets and started seeding real Policies instead.</li>
          <li><strong>Org scope and inheritance.</strong> Each asset is owned by exactly one org, and only <strong>company</strong> or <strong>division</strong> levels can own — departments and teams can't. If the active <em>Working in&hellip;</em> scope isn't an owning level, the <em>+ Add data asset</em> button is hidden and a banner explains why (the list still renders so users can read inherited rows from above). When you're scoped to a division, the list shows division-owned assets <em>plus</em> assets owned at the parent company — the parent-owned ones carry a small <em>Owned by &lt;Company&gt;</em> badge and their edit / delete / inline-cell affordances are disabled with a "Switch the Working in&hellip; scope to &lt;Company&gt; to edit" tooltip. Conversely, a company-scoped user sees everything below (a rollup view) with the same badge on division-owned rows. Sibling divisions don't see each other's assets. The level guard is enforced server-side too — a direct API call with a department-level <code>orgId</code> is rejected with a 400.</li>
        </ul>
        <h3 style={h3Style}>Business Glossary</h3>
        <ul style={listStyle}>
          <li>Searchable dictionary of agreed-upon business terms.</li>
          <li>Group by category (Business, Technical, Regulatory, Metric) or alphabetically.</li>
          <li>Industry-specific seed terms based on your organization's industry.</li>
          <li>Approval workflow: Draft &rarr; Proposed &rarr; Approved &rarr; Deprecated.</li>
        </ul>
        <h3 style={h3Style}>Data Lineage</h3>
        <ul style={listStyle}>
          <li>Upstream / downstream data flow visualisation. Visualization view has a three-way toggle: <strong>Systems</strong> (system-to-system flows), <strong>Assets</strong> (auto-derived asset-to-asset edges), or <strong>Both</strong>.</li>
          <li><strong>Import dbt manifest</strong> &mdash; drop a dbt-generated <code>manifest.json</code>. Procela creates or matches a Data Asset for each model, source, seed, and snapshot, then derives asset-to-asset edges from <code>depends_on</code>. dbt tests in the manifest become Data Quality rules automatically (not_null &rarr; Completeness/NOT_NULL, unique &rarr; Uniqueness/UNIQUE, accepted_values &rarr; Validity/IN_SET, relationships &rarr; Consistency/CUSTOM).</li>
          <li><strong>dbt Cloud connections</strong> &mdash; configure account ID, job ID, and API token. Procela pulls the manifest for the latest successful run, on a polling schedule of your choice (Hourly / Daily / Weekly) or on demand via <em>Refresh now</em>. Last refresh time, status, and a relative "next in 4h" hint show in the table.</li>
          <li><strong>Stale-edge detection</strong> &mdash; auto-derived edges that haven't been re-seen by an import in 30 days are flagged with a STALE badge in the table and rendered as dashed lines in the visualisation. Manual edges are exempt.</li>
          <li>Re-imports are idempotent &mdash; assets, edges, and dbt-test rules are matched by stable identifiers and updated in place. Edges and rules removed from the manifest are deleted; user edits to a dbt-derived rule survive the next refresh.</li>
        </ul>
        <h3 style={h3Style}>Data Domains</h3>
        <ul style={listStyle}>
          <li>Logical groupings of data assets (e.g., Customer Data, Financial Data).</li>
          <li>Assign owner and stewards per domain.</li>
          <li>Option to auto-create a Data Stewardship Team when creating a domain.</li>
          <li>AI-generated domain suggestions based on your industry.</li>
          <li><strong>Criticality</strong> &mdash; mark a domain's business-criticality tier (Tier-1 = council-critical &hellip; Tier-4). Tier-1 domains are what the <strong>Council Scorecard</strong> measures for coverage &mdash; the share of your most critical domains that have a named owner.</li>
          <li><strong>Sub-domains.</strong> Nest a domain one level deep under a parent (set <em>Parent domain</em> on the form, or use <em>Suggest sub-domains</em> to have AI propose them). A sub-domain with no owner of its own can <em>inherit the parent's owner</em> in one click.</li>
          <li><strong>Navigating the left tree.</strong> The domain index shows each parent with its sub-domains indented beneath it. A parent that has sub-domains carries a <strong>&#9662;/&#9656; caret</strong> &mdash; click it to fold or unfold that parent, or use <strong>Collapse&nbsp;all / Expand&nbsp;all</strong> at the top of the index; your choice is remembered per organization. Names that are too long to fit clip with an ellipsis and show the full label on hover.</li>
        </ul>
        <h3 style={h3Style}>Data Quality</h3>
        <ul style={listStyle}>
          <li>Quality rules per asset / column with dimensions (completeness, accuracy, timeliness, etc.). The Add/Edit Rule form has a <strong>Column picker</strong> populated from the selected asset's columns, so a rule can target one specific column (the bound set) or the asset as a whole; each rule then measures exactly its own column. It also has a <strong>Rule Type</strong> selector &mdash; the five connector-measured types (NOT_NULL, UNIQUE, IN_SET, NUMERIC_RANGE, LENGTH_RANGE) with their parameter inputs, plus REGEX_MATCH / CUSTOM (simulated) and an explicit untyped option. Only a <em>typed</em> rule is measured &mdash; by the on-prem connector or a direct database Connection; an untyped rule stays at &ldquo;not measured&rdquo;. (Shortcut: on the Quality tab, expand an asset and use a column's Not-null / Unique quick-add buttons, which set the type for you.)</li>
          <li><strong>Find quickly.</strong> Both the <em>Quality</em> (assets) and <em>Rules</em> tabs have a free-text search box alongside the existing filters &mdash; search assets by name/description, or rules by rule name, asset, or column.</li>
          <li><strong>Weighted scoring</strong> rolls <em>measured</em> rule results up to an asset-level health score (and per column). An asset&rsquo;s <strong>Health reads 0%</strong> when no measured rule backs it &mdash; health is earned from measured quality, never a freshness or manual stand-in, and the Health column is read-only &mdash; while an individual column with no measured rule reads &ldquo;&mdash;&rdquo; on the 360 view. Measured results come from a local-file (CSV) upload; an <strong>on-prem connector</strong> &mdash; which runs the five pushdown-safe rule types (NOT_NULL, UNIQUE, IN_SET, NUMERIC_RANGE, LENGTH_RANGE) inside your network and pushes back real pass rates, no row values leaving the host; and a <strong>direct database Connection</strong>, which now runs those same five types as one aggregate query over the live database. Only REGEX_MATCH / CUSTOM (no portable engine support) still <em>simulate</em> &mdash; a clearly-labelled result that does not count toward health; an asset whose rules are <em>all</em> simulated reads 0% health and shows up in the rules-coverage filter&rsquo;s <strong>Est</strong> (&ldquo;rules but unmeasured&rdquo;) bucket.</li>
          <li>dbt tests imported via a manifest become rules automatically (templateId starts with <code>dbt:</code>). Edits to those rules persist across re-imports; removed tests delete their rule.</li>
        </ul>
        <h3 style={h3Style}>Orphan Assets</h3>
        <ul style={listStyle}>
          <li>Data assets that no process step references &mdash; candidates to either map to a step that uses them or retire. They carry an <strong>Unmapped</strong> badge on the catalog and are isolated by the <strong>Mapping &rarr; Unmapped</strong> filter on <strong>Data &rarr; Data Assets</strong> (<code>/data-assets?mapping=unmapped</code>); the same orphans also surface in Gap Detection.</li>
        </ul>
      </Card>

      {/* 6. Systems */}
      <Card padding={24} marginBottom={20}>
        <h2 id="help-systems" style={h2Style}>6. Systems</h2>
        <h3 style={h3Style}>Systems</h3>
        <ul style={listStyle}>
          <li>Register applications and platforms. Sidebar filter by type (ERP, CRM, GIS, etc.).</li>
          <li>Business criticality rating (High / Medium / Low) with filter.</li>
          <li>Clicking a system name opens the detail modal; inline editing is reserved for the Type column. Rename via the row's Edit pencil.</li>
          <li>Owner, Deputy Owner, and Operators (DAMA: Custodians) per system &mdash; the people on the hook day-to-day. Clicking any of those role badges opens the Role Detail drawer for that entity-attached role, so users see the same definition / responsibilities / required-skills view as for DAMA roles.</li>
          <li>Where Used panel shows every data asset, connection, and process touching the system. A Discussion (comments) and Activity section sit at the bottom of the modal.</li>
          <li><strong>Org scope and inheritance.</strong> Same rule as Data Assets — each system is owned by exactly one org (company or division), departments and teams can't own. The <em>+ Add system</em> button hides when the active scope is a non-owning level; rows whose owner doesn't match the active <em>Working in&hellip;</em> scope carry an <em>Owned by &lt;Org&gt;</em> badge and have their edit / delete affordances disabled with a switch-scope tooltip. The level guard is enforced server-side.</li>
        </ul>
        <h3 style={h3Style}>Connections</h3>
        <ul style={listStyle}>
          <li>Database, File Storage, API, Data Warehouse, and Spreadsheet connections.</li>
          <li>Test connection (TCP / HTTP probe) and Discover &mdash; for a configured direct-connect database (Postgres / MySQL / SQL Server / Oracle) Discover runs a <strong>real</strong> catalog scan of tables and columns, not sample data. From the Discover view, <strong>Reconcile to catalog</strong> matches each discovered table to an existing business Data Asset (suggested by name) or creates a new Bronze one and binds it &mdash; one-click confirm or per-row override.</li>
          <li>Many-to-many: a connection can serve multiple systems.</li>
          <li><strong>Use a Connection when Procela can reach the source.</strong> Credentials live server-side (encrypted), and Procela's backend makes live outbound calls for Test, Discover, data-quality rule execution, and lineage sampling. Cloud warehouses and internal databases exposed via VPN or PrivateLink belong here.</li>
        </ul>
        <h3 style={h3Style}>On-prem connectors</h3>
        <ul style={listStyle}>
          <li>Small container (<code>ghcr.io/datalign-technology/procela-connector:edge</code>) that runs <strong>inside your customer's network</strong> and ships catalog metadata back to Procela over outbound HTTPS. Use it when Procela cannot reach the source database — the classic "our security team won't open inbound firewall rules" case.</li>
          <li>Managed in <strong>Settings &rarr; Integrations &rarr; On-prem connectors</strong>. Admin creates a record with a name and the systems it reports for, receives a one-time 8-digit pairing code, and the operator running the container claims it on first boot. The connector heartbeats every 60 s and scans configured databases every 30 min by default.</li>
          <li><strong>Freshness states.</strong> Each row shows a live status: <em>Online</em> (heartbeat &lt; 30 min), <em>Stale</em> (30 min &ndash; 4 h), <em>Offline</em> (&gt; 4 h). Offline transitions fire an in-app notification once.</li>
          <li><strong>Adapters bundled today:</strong> Postgres, MySQL/MariaDB, SQL Server, and Oracle. Cloud warehouses are intentionally out of scope for the agent — they belong on the Connections path.</li>
          <li><strong>Click a connector row</strong> to open the detail drawer: rename, reassign systems, review the recent-activity timeline (paired, heartbeats, scans, ASSETS_REPORTED).</li>
          <li><strong>What crosses the wire.</strong> Only catalog metadata (table names, row counts, freshness timestamps, table comments). Connection strings, credentials, and row values never leave the on-prem host.</li>
          <li><strong>What Procela does with it.</strong> Reported tables either create new <em>Bronze</em>-tier Data Assets (which show up as Orphan Asset work items for stewards) or update an existing asset's <em>Synced N min ago</em> chip. Everything downstream (dashboards, digests, gap detection) reads the same asset table, so connector-sourced data blends in.</li>
          <li><strong>Safety rails.</strong> <code>/pair/claim</code> throttles at 10/min and 100/hr per IP. Tokens are <code>pct_</code>-prefixed and SHA-256 hashed at rest; the plaintext is shown once at claim time. Revoke immediately disables a token but keeps the row for audit.</li>
        </ul>
        <p style={pStyle}>
          <strong>Connection vs on-prem connector?</strong> If Procela can reach the source over the internet with a credential &mdash; use a <em>Connection</em>. If it can't (on-prem database, air-gapped VPC, regulated environment) &mdash; use an <em>on-prem connector</em>. An org can mix and match; the resulting Data Assets look identical downstream. See the FAQ section for the install commands.
        </p>
      </Card>

      {/* 7. Organizations */}
      <Card padding={24} marginBottom={20}>
        <h2 id="help-organizations" style={h2Style}>7. Organizations</h2>
        <p style={pStyle}>
          The "who" of the platform. The Organizations accordion gathers the four things that act on (or are acted on by) your data: the company tree itself, the humans, the AI agents, and the competencies those actors carry.
        </p>
        <h3 style={h3Style}>Structure</h3>
        <ul style={listStyle}>
          <li>Hierarchical company tree (company &rarr; division &rarr; department &rarr; team) that scopes every other page.</li>
          <li>Import from CSV / JSON, tree visualization, "Working in" selector in the header picks the active branch.</li>
          <li>The sidebar label is <em>Structure</em> but the page route is still <code>/organizations</code> and the browser tab reads "Organizations · Procela".</li>
          <li><strong>Deleting an org is a controlled blast.</strong> Clicking delete opens a dedicated dialog (not a generic confirm) that walks you through what cascades. The dialog opens with a red "This action cannot be undone" banner and a severity badge — <em>Small / Medium / Large / Catastrophic</em> — computed from the total entity count and number of child orgs. Every affected category (people, processes, data assets, systems, mappings, governance documents, controls, etc.) is listed with both the count and up to three sample names ("47 mappings — Bills→Customer Master, Outages→SCADA, +44 more") so you can see exactly what you're about to delete, not just a number. Each category gets a per-category action picker (<em>Delete</em> / <em>Move to…</em> / <em>Orphan</em>; orphan is only allowed for People and Processes), a "default for everything" picker that bulk-applies one action, a live tally at the bottom, and a type-<code>DELETE</code> confirmation gate. An <em>Export org snapshot</em> button in the footer downloads a JSON archive of every entity the delete would touch — recommended before any Large or Catastrophic delete as a recovery aid.</li>
        </ul>
        <h3 style={h3Style}>People</h3>
        <ul style={listStyle}>
          <li>Team members with app roles (Super Admin, Org Admin, Editor, Contributor, Viewer).</li>
          <li>Import from CSV. Columns: Name (required), Email, Role, Title, Org (optional). An <em>Org</em> value on a row lands that person in the named org — either a full path (<code>Tidewater Utilities &gt; Tidewater Electric &gt; Power Generation</code>) or a single unique name; rows without the column fall back to the "Default org" picked in the import dialog. The People export emits the same Org column so a single-file enterprise-wide round-trip preserves which org each person belongs to.</li>
          <li>Click any role chip on a person's profile to open the Role Detail drawer.</li>
          <li><strong>Filter by skill.</strong> The toolbar's <em>Skill</em> dropdown narrows the roster to people who hold a given competency — the workflow for staffing a new initiative or backfilling an unqualified activity. Combines with the existing governance-role and org-tree filters.</li>
          <li><strong>Skill gaps column.</strong> Shows the number of activities where this person is the Responsible owner but doesn't hold the required skills. Zero means they're fully qualified for every activity they're on; any non-zero value is a backlog item, and the cell tooltips with the activity names so you know what to address (assign someone else, or get the person the missing skills).</li>
        </ul>
        <h3 style={h3Style}>Agents</h3>
        <ul style={listStyle}>
          <li>AI agent registry for governance execution &mdash; pipelines, bots, service accounts.</li>
          <li>Agents can hold governance roles too (e.g., an automated DQ agent as Data Quality Analyst), which is why they sit alongside People rather than in a separate "automation" bucket.</li>
          <li><strong>Filter like People.</strong> The page carries the same org-tree sidebar (per-org counts and an &ldquo;All (N)&rdquo; row), a Search box, and a Governance Role filter, so you can narrow the registry by organization and by DAMA role. There&rsquo;s no App-role filter &mdash; agents are non-human actors and carry no application login role, only governance roles.</li>
        </ul>
        <h3 style={h3Style}>Skills</h3>
        <ul style={listStyle}>
          <li>Catalog of competencies attached to people. Seed standard DAMA-aligned skills with one click.</li>
          <li>The Role Detail drawer reads from this catalog to show "Skills typically needed" for each governance role &mdash; chips appear solid when the skill is in your org's catalog, dashed if not yet seeded.</li>
          <li><strong>Skills drive four cross-page workflows:</strong>
            <ul style={listStyle}>
              <li><strong>Qualified-person check.</strong> On a Process activity, if the responsible person's <code>skillIds</code> don't cover the activity's <code>requiredSkillIds</code>, an amber warning chip appears next to the skill picker spelling out which skills are missing. The same gap shows up as a "Skill gaps" column on the People table.</li>
              <li><strong>Find people by skill.</strong> A skill filter on the People page lets you narrow the roster to everyone who holds a given competency &mdash; useful when staffing a new initiative or backfilling an unqualified assignment.</li>
              <li><strong>Recommended role assignees.</strong> The Role Detail drawer surfaces a "Best-matching people" list, ranked by how many of the role's required skills each person already holds (case-insensitive name match).</li>
              <li><strong>Skill-gap report on the dashboard.</strong> The Skill Gaps section ranks the org's most under-staffed required skills (required-by-activities vs held-by-people), with critical "no coverage" calls flagged in red.</li>
            </ul>
          </li>
        </ul>
      </Card>

      {/* 8. Governance */}
      <Card padding={24} marginBottom={20}>
        <h2 id="help-governance" style={h2Style}>8. Governance</h2>
        <h3 style={h3Style}>Governance Program (on Get Started)</h3>
        <ul style={listStyle}>
          <li>The program has <strong>no page of its own</strong> &mdash; its four-phase tracker, lifecycle, and Next Actions live on the <strong>Get Started</strong> hub (Section 1), as the <strong>Govern</strong> and <strong>Operate</strong> stages. Every check reflects work done elsewhere and deep-links there; the stage you're on is named by the stage line (Stage X of 4) and each carries a plain <strong>"n / m done" count</strong>, not a percentage. (The old <code>/governance-program</code> URL redirects to <code>/setup</code>.)</li>
          <li><strong>No single overall percentage.</strong> A live roll-up of every check could move <em>down</em> when your catalog changed (e.g. adding an unowned domain), which read like a regression. Get Started shows honest axes instead: the <strong>lifecycle status</strong> (a badge + a Planning &rarr; Active &rarr; Paused &rarr; Completed strip) and each stage's own count.</li>
          <li><strong>Foundation authoring lives on its own page.</strong> Scope (in / out), guiding principles, and operating model are edited on <strong>Governance &rarr; Foundation</strong>; the Govern stage's <em>Governance foundation</em> item deep-links there. Same program record — the checks update as you save.</li>
          <li><strong>Governed lifecycle:</strong> the program status (Planning &rarr; Active &harr; Paused &rarr; Completed, with explicit Reopen) is changed from the <strong>lifecycle bar on Get Started</strong>, can only be changed by an admin / program owner, follows a fixed transition path (no backward slides or skips), and every change is written to the audit log with the actor and an optional reason. Phase 1 (Foundation) must be complete before the program can go Active &mdash; the <strong>Launch button is disabled until it is</strong> &mdash; and launching with Phases 2&ndash;4 incomplete pops a confirmation listing exactly what's missing and records it as an early launch. Because Foundation is the prerequisite, you can also <strong>launch from the Governance &rarr; Foundation page</strong> once it's complete. The actual go-live is captured as a <strong>Launched</strong> date (set the first time it goes Active, kept through pause/resume) and shown next to the status. A program marked <strong>Completed</strong> still counts as launched, so completing it never drops the tracker back below done.</li>
        </ul>
        <h3 style={h3Style}>Governance Groups</h3>
        <ul style={listStyle}>
          <li>Hierarchical governance bodies: Council &rarr; Office &rarr; Committee &rarr; Stewardship Teams &rarr; Working Groups &rarr; Communities of Practice.</li>
          <li>Generate the standard DAMA structure with one click. Explore Recommendations suggests additional groups based on your data domains.</li>
          <li>Per group: an Expected Roles panel lists the governance roles the group should have, the required vs optional split, and current fill status. Click any role label to open the Role Detail drawer.</li>
          <li><strong>Org-aware fill status.</strong> A role counts as filled when it's held anywhere in the org — the same scope the Governance Roles page assigns at — not only by a current member of this group. Each holder chip shows their relationship to this body: teal = on the group, amber = holds the role org-wide but isn't a member yet, with an inline <strong>+ add to group</strong> to bring them on. So a role assigned on the Roles page is recognised here, and assigning here writes the same org-scoped assignment — the two pages stay consistent in both directions.</li>
          <li><strong>Domain assignments inline.</strong> For roles where the question is meaningful — <em>Data Owner</em>, <em>Domain Owner</em>, <em>Data Steward</em>, <em>Domain Steward</em>, <em>Business Data Steward</em>, <em>Data Architect</em> — each holder gets a sub-line under the chip strip listing the data domains they own and/or steward (e.g. "<em>Alice:</em> owns Customer, Billing · stewards Outage"). If a holder of a domain-scoped role has no domains attached at all, the line renders "<em>no data domains assigned</em>" in red so the gap is visible without leaving the page. Read straight from the DataDomain entity — assigning or removing a domain owner/steward elsewhere (Data Domains page) updates this line on the next fetch.</li>
          <li>Two remove actions are distinct: the <strong>x on a role chip</strong> removes that specific role assignment; <strong>Remove from group</strong> in the members table removes the person from the group entirely (their role assignments survive at the org level).</li>
          <li><strong>Open full composition →</strong> on any selected group jumps to the Group Composition page (<code>/governance-groups/:id</code>) &mdash; one cohesive surface that combines members, expected-role gaps, decision rights this body owns, policies tied to it via member roles, the calendar cadence, and a snapshot of RACI assignments. Each role chip shows the typical RACI letter(s) the role holds on common decisions, so you can see at a glance what each role is accountable / responsible / consulted / informed for without opening the drawer.</li>
          <li><strong>Group role vs governance role.</strong> These are two independent things and the members table calls it out: a person's <em>group role</em> (Chair, Member, Secretary…) is just their seat on this body and has no RACI effect; their <em>governance roles</em> (Data Owner, Steward, CDO…) are the org-wide DAMA roles that drive RACI and ownership. Someone can be a group Member with no governance role, or hold a governance role without sitting on any group.</li>
        </ul>
        <h3 style={h3Style}>Roles (with RACI Matrix tab)</h3>
        <ul style={listStyle}>
          <li>Single page with two tabs: <strong>Assignments</strong> and <strong>RACI Matrix</strong>. RACI is a view derived from role assignments, so editing and inspection live together.</li>
          <li><strong>Assignments tab.</strong> Role-first catalog of DAMA governance roles (CDO, Data Governance Lead, Data Owner, Stewards, etc.). The left sidebar lists <em>every</em> role with its live holder count &mdash; filled or not &mdash; and clicking one filters the page to that role. The main area always shows the full role slate: filled rows list the holders inline; unfilled rows are flagged with an <em>Unfilled</em> marker and an inline <em>+ Assign</em>. A search box matches role label, person, or organization. This page tells the same story as the Governance Groups expected-role slate &mdash; the roles always exist; assignment is what varies.</li>
          <li><strong>Collapsible categories &amp; roles.</strong> Roles are grouped under <em>Executive</em>, <em>Business</em>, and <em>Technical</em>; each category header has a chevron that collapses the whole section. Individual role cards have their own chevron that hides the holder list while keeping the header visible so unfilled / required gaps still surface. <em>Expand all</em> / <em>Collapse all</em> controls at the top of the catalog flip everything at once. Defaults to fully expanded; when a single-role filter is active the controls hide since there's only one card to show.</li>
          <li><strong>Typed scope on every holder row.</strong> Each holder shows a small kind tag next to their scope &mdash; <em>ORG</em> (indigo), <em>DOMAIN</em> (green), <em>SYSTEM</em> (red), <em>ASSET</em> (blue), or <em>UNKNOWN</em> (amber) &mdash; followed by the resolved name. So a Data Architect attached to the Customer Data domain reads as <code>DOMAIN: Customer Data</code> instead of a raw UUID, and a System Owner reads as <code>SYSTEM: SCADA</code>. An <em>UNKNOWN</em> tag with "unresolved" copy means the scoped entity has been deleted &mdash; the same dangling-reference signal we use on the Data Mapping page.</li>
          <li><strong>Per-domain gap rows.</strong> For domain-scoped roles (<em>Data Owner</em>, <em>Domain Owner</em>, <em>Data Steward</em>, <em>Domain Steward</em>, <em>Business Data Steward</em>, <em>Data Architect</em>), each role card has a footer panel listing every data domain in the org that currently has no holder of this role scoped to it. So if Tidewater has <em>Customer Data</em>, <em>Operational Data</em>, and <em>Regulatory Data</em>, and only Customer Data has a Data Owner, the other two appear as amber chips under <em>Unfilled for 2 domains</em>. Mirrors the per-person "no data domains assigned" line we ship on the Governance Groups page, just from the role-side perspective.</li>
          <li>Click any role chip anywhere in the app to open the <strong>Role Detail drawer</strong> &mdash; plain-language summary, day-to-day responsibilities, typical RACI authority, groups that need the role, current assignees in your org, and required skills.</li>
          <li><strong>Best-matching people.</strong> The Role Detail drawer surfaces a ranked list of people who already hold the most of the role's required skills (case-insensitive name match against the org's Skills catalog). Each row shows a <em>matched / required</em> score chip — green ≥ 0.75, blue ≥ 0.5, amber below — and clicking a row jumps to that person's profile. Use this when a role's <em>Unfilled</em>: the drawer tells you who in the org is already closest to qualified rather than guessing.</li>
          <li>The drawer also covers <strong>entity-attached roles</strong> &mdash; System Owner, Deputy System Owner, System Custodian, Data Asset Owner / Steward, Data Domain Owner / Steward. The drawer shows a "Per system / asset / domain" scope badge so users understand two people can both hold the same entity-attached role for different entities without it being a RACI violation.</li>
          <li><strong>RACI Matrix tab.</strong> Responsibility assignments per process activity: Responsible, Accountable, Consulted, Informed. Auto-derived from process / asset ownership and governance group membership; click a cell to cycle R &rarr; A &rarr; C &rarr; I &rarr; clear as a manual override. Validation warnings surface RACI rule violations (no R, no A, multiple A's). Export to CSV / Excel / JSON respects active filters and hide-empty-columns setting.</li>
          <li>Old <code>/raci</code> deep links still work &mdash; they redirect to the RACI tab.</li>
        </ul>
        <h3 style={h3Style}>Decision Rights</h3>
        <ul style={listStyle}>
          <li>Document who Decides, Recommends, Approves, and is Informed for each governance decision.</li>
          <li>Sidebar of categories with counts; search box matches decision name, description, decider, or escalation path.</li>
          <li>Rows are collapsible: default view shows decision + category + decider, click a row to reveal the full R / A / C / I and escalation panel.</li>
          <li>10 seed decisions (approve policy, grant exception, close issue, etc.) ship out of the box.</li>
        </ul>
        <h3 style={h3Style}>Governance Documents (was Policies)</h3>
        <ul style={listStyle}>
          <li>The unified home for every formal governance document with a lifecycle — <strong>Charter</strong> (program scope / principles), <strong>Framework</strong> (overarching structure), <strong>Standard</strong> (naming conventions / data type rules), and <strong>Policy</strong> (the rule-shaped subset). A segmented filter at the top of the page lets you focus on one type or see all.</li>
          <li>Each row carries a <em>documentType</em> badge plus the existing status, review cadence, owner, and category. Codes are auto-generated and per-type — <code>CHA-001</code>, <code>FRW-001</code>, <code>STD-001</code>, <code>POL-001</code> — so the code itself tells you what kind of document you're looking at.</li>
          <li><strong>Controls hang off Policies only.</strong> The expanded controls panel only opens for rows with <em>documentType: Policy</em> — charters and frameworks don't have rule-shaped controls and the panel stays hidden for them.</li>
          <li>Controls have a type (Preventive / Detective / Corrective) and an automation mode (Human / Agent / Hybrid).</li>
          <li>This used to be called <em>Policies</em> and was scoped to rules only. It now lives at <code>/governance-policies</code> (the route the sidebar links to); the <code>/governance-documents</code> alias also resolves here. Sidebar label is now <strong>Documents</strong> under the Governance section.</li>
          <li>If you previously ran the <em>Generate governance processes</em> wand, it used to seed 15 "governance Data Assets" — Charter, Policies, Standards, Glossary, Domain Catalog, etc. A one-time startup migration moves the four real documents (Charter, Data Policies, Data Standards, Access Control Policies) into Governance Documents with the right type, and deletes the rest because they were either duplicates of existing entities (Glossary, Domains, Lineage, DQ Rules, Issues, Tasks) or generated outputs (reports, communications) that were never really stored data.</li>
        </ul>
        <h3 style={h3Style}>Documentation (Manual + Procedures)</h3>
        <ul style={listStyle}>
          <li>Single page with two tabs &mdash; the Manual answers "what does each role do?", the Procedures tab answers "how do I do task X?".</li>
          <li><strong>Manual tab.</strong> Role-specific runbooks for the 10 governance roles, with daily / weekly / monthly / quarterly activities and escalation paths.</li>
          <li><strong>Procedures tab.</strong> Step-by-step SOPs for common governance activities. 5 seed SOPs (onboard data asset, quality incident, access request, escalation, quarterly review).</li>
          <li>Old <code>/operations-manual</code> and <code>/sops</code> deep links still work &mdash; they redirect to the right tab.</li>
        </ul>
        <h3 style={h3Style}>Governance Calendar</h3>
        <ul style={listStyle}>
          <li>Recurring events (Council meetings, Committee syncs, stewardship huddles) with cadence options weekly through annual.</li>
          <li>Auto-generates governance tasks per attendee when an event occurs.</li>
        </ul>
        <h3 style={h3Style}>Tasks &amp; Issues</h3>
        <ul style={listStyle}>
          <li><strong>Tasks</strong> &mdash; workflow states (Draft &rarr; Open &rarr; In Progress &rarr; Pending Review &rarr; Completed), priority, assignee, due dates.</li>
          <li><strong>Issues</strong> &mdash; 9 types (Metadata, Data Quality, Classification, Ownership, Policy, Access, Lineage, Compliance, Workflow), severity levels.</li>
          <li>Steward onboarding: auto-creates 4 tasks when a steward role is assigned (7 / 14 / 21 / 90-day milestones).</li>
          <li><strong>Automatic overdue detection.</strong> A background sweep runs every hour and writes a <em>Task overdue: &lt;title&gt;</em> warning into the notifications bell for the assignee of any OPEN / IN_PROGRESS / PENDING_APPROVAL task whose due date has slipped. It's idempotent (the row is stamped after firing) and re-arms when the due date is pushed forward or the task cycles back to OPEN. Unassigned tasks fire org-wide. <code>POST /api/v1/governance-tasks/sweep-overdue</code> drives the same sweep synchronously.</li>
          <li><strong>Weekly digest scheduler.</strong> The same in-app scheduler fires the gap-delta digest (see below) once a week on the first tick after Sunday 23:00 UTC. The last-fired timestamp is persisted, so a restart in the firing window doesn't double-notify. All background loops can be disabled via <code>PROCELA_DISABLE_SCHEDULERS=1</code> — set it on every replica except the one designated to run scheduled work, so jobs fire once, not once per replica.</li>
        </ul>
        <h3 style={h3Style}>Governance Exceptions</h3>
        <ul style={listStyle}>
          <li><strong>A register of time-boxed waivers at Governance &rarr; Operate &rarr; Exceptions.</strong> An exception records that a policy or control has been deliberately waived for a stated reason until an expiry date &mdash; the auditable alternative to a control quietly going unmet.</li>
          <li><strong>Grant one</strong> with a title (what is being waived), an expiry date, and an optional reason. New exceptions start Active.</li>
          <li><strong>Past-expiry is the signal.</strong> An exception still Active after its expiry date is flagged in red and counted at the top of the page &mdash; those are what the governance council watches, and they feed the <em>Exceptions past expiry</em> measure on the Council Scorecard. Renew (reopen with a new date) or Close each one.</li>
          <li><strong>Close / reopen / delete.</strong> Close an exception once the underlying gap is fixed; reopen if it recurs. Granting and changing exceptions is limited to users with governance-write permission.</li>
        </ul>
        <h3 style={h3Style}>Dependency Enforcement</h3>
        <p style={pStyle}>
          Governance pages show prerequisite banners when prior steps haven't been completed.
          For example, the RACI page shows "Create domains and governance groups first" until those exist.
        </p>
      </Card>

      {/* 9. Insights */}
      <Card padding={24} marginBottom={20}>
        <h2 id="help-insights" style={h2Style}>9. Insights</h2>
        <p style={pStyle}>
          Cross-cutting exploration and review surfaces that read across every part of the
          catalog. Promoted out of Governance into their own <strong>Insights</strong> sidebar
          section &mdash; grouped into <strong>Explore</strong> (Enterprise View, Analysis, Data
          Mapping, Process &harr; Data Map) and <strong>Review</strong> (Reports, Council Scorecard,
          Gap Detection, Audit Log).
        </p>
        <h3 style={h3Style}>Enterprise View</h3>
        <ul style={listStyle}>
          <li>Single pane of glass across processes, systems, data assets, domains, and people. Filters by view preset (Process &rarr; System &rarr; Data, Governance, Ownership, Lineage, etc.) to focus on one relationship at a time.</li>
          <li><strong>Cards / Diagram</strong> toggle &mdash; the diagram lays nodes out as horizontal swimlanes with edges between lanes so you can see how the org is wired together at a glance. Cards is the dense alternative.</li>
          <li>Click any node to run impact analysis &mdash; the sidebar lists every entity connected to your selection (direct and transitive), and unrelated nodes fade out. Use this to plan changes ("if we deprecate System X, which processes are affected?").</li>
          <li><strong>What happened to Control Tower?</strong> The operational dashboard view folded in here. Old <code>/control-tower</code> deep links redirect to Enterprise View. Future updates may add a dedicated "Health" preset that mirrors the old dashboard.</li>
        </ul>
        <h3 style={h3Style}>Analysis (cube)</h3>
        <ul style={listStyle}>
          <li>Drag-and-drop pivot builder. Drag a dimension into <strong>Rows</strong>, another into <strong>Columns</strong>; the grid below shows how many records connect each pair. Seven dimensions ship: Systems, Data Assets, Domains, Processes, Roles, People, Connections. Reachable from the sidebar (<strong>Insights</strong> &rarr; Analysis) and from Dashboard <strong>Quick Actions</strong>.</li>
          <li><strong>Starter pivots.</strong> Before you've configured anything, the empty state offers one-click examples (Data Assets by System, Roles by Person, Assets by Domain, Processes by System) so you can see a result immediately instead of facing a blank palette.</li>
          <li><strong>Sub-group.</strong> Drag a second dimension into either zone to create a nested grouping (max 2 per axis). The grid renders the parent label with a merged cell spanning all its sub-rows / sub-columns, so e.g. <em>Systems &gt; Data Assets</em> on rows shows each system once with its assets indented underneath.</li>
          <li><strong>Pivot.</strong> The pivot button between the Rows and Columns zones swaps everything in one click — useful when you want to flip a tall report into a wide one without re-dragging.</li>
          <li><strong>Drill down.</strong> Click any cell count to open a side panel listing the underlying records (asset facts, role assignments, mappings, ownership rows, etc.).</li>
          <li><strong>Filter.</strong> Click any row label or column header to add that value as a filter; chips appear above the grid and can be removed individually. Each filter narrows the cube to facts that match that dim/value.</li>
          <li><strong>Saved reports.</strong> Save your (rows / columns / filters) configuration with a name and description. Reports are org-visible; only the owner can rename or delete their own. The active dims are also mirrored to the URL so direct links are shareable without saving. Saved pivots live on this page; for the new schema-driven Report Builder catalog, see <strong>Review &rarr; Reports &rarr; My Reports</strong>.</li>
          <li><strong>Export.</strong> The full grid exports to CSV, Excel, JSON, or PDF (browser-print) with row/column totals included. Sub-group labels are flattened with “ / ” separators in the export.</li>
        </ul>
        <h3 style={h3Style}>Reports</h3>
        <ul style={listStyle}>
          <li>The <strong>Reports</strong> page is the report catalog + <strong>Report Builder</strong> — build, save, and open reports against Procela's data model. It used to carry <em>Executive Report</em> and <em>Scorecard</em> tabs; both were removed, so there's no tab bar any more. (Cube pivots live on their own page at <strong>Explore &rarr; Analysis</strong>.)</li>
          <li><strong>My Reports + Report Builder.</strong> Build a report against Procela's logical data model — pick a starting entity (Processes, Data Assets, Systems, People, Mappings, Domains, Roles, Skills, Organizations), choose columns directly on that entity <em>or</em> joined columns from a related entity (e.g. <em>Responsible Person → Name</em>, <em>Required Skills → Name</em>), add filters with op-aware value inputs (enum dropdowns, number coercion), set sort, and preview live as you type. Save with a name and visibility (Shared with org / Private to me); saved reports show up on the My Reports tab with metadata (primary entity, column count). Edit at <code>/reports/builder/:id</code>; new at <code>/reports/builder</code>.</li>
          <li><strong>Gap Detection.</strong> Cross-cutting view of unmapped activities, ungoverned assets, <strong>ungoverned columns</strong> (a column an asset is bound to but has no quality rule &mdash; coverage you claimed but never measure), ownership gaps, low-health assets, unowned domains, orphaned assets, unlinked assets, unassigned people, and duplicate asset names. Drill-down everywhere: the four summary cards at the top (Total Gaps / Critical / Warning / Informational) scroll to the first matching section when clicked; each row inside a section is a hyperlink that opens the affected item on its source page so you can fix the gap in one click — Unmapped Activity rows jump to the Process Catalog with the node highlighted, asset rows jump to Data Assets, person rows open the person's profile, and so on.</li>
        </ul>
        <h3 style={h3Style}>Council Scorecard</h3>
        <ul style={listStyle}>
          <li><strong>A monthly governance report at Insights &rarr; Review &rarr; Council Scorecard.</strong> Each child division reports four measures that roll up to an enterprise total, plus two narrative sections &mdash; the council's per-division report card.</li>
          <li><strong>The four measures are auto-derived from live data:</strong> Tier-1 coverage (share of Tier-1 domains with a named owner), Classification (share of assets with a sensitivity classification), Open issues over 30 days, and Exceptions past expiry. Each division's row is computed over its own subtree; the <strong>Enterprise</strong> row is a true rollup &mdash; computed across the parent's whole subtree, not an average of the divisions. Status per row (On track / Behind / At risk) is derived from the measures against their targets; a division with nothing to assess yet &mdash; no governed domains, no classified assets, and no open issues or exceptions &mdash; reads a neutral <strong>No data</strong> rather than being flagged Behind.</li>
          <li><strong>Targets are configurable per tenant.</strong> The four thresholds &mdash; coverage %, classification %, max aged open issues, max past-expiry exceptions, and the open-issue age in days &mdash; ship with sensible defaults (80 / 70 / 0 / 0 / 30) and can be tuned by an org admin under <strong>Settings &rarr; Data &rarr; Council Scorecard targets</strong>. A change re-derives the live scorecard on its next load; already-saved snapshots keep the targets they were frozen with. Set on a company org, the bar applies to its divisions.</li>
          <li><strong>Two narrative sections are auto-drafted:</strong> &ldquo;What moved this month&rdquo; from the last 30 days of governance activity (audit log), and &ldquo;For the council&rdquo; from current risk facts (Tier-1 domains without an owner, exceptions past expiry, unclassified assets). Both carry an <em>auto-derived</em> chip until edited.</li>
          <li><strong>Edit &amp; override (CDO / Data Governance Lead only).</strong> Those two roles &mdash; or an org admin &mdash; can override any derived cell or the narrative. Overrides are per-cell: the machine value is preserved underneath and an overridden cell is marked, so the council always sees what was adjusted. A cell can be reset back to its derived value.</li>
          <li><strong>Save versions.</strong> <em>Save snapshot</em> freezes the current derived-plus-overridden scorecard as an immutable version for the period &mdash; one click straight from the read-only view, no need to enter edit mode first (the <em>Publish snapshot</em> button does the same from inside Edit &amp; override). If a snapshot for that period already exists, Procela asks whether to <strong>Replace existing</strong> (overwrite that version in place, keeping its identity but refreshing the numbers) or <strong>Save as a new snapshot</strong> (keep both, as a separate dated version). The version-history panel reopens any past month read-only. Saving, replacing, and editing are recorded in the audit log.</li>
        </ul>
        <h3 style={h3Style}>Process &harr; Data Map</h3>
        <ul style={listStyle}>
          <li>A bipartite visualization of which activities depend on which data assets, drawn as two columns with mapping edges between them &mdash; the graph view of the <em>Data Mapping</em> table. Sidebar: <strong>Insights &rarr; Explore &rarr; Process &harr; Data Map</strong> (<code>/processes/data-map</code>). Governance-domain activities are hidden by default; toggle them in with the include-governance control.</li>
        </ul>
        <h3 style={h3Style}>Audit Log</h3>
        <ul style={listStyle}>
          <li>The full, queryable trail of every change &mdash; who did what to which entity and when. Filter by organization, entity type / id, or user, cap the result size, and export to CSV for a compliance reviewer. Sidebar: <strong>Insights &rarr; Review &rarr; Audit Log</strong> (<code>/audit-log</code>). Every row is hash-chained to the previous one; the <em>Verify integrity</em> action (see Security &amp; Account) walks the chain and flags any tampering.</li>
        </ul>
      </Card>

      {/* 10. Security & Account */}
      <Card padding={24} marginBottom={20}>
        <h2 id="help-security" style={h2Style}>10. Security &amp; Account</h2>
        <p style={pStyle}>
          Procela ships with a layered sign-in stack — federated SSO, second-factor authentication, brute-force defences, and admin controls for credential lifecycle. Most of these are configurable per deployment; the defaults are sensible for a prototype but production deployments will want to set the env vars called out below. All settings below live under <strong>Settings</strong> unless noted; the credential-lifecycle admin actions live on the Person detail page.
        </p>

        <h3 style={h3Style}>Sign-in providers</h3>
        <ul style={listStyle}>
          <li><strong>Dev Mode</strong> (default) — email + optional name, no credential check. For local development only; production refuses to start with a warning if it's still active.</li>
          <li><strong>Local credentials</strong> — email + password stored on the Person record as Argon2id hashes. Includes forgot-password by email, admin-set passwords, forced password change on first login, and a one-click <em>Migrate everyone to Local</em> action that generates temporary passwords for distribution.</li>
          <li><strong>OIDC</strong> (Microsoft Entra ID, Okta, generic) — Authorization Code + PKCE flow, JWKS-verified id_tokens, multi-IdP per install. Admins add and rotate providers in <strong>Settings &rarr; Authentication</strong>. Each provider can be scoped to specific email domains so the login page only offers the right buttons for the user typing their address.</li>
          <li><strong>SAML 2.0</strong> — SP-initiated single sign-on for ADFS, Shibboleth, PingFederate, and any IdP that speaks SAML. Configured via <code>SAML_ENTRY_POINT</code>, <code>SAML_ISSUER</code>, <code>SAML_IDP_CERT</code>, and <code>SAML_CALLBACK_URL</code>. The IdP can import Procela's SP metadata directly from <code>GET /api/v1/auth/saml/metadata</code> — entity ID, ACS, and both SLO bindings are declared there.</li>
        </ul>

        <h3 style={h3Style}>Two-step verification (TOTP)</h3>
        <p style={pStyle}>
          Open <strong>Settings &rarr; Two-step verification</strong> and click <em>Set up two-step verification</em>. Procela renders a QR code plus the underlying secret; scan it with Google Authenticator, 1Password, Authy, or any TOTP app, then enter the 6-digit code to confirm enrolment. On success you get a one-time display of <strong>10 backup codes</strong> — save these somewhere safe (the panel offers a download button); they're the only way to sign in if you lose your authenticator. A nudge appears when fewer than 3 codes remain so you can regenerate before you're locked out.
        </p>
        <p style={pStyle}>
          Once enrolled, every password sign-in is held back until you produce a TOTP code (or a backup code) on the prompt that follows. Admins can reset another user's enrolment on the Person detail page <em>Security</em> panel; the user is then forced through enrolment again on their next sign-in.
        </p>

        <h3 style={h3Style}>Security keys (WebAuthn / FIDO2)</h3>
        <p style={pStyle}>
          Hardware keys (YubiKey, Titan, Feitian) and platform authenticators (Touch ID, Windows Hello, Android fingerprint) work as either a second factor alongside TOTP <em>or</em> a passwordless first factor. Register a key under <strong>Settings &rarr; Two-step verification &rarr; Security keys</strong> — Procela asks for a friendly label so you can tell devices apart later. You can register multiple keys.
        </p>
        <ul style={listStyle}>
          <li>At sign-in, the password prompt offers <em>Sign in with a security key</em> — picking it runs the WebAuthn discoverable-credential ceremony and skips email + password entirely.</li>
          <li>If you have both TOTP and a security key enrolled, either one satisfies the MFA gate; the prompt at sign-in lets you pick.</li>
          <li>Admins can clear all registered keys for a user from the Person detail page <em>Security</em> panel.</li>
        </ul>

        <h3 style={h3Style}>Active sessions</h3>
        <p style={pStyle}>
          <strong>Settings &rarr; Active sessions</strong> lists every device or browser you're signed in from. Each row shows the device hint (parsed from the User-Agent), the IP at sign-in, the auth provider, and a relative "last used" timestamp. Your current session is tagged with a <em>This device</em> badge.
        </p>
        <ul style={listStyle}>
          <li><em>Revoke</em> on a single row invalidates that session's refresh token — that device gets booted to the login screen on its next API call. Other devices keep working.</li>
          <li><em>Sign out everywhere</em> kills every session including the one you're on. Use this if you've lost a device or want a clean slate.</li>
          <li>Refresh tokens are bound to the IP subnet (<code>/24</code> for IPv4, <code>/64</code> for IPv6) and User-Agent they were minted with — a stolen refresh token replayed from a different network is rejected automatically.</li>
          <li>Refresh tokens rotate on every use: when your access token expires and the client renews it, the old refresh token is revoked and a new one issued. A stolen token is only useful until the legitimate client next refreshes.</li>
        </ul>

        <h3 style={h3Style}>Account lockout &amp; CAPTCHA</h3>
        <p style={pStyle}>
          Three layers of brute-force defence sit in front of the credential verifier:
        </p>
        <ul style={listStyle}>
          <li><strong>IP rate limiter</strong> — 5 sign-in attempts per minute per (IP, email) pair, 20 per hour. Blocks bursts from one source.</li>
          <li><strong>Per-account lockout</strong> — 10 failed attempts inside a 30-minute window locks the account for 30 minutes. Catches distributed credential-stuffing where each attempt comes from a different IP. Defaults adjustable via <code>LOCKOUT_THRESHOLD</code> / <code>LOCKOUT_WINDOW_MS</code> / <code>LOCKOUT_DURATION_MS</code>. Admins can clear a lockout immediately from the Person detail page <em>Security</em> panel after positively identifying the user via another channel.</li>
          <li><strong>CAPTCHA challenge</strong> — after 3 failures from one IP in 15 minutes, every subsequent sign-in from that IP must include a verified CAPTCHA token. Procela uses hCaptcha when <code>HCAPTCHA_SITE_KEY</code> + <code>HCAPTCHA_SECRET</code> are set; without them an "I'm not a robot" checkbox stands in for dev testing.</li>
        </ul>

        <h3 style={h3Style}>Idle-session timeout</h3>
        <p style={pStyle}>
          After <code>VITE_IDLE_TIMEOUT_MINUTES</code> of no mouse, keyboard, scroll, or touch activity (default 30; SOC 2 / HIPAA controls typically want 15) Procela signs you out automatically — even if your access token is still valid. A one-minute warning banner with a <em>Keep me signed in</em> button precedes the actual logout. The countdown is shared across browser tabs, so activity in any tab keeps every Procela tab alive.
        </p>

        <h3 style={h3Style}>Per-org role assignments (admins)</h3>
        <p style={pStyle}>
          A Person can hold a different role in different orgs — Process Owner in Operations, Viewer in Finance, ORG_ADMIN in their own department. On the Person detail page, every assigned-org chip carries an inline role pill. An asterisk on the pill indicates the role is inheriting from the person's default; clicking opens a dropdown where you can set a per-org override or revert. Switching the <em>Working in&hellip;</em> scope in the header re-mints your access token with the role for the new org so authorisation gates update immediately.
        </p>

        <h3 style={h3Style}>SCIM 2.0 provisioning (IdP admins)</h3>
        <p style={pStyle}>
          Procela exposes SCIM 2.0 endpoints under <code>/scim/v2/</code> so Microsoft Entra, Okta, and other identity providers can push user lifecycle events automatically — create on hire, deactivate on offboard, role updates as people move teams. The IdP authenticates with a long-lived bearer token configured via <code>SCIM_BEARER_TOKEN</code>; paste the same value into both Procela and the IdP's provisioning config. Supported resources are <code>/Users</code> and <code>/Groups</code> with full filter / PATCH / soft-delete semantics. When the token isn't set, every SCIM request returns 401.
        </p>

        <h3 style={h3Style}>Reset everything — start over (super admins)</h3>
        <p style={pStyle}>
          Below the Backup & Restore card on the Settings page, super admins
          see a <em>Reset everything</em> control that performs a true factory
          reset: every organization, person, process, data asset, system,
          mapping, governance record, comment, and audit-log entry is deleted.
          The next sign-in starts the onboarding wizard for a brand-new
          organization. The confirmation phrase is the literal word{' '}
          <code>RESET</code>; the panel also surfaces a one-click <em>Export now</em>{' '}
          shortcut so you can save a recovery backup before nuking anything.
          A single <code>ALL_DATA_RESET</code> audit entry is written
          immediately after the wipe so the reset itself is traceable.
        </p>

        <h3 style={h3Style}>GDPR — right to be forgotten (admins)</h3>
        <p style={pStyle}>
          The Person detail page <em>Security</em> panel has a <em>Forget person&hellip;</em> action that runs the GDPR Article 17 cascade. The Person record is deleted and every reference across the catalog — ownership, stewardship, group membership, authored comments, role assignments — is scrubbed. Audit log entries authored by that user are <em>tombstoned</em>, not deleted, so the action history survives but the personal identifier is replaced with <code>[deleted]</code>. The confirmation modal requires you to type the literal phrase <code>FORGET &lt;email&gt;</code> to defend against muscle-memory triggers. The response summarises how many stores and rows were touched.
        </p>

        <h3 style={h3Style}>Audit log integrity</h3>
        <p style={pStyle}>
          Every entry on the Audit Log carries a SHA-256 hash chaining it to the previous entry's hash. The <em>Verify integrity</em> button at the top of <strong>Insights &rarr; Audit Log</strong> walks the chain on demand: green means no entry has been altered, reordered, inserted, or deleted since it was written; red points at the first broken row so you can investigate. The chain survives the GDPR redaction pass because hashes are re-computed from the first modified entry onward.
        </p>

        <h3 style={h3Style}>At-rest encryption for secrets</h3>
        <p style={pStyle}>
          TOTP secrets, OIDC client secrets, and SMTP passwords can all be stored encrypted at rest. Set <code>MFA_ENCRYPTION_KEY</code> (32+ chars random) for the local AES-256-GCM backend, or <code>KMS_PROVIDER=aws-kms|azure-kv|gcp-kms</code> with the matching cloud config for envelope encryption via AWS KMS, Azure Key Vault, or GCP KMS. To put an encrypted SMTP password or OIDC client secret in <code>.env</code>, POST the plaintext to <code>/api/v1/auth/encrypt-secret</code> (admin-only) and paste the <code>enc:v1:&hellip;</code> envelope it returns. Procela decrypts at boot.
        </p>
      </Card>

      {/* 11. Cross-cutting Features */}
      <Card padding={24} marginBottom={20}>
        <h2 id="help-cross-cutting" style={h2Style}>11. Cross-cutting Features</h2>
        <p style={pStyle}>
          A handful of components show up on every detail page so the patterns stay the same as you move around the app.
        </p>

        <h3 style={h3Style}>Comments &amp; @mentions</h3>
        <ul style={listStyle}>
          <li>Threaded comments on every major detail surface: System, Data Asset, Person, and per-node on the Process Catalog. One level of replies; deeper threading is a known follow-up.</li>
          <li>Typing <code>@</code> in the composer opens a popover of people in the active org. Arrow keys move selection; Enter or Tab inserts the full name; Escape closes. Cmd/Ctrl + Enter submits the comment.</li>
          <li>Each new @mention spawns an in-app notification for that person with a link back to the entity. Email notifications are a future follow-up.</li>
          <li>Authors can edit or delete their own comments; deletes are soft so thread structure stays intact.</li>
          <li>Comment events appear in the Activity feed under the affected entity, with verbs like "commented on" / "edited a comment".</li>
        </ul>

        <h3 style={h3Style}>Activity feed</h3>
        <ul style={listStyle}>
          <li>Same component in three lenses. Org-wide on the Dashboard's Recent Activity widget; per-entity on the System / Data Asset / Process node detail pages; per-person on the People profile.</li>
          <li>Rows phrase events as English ("Eleanor created System SAP Finance &middot; 5m ago") with the actor's name, the action verb, and the affected record. Comments use conversation verbs; CRUD events use create/update/delete.</li>
          <li>Backed by the audit log; comments, role assignments, and dbt imports all flow through it so the timeline is the single source of truth for "what changed and who changed it".</li>
        </ul>

        <h3 style={h3Style}>Notifications</h3>
        <ul style={listStyle}>
          <li>The bell in the top bar surfaces in-app notifications: @mentions in comments, tasks assigned to you, issues you've been flagged on, and policy reviews coming due. A red badge on the bell shows your unread count (caps at 99+).</li>
          <li>Click the bell to open the dropdown. Each row links straight to the source entity &mdash; the click marks it read on the way through.</li>
          <li><strong>Mark all read</strong> clears the unread state without deleting; <strong>Clear all</strong> deletes every notification with no undo and is a two-click action (the first click arms it with a 3-second countdown, the second confirms). Per-row <strong>x</strong> dismisses a single notification.</li>
          <li>Escape or clicking outside closes the dropdown. The unread count refreshes whenever you navigate, so a notification arriving while you're on another page surfaces when you come back.</li>
        </ul>

        <h3 style={h3Style}>Saved views</h3>
        <ul style={listStyle}>
          <li>Capture the current sidebar / search / group-by state on a list page under a name, then recall it later. The <strong>Views</strong> button sits in the page header next to Export.</li>
          <li>Seven list pages support saved views: Data Assets, Systems, Connections, Decision Rights, Governance Roles, Business Glossary, and People.</li>
          <li>Views are org-visible &mdash; everyone in the org sees views saved by anyone. Only the owner can delete or rename their own.</li>
          <li>Tree-based pages (Organizations, Process Catalog, Governance Groups) don't have saved views because their state isn't a flat filter set.</li>
        </ul>

        <h3 style={h3Style}>Role Detail drawer</h3>
        <ul style={listStyle}>
          <li>Click any role chip or label anywhere in the app to open the side drawer. Works for both DAMA roles (CDO, Data Owner, Stewards) and entity-attached roles (System Owner, Custodian, Asset Owner, Domain Steward).</li>
          <li>Each role has a plain-language summary, day-to-day responsibilities, typical RACI decision authority, governance groups that need it (DAMA only), current assignees in your org, and required skills.</li>
          <li>Required-skill chips render solid when the skill is in your org's Skills catalog and dashed-italic when it isn't yet, with a hover tooltip explaining what's missing.</li>
        </ul>

        <h3 style={h3Style}>Discussion drawer integration</h3>
        <p style={pStyle}>
          The Comments panel and Activity feed live together on every detail surface, with the Role Detail drawer accessible from any role chip. Together they answer "what is this record, what's changed, and who am I talking to about it" without leaving the page.
        </p>
      </Card>

      {/* 12. Key Concepts */}
      <Card padding={24} marginBottom={20}>
        <h2 id="help-key-concepts" style={h2Style}>12. Key Concepts</h2>
        <h3 style={h3Style}>DAMA Framework</h3>
        <p style={pStyle}>
          Procela follows the DAMA (Data Management Association) framework for data governance. The governance
          structure, roles, and processes align with DAMA best practices.
        </p>
        <h3 style={h3Style}>Org scoping and inheritance</h3>
        <p style={pStyle}>
          Every value stream, data asset, and system is owned by exactly one org. Only the <strong>company</strong> and <strong>division</strong> levels can own — departments and teams inherit visibility from above but can't themselves be owners. The org you pick in the <em>Working in&hellip;</em> header decides which artefacts you see and which you can edit, following the same rule everywhere in the app.
        </p>
        <ul style={listStyle}>
          <li><strong>Visibility rolls down, never sideways.</strong> Scoping to <em>Tidewater Water</em> shows Water-owned artefacts plus everything owned at <em>Tidewater Utilities</em> (the parent company). Sibling divisions (Electric, Shared Services) don't show up. Scoping to the parent company shows the full rollup view — Water, Electric, Shared Services and the company-owned artefacts together.</li>
          <li><strong>Editing is local.</strong> A row whose owner doesn't match the active scope renders with an <em>Owned by &lt;Org&gt;</em> badge and its edit / delete / inline-cell affordances are disabled with a <em>Switch the Working in&hellip; scope to &lt;Org&gt; to edit</em> tooltip. The same rule applies whether the row is inherited from above (a Water user seeing a corporate asset) or rolled up from below (a corporate user seeing a Water asset).</li>
          <li><strong>Create flows enforce the rule on both ends.</strong> The <em>+ Add value stream</em>, <em>+ Add data asset</em>, and <em>+ Add system</em> buttons hide when the active scope is a department or team, and the backend rejects a direct API call with a non-owning <code>orgId</code> with a 400. For value streams there's a second guard: generating <em>operational</em> processes at a multi-division company is blocked (with one-click <em>Switch to: &lt;Division&gt;</em> chips in the warning) because each division should own its own process catalog. <em>Governance</em> processes are exempt from that second guard — corporate governance is one enterprise-wide program by design, so the <em>Generate governance processes</em> wand still works at the parent.</li>
          <li><strong>Cross-division links warn before saving.</strong> Linking a Water activity to an Electric asset (sibling divisions, neither an ancestor of the other) pops a confirm — the reference almost always means the wrong asset was picked. Cross-axis links to shared parent-company assets (a Water activity using the corporate Customer Master) go through silently because the asset is in scope by inheritance.</li>
        </ul>
        <h3 style={h3Style}>Plain English vs. DAMA terminology</h3>
        <p style={pStyle}>
          The <strong>user menu</strong> (click your name / avatar in the top-right corner) has a <strong>Plain / DAMA</strong> toggle under <em>Display preferences</em> that flips jargon-heavy labels between business-friendly and canonical DAMA wording. Plain is the default so business users aren't met with unfamiliar terms; data professionals can switch to DAMA mode for the formal vocabulary.
        </p>
        <ul style={listStyle}>
          <li><strong>Custodian</strong> (DAMA) &harr; <strong>Operator</strong> (Plain)</li>
          <li><strong>Governance Tier</strong> (DAMA) &harr; <strong>Trust Level</strong> (Plain)</li>
          <li><strong>Uncertified / Managed / Certified</strong> &harr; <strong>Untrusted / Managed / Trusted</strong></li>
        </ul>
        <h3 style={h3Style}>Trust Level (Governance Tier)</h3>
        <ul style={listStyle}>
          <li><strong>Untrusted (Uncertified)</strong> &mdash; Catalogued but not yet governed. No formal ownership or quality rules.</li>
          <li><strong>Managed</strong> &mdash; Owner and steward assigned, basic quality rules in place.</li>
          <li><strong>Trusted (Certified)</strong> &mdash; Fully governed, audit-ready data with complete documentation.</li>
        </ul>
        <h3 style={h3Style}>Governance Roles</h3>
        <p style={pStyle}>Click any role chip anywhere in the app to open the Role Detail drawer for a full breakdown of what each role does.</p>
        <ul style={listStyle}>
          <li><strong>Strategic / Executive</strong>: Chief Data Officer (CDO), Data Governance Lead</li>
          <li><strong>Business accountability</strong>: Data Owner, Business Data Steward</li>
          <li><strong>Technical</strong>: Technical Data Steward, Data Architect, Data Engineer, Database Administrator</li>
          <li><strong>Specialty</strong>: Data Quality Analyst, Data Custodian (Operator)</li>
        </ul>
        <h3 style={h3Style}>Automation Modes</h3>
        <ul style={listStyle}>
          <li><strong>Human</strong> &mdash; Task performed entirely by a person.</li>
          <li><strong>Agent</strong> &mdash; Task performed by an AI agent.</li>
          <li><strong>Hybrid</strong> &mdash; Agent recommends, human approves.</li>
        </ul>
        <h3 style={h3Style}>Export formats</h3>
        <p style={pStyle}>
          Every list page has an Export button with format choices: CSV (open in any spreadsheet), Excel (.xlsx with proper types and sheet names), JSON (re-import or feed to the AI assistant), and Copy to clipboard (paste straight into Sheets / Numbers / a doc).
        </p>
      </Card>

      {/* 13. FAQ — the keyboard-shortcuts section that used to live
          here was a duplicate of the formatted table further down the
          page. Removed when the L-pass appendix added the better one. */}
      <Card padding={24} marginBottom={20}>
        <h2 id="help-faq" style={h2Style}>13. Frequently Asked Questions</h2>

        <h3 style={h3Style}>What is Procela?</h3>
        <p style={pStyle}>
          Procela connects your business processes to the data and systems that support them, giving you a single
          place to define how the business works, assign ownership, and govern data quality across every level.
        </p>

        <h3 style={h3Style}>Where did the Governance Program page go?</h3>
        <p style={pStyle}>
          It was folded into <strong>Get Started</strong> (<code>/setup</code>) &mdash; the old <code>/governance-program</code> URL now
          redirects there. The 4-phase approach (Foundation, Structural Design, People &amp; Processes, Operationalization) is now the
          <strong>Govern</strong> and <strong>Operate</strong> stages of the Get Started journey, with the lifecycle bar (Planning &rarr;
          Active &rarr; Paused &rarr; Completed) and Next Actions right there. Progress is tracked automatically from your actual data as a
          per-stage "n / m done" count &mdash; there's no single overall percentage, because that number could move backward as your
          catalog changed. Phase 1 groundwork (scope, guiding principles, operating model) is authored on the
          <strong>Governance &rarr; Foundation</strong> page.
        </p>

        <h3 style={h3Style}>How do SOPs work?</h3>
        <p style={pStyle}>
          Open <strong>Governance &rarr; Documentation</strong> and switch to the <em>Procedures</em> tab. Standard Operating Procedures are step-by-step guides for common governance activities. You can seed 5 standard SOPs or create your own. Each step includes a description and estimated time.
        </p>

        <h3 style={h3Style}>Why is "Add value stream" or the Process Wizard hidden?</h3>
        <p style={pStyle}>
          The Process Catalog only lets you create value streams at the <strong>company</strong> or <strong>division</strong> level, and it blocks the parent if the company has divisions in its subtree. The two cases:
        </p>
        <ul style={listStyle}>
          <li><strong>The active org is a department or team.</strong> Pick a parent (company or division) from the <em>Working in&hellip;</em> header.</li>
          <li><strong>The active org is a multi-division company</strong> (e.g. Tidewater Utilities with Electric / Water). Generating <em>operational</em> processes at the parent would silently create one shared catalog the divisions don't actually share. The banner on the page lists the divisions as one-click <em>Switch to:</em> chips, so you can drop into one without going back to the header. The <em>Working in&hellip;</em> dropdown also lists divisions nested under their parent company. The <em>Generate governance processes</em> wand stays available at the parent even when divisions exist — corporate data governance is intentionally one enterprise-wide program, not a per-division thing.</li>
        </ul>
        <p style={pStyle}>
          Read-only surfaces (Visualize, Compare, Export) stay available even when create is blocked. Single-tier companies with no divisions keep working normally at the company level. The same guard applies to the Process Wizard, so navigating to <code>/processes/wizard</code> with a blocked scope shows the same banner there.
        </p>

        <h3 style={h3Style}>Why can't I edit this data asset (or system)?</h3>
        <p style={pStyle}>
          The row carries an <em>Owned by &lt;Org&gt;</em> badge — its owner is a different org from the one you're scoped to. The list shows it because visibility rolls down (corporate assets are visible to every division) and up (the parent rolls up everything below), but edits are local: you can only edit a row from the scope where it's owned. Hover the disabled Edit pencil for a switch-scope tooltip, or use the <em>Working in&hellip;</em> dropdown directly. Sibling divisions never see each other's rows, so if you're scoped to Tidewater Water you'll never see a Tidewater Electric asset at all.
        </p>

        <h3 style={h3Style}>Why am I being warned about a cross-division link?</h3>
        <p style={pStyle}>
          You're linking a process activity to a data asset whose owner org is on a different vertical axis from the activity's value-stream org — typically a Water activity reaching for an Electric asset when both are scoped from the parent company. Cross-division references almost always mean the wrong asset was picked; the warning is your chance to pick again. Confirming the warning creates the link normally (it's a <strong>warn, not block</strong>), so genuine shared dependencies can still be modelled. Same-axis links — a Water activity using the corporate Customer Master at the parent company — don't trigger the warning because the asset is in scope by inheritance.
        </p>

        <h3 style={h3Style}>Where did Control Tower go?</h3>
        <p style={pStyle}>
          Control Tower folded into <strong>Insights &rarr; Enterprise View</strong>. The operational dashboard view &mdash; open issues, active tasks, policy coverage, automation rate, coverage gaps across domains / assets / processes &mdash; is being reworked as a preset there. Old <code>/control-tower</code> deep links redirect automatically.
        </p>

        <h3 style={h3Style}>I used to open Operations Manual or SOPs directly &mdash; do those links still work?</h3>
        <p style={pStyle}>
          Yes. Both surfaces now live under <strong>Governance &rarr; Documentation</strong> as tabs. Old <code>/operations-manual</code> and <code>/sops</code> bookmarks redirect to the right tab, and shareable links use a <code>?tab=</code> query param so you can deep-link to a tab.
        </p>

        <h3 style={h3Style}>How do I open the RACI Matrix?</h3>
        <p style={pStyle}>
          Open <strong>Governance &rarr; Roles</strong> and switch to the <em>RACI Matrix</em> tab. RACI is a derived view of role assignments, so editing assignments and inspecting RACI now sit together. Old <code>/raci</code> links redirect to the matrix tab.
        </p>

        <h3 style={h3Style}>How do I export my data catalog?</h3>
        <p style={pStyle}>
          Go to Data &rarr; Data Assets. Filter by domain, classification, or trust level if needed, then click the Export button and choose Excel, CSV, JSON, or copy to clipboard.
        </p>

        <h3 style={h3Style}>How do I learn what a governance role does?</h3>
        <p style={pStyle}>
          Click any role chip or label anywhere in the app &mdash; on Governance Groups, on the Governance Roles page, on a person's profile. A side drawer opens with the role's plain-language summary, day-to-day responsibilities, typical RACI decision authority, the governance groups that need it, who currently holds it in your org, and the skills typically needed.
        </p>

        <h3 style={h3Style}>How do I switch between plain English and DAMA terminology?</h3>
        <p style={pStyle}>
          Click your name / avatar in the top-right corner of any page to open the user menu, then flip the Plain / DAMA toggle (alongside the Cozy / Compact density toggle). Plain is the default; the choice persists in your browser. It flips labels like Custodian / Operator, Governance Tier / Trust Level, and Uncertified / Untrusted across the app.
        </p>

        <h3 style={h3Style}>Why are there two ways to remove someone from a governance group?</h3>
        <p style={pStyle}>
          The <strong>x</strong> next to a role chip removes one role assignment (the person stays in the group). <strong>Remove from group</strong> in the members table is the destructive option &mdash; the person leaves the group entirely, but their governance role assignments at the org level survive.
        </p>

        <h3 style={h3Style}>How do I automate lineage from dbt?</h3>
        <p style={pStyle}>
          Go to Data &rarr; Data Lineage &rarr; <strong>+ Connect a dbt Cloud job</strong>. Fill in your dbt Cloud account ID, job ID, and an API token. Set the polling schedule to Hourly / Daily / Weekly (or leave Manual). Procela pulls the manifest from the latest successful run of that job and reconciles models, edges, and dbt tests into the catalog. The same flow works as a one-off via <strong>Import dbt manifest</strong> if you'd rather upload <code>manifest.json</code> by hand from dbt Core.
        </p>

        <h3 style={h3Style}>What's a "stale" lineage edge?</h3>
        <p style={pStyle}>
          An auto-derived edge (dbt) whose <code>lastSeenAt</code> is older than 30 days &mdash; meaning no recent import has confirmed it still exists. Stale edges render as dashed lines in the visualization and get a STALE badge in the table. Re-import the manifest to clear them, or remove them manually if the upstream model is genuinely gone.
        </p>

        <h3 style={h3Style}>How do I save a filtered view of a list page?</h3>
        <p style={pStyle}>
          On a list page with the <strong>Views</strong> button (Data Assets, Systems, Connections, Decision Rights, Governance Roles, Business Glossary, People), set your filters, click <em>Views</em>, then <em>+ Save current filters as view</em> and name it. Views are org-visible; only the owner can rename or delete their own.
        </p>

        <h3 style={h3Style}>How do I mention someone in a comment?</h3>
        <p style={pStyle}>
          Type <code>@</code> in any Discussion composer. A popover appears with people in the active org; arrow-key or click to pick one. The mentioned person sees an in-app notification with a link back to the comment.
        </p>

        <h3 style={h3Style}>Why does Custodian on a system look different from Data Custodian on the Governance Roles page?</h3>
        <p style={pStyle}>
          They're different roles. <em>System Custodian</em> is the technical caretaker of one specific system &mdash; per-system scope. <em>Data Custodian</em> (DAMA) is an enterprise-level role covering data storage, security, and access broadly. Click either badge to open the Role Detail drawer, where the scope badge ("Per system" vs. nothing) and the responsibilities list make the difference clear.
        </p>

        <h3 style={h3Style}>Can I undo a delete?</h3>
        <p style={pStyle}>
          Yes &mdash; when you delete a single item (data asset, system, person), a toast notification appears with an
          "Undo" button. Click it within 6 seconds to restore the item.
        </p>

        <h3 style={h3Style}>What governance framework does Procela follow?</h3>
        <p style={pStyle}>
          Procela follows the DAMA (Data Management Association) framework for data governance. Roles, groups,
          processes, and the governance hierarchy are all aligned with DAMA best practices.
        </p>

        <h3 style={h3Style}>Where is my data stored?</h3>
        <p style={pStyle}>
          In the current prototype, data is stored in JSON files on the server. In production, Procela is designed
          to use PostgreSQL with full multi-tenancy, encryption, and backup capabilities.
        </p>

        <h3 style={h3Style}>I lost my authenticator app. How do I get back in?</h3>
        <p style={pStyle}>
          Use one of the backup codes you saved at enrolment — the sign-in MFA prompt has a <em>Use backup code instead</em> link. Each code is single-use. If you've burned through them, an admin can reset your two-step verification from the Person detail page <em>Security</em> panel; you'll be re-enrolled on your next sign-in. If you registered a security key, you can also use that to sign in passwordlessly and then re-enrol TOTP from Settings.
        </p>

        <h3 style={h3Style}>Why am I being asked to confirm I'm human?</h3>
        <p style={pStyle}>
          Three failed sign-in attempts from your network inside 15 minutes flips the CAPTCHA gate on for that IP. A successful sign-in clears the counter; the gate also lifts automatically after the window passes. If you're seeing it without having mistyped, someone else on the same network may be hammering the login — the gate is doing its job.
        </p>

        <h3 style={h3Style}>My account is locked. What now?</h3>
        <p style={pStyle}>
          10 failed sign-ins inside a 30-minute window lock the account for the next 30 minutes. Wait for the auto-unlock, use the password-reset link to set a new password (success there clears the lock), or ask an admin to clear it manually from the Person detail page after verifying you over another channel.
        </p>

        <h3 style={h3Style}>I see a session in <em>Active sessions</em> I don't recognise.</h3>
        <p style={pStyle}>
          Click <em>Revoke</em> on that row — the device gets booted to the login screen on its next API call. Then change your password from Settings (or use the forgot-password flow if you've forgotten it). If multiple unknown sessions show up, hit <em>Sign out everywhere</em> to invalidate everything in one shot and re-sign in from a known device.
        </p>
      </Card>

      {/* Keyboard shortcuts — list the chords plus a button that pops
          the same overlay the user gets from Shift+? globally. Keeps
          discoverability high without forcing users to know the chord. */}
      <Card padding={24} marginBottom={20}>
        <h2 id="help-shortcuts" style={h2Style}>14. Keyboard shortcuts</h2>
        <p style={pStyle}>
          Procela has a small set of keyboard chords for the things you'll do most often.
          Press <kbd style={kbdStyle}>Shift</kbd> + <kbd style={kbdStyle}>?</kbd> anywhere
          to open the full reference, or use the button below.
        </p>
        <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 12 }}>
          <tbody>
            {[
              ['/', 'Open command palette'],
              ['Ctrl / Cmd + K', 'Open command palette'],
              ['Shift + ?', 'Show all keyboard shortcuts'],
              ['g then d', 'Go to Dashboard'],
              ['g then o', 'Go to Organizations'],
              ['g then p', 'Go to People'],
              ['g then c', 'Go to Processes'],
              ['g then a', 'Go to Data Assets'],
              ['g then s', 'Go to Systems'],
              ['g then m', 'Go to Data Mapping (mappings)'],
              ['g then l', 'Go to Lineage'],
              ['g then q', 'Go to Data Quality'],
              ['g then g', 'Go to Governance Foundation'],
              ['g then r', 'Go to Reports'],
              ['g then e', 'Go to Enterprise View'],
              ['g then h', 'Go to Help'],
              ['Escape', 'Close the palette, drawers, modals, and dropdowns'],
            ].map(([keys, what]) => (
              <tr key={keys} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                  <kbd style={kbdStyle}>{keys}</kbd>
                </td>
                <td style={{ padding: '6px 8px', color: 'var(--color-text-secondary)' }}>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <button
          onClick={() => window.dispatchEvent(new Event('procela:open-shortcuts'))}
          style={{
            padding: '8px 16px', background: 'var(--color-surface)',
            color: 'var(--color-primary)', border: '1px solid var(--color-primary)',
            borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}
        >
          Open keyboard shortcuts overlay
        </button>
      </Card>
    </Page>
  );
}
