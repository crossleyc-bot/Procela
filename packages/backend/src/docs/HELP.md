# Help Guide

Procela is a DAMA-aligned governance operating platform that helps organizations design, execute, and mature data governance using workflows, accountability models, and structured procedures. This guide is the feature-by-feature reference for the platform.

---

## 1. Getting Started

The fastest way in is the Get Started hub (titled **Set up Procela**) — a resumable, data-driven journey from an empty org to a running governance program. It sits at the top of the sidebar and at /setup. Onboarding the org and standing up the program are **one spine**, not two separate tracks: onboarding is simply the first half of standing the program up.

### The four stages

- ① Capture — tell Procela about your business: organization structure, people, processes, systems, and data assets.
- ② Assign — give every process, system, data domain, and data asset a clear owner. Each ownable type is its own board item (Process / System / Domain / Data-asset ownership), and each deep-links to that type's own page — the Process Catalog, Systems, Data Domains, and Data Assets — where you assign owners in context. A row ticks once that type has no ownerless items.
- ③ Govern — connect data to processes, tier and grade assets, and define your governance foundation (scope, principles, operating model).
- ④ Operate — stand up the governance structure and roles & policies, then launch and run the program.

### The lifecycle bar

Across the top, the governance program's lifecycle — Planning → Active → Paused → Completed — governs the whole arc. The valid next transitions (Launch, Pause, Complete, Reopen) are buttons right here on the lifecycle bar; they're role-gated (admin / program owner) and audited, with a reason prompt and an early-launch confirmation when phases are still incomplete. Launch stays disabled until Foundation (Phase 1) is complete — the one hard prerequisite — and once the program goes live the actual Launched date is recorded and shown next to the status.

### How progress is shown

- No overall %. A single number mixing "have I added my systems" with "is the program launched" is meaningless and oscillates — so each stage carries its own count instead. A stage line names the current stage and reads "Stage X of 4 · <name> — n of m done".
- Derived from live data, not checkboxes. Add five systems and the Systems item flips automatically — there's no separate to-do list to keep in sync. Statuses come from dashboard stats (operationally scoped) plus the governance-program status.
- HERE / AUTO source badges. Each board item is tagged Here (you define it in Procela — e.g. adding systems, mapping data, editing the Foundation) or Auto (derived from your catalog — e.g. ownership coverage, program launch). Every row deep-links to the page where the work happens.
- Operationally scoped. Process-side counts (value streams, steps, ownership gaps, coverage) reflect only your business processes, so the canned Data Governance Management scaffold never masquerades as business-process progress.
- Sidebar progress ring. The ring next to the Get Started link now spans all four stages; in the default Auto mode the link auto-hides once the whole journey reaches 100% — i.e. once the program is actually stood up and running, not merely when the org is onboarded. You can override this under Settings → Get Started guide with an Auto / Always / Hidden control — Always pins the entry even after setup completes, Hidden removes it entirely. This preference is global per user: it follows you across every organization you work in, rather than being set per org.

### Reading the board

- Below the stage line, a four-column board (one column per stage) shows each item as a checklist row with its source badge and a segmented progress bar. Every row's deep-link hands off to the same destination the left nav exposes, so the move from journey to workspace is seamless. Operate reads strictly top-to-bottom: "Program launched" only ticks once the structure and roles & policies it depends on are in place.
- The hub is for setup and check-ins; the left nav is your persistent workspace once you know the app.

### The governance program lives here

There is no separate Governance Program page — it was folded into this journey. The Govern and Operate stages, the lifecycle bar, and Next Actions together are the program's four-phase tracker (Foundation → Structure → People → Operations) and its governed lifecycle. Authoring the foundation itself — scope, guiding principles, operating model — happens on Governance → Foundation, and the individual pieces (domains, groups, roles, policies) live on their own Governance pages, which each board item and Next Action deep-links to. (The old /governance-program URL now redirects here.)

## 2. Navigation

The sidebar opens with Get Started for first-run onboarding (it auto-hides at 100%), then the platform's "who" and "what does work" before fanning out into the artefact buckets. Dashboard is a direct link; Organizations and Processes follow as the actors and the verb that connects them; Data / Systems / Governance / Insights cover the artefacts the work runs through. Sections with multiple destinations are accordions you can expand and collapse.

- Get Started — Resumable setup hub: **one journey** (Capture → Assign → Govern → Operate) from an empty org to a running governance program, with the program lifecycle (Planning → Active → Paused → Completed) across the top and HERE/AUTO board items deep-linking to each workspace. No overall %; each stage carries its own count. The progress ring and auto-hide track all four stages. See Section 1 for the mechanics.
- Dashboard — Personalized home with your tasks, issues, domains, and KPIs.
- Organizations — Accordion covering the "who" of the platform: Structure (your company / division / team tree), People (the humans on your team), Agents (AI agents that hold governance roles and run automation), and Skills (the competencies your roles need).
- Processes — the Process Catalog, where you define value streams, processes, sub-processes and activities, and connect each node to its owner / responsible role / systems / data assets inline. Direct link, not an accordion. (The cross-process flat-list view of activity↔asset mappings lives under Insights → Data Mapping.)
- Data — Data Assets, Glossary, Data Dictionary, Lineage, Domains, Data Quality.
- Systems — Systems and Connections (databases, APIs, files).
- Governance — grouped into Set up (Foundation, Groups, Roles with RACI Matrix tab, Documents, Decision Rights) and Operate (Documentation with Manual + Procedures tabs, Calendar, Tasks & Issues, Exceptions). The sub-labels are visual dividers in the expanded section — every item still navigates directly. (The program's tracker and lifecycle live on Get Started now, not a separate Program page.)
- Insights — grouped into Explore (Enterprise View, Analysis, Data Mapping) and Review (Reports, Council Scorecard, Gap Detection, Audit Log). Cross-cutting exploration and review surfaces that read across Data, Systems, People, Processes and Governance — promoted out of Governance so they're easier to find.

Settings sits at the bottom of the sidebar. Help lives only in the top bar (next to Ask AI) — it opens the guide in a separate popup window so you keep whatever page you're on. The Training Guide follows the same pattern. The `/help` URL still works if you have deep links saved (e.g. `/help#connectors`).

### Header controls

- Search box (Cmd/Ctrl + K or /) — Universal command palette. Searches processes, data assets, systems, people, domains, and groups in your active org. Results are ranked and link directly to the matching item.
- Working in … — Organization selector. Scopes every page to the selected org. Divisions are listed nested under their parent company (Tidewater Utilities ▸ Electric / Water), so you can drop into a division-scoped view without leaving the page. Single-tier companies render as a flat list.
- Display preferences — the Plain / DAMA terminology toggle and the Cozy / Compact density toggle live in the user menu (click your name / avatar in the top-right corner). Per-user, persisted per browser, applied immediately. The Settings page is admin-only and holds org-wide configuration instead.
- Report a problem — the top-bar button (next to Help) opens a short form: pick a category (Bug, Question, or Feedback), describe the issue, and submit. Every report is recorded to the audit trail, so nothing is lost even when email isn't configured; where a support inbox is set up it's also emailed there. Use it for anything that looks wrong or any feature request — it reaches whoever administers your Procela instance.

## 3. Dashboard

![Dashboard headline cards with the "Overview" KPI row visible at the top and the "Needs My Attention" section beneath. Anchor screenshot: the shape of the dashboard's primary tiles.](images/dashboard-hero.png)

The dashboard is personalized to your login. You must have a People record with your email to see personalized data.

- My Dashboard — Open tasks, issues, domains you own/steward, upcoming events. Each tile is a hyperlink — Open Tasks jumps to Governance Work (Tasks tab), Open Issues to the Issues tab, My Domains to the Data Domains page, and Upcoming Events to the Governance Calendar. Hover lifts the tile to signal it's interactive; zero-count tiles fade the number but still link through to the destination's empty state.
- Needs My Attention — Overdue tasks, critical issues, pending policy reviews
- My Schedule — Governance events in the next 14 days
- Overview — Organization-wide KPIs (value streams, assets, coverage, health). Each tile is a hyperlink — click Value Streams / Processes to jump into the Process Catalog, Data Assets / Systems to their catalogs, Coverage straight to Data Mapping (where the unmapped-activity and unlinked-asset banners surface), and Avg Health to Data Assets sorted by health ascending so the worst-scoring assets are at the top. Hover lifts the tile to signal it's interactive; zero-count tiles fade the number but still link through to the destination's empty state.
- Governance Posture — The state of governance at a glance, as charts rather than numbers: a **tier-mix donut** (how many data assets are Certified / Managed / Uncertified) beside semicircular **Coverage** and **Avg Health** gauges, each coloured green / amber / red by the same 80 / 50 thresholds used everywhere else.
- Trends — Sparklines of **Coverage**, **Avg Health** and **Open Gaps** over the last several weeks, each with a ▲/▼ delta versus the start of the window (green when the direction is good — coverage/health up, gaps down). The headline number is the live value, so the trend always agrees with the Overview tiles. Backed by a weekly stats snapshot; a brand-new org sees a short synthesized trail until real history accrues.
- Governance Gaps — The open gap signals (unmapped activities, ownerless processes, ungoverned / orphan assets, unowned domains) as a critical-vs-warning **severity bar** over a list of counts; each row links to the page that fixes it.
- Catalog Shape — Horizontal bars for the size of each process level (Value Streams → Processes → Sub-processes → Activities), so you can see the shape and depth of the catalog at a glance.
- Program Maturity — Current governance phase with next steps to advance
- What's Next — Contextual recommendations based on org maturity
- Skill Gaps — Top under-staffed required skills across the org. Each row compares required by activities against held by people as a bar chart; rows where nobody on staff holds the skill are flagged in red ("no coverage"), tight-but-covered rows in amber, healthy in green. The Find people by skill → link jumps straight to the People page's skill filter for staffing backfills.
- Recent Activity — Last audit log entries (expandable)
- Quick Actions — Shortcuts to common tasks

Click Customize to control the layout. For each section you can reorder it (up / down arrows), set its width — **Half** (packs two sections side-by-side, so the page stays tight with less scrolling) or **Full** (its own row) — and show or hide it. The dashboard opens on a sensible importance-ordered default (your personal items and headline KPIs first, the visual posture and trends next, then the analytical widgets, with utilities and the activity feed at the bottom), and most analytical widgets default to Half width so they pair up. Your layout is saved automatically per browser; use **Reset to Default** to return to the shipped arrangement.

## 4. Processes

### Process Catalog

![Process Catalog page with a value stream expanded to show its child processes and one activity's Inputs / Outputs panel opened. The tree hierarchy Value Stream → Process → Activity is visible at a glance.](images/process-catalog-tree.png)

- Hierarchical process catalog: Value Stream → Process → Activity (with optional Sub-Process and Task levels for detail).
- AI-powered Value Stream Wizard generates process hierarchies tailored to the active org, not just the industry. Running the wizard scoped to Tidewater Electric produces electric-utility processes (SCADA, outage management, transmission & distribution); scoping to Tidewater Water produces water-utility processes (treatment, distribution mains, wastewater). The active org's name, type, and description ride along with the industry to the AI prompt so output reflects this specific division rather than generic Utilities content. The result is cached per (industry + org) on the server — first user pays the 10–30 second Claude call, every subsequent run for the same org returns the same template instantly, and each division caches independently. A Cached / Fresh from AI badge plus a Specialised: <Org> chip on the review screen tells you what's been tailored; the Regenerate from AI button next to the standard Regenerate bypasses the cache and replaces the stored copy with a brand-new Claude generation.
- Real progress bar while the wizard runs. The Generate call streams from Claude token by token, so the wait screen fills a progress bar and ticks through phased captions ("Analysing industry context…" → "Drafting value streams…" → "Adding processes…" → "Adding activities…" → "Finalising hierarchy…") instead of a spinner. Step bar at the top of the wizard shows Industry → Generate → Review → Apply so you always know where you are. Cache hits jump straight to the review screen without the progress animation.
- Level-specific attributes: frequency, risk level, responsible role, automation level.
- Status lifecycle: Draft → Active → Deprecated.
- Level visibility toggles. The Legend chips ("1 Value Stream", "2 Processes", "1 Sub-Process", "4 Activities", …) double as show/hide switches — click a level to drop it from the tree. Hidden levels don't orphan their children: their descendants are promoted up, so hiding Sub-Process shows the Activities directly under their Process, and hiding everything but Value Streams and Activities gives a two-level read of the catalog. It's a per-view filter — nothing is deleted, and the counts still reflect the full hierarchy.

![Animated walkthrough: with the process tree expanded, clicking the "Sub-Process" Legend chip drops that level and promotes its Activities directly under their Process; clicking it again brings the level back.](images/process-levels.gif)
- Operational / Governance lens. A segmented control (All · Operational · Governance) at the top filters which value streams show. Governance value streams (created by the governance template) carry a persisted domain classifier; business value streams are operational. The lens is per page — the Process Catalog always opens on All, and your choice here is independent of the lens on other pages.
- Governance is enterprise-scoped. Governance value streams defined at the parent (company) level don't appear in a child division's Process Catalog by default. Enterprise governance is one program for the whole org tree — showing it under every division inflated their counts and rendered a locked row a division user couldn't act on. To reference the enterprise governance program from a division seat, switch Working in… up to the parent org. Governance a division defined for itself still shows normally.
- Assigning an Owner or Stakeholders opens the shared person picker — search by name / title / org, or browse the org tree (Company → Division → Department) or governance groups. Every result shows the person's title and org path so two people with the same name are distinguishable. The same picker is used for owners, stewards, deputies, and group members across the app.
- Domain-aware role assignment. Governance value streams default the person picker to the governance bodies and the Responsible Role selector to the DAMA governance roles only; operational (business) processes default to the org tree and the generic business roles, with the DAMA roles hidden. A "show all roles" toggle reveals the other set for genuine cross-overs, and a picked role from the other domain is flagged Cross-domain. Existing free-text role values are preserved until you re-pick.
- Operational vs governance node fields. Governance nodes (those under a value stream with domain === 'GOVERNANCE') skip the Where it runs summary and the Systems picker — governance happens in policies, decisions and meetings, not on systems, and showing perpetually-zero system / data-asset counts on a governance activity was just noise. Operational nodes keep the full layout. The Inputs / Outputs note and the data-asset linker stay available on governance nodes too, since edge cases (an Audit Log Review activity consuming the audit log) are still legitimate.
- Inputs / Outputs panel — picker varies by domain. Operational activities can link a row to a Data Asset (operational I/O), a Governance Document (a charter or policy the activity references), or an Attachment (uploaded file / URL). Governance activities lose the Data Asset tab — their I/O is documents and attachments only, since they don't produce or consume operational data. The + Add Input / Output picker is segmented across the available kinds; pick what kind first, then the specific target. A row's label is clickable: a data asset opens the asset detail, a document jumps to Governance Documents, an attachment downloads. So Define Data Governance Charter defaults to the Document tab and can link the actual Data Governance Charter policy (CHA-001) as its Output, with the signed PDF uploaded as a separate output row.
- Dependencies panel (activity level). Two columns — Predecessors and Successors — declare what has to run before this activity and what it unblocks. Backed by SEQUENCE, PARALLEL, CONDITIONAL, and LOOP flow types (the picker defaults to SEQUENCE for the simple case). Procela enforces three things: cycles are blocked before the edge lands (unless the caller explicitly declares LOOP), a picked activity from a different value stream carries a small amber CROSS-STREAM chip so a wrong pick is visible, and deleting an activity cascades every dependency edge touching it so nothing dangles. Collapsed activity rows in the tree show a compact `←N →M` indicator with the incoming/outgoing counts.
- BCM + operational attributes (advanced view, activity level). Several extra fields sit next to Automation / Est. Duration when the tree is in advanced mode: **Criticality** (Tier 1 mission-critical, Tier 2 business-critical, Tier 3 standard, Tier 4 non-critical, or Not rated), **RTO (hours)** (Recovery Time Objective — how fast must it recover?), **RPO (hours)** (Recovery Point Objective — how much data loss, in time, is tolerable? the BCM pair to RTO), **Trigger** (what initiates the activity — Scheduled / Event-driven / Upstream completion / Manual / External request), **Volume** (processing scale / throughput such as "~10k invoices/day", distinct from Frequency's cadence), and **Target / SLA** (free-text measurable target — "resolve within 4h P95", "99.9% monthly"; this single field absorbed the former separate *Success Measure* and *SLA Target*). Together they answer BCM regulator questions like "what's the RTO and RPO for outage triage?" that Procela couldn't otherwise produce, and give dashboards a measurable target next to the narrative business outcome.
- Controls picker (advanced view, activity level). Multi-select linking the activity to specific governance controls (CTL-001, CTL-002, …) defined on Governance Documents. Chips show the code + name; hovering the pill shows the description. Deleting a control on the Governance Documents page cascades — the control id is swept off every activity that referenced it, so nothing dangles. This is the first-class alternative to the free-form `complianceTags` array: activities linked to a control appear in the control's Where Used view, and the loop between policy definition (Governance Documents) and execution (activities) closes end-to-end.
- One-click demo data (Settings → Load demo data, super-admin). Seeds the Tidewater Utilities fixture in a single call — org tree (Tidewater Utilities + Electric + Water + Shared Services + a few departments), 24 named people including a Susan Chen persona, 8 systems (SCADA, CIS, AMI, OMS, GIS, Data Warehouse, LIMS, Hydraulic Model), 5 agents wired to their responsible people, 3 data domains with owners and stewards, 9 data assets (seven operational + two deliberately-planted orphans named *Legacy Billing Extract* and *Meter CSV Dump* so the Ask AI orphan-detection prompt returns something quotable), a 15-node process hierarchy for Outage Management with 7 activity↔asset mappings, 3 governance tasks assigned to Susan, 1 open ownership issue, 2 DQ rules (one PASSING on Customer Master, one FAILING on Generation Output — same asset as the seeded issue so the DQ tile and the issue tell one coherent story), a Weekly *Data Governance Committee* calendar event owned by Susan (so the *Upcoming Events* dashboard tile has real content), and **two edge connectors** — one *Tidewater Data Platform* connector (agent v1.2.0, ONLINE, five events in its activity feed) plus a second *Water Plant SCADA* connector still in the PAIRING state with a visible 8-digit code valid for 5 minutes so the demo can show both halves of the agent lifecycle. Meter Reads shows a fresh *Synced 5 min ago* chip on its detail page — enough to walk a prospect through the on-prem agent story without spinning up a real container. The seed also **pre-warms the AI wand cache** for Tidewater Electric and Tidewater Water — the "Generate processes" wand click during the demo returns instantly instead of stalling on a 10–30s Claude call. Idempotent: every row lands with a `demo-` prefix; a second click wipes the prior seed and reseeds so the fixture always converges on the same known state. Recommended pre-demo flow: click **Load Tidewater demo** → sign in as **Susan Chen** → walk the dashboard.
- Sign-in white-labeling (Settings → Security → Sign-in page appearance, super-admin). Customises the sign-in card for users landing at your tenant URL — `/login?tenant=<slug>` in dev or a subdomain match in production — so the card reads as *"Sign in to Acme Corp"* with the customer's emoji glyph, display name, SSO button label, and primary color, instead of generic Procela. All fields are optional; empty ones fall back to platform defaults. Tenant slugs are unique across companies (3–64 lowercase letters, digits, or hyphens); primary color takes `#RRGGBB` hex. A preview panel in the Settings section renders the sign-in card exactly as it'll appear, so a super-admin can eyeball their branding before sharing the URL with a customer. When a tenant brand is active, a small "Powered by Procela" line sits under the wordmark so the platform stays credited without dominating the sign-in surface.
- Change-management review workflow (Settings → Process & Asset Lifecycle → **Review**). One approver gate between Draft and Active — Draft → Pending Review → Active → Deprecated — with segregation of duties baked in: the submitter cannot approve their own change, but can withdraw it. Submitting for review takes an optional comment ("what are you changing?"); approving or requesting changes takes its own comment. The row shows a yellow "Pending review" banner with the submitter's name, timestamp, and comment while the change is in flight. Notifications land in the bell — the org sees "Change submitted for review: X" when a submission opens; the submitter sees "Change approved" or "Changes requested: …" when the reviewer acts. Two modes for two contexts: **Simple** for teams that trust each other; **Review** for change control; **Advanced** for regulated environments that need the four-state ceremony (Proposed → Under Review → Approved → Active). Switching modes migrates existing rows to a valid ground state on the target machine — no orphaned statuses.
- Qualified-person check. When an activity carries a Responsible person and required skills, Procela compares the person's skillIds against the activity's requiredSkillIds. If anything's missing, an amber chip appears next to the Required Skills picker on the activity panel — "Responsible person lacks N required skill(s)" — with the missing names in the tooltip. The same gap surfaces as a Skill gaps count on the People table, so you can spot under-qualified assignments from either end. The check is per-org and updates live as you change the person or the required-skill list.
- Cross-division link warning. When you add a data-asset or document link to an activity, Procela checks whether the target's owner org is on the same vertical axis as the activity's value-stream org (i.e. same org, ancestor, or descendant). If it isn't — typically a Tidewater Water activity reaching for a Tidewater Electric asset — a confirm pops first: "<Target> is owned by <Other Division>, but <Activity> sits in <This Division>. Cross-division links usually mean the wrong target was picked — pick again, or confirm if this is genuinely a shared dependency." The default is warn, not block: confirming creates the link normally; cancelling drops it. Cross-axis links to shared parent-company targets (a Water activity using the corporate Customer Master, or the enterprise Data Governance Charter) go through silently because the target is in scope by inheritance. Attachments skip the check since they're scoped to the activity directly.
- Suggested data assets / systems / people (Phase 3 Discover). Each expanded activity card carries three small "Suggested…" panels beneath the Inputs/Outputs picker. Procela ranks candidates against the activity's name, description, declared systems, and required skills, and shows the top hits with a High / Medium / Low confidence chip and a one-line rationale ("Same system as the step (SAP Finance)", "Has 2 of 3 required skills"). Accept moves the suggestion into the right slot (asset → adds a mapping; system → appends to the step's systems; person → assigns as Responsible). Dismiss persists server-side via the learning loop — once dismissed, a candidate isn't suggested again for that step. Panels hide themselves entirely when nothing scores above the threshold, so steps that are already fully mapped don't accumulate dead UI.
Where value streams can be created. Streams attach to the active org in the Working in&hellip; header, but only at the company or division level. Two cases block the create UI (the + Add value stream button, the wizard wand, the governance-template wand, and the empty-state buttons all hide; Visualize / Compare / Export stay available):

- Wrong level. The active org is a department, team, or anything below division. Pick a parent org from Working in….
- Multi-division company. The active org is a company that has at least one division anywhere in its subtree (e.g. Tidewater Utilities → Electric / Water, or Company → Region → Division). Generating at the parent would silently create one shared operational catalog the divisions don't actually share. The banner lists the divisions as one-click Switch to: chips, so you can drop into one without leaving the page. Single-tier companies (no divisions) keep working normally at the company level. Governance is the exception — corporate data governance is intentionally one enterprise-wide program (one policy book, one decision-rights matrix, one RACI), so the Generate governance processes wand stays available at the parent and isn't blocked even when divisions exist. Divisions themselves do NOT see the governance wand — enterprise governance is only creatable from the company (root) scope, so a division user can't accidentally create a governance value stream the same catalog would then hide from them.

- The same guard applies to both the Process Wizard and the catalog's manual create path so it can't be sidestepped.

### Data Mapping

- Flat audit / bulk-edit view of every activity ↔ target link in the catalog. Sortable columns, CSV/Excel export, bulk delete, and the Batch Mapping Wizard (matrix interface) for creating many mappings at once.
- Day-to-day, you connect an activity to its data assets inline on the Process Catalog — each node panel has Owner, Responsible Role, Systems, and Inputs/Outputs (data assets) in one place. Data Mapping is the cross-process review surface for those same links; it doesn't introduce a separate model.
- Mappings can be AI-suggested or user-defined; the page tracks which is which so suggestion overrides are auditable.
- Target column. A mapping can point at one of three things — a Data Asset, a Governance Document (charter / policy / standard / framework), or an Attachment. Each row carries a typed tag (ASSET, DOCUMENT, ATTACHMENT) plus the target's name and a sub-detail (governance tier for assets, code · type for documents, filename for attachments) so the three link kinds are visually distinct at a glance.
- Orphan detection + cleanup. When the activity, asset, document, or attachment a mapping points at has been deleted (commonly: an agent draft was promoted, then the source activity got regenerated by the Process Wizard with new ids), the row renders the dangling side as an amber "Activity deleted" / "Data asset deleted" / "Governance document deleted" chip with the original id-prefix in the tooltip. A red banner above the table shows the total orphan count and a one-click Delete all orphans action — the surviving activities, assets, and documents are untouched. Orphans sort to the end of the table so the active rows stay together at the top.

### Process ↔ Data Map

- Bipartite visualization of every activity ↔ data asset link in scope. Activities on the left grouped by parent process; mapped data assets on the right grouped by system. Each mapping renders as a coloured curve between the two columns — green for produces, blue for consumes, purple for transforms, grey for references. Read at a glance: "which assets does this step touch", and inversely "which steps use this asset".
- Lives in the nav under **Insights → Explore**, next to Data Mapping — same data, different read. Data Mapping is the table (edit-capable, exhaustive, bulk-actions); Process ↔ Data Map is the picture (read-only, visual, click-to-focus).
- Click an activity (or asset) to focus its connections. Connected rows stay bright; everything else fades. A Clear focus button appears above the legend. Useful when the catalog is large enough that the all-edges view is busy — pick a node and only its neighbourhood pops.
- Header counters show coverage at a glance: `N activities · N mapped assets · N mappings · M/N activities have at least one mapping`. When unmapped activities exist, a footer link jumps to Gap Detection so you can fix them in context.
- System filter and Include governance toggle. The default view is operational only; flip the toggle to include governance activities. The system filter narrows both columns to assets on a single system, which is the fastest way to answer "what processes use Salesforce" or "what does our SCADA data feed".
- Orphan assets (no process references them) are intentionally excluded — they live on their own page, see Data → Orphan Assets below.

## 5. Data

### Data Assets

![Data Assets list showing several rows with governance-tier badges (Bronze / Silver / Gold), health scores, and at least one row carrying a green "Synced N min ago" chip next to its name so the connector-sourced freshness signal is visible.](images/data-assets-list.png)

- Register data assets in business terms. Each asset has a Trust Level (Untrusted / Managed / Trusted — DAMA mode calls these Uncertified / Managed / Certified).
- Sidebar filter by **Data Classification** — the business *kind* of data: Master, Reference, Transactional, Analytical, Metadata (distinct from the SQL data type, and from the Sensitivity axis below).
- **Filter by rules (DQ coverage).** The toolbar has a rules filter — *Has rules* / *No rules* / *Rules but unmeasured*, each with a live count. *No rules* is your coverage gap (assets nothing measures yet); *Rules but unmeasured* is the false-confidence bucket (assets that carry rules but where none have a real, non-simulated result, so their health is an **estimate** badged *Est*, not a measured reading — the ones to point a connector at next).
- Inline editing for Trust Level directly in the table.
- **Health is earned from measured data quality, not hand-set.** The Health column shows an asset's rolled-up score only when at least one *measured* (non-simulated) quality rule backs it; with no measured rule it reads **0%**. It's read-only in the list — a connector-freshness or manual number is never surfaced as "health". (Per-column health on the 360 view still reads "—" for a column whose rule hasn't been measured.)
- Link to Source connects an asset to a database table, file, or API. In the Link-to-connection dialog you can bind the asset to the **whole** table/file, or tick a **named set of its columns** — so one physical table can back several business assets, each scoped to its own subset. The Source cell shows the target as `table`, `table.column`, or `table · N cols`.
- Expandable columns show data types and quality rules per column. Binding a column set **materializes those columns as governed columns** automatically, so they are immediately targetable by quality rules and roll their health up to the asset.
- **Deleting a column warns when rules reference it.** Removing a column that has data-quality rules pops a confirm ("N data-quality rules reference this column"). The rules aren't deleted — they *detach* from the column: they keep measuring by column name if the source still has it, but no longer appear under the column. A column with *no* rules deletes without a prompt, and a connector-discovered column re-appears on the next scan anyway.
- Bulk set Trust Level / owner / steward.
- Owner and stewards inherit from the domain by default. Under both the Owner picker and the Stewards picker on the edit form, the field shows a hint reading "Inherits from domain — <person(s)>" when the pick is empty and the domain has an owner / stewards; the asset row still renders with the effective person(s) as if you'd picked them. Pick a specific person (or list) when the asset has its own accountable owner different from the domain's (regulatory scope, cross-functional asset, delegation, transition period); the hint switches to "Overrides domain (<person>) — Reset to domain owner" with a one-click reset. Changing a domain owner or steward propagates to every inheriting asset automatically. DAMA-aligned: Data Asset Owner and Data Steward are separate accountabilities from their Domain counterparts by design, but should default to the domain values.
- Where Used in the detail modal shows every process, mapping, and policy referencing the asset.
- **Impact analysis — "if this asset changes, what breaks?"** The *Impact* panel on the 360 view counts how many activities consume the asset, how many processes those roll up to, and how many value streams that touches, then expands to a per-person **Notify** list — each entry showing *why* they'd be told (Owner on an activity, Responsible person, Domain steward, etc.). Use it as your change-comms distribution list before deprecating a system or retiring a field.
- **Bound columns** panel on the detail (360) view lists the columns the asset is bound to — each with its rule count and per-column health — plus which physical table/columns it maps to. A column with a rule that hasn't been measured reads "—", never a fabricated score.
- **Sensitivity tags.** An asset can carry one or more sensitivity tags describing the regulated content it holds: PII (personally identifiable information), PHI (protected health), PCI (payment-card), FINANCIAL, CREDENTIAL, CONFIDENTIAL, PUBLIC. Distinct axis from Data Classification (PUBLIC/INTERNAL/CONFIDENTIAL/RESTRICTED) — the same asset can be PII inside an INTERNAL surface, or PCI + PII simultaneously. The API surface is two routes: `POST /data-assets/:id/suggest-sensitivity` asks Claude to classify the asset from its name, description, system type, and column names/types, returning `{tag, confidence, reason}[]` for review; `PUT /data-assets/:id/sensitivity` writes the accepted set. Classifier is deliberately conservative — false positives (labelling everything PII) create noise across every gap/coverage report, so it errs on "don't tag if unsure". The 360 view has a **Suggest & Review** UX: click *Suggest sensitivity tags* and each proposal gets its own **Accept / Reject** chip, so you take the ones that fit and drop the rest; a rejected tag stays rejected across re-runs, so a later *Suggest* won't re-propose it.
- **Synced N min ago** chip. When an on-prem connector last refreshed an asset's freshness signal, the row shows a small pill next to the name: green (**Live**, synced in the last 30 min), amber (synced 30 min – 4 h ago), red (synced > 4 h ago). The tooltip carries the exact ISO timestamp. Manually-added assets never show a chip. The chip is a "trust the number" cue — if it's green, the row count and last-write timestamp reflect the source database, not a human's last manual edit.
- **Connector-discovered assets arrive as Bronze**. When an on-prem connector reports a new table, Procela creates the asset at Bronze tier with no owner, no steward, no linked processes. That's intentional — new arrivals should surface as work items for stewards on the Orphan Assets and Ungoverned dashboards, not silently melt into an approved catalog.
- Data Assets is operational-only. Governance documents (charters, policies, standards, frameworks) live under Governance → Documents, not here. The earlier All · Operational · Governance lens was removed from this page when the governance template stopped seeding placeholder data assets and started seeding real Policies instead.
- Org scope and inheritance. Each asset is owned by exactly one org, and only company or division levels can own — departments and teams can't. If the active Working in… scope isn't an owning level, the + Add data asset button is hidden and a banner explains why (the list still renders so users can read inherited rows from above). When you're scoped to a division, the list shows division-owned assets plus assets owned at the parent company — the parent-owned ones carry a small Owned by <Company> badge and their edit / delete / inline-cell affordances are disabled with a "Switch the Working in… scope to <Company> to edit" tooltip. Conversely, a company-scoped user sees everything below (a rollup view) with the same badge on division-owned rows. Sibling divisions don't see each other's assets. The level guard is enforced server-side too — a direct API call with a department-level orgId is rejected with a 400.

### Orphan Assets

- Reverse view of the catalog: data assets that exist but no process step references them. The forward Discover loop asks "what data supports this step?"; this page asks the inverse — "what data do we have that nobody's using?". Reachable from the sidebar (Data → Orphan Assets).
- Useful as a cleanup signal (delete / archive / reassign) and as a fresh-mapping hint (an orphan that looks process-shaped probably belongs on a step nobody's mapped yet). Each row shows the asset, owning system, owner, governance tier, and last-updated date; the name links straight to the asset detail so you can fix the gap in one click.
- The Dashboard's Governance Gaps card surfaces the orphan count alongside the other gap signals — clicking through lands you here.
- The same orphans also carry an **Unmapped** badge on the main Data Assets catalog, and the **Mapping → Unmapped** toolbar filter isolates them there (`/data-assets?mapping=unmapped`) — so you can work the gap from the full registry, not only this dedicated page.

### Business Glossary

- Searchable dictionary of agreed-upon business terms.
- Group by category (Business, Technical, Regulatory, Metric) or alphabetically.
- Industry-specific seed terms based on your organization's industry.
- Approval workflow: Draft → Proposed → Approved → Deprecated.

### Data Dictionary

- Publishable technical catalog of all data assets organized by domain.
- Shows columns, data types, ownership, source connections, health scores.
- Export to CSV, Excel, JSON, or clipboard via the Export button.

### Data Lineage

- Upstream / downstream data flow visualisation. Visualization view has a three-way toggle: Systems (system-to-system flows), Assets (auto-derived asset-to-asset edges), or Both.
- Import dbt manifest — drop a dbt-generated manifest.json. Procela creates or matches a Data Asset for each model, source, seed, and snapshot, then derives asset-to-asset edges from depends_on. dbt tests in the manifest become Data Quality rules automatically (not_null → Completeness/NOT_NULL, unique → Uniqueness/UNIQUE, accepted_values → Validity/IN_SET, relationships → Consistency/CUSTOM).
- dbt Cloud connections — configure account ID, job ID, and API token. Procela pulls the manifest for the latest successful run, on a polling schedule of your choice (Hourly / Daily / Weekly) or on demand via Refresh now. Last refresh time, status, and a relative "next in 4h" hint show in the table.
- Stale-edge detection — auto-derived edges that haven't been re-seen by an import in 30 days are flagged with a STALE badge in the table and rendered as dashed lines in the visualisation. Manual edges are exempt.
- Re-imports are idempotent — assets, edges, and dbt-test rules are matched by stable identifiers and updated in place. Edges and rules removed from the manifest are deleted; user edits to a dbt-derived rule survive the next refresh.

### Data Domains

- Logical groupings of data assets (e.g., Customer Data, Financial Data).
- Assign owner and stewards per domain.
- Option to auto-create a Data Stewardship Team when creating a domain.
- **Sub-domains.** Nest a domain one level deep under a parent (set *Parent domain* on the form, or use *Suggest sub-domains* to have AI propose them). Names are unique **within a parent**, not globally — "Billing" can sit under both Customer and Finance; the structured `code` (e.g. `MFG-02`) is the org-wide handle. A sub-domain with no owner of its own can *inherit the parent's owner* in one click.
- **AI-generated hierarchy.** The *Generate domains* wand builds top-level domains **each with their sub-domains nested**, and shows the whole thing in one editable review tree — accept a suggestion, edit its name/description, add your own, or drop a row, all before applying. The per-domain *Suggest sub-domains* wand opens that same tree seeded with the one existing domain as a locked parent.
- **Navigating the left tree.** The domain index nests each parent with its sub-domains indented beneath it; a parent that has children carries a ▾/▸ caret to fold that branch, with **Collapse all / Expand all** at the top (the fold state is remembered per organization). Long names clip to one line and reveal the full label on hover.
- **Criticality** — mark a domain's business-criticality tier (Tier-1 = council-critical … Tier-4). Tier-1 domains are what the Council Scorecard measures for coverage — the share of your most critical domains that have a named owner.

### Data Quality

- Quality rules per asset / column with dimensions (completeness, accuracy, timeliness, etc.). The Add/Edit Rule form has a **Column picker** populated from the selected asset's columns, so a rule can target one specific column (the bound set) or the asset as a whole; each rule then measures exactly its own column. It also has a **Rule Type** selector — the five connector-measured types (NOT_NULL, UNIQUE, IN_SET, NUMERIC_RANGE, LENGTH_RANGE) with their parameter inputs, plus REGEX_MATCH / CUSTOM (simulated) and an explicit untyped option. Only a *typed* rule is measured — by the on-prem connector or a direct database Connection; an untyped rule stays at "not measured". (Shortcut: on the Quality tab, expand an asset and use a column's Not-null / Unique quick-add buttons, which set the type for you.)
- Weighted scoring rolls up health from **measured** rule results only — both at the asset level and per column. An asset's **Health reads 0%** when no measured rule backs it: health is earned from measured quality, never a connector-freshness or manual stand-in, and the Health column is read-only. On the 360 view, an individual *column* with no measured rule still reads "—".
- **Find quickly:** both the Quality (assets) and Rules tabs have a free-text search box alongside the existing filters — search assets by name/description, or rules by rule name, asset, or column.
- **Where rules run measured:** a local-file (CSV) upload; an on-prem connector — which evaluates the five pushdown-safe types (NOT_NULL, UNIQUE, IN_SET, NUMERIC_RANGE, LENGTH_RANGE) inside the customer network and pushes back aggregate pass/fail counts, no row values leaving the host; **and a direct database Connection**, which now runs those same five types as one aggregate query over the live database. Only the REGEX_MATCH / CUSTOM types (no portable engine support) still return a clearly-labelled **simulated** result that does not move health (the asset is badged "Est").
- dbt tests imported via a manifest become rules automatically (templateId starts with dbt:). Edits to those rules persist across re-imports; removed tests delete their rule.
- Scheduled execution. Set a rule's frequency to Hourly / Daily / Weekly and a background scheduler runs it on that cadence — no cron config, no external orchestrator. Manual `Run now` still works whenever you want an immediate check. Each run persists a snapshot (pass rate, sample failing rows, run timestamp) and updates the asset's health score.
- **Failures auto-create governance issues.** When a scheduled or manual run transitions a rule to FAILING, Procela creates a governance issue in the DATA QUALITY category, severity HIGH, assigned to the domain steward (falling back to domain owner, then asset owner). The issue's `linkedRuleId` marks it as auto-created so a subsequent failing run just updates the existing ticket instead of piling up duplicates. WARNING transitions create the same issue at severity MEDIUM. The assignee sees an ACTION notification in the top-bar bell that links straight to the issue detail.
- **Recoveries auto-close the issue.** When a run flips the rule back to PASSING, the linked issue is auto-resolved with a "rule recovered" summary and the assignee gets an INFO notification. No orphaned tickets, no stale severity signals — the DQ engine tracks the failure through to resolution.

## 6. Systems

### Systems

- Register applications and platforms. Sidebar filter by type (ERP, CRM, GIS, etc.).
- Business criticality rating (High / Medium / Low) with filter.
- Clicking a system name opens the detail modal; inline editing is reserved for the Type column. Rename via the row's Edit pencil.
- Owner, Deputy Owner, and Operators (DAMA: Custodians) per system — the people on the hook day-to-day. Clicking any of those role badges opens the Role Detail drawer for that entity-attached role, so users see the same definition / responsibilities / required-skills view as for DAMA roles.
- Where Used panel shows every data asset, connection, and process touching the system. A Discussion (comments) and History section sit at the bottom of the modal.
- Org scope and inheritance. Same rule as Data Assets — each system is owned by exactly one org (company or division), departments and teams can't own. The + Add system button hides when the active scope is a non-owning level; rows whose owner doesn't match the active Working in… scope carry an Owned by <Org> badge and have their edit / delete affordances disabled with a switch-scope tooltip. The level guard is enforced server-side.

### Connections

- Database, File Storage, API, Data Warehouse, and Spreadsheet connections.
- Test connection (TCP / HTTP probe) and Discover — for a configured direct-connect database (Postgres / MySQL / SQL Server / Oracle) Discover runs a **real** catalog scan (tables + columns), not sample data. From the Discover view, **Reconcile to catalog** matches each discovered table to an existing business Data Asset (suggested by name) or creates a new Bronze one and binds it — a one-click confirm or per-row override.
- Many-to-many: a connection can serve multiple systems.
- **Use a Connection when Procela can reach the source.** Credentials live server-side (encrypted), and Procela's backend makes live outbound calls for Test, Discover, data-quality rule execution, and lineage sampling. Cloud warehouses (Snowflake, BigQuery, Redshift, Databricks), cloud databases with a public endpoint, and internal databases exposed via a VPN / PrivateLink tunnel all belong here.

### On-prem connectors

![Settings → On-prem connectors panel showing at least one paired connector row with an "Online" status chip, a systems column populated with system names, and the "Add connector" button visible top-right. Empty-state or single-row is fine — the point is to show the admin's landing view.](images/connectors-panel.png)

- Small container (`ghcr.io/datalign-technology/procela-connector`) that runs **inside your customer's network** and ships catalog metadata back to Procela over outbound HTTPS. Use it when Procela cannot reach the source database — the classic "our security team won't open inbound firewall rules" case.
- Managed in **Settings → Integrations → On-prem connectors**. Admin creates a connector record with a name and the systems it reports for, receives a one-time 8-digit pairing code, and the operator running the container claims the code on first boot. From then on the connector heartbeats every 60s and scans configured databases every 30 min (both cadences are configurable in the connector's YAML).
- **Freshness states.** Each row shows a live status derived from `lastHeartbeatAt`:
  - **Online** — heartbeat received in the last 30 minutes
  - **Stale** — no heartbeat in 30 min – 4 hours
  - **Offline** — no heartbeat in over 4 hours (fires an in-app notification once per ONLINE→OFFLINE transition)
- **Adapters bundled with the container today**: Postgres, MySQL/MariaDB, SQL Server, and Oracle. Cloud warehouses are intentionally out of scope — they go through Connections.
- **Click a connector row** to open the detail drawer: rename, reassign which systems it reports for, and review the recent-activity timeline (paired, heartbeats, scans, ASSETS_REPORTED with created / updated counts).

![The pairing-code modal after clicking "Add connector" and hitting Generate — an eight-digit code in monospaced type dominates the modal, with the docker run hint underneath. This is what the admin hands (securely) to the operator running the container.](images/connector-pairing.png)

![Animated walkthrough: on Settings → Integrations, clicking "Add connector", naming it, and hitting "Generate pairing code" produces the one-time eight-digit code to paste into the on-prem connector's config.](images/connector-setup.gif)
- **What crosses the wire.** Catalog metadata — table names in `schema.table` form, approximate row counts, last-write timestamps, and any table-comment description — plus aggregate data-quality results (pass/fail counts from pushdown queries). **Connection strings, credentials, and row values never leave the on-prem host.** Every payload the agent sends is auditable in the connector's activity drawer.
- **What Procela does with it.** Each reported table either creates a new **Bronze**-tier Data Asset (which shows up as an Orphan Asset work item for stewards) or updates an existing asset's `lastSyncedAt` and freshness signal (the "Synced N ago" chip). Everything downstream — dashboards, weekly digests, gap detection, orphan lists, AI answers — reads from the same asset table, so connector-sourced data blends in without any feature having to know it came from a connector. (Displayed *health*, though, comes from measured DQ rules — see Data Quality — not from the connector's freshness scan.)
- **Rate-limits and safety rails.** `/pair/claim` throttles at 10/min and 100/hr per IP so the 8-digit code isn't brute-forceable. Tokens are `pct_`-prefixed and stored as SHA-256 hashes; the plaintext is shown once at claim time and never again. Revoke immediately disables a token but keeps the row for audit.

### Connections vs on-prem connectors — which one?

| Question | If **yes** | If **no** |
|---|---|---|
| Can Procela reach the source over the internet (with credentials)? | **Connection** | **On-prem connector** |
| Do you need live column-level discovery on demand (Test / Discover)? | **Connection** | Not on demand — the connector reports metadata on its scan cadence |
| Do you need **measured** Data Quality rules? | Both measure the five supported types (NOT_NULL/UNIQUE/IN_SET/NUMERIC_RANGE/LENGTH_RANGE): a direct Connection runs them as an aggregate query over the live DB; the connector runs them on-prem | Connector measures the five supported types; REGEX_MATCH / CUSTOM simulate |
| Regulatory constraint that no cloud system holds your DB credentials? | **On-prem connector** — credentials stay on-prem | — |

The two are not exclusive. An org can have some sources on Connections and some on connectors; the resulting Data Assets look identical downstream. See the **Frequently Asked Questions** section for the install commands.

## 7. Organizations

The "who" of the platform. The Organizations accordion gathers the four things that act on (or are acted on by) your data: the company tree itself, the humans, the AI agents, and the competencies those actors carry.

### Structure

- Hierarchical company tree (company → division → department → team) that scopes every other page.
- Import from CSV / JSON, tree visualization, "Working in" selector in the header picks the active branch.
- The sidebar label is Structure but the page route is still /organizations and the browser tab reads "Organizations · Procela".
- Deleting an org is a controlled blast. Clicking delete opens a dedicated dialog (not a generic confirm) that walks you through what cascades. The dialog opens with a red "This action cannot be undone" banner and a severity badge — Small / Medium / Large / Catastrophic — computed from the total entity count and number of child orgs. Every affected category (people, processes, data assets, systems, mappings, governance documents, controls, etc.) is listed with both the count and up to three sample names ("47 mappings — Bills→Customer Master, Outages→SCADA, +44 more") so you can see exactly what you're about to delete, not just a number. Each category gets a per-category action picker (Delete / Move to… / Orphan; orphan is only allowed for People and Processes), a "default for everything" picker that bulk-applies one action, a live tally at the bottom, and a type-DELETE confirmation gate. An Export org snapshot button in the footer downloads a JSON archive of every entity the delete would touch — recommended before any Large or Catastrophic delete as a recovery aid.

### People

- Team members with app roles (Super Admin, Org Admin, Editor, Contributor, Viewer).
- Import from CSV. Columns: Name (required), Email, Role, Title, Org (optional). An Org value on a row lands that person in the named org — either a full path (Tidewater Utilities > Tidewater Electric > Power Generation) or a single unique name; rows without the column fall back to the "Default org" picked in the import dialog. The People export emits the same Org column so a single-file enterprise-wide round-trip preserves which org each person belongs to.
- Click any role chip on a person's profile to open the Role Detail drawer.
- Filter by skill. The toolbar's Skill dropdown narrows the roster to people who hold a given competency — the workflow for staffing a new initiative or backfilling an unqualified activity. Combines with the existing governance-role and org-tree filters.
- Skill gaps column. Shows the number of activities where this person is the Responsible owner but doesn't hold the required skills. Zero means they're fully qualified for every activity they're on; any non-zero value is a backlog item, and the cell tooltips with the activity names so you know what to address (assign someone else, or get the person the missing skills).

### Agents

- AI agent registry for governance execution — pipelines, bots, service accounts.
- Agents can hold governance roles too (e.g., an automated DQ agent as Data Quality Analyst), which is why they sit alongside People rather than in a separate "automation" bucket.
- **Filter like People.** The page carries the same org-tree sidebar (with per-org counts and an "All (N)" row), a Search box, and a Governance Role filter, so you can narrow the registry by organization and by DAMA role. There's no App-role filter — agents are non-human actors and carry no application login role, only governance roles.
- **Responsible-person invariant.** An agent can only carry the ACTIVE status when it has a valid responsible person. The Status picker greys out ACTIVE until a person is assigned; imports and freshly-created agents land as PAUSED. If the responsible person is later cleared, deleted, or deactivated, every active agent they own auto-transitions to PAUSED and a HIGH-severity OWNERSHIP issue opens against the org so the work re-surfaces. Reactivating the person doesn't auto-restart the agent — a lead has to review, confirm the ownership is right, and flip the status back.

### Skills

- Catalog of competencies attached to people. Seed standard DAMA-aligned skills with one click.
- The Role Detail drawer reads from this catalog to show "Skills typically needed" for each governance role — chips appear solid when the skill is in your org's catalog, dashed if not yet seeded.
Skills drive four cross-page workflows:

- Qualified-person check. On a Process activity, if the responsible person's skillIds don't cover the activity's requiredSkillIds, an amber warning chip appears next to the skill picker spelling out which skills are missing. The same gap shows up as a "Skill gaps" column on the People table.
- Find people by skill. A skill filter on the People page lets you narrow the roster to everyone who holds a given competency — useful when staffing a new initiative or backfilling an unqualified assignment.
- Recommended role assignees. The Role Detail drawer surfaces a "Best-matching people" list, ranked by how many of the role's required skills each person already holds (case-insensitive name match).
- Skill-gap report on the dashboard. The Skill Gaps section ranks the org's most under-staffed required skills (required-by-activities vs held-by-people), with critical "no coverage" calls flagged in red.

## 8. Governance

### Governance Program (on Get Started)

- The program has **no page of its own** — its four-phase tracker, lifecycle, and Next Actions live on the **Get Started** hub (Section 1), as the **Govern** and **Operate** stages. Every check reflects work done elsewhere and deep-links there; the stage you're on is named by the stage line (Stage X of 4) and each carries a plain **"n / m done" count**, not a percentage. (The old /governance-program URL redirects to /setup.)
- **No single overall percentage.** A live roll-up of all the checks could move *down* when your catalog changed (e.g. adding an unowned domain), which read like a regression. Get Started shows honest axes instead: the **lifecycle status** (a badge + a Planning → Active → Paused → Completed strip) and each stage's own count.
- **Foundation authoring lives on its own page.** Scope (in / out), guiding principles, and operating model are edited on **Governance → Foundation**; the Govern stage's *Governance foundation* item deep-links there. (Same underlying program record — the checks update as you save.)
- Governed lifecycle: the program status (Planning → Active ↔ Paused → Completed, with explicit Reopen) is changed from the **lifecycle bar on Get Started**, can only be changed by an admin / program owner, follows a fixed transition path (no backward slides or skips), and every change is written to the audit log with the actor and an optional reason. Phase 1 (Foundation) must be complete before the program can go Active — the Launch button is disabled until it is — and launching with Phases 2–4 incomplete pops a confirmation listing exactly what's missing and records it as an early launch. Because Foundation is the prerequisite, you can also launch from the Governance → Foundation page once it's complete. The actual go-live is captured as a Launched date (set the first time it goes Active, kept through pause/resume) and shown next to the status. A program marked **Completed** still counts as launched, so completing it never drops the tracker back below done.

### Governance Groups

- Hierarchical governance bodies: Council → Office → Committee → Stewardship Teams → Working Groups → Communities of Practice.
- Generate the standard DAMA structure with one click. Explore Recommendations suggests additional groups based on your data domains.
- Per group: an Expected Roles panel lists the governance roles the group should have, the required vs optional split, and current fill status. Click any role label to open the Role Detail drawer.
- Org-aware fill status. A role counts as filled when it's held anywhere in the org — the same scope the Governance Roles page assigns at — not only by a current member of this group. Each holder chip shows their relationship to this body: teal = on the group, amber = holds the role org-wide but isn't a member yet, with an inline + add to group to bring them on. So a role assigned on the Roles page is recognised here, and assigning here writes the same org-scoped assignment — the two pages stay consistent in both directions.
- Domain assignments inline. For roles where the question is meaningful — Data Owner, Domain Owner, Data Steward, Domain Steward, Business Data Steward, Data Architect — each holder gets a sub-line under the chip strip listing the data domains they own and/or steward (e.g. "Alice: owns Customer, Billing · stewards Outage"). If a holder of a domain-scoped role has no domains attached at all, the line renders "no data domains assigned" in red so the gap is visible without leaving the page. Read straight from the DataDomain entity — assigning or removing a domain owner/steward elsewhere (Data Domains page) updates this line on the next fetch.
- Two remove actions are distinct: the x on a role chip removes that specific role assignment; Remove from group in the members table removes the person from the group entirely (their role assignments survive at the org level).
- Open full composition → on any selected group jumps to the Group Composition page (/governance-groups/:id) — one cohesive surface that combines members, expected-role gaps, decision rights this body owns, policies tied to it via member roles, the calendar cadence, and a snapshot of RACI assignments. Each role chip shows the typical RACI letter(s) the role holds on common decisions, so you can see at a glance what each role is accountable / responsible / consulted / informed for without opening the drawer.
- Group role vs governance role. These are two independent things and the members table calls it out: a person's group role (Chair, Member, Secretary…) is just their seat on this body and has no RACI effect; their governance roles (Data Owner, Steward, CDO…) are the org-wide DAMA roles that drive RACI and ownership. Someone can be a group Member with no governance role, or hold a governance role without sitting on any group.

### Roles (with RACI Matrix tab)

- Single page with two tabs: Assignments and RACI Matrix. RACI is a view derived from role assignments, so editing and inspection live together.
- Assignments tab. Role-first catalog of DAMA governance roles (CDO, Data Governance Lead, Data Owner, Stewards, etc.). The left sidebar lists every role with its live holder count — filled or not — and clicking one filters the page to that role. The main area always shows the full role slate: filled rows list the holders inline; unfilled rows are flagged with an Unfilled marker and an inline + Assign. A search box matches role label, person, or organization. This page tells the same story as the Governance Groups expected-role slate — the roles always exist; assignment is what varies.
- Collapsible categories & roles. Roles are grouped under Executive, Business, and Technical; each category header has a chevron that collapses the whole section. Individual role cards have their own chevron that hides the holder list while keeping the header visible so unfilled / required gaps still surface. Expand all / Collapse all controls at the top of the catalog flip everything at once. Defaults to fully expanded; when a single-role filter is active the controls hide since there's only one card to show.
- Typed scope on every holder row. Each holder shows a small kind tag next to their scope — ORG (indigo), DOMAIN (green), SYSTEM (red), ASSET (blue), or UNKNOWN (amber) — followed by the resolved name. So a Data Architect attached to the Customer Data domain reads as DOMAIN: Customer Data instead of a raw UUID, and a System Owner reads as SYSTEM: SCADA. An UNKNOWN tag with "unresolved" copy means the scoped entity has been deleted — the same dangling-reference signal we use on the Data Mapping page.
- Per-domain gap rows. For domain-scoped roles (Data Owner, Domain Owner, Data Steward, Domain Steward, Business Data Steward, Data Architect), each role card has a footer panel listing every data domain in the org that currently has no holder of this role scoped to it. So if Tidewater has Customer Data, Operational Data, and Regulatory Data, and only Customer Data has a Data Owner, the other two appear as amber chips under Unfilled for 2 domains. Mirrors the per-person "no data domains assigned" line we ship on the Governance Groups page, just from the role-side perspective.
- Click any role chip anywhere in the app to open the Role Detail drawer — plain-language summary, day-to-day responsibilities, typical RACI authority, groups that need the role, current assignees in your org, and required skills.
- Best-matching people. The Role Detail drawer surfaces a ranked list of people who already hold the most of the role's required skills (case-insensitive name match against the org's Skills catalog). Each row shows a matched / required score chip — green ≥ 0.75, blue ≥ 0.5, amber below — and clicking a row jumps to that person's profile. Use this when a role's Unfilled: the drawer tells you who in the org is already closest to qualified rather than guessing.
- The drawer also covers entity-attached roles — System Owner, Deputy System Owner, System Custodian, Data Asset Owner / Steward, Data Domain Owner / Steward. The drawer shows a "Per system / asset / domain" scope badge so users understand two people can both hold the same entity-attached role for different entities without it being a RACI violation.
- RACI Matrix tab. Responsibility assignments per process activity: Responsible, Accountable, Consulted, Informed. Auto-derived from process / asset ownership and governance group membership; click a cell to cycle R → A → C → I → clear as a manual override. Validation warnings surface RACI rule violations (no R, no A, multiple A's). Export to CSV / Excel / JSON respects active filters and hide-empty-columns setting.
- Old /raci deep links still work — they redirect to the RACI tab.

### Decision Rights

- Document who Decides, Recommends, Approves, and is Informed for each governance decision.
- Sidebar of categories with counts; search box matches decision name, description, decider, or escalation path.
- Rows are collapsible: default view shows decision + category + decider, click a row to reveal the full R / A / C / I and escalation panel.
- 10 seed decisions (approve policy, grant exception, close issue, etc.) ship out of the box.

### Governance Documents (was Policies)

- The unified home for every formal governance document with a lifecycle — Charter (program scope / principles), Framework (overarching structure), Standard (naming conventions / data type rules), and Policy (the rule-shaped subset). A segmented filter at the top of the page lets you focus on one type or see all.
- Each row carries a documentType badge plus the existing status, review cadence, owner, and category. Codes are auto-generated and per-type — CHA-001, FRW-001, STD-001, POL-001 — so the code itself tells you what kind of document you're looking at.
- Controls hang off Policies only. The expanded controls panel only opens for rows with documentType: Policy — charters and frameworks don't have rule-shaped controls and the panel stays hidden for them.
- Controls have a type (Preventive / Detective / Corrective) and an automation mode (Human / Agent / Hybrid).
- This used to be called Policies and was scoped to rules only. The canonical path is /governance-policies (what the sidebar links to); /governance-documents also resolves as an alias. Sidebar label is now Documents under the Governance section.
- If you previously ran the Generate governance processes wand, it used to seed 15 "governance Data Assets" — Charter, Policies, Standards, Glossary, Domain Catalog, etc. A one-time startup migration moves the four real documents (Charter, Data Policies, Data Standards, Access Control Policies) into Governance Documents with the right type, and deletes the rest because they were either duplicates of existing entities (Glossary, Domains, Lineage, DQ Rules, Issues, Tasks) or generated outputs (reports, communications) that were never really stored data.

### Documentation (Manual + Procedures)

- Single page with two tabs — the Manual answers "what does each role do?", the Procedures tab answers "how do I do task X?".
- Manual tab. Role-specific runbooks for the 10 governance roles, with daily / weekly / monthly / quarterly activities and escalation paths.
- Procedures tab. Step-by-step SOPs for common governance activities. 5 seed SOPs (onboard data asset, quality incident, access request, escalation, quarterly review).
- Old /operations-manual and /sops deep links still work — they redirect to the right tab.

### Governance Calendar

- Recurring events (Council meetings, Committee syncs, stewardship huddles) with cadence options weekly through annual.
- Auto-generates governance tasks per attendee when an event occurs.

### Tasks & Issues

- Tasks — workflow states (Draft → Open → In Progress → Pending Review → Completed), priority, assignee, due dates.
- Issues — 9 types (Metadata, Data Quality, Classification, Ownership, Policy, Access, Lineage, Compliance, Workflow), severity levels.
- Steward onboarding: auto-creates 4 tasks when a steward role is assigned (7 / 14 / 21 / 90-day milestones).
- **Automatic overdue detection.** An hourly background sweep writes a *"Task overdue: …"* warning to the notifications bell for any task with a due date in the past that's still OPEN / IN_PROGRESS / PENDING_APPROVAL — to the assignee, or org-wide if the task is unassigned. It's idempotent (it stamps a task after firing and re-arms only when the due date moves forward or the task reopens), and `POST /api/v1/governance-tasks/sweep-overdue` runs the same check synchronously on demand.

### Governance Exceptions

- **A register of time-boxed waivers at Governance → Operate → Exceptions.** An exception records that a policy or control has been deliberately waived for a stated reason until an expiry date — the auditable alternative to a control quietly going unmet.
- **Grant one** with a title (what is being waived), an expiry date, and an optional reason. New exceptions start Active.
- **Past-expiry is the signal.** An exception that is still Active after its expiry date is flagged in red and counted at the top of the page — those are what the governance council watches, and they feed the *Exceptions past expiry* measure on the Council Scorecard. Renew (reopen with a new date) or Close each one.
- **Close / reopen / delete.** Close an exception once the underlying gap is fixed; reopen if it recurs. Granting and changing exceptions is limited to users with governance-write permission.

### Enterprise View

- Single pane of glass across processes, systems, data assets, domains, and people.
- Per-type filter dropdowns. A filter bar at the top carries one dropdown per entity type — Processes, Systems, Data Assets, Domains, People. Each button shows how many of that type are shown ("Systems · 3 of 8", or "Hidden"); open it for a searchable checkbox list of every entity of that type. Check the ones you want (one, several, or all), or use Clear (hide) to drop the whole type and Select all to bring it back. So you can narrow the picture to, say, two systems and the processes and data around them, or hide People entirely. The filter applies to both the Cards and the Diagram view.

![Animated walkthrough: opening the Systems filter dropdown and unchecking a few systems narrows the diagram to just the selected ones and the processes and data around them.](images/enterprise-view-filter.gif)
- Diagram / Cards toggle — opens on the Diagram view by default. The diagram lays nodes out as horizontal swimlanes with curved, colour-coded edges between them — the same visual language as the Process ↔ Data Map. Within a lane, nodes cluster under sub-group headers: process nodes group under their value stream, and data assets group under the system (or domain) that holds them. Relationships are coloured by type — mapping links reuse the Process ↔ Data Map palette (green produces, blue consumes, purple transforms, grey references/uses), with distinct colours for hosted-by, governs, owned-by, lineage, and contains — and a legend beneath the canvas names the ones in view. Cards is the dense, searchable alternative (a summary-tile grid with a search box).
- Process depth — drill up or drill down. A Depth control (Value Streams · Processes · Sub-processes · Activities) sets how deep the process tree renders. Drill up to see just the value streams or processes for a clean executive overview; drill down to the activities for the full picture. Crucially, when you drill up, the data and system links that live on the deeper levels don't disappear — they roll up onto the nearest visible ancestor, so a process shows all the data its activities touch even while the activities are hidden. Each process that has hidden children shows a "＋N" caret (in the diagram and in the detail panel) to drill into just that one branch while the rest stay collapsed; click it again (or the − caret) to collapse it back.
- Connect from the view. Selecting a process node adds a bridge into authoring: an activity offers Connect data / system →, which opens the Data Mapping editor with the value stream → process → activity chain pre-filled so you only pick the data asset; higher levels offer Open in Process ↔ Data Map → to drill down there.
- Governance value streams are excluded by default. The canvas opens on the operational picture; when the catalog has governance value streams (Data Governance Management, etc.), an Include governance toggle appears to fold them back in — the same domain classifier the Process ↔ Data Map filters on.
- Hide unconnected. On the diagram, a Hide unconnected toggle drops any node that has no visible edges under the current filter, so the canvas focuses on what's actually wired together rather than a field of stranded nodes.
- Click any node to run impact analysis — the sidebar impact rail lists every entity connected to your selection (direct and transitive), and unrelated nodes fade out. Use this to plan changes ("if we deprecate System X, which processes are affected?").
- What happened to Control Tower? The operational dashboard view folded in here. Old /control-tower deep links redirect to Enterprise View.

### Analysis (cube)

- Drag-and-drop pivot builder. Drag a dimension into Rows, another into Columns; the grid below shows how many distinct relationships connect each pair. Seven dimensions ship: Systems, Data Assets, Domains, Processes, Roles, People, Connections. Reachable from the sidebar (Insights → Analysis) and from Dashboard Quick Actions.
- Distinct-pair counting. Cell counts are the number of unique (row, column) relationships that exist — not the number of underlying facts that touch both dimensions. So if a system↔connection link is described by both a direct join AND a downstream data-asset binding, it counts as one relationship, not two. Row / column totals become "how many columns / rows this axis value participates in". Drill-down still lists every underlying fact if you want to see them.
- Starter pivots. Before you've configured anything, the empty state offers one-click examples (Data Assets by System, Roles by Person, Assets by Domain, Processes by System) so you can see a result immediately instead of facing a blank palette.
- Sub-group. Drag a second dimension into either zone to create a nested grouping (max 2 per axis). The grid renders the parent label with a merged cell spanning all its sub-rows / sub-columns, so e.g. Systems > Data Assets on rows shows each system once with its assets indented underneath.
- Pivot. The pivot button between the Rows and Columns zones swaps everything in one click — useful when you want to flip a tall report into a wide one without re-dragging.
- Drill down. Click any cell count to open a side panel listing the underlying records (asset facts, role assignments, mappings, ownership rows, etc.).
- Filter. Click any row label or column header to add that value as a filter; chips appear above the grid and can be removed individually. Each filter narrows the cube to facts that match that dim/value.
- Saved reports. Save your (rows / columns / filters) configuration with a name and description. Reports are org-visible; only the owner can rename or delete their own. The active dims are also mirrored to the URL so direct links are shareable without saving. Saved pivots live on this page; for the new schema-driven Report Builder catalog, see Review → Reports → My Reports.
- Export. The full grid exports to CSV, Excel, JSON, or PDF (browser-print) with row/column totals included. Sub-group labels are flattened with “ / ” separators in the export.

### Reports

- The Reports page is the report catalog + Report Builder — build, save, and open reports against Procela's data model. It used to carry Executive Report and Scorecard tabs; both were removed, so there's no tab bar any more. (Cube pivots live on their own page at Explore → Analysis.)
- Audit log full export. The Audit Log page (Insights → Review → Audit Log, `/audit-log`) filters by org, entity type + id, and user, and caps the on-screen result size for responsiveness. It offers two CSV exports: Export view dumps what's currently loaded (post-filter, capped at the page limit) for ad-hoc review; Full log (CSV) hits the server endpoint that bypasses the cap and includes the `entryHash` column for chain-integrity verification offline. Use the second one for compliance reviewers asking for "everything in this org for the last N months".
- My Reports + Report Builder. Build a report against Procela's logical data model — pick a starting entity (Processes, Data Assets, Systems, People, Mappings, Domains, Roles, Skills, Organizations), choose columns directly on that entity or joined columns from a related entity (e.g. Responsible Person → Name, Required Skills → Name), add filters with op-aware value inputs (enum dropdowns, number coercion), set sort, and preview live as you type. Save with a name and visibility (Shared with org / Private to me); saved reports show up on the My Reports tab with metadata (primary entity, column count). Edit at /reports/builder/:id; new at /reports/builder.
- Gap Detection. Cross-cutting view of unmapped activities, ungoverned assets, ungoverned columns (a column an asset is bound to but has no quality rule — coverage you claimed but never measure), ownership gaps, low-health assets, unowned domains, orphaned assets, unlinked assets, unassigned people, and duplicate asset names. Drill-down everywhere: the four summary cards at the top (Total Gaps / Critical / Warning / Informational) scroll to the first matching section when clicked; each row inside a section is a hyperlink that opens the affected item on its source page so you can fix the gap in one click — Unmapped Activity rows jump to the Process Catalog with the node highlighted, asset rows jump to Data Assets, person rows open the person's profile, and so on.

### Council Scorecard

- **A monthly governance report at Insights → Review → Council Scorecard.** Each child division reports four measures that roll up to an enterprise total, plus two narrative sections — the council's per-division report card.

![Council Scorecard for Tidewater Utilities: four measure tiles (Tier-1 coverage, Classification, Open issues, Exceptions) above a per-division table. Three divisions with nothing to assess show a neutral grey "No data" status; the enterprise rollup row shows "Behind". A primary "Save snapshot" button sits at the top right.](images/council-scorecard.png)
- **The four measures are auto-derived from live data:** Tier-1 coverage (share of Tier-1 domains with a named owner), Classification (share of assets with a sensitivity classification), Open issues over 30 days, and Exceptions past expiry. Each division's row is computed over its own subtree; the **Enterprise** row is a true rollup — computed across the parent's whole subtree, not an average of the divisions. Status per row (On track / Behind / At risk) is derived from the measures against their targets; a division with nothing to assess yet — no governed domains, no classified assets, and no open issues or exceptions — reads a neutral **No data** rather than being flagged Behind.
- **Targets are configurable per tenant.** The four thresholds — coverage %, classification %, max aged open issues, max past-expiry exceptions, and the open-issue age in days — ship with sensible defaults (80 / 70 / 0 / 0 / 30) and can be tuned by an org admin under **Settings → Data → Council Scorecard targets**. A change re-derives the live scorecard on its next load; already-saved snapshots keep the targets they were frozen with. Set on a company org, the bar applies to its divisions.
- **Two narrative sections are auto-drafted:** "What moved this month" from the last 30 days of governance activity (audit log), and "For the council" from current risk facts (Tier-1 domains without an owner, exceptions past expiry, unclassified assets). Both carry an *auto-derived* chip until edited.
- **Edit & override (CDO / Data Governance Lead only).** Those two roles — or an org admin — can override any derived cell or the narrative. Overrides are per-cell: the machine value is preserved underneath and an overridden cell is marked, so the council always sees what was adjusted. A cell can be reset back to its derived value.
- **Save versions.** *Save snapshot* freezes the current derived-plus-overridden scorecard as an immutable version for the period — one click straight from the read-only view, no need to enter edit mode first (the *Publish snapshot* button does the same from inside Edit & override). If a snapshot for that period already exists, Procela asks whether to **Replace existing** (overwrite that version in place, keeping its identity but refreshing the numbers) or **Save as a new snapshot** (keep both, as a separate dated version). The version-history panel reopens any past month read-only. Saving, replacing, and editing are recorded in the audit log.

### Dependency Enforcement

Governance pages show prerequisite banners when prior steps haven't been completed.
 For example, the RACI page shows "Create domains and governance groups first" until those exist.

## 9. Security & Account

Procela ships with a layered sign-in stack — federated SSO, second-factor authentication, brute-force defences, and admin controls for credential lifecycle. Most of these are configurable per deployment; the defaults are sensible for a prototype but production deployments will want to set the env vars called out below. All settings below live under Settings unless noted; the credential-lifecycle admin actions live on the Person detail page.

### Sign-in providers

- Dev Mode (default) — email + optional name, no credential check. For local development only; production refuses to start with a warning if it's still active.
- Local credentials — email + password stored on the Person record as Argon2id hashes. Includes forgot-password by email, admin-set passwords, forced password change on first login, and a one-click Migrate everyone to Local action that generates temporary passwords for distribution.
- OIDC (Microsoft Entra ID, Okta, generic) — Authorization Code + PKCE flow, JWKS-verified id_tokens, multi-IdP per install. Admins add and rotate providers in Settings → Authentication. Each provider can be scoped to specific email domains so the login page only offers the right buttons for the user typing their address.
- SAML 2.0 — SP-initiated single sign-on for ADFS, Shibboleth, PingFederate, and any IdP that speaks SAML. Configured via SAML_ENTRY_POINT, SAML_ISSUER, SAML_IDP_CERT, and SAML_CALLBACK_URL. The IdP can import Procela's SP metadata directly from GET /api/v1/auth/saml/metadata — entity ID, ACS, and both SLO bindings are declared there.

### Two-step verification (TOTP)

Open Settings → Two-step verification and click Set up two-step verification. Procela renders a QR code plus the underlying secret; scan it with Google Authenticator, 1Password, Authy, or any TOTP app, then enter the 6-digit code to confirm enrolment. On success you get a one-time display of 10 backup codes — save these somewhere safe (the panel offers a download button); they're the only way to sign in if you lose your authenticator. A nudge appears when fewer than 3 codes remain so you can regenerate before you're locked out.

Once enrolled, every password sign-in is held back until you produce a TOTP code (or a backup code) on the prompt that follows. Admins can reset another user's enrolment on the Person detail page Security panel; the user is then forced through enrolment again on their next sign-in.

### Security keys (WebAuthn / FIDO2)

Hardware keys (YubiKey, Titan, Feitian) and platform authenticators (Touch ID, Windows Hello, Android fingerprint) work as either a second factor alongside TOTP or a passwordless first factor. Register a key under Settings → Two-step verification → Security keys — Procela asks for a friendly label so you can tell devices apart later. You can register multiple keys.

- At sign-in, the password prompt offers Sign in with a security key — picking it runs the WebAuthn discoverable-credential ceremony and skips email + password entirely.
- If you have both TOTP and a security key enrolled, either one satisfies the MFA gate; the prompt at sign-in lets you pick.
- Admins can clear all registered keys for a user from the Person detail page Security panel.

### Active sessions

Settings → Active sessions lists every device or browser you're signed in from. Each row shows the device hint (parsed from the User-Agent), the IP at sign-in, the auth provider, and a relative "last used" timestamp. Your current session is tagged with a This device badge.

- Revoke on a single row invalidates that session's refresh token — that device gets booted to the login screen on its next API call. Other devices keep working.
- Sign out everywhere kills every session including the one you're on. Use this if you've lost a device or want a clean slate.
- Refresh tokens are bound to the IP subnet (/24 for IPv4, /64 for IPv6) and User-Agent they were minted with — a stolen refresh token replayed from a different network is rejected automatically.
- Refresh tokens rotate on every use: when your access token expires and the client renews it, the old refresh token is revoked and a new one issued. A stolen token is only useful until the legitimate client next refreshes.

### Account lockout & CAPTCHA

Three layers of brute-force defence sit in front of the credential verifier:

- IP rate limiter — 5 sign-in attempts per minute per (IP, email) pair, 20 per hour. Blocks bursts from one source.
- Per-account lockout — 10 failed attempts inside a 30-minute window locks the account for 30 minutes. Catches distributed credential-stuffing where each attempt comes from a different IP. Defaults adjustable via LOCKOUT_THRESHOLD / LOCKOUT_WINDOW_MS / LOCKOUT_DURATION_MS. Admins can clear a lockout immediately from the Person detail page Security panel after positively identifying the user via another channel.
- CAPTCHA challenge — after 3 failures from one IP in 15 minutes, every subsequent sign-in from that IP must include a verified CAPTCHA token. Procela uses hCaptcha when HCAPTCHA_SITE_KEY + HCAPTCHA_SECRET are set; without them an "I'm not a robot" checkbox stands in for dev testing.

### Idle-session timeout

After VITE_IDLE_TIMEOUT_MINUTES of no mouse, keyboard, scroll, or touch activity (default 30; SOC 2 / HIPAA controls typically want 15) Procela signs you out automatically — even if your access token is still valid. A one-minute warning banner with a Keep me signed in button precedes the actual logout. The countdown is shared across browser tabs, so activity in any tab keeps every Procela tab alive.

### Per-org role assignments (admins)

A Person can hold a different role in different orgs — Process Owner in Operations, Viewer in Finance, ORG_ADMIN in their own department. On the Person detail page, every assigned-org chip carries an inline role pill. An asterisk on the pill indicates the role is inheriting from the person's default; clicking opens a dropdown where you can set a per-org override or revert. Switching the Working in… scope in the header re-mints your access token with the role for the new org so authorisation gates update immediately.

### SCIM 2.0 provisioning (IdP admins)

Procela exposes SCIM 2.0 endpoints under /scim/v2/ so Microsoft Entra, Okta, and other identity providers can push user lifecycle events automatically — create on hire, deactivate on offboard, role updates as people move teams. The IdP authenticates with a long-lived bearer token configured via SCIM_BEARER_TOKEN; paste the same value into both Procela and the IdP's provisioning config. Supported resources are /Users and /Groups with full filter / PATCH / soft-delete semantics. When the token isn't set, every SCIM request returns 401.

### Reset everything — start over (super admins)

Below the Backup & Restore card on the Settings page, super admins
 see a Reset everything control that performs a true factory
 reset: every organization, person, process, data asset, system,
 mapping, governance record, comment, and audit-log entry is deleted.
 The next sign-in starts the onboarding wizard for a brand-new
 organization. The confirmation phrase is the literal word
 RESET; the panel also surfaces a one-click Export now
 shortcut so you can save a recovery backup before nuking anything.

![Settings page on the Data tab, one of four tabs (General, Sign-in & Security, Integrations, Data). The Data tab opens with "Data classification regimes" (CUI, ITAR, Export-Controlled toggles) at the top, then "Council Scorecard targets" (editable thresholds for coverage, classification, open issues, exceptions, and open-issue age), then Backup & Restore, and finally Load demo data and Reset everything.](images/settings-data-tab.png)
 A single ALL_DATA_RESET audit entry is written
 immediately after the wipe so the reset itself is traceable.

### GDPR — right to be forgotten (admins)

The Person detail page Security panel has a Forget person… action that runs the GDPR Article 17 cascade. The Person record is deleted and every reference across the catalog — ownership, stewardship, group membership, authored comments, role assignments — is scrubbed. Audit log entries authored by that user are tombstoned, not deleted, so the action history survives but the personal identifier is replaced with [deleted]. The confirmation modal requires you to type the literal phrase FORGET <email> to defend against muscle-memory triggers. The response summarises how many stores and rows were touched.

### Audit log integrity

Every entry on the Audit Log carries a SHA-256 hash chaining it to the previous entry's hash. The Verify integrity button at the top of Insights → Audit Log walks the chain on demand: green means no entry has been altered, reordered, inserted, or deleted since it was written; red points at the first broken row so you can investigate. The chain survives the GDPR redaction pass because hashes are re-computed from the first modified entry onward.

### At-rest encryption for secrets

TOTP secrets, OIDC client secrets, and SMTP passwords can all be stored encrypted at rest. Set MFA_ENCRYPTION_KEY (32+ chars random) for the local AES-256-GCM backend, or KMS_PROVIDER=aws-kms|azure-kv|gcp-kms with the matching cloud config for envelope encryption via AWS KMS, Azure Key Vault, or GCP KMS. To put an encrypted SMTP password or OIDC client secret in .env, POST the plaintext to /api/v1/auth/encrypt-secret (admin-only) and paste the enc:v1:… envelope it returns. Procela decrypts at boot.

## 10. Cross-cutting Features

A handful of components show up on every detail page so the patterns stay the same as you move around the app.

### Comments & @mentions

- Threaded comments on every major detail surface: System, Data Asset, Person, and per-node on the Process Catalog. One level of replies; deeper threading is a known follow-up.
- Typing @ in the composer opens a popover of people in the active org. Arrow keys move selection; Enter or Tab inserts the full name; Escape closes. Cmd/Ctrl + Enter submits the comment.
- Each new @mention spawns an in-app notification for that person with a link back to the entity. Email notifications are a future follow-up.
- Authors can edit or delete their own comments; deletes are soft so thread structure stays intact.
- Comment events appear in the Activity feed under the affected entity, with verbs like "commented on" / "edited a comment".

### Activity feed

- Same component in three lenses. Org-wide on the Dashboard's Recent Activity widget; per-entity on the System / Data Asset / Process node detail pages; per-person on the People profile.
- Rows phrase events as English ("Eleanor created System SAP Finance &middot; 5m ago") with the actor's name, the action verb, and the affected record. Comments use conversation verbs; CRUD events use create/update/delete.
- Backed by the audit log; comments, role assignments, and dbt imports all flow through it so the timeline is the single source of truth for "what changed and who changed it".

### Notifications

- The bell in the top bar surfaces in-app notifications: @mentions in comments, tasks assigned to you, issues you've been flagged on, policy reviews coming due, and weekly digest deltas (see below).
- Click the bell to open the dropdown. Each row links straight to the source entity — the click marks it read on the way through.
- Mark all read clears the unread state without deleting; Clear all deletes every notification with no undo and is a two-click action (the first click arms it with a 3-second countdown, the second confirms). Per-row x dismisses a single notification.
- Escape or clicking outside closes the dropdown. The unread count refreshes whenever you navigate, so a notification arriving while you're on another page surfaces when you come back.
- Weekly digest. Procela snapshots the gap signals shown on the Dashboard (mapping coverage, orphan assets, ungoverned-in-use assets, ownerless processes) and diffs them week-over-week. When something meaningful changes, the bell gains a notification with a one-click link to the affected page — "3 new orphan data assets this week" links to Orphan Assets, "Mapping coverage dropped to 72%" links to the Process ↔ Data Map, "2 new ownerless processes" links to the Process Catalog. The thresholds are conservative — small noise (one orphan promoted, one mapping added) doesn't ping anyone. The first run for an org is a baseline and writes nothing; subsequent runs compare against the previous snapshot. A built-in scheduler fires it automatically — on the first hourly tick after Sunday 23:00 UTC each week, walking every org — with the last-fired timestamp persisted so a restart in the window doesn't double-notify; `POST /api/v1/digest/run` still triggers a one-off run on demand. Set `PROCELA_DISABLE_SCHEDULERS=1` on every replica except the one designated to run scheduled work so jobs fire once cluster-wide rather than once per replica.

### List rows — clipped text with hover tooltip

Description and long-name columns on every list surface (Systems, Data Assets, Skills, Data Lineage, Business Glossary, Data Dictionary, Agents, Data Quality, Connections) clip to a single line with an ellipsis. Hover the cell to see the full text in a native browser tooltip. The pattern keeps rows a uniform height so downstream columns don't shift when one row's description is a paragraph — the whole content is still available, it's just gated behind a hover.

### Large lists — pagination

List pages cap how many rows render at once so a large org's roster or catalog stays fast and the page stays a fixed height (one scrollbar). Once a list runs past the page size, a numbered pager appears at the bottom: an "N–M of T" count, First / Prev / page-number / Next / Last controls, and a Rows-per-page selector. Lists default to 15 rows per page and let you switch to 15 / 50 / 100 / 200. Sorting, searching, filtering, and select-all still operate over the whole result set — only how many rows mount at a time is capped, and the pager snaps back to the first page whenever a filter changes the result size. Every shared list table gets this automatically — People, Systems, Data Assets, Business Glossary, Data Dictionary, Connections, Skills, Agents, and the Audit Log all use the same pager. Small lists that fit on one page show no pager at all.

### Saved views

- Capture the current sidebar / search / group-by state on a list page under a name, then recall it later. The Views button sits in the page header next to Export.
- Eight list pages support saved views: Data Assets, Systems, Connections, Data Dictionary, Decision Rights, Governance Roles, Business Glossary, and People.
- Views are org-visible — everyone in the org sees views saved by anyone. Only the owner can delete or rename their own.
- Tree-based pages (Organizations, Process Catalog, Governance Groups) don't have saved views because their state isn't a flat filter set.

### Role Detail drawer

- Click any role chip or label anywhere in the app to open the side drawer. Works for both DAMA roles (CDO, Data Owner, Stewards) and entity-attached roles (System Owner, Custodian, Asset Owner, Domain Steward).
- Each role has a plain-language summary, day-to-day responsibilities, typical RACI decision authority, governance groups that need it (DAMA only), current assignees in your org, and required skills.
- Required-skill chips render solid when the skill is in your org's Skills catalog and dashed-italic when it isn't yet, with a hover tooltip explaining what's missing.

### Discussion drawer integration

The Comments panel and Activity feed live together on every detail surface, with the Role Detail drawer accessible from any role chip. Together they answer "what is this record, what's changed, and who am I talking to about it" without leaving the page.

### Ask AI assistant

![AI assistant chat panel opened on the right side of the app. A question like "Where are our data gaps?" is visible in the input, and an in-flight or completed answer shows below with at least one clickable entity citation (a coloured name link) and, ideally, a green pill-shaped "Open" navigation chip at the end of the reply.](images/chat-panel.png)

- The Ask AI button in the top bar is the single entry point to a chat panel grounded in your organization's actual catalog. What the assistant can see, and answer from: the process tree (value streams / processes / activities), systems, data assets, activity ↔ data mappings, activity → system declarations, data connections with their linked systems, the business glossary, governance documents (charters / frameworks / standards / policies), open governance issues and tasks, data-quality rules (passing / failing / not measured), data domains, people, and the gap signals (orphan assets, ownerless processes, low-health assets, learning-loop dismissals). Everything the assistant reads comes from this snapshot, so it won't fabricate rows that don't exist in your org.
- Streaming replies. The assistant types the answer as it generates — no "Thinking…" wait for the full response. Useful for long answers (full gap analyses, multi-step recommendations).
- Inline citations. When the assistant names a real entity from your catalog ("Unused billing ledger", "Look up patient record", "SAP Finance"), the name becomes a clickable link that takes you straight to the entity's page. Longest-name match wins, so "Customer Billing Master" links to the asset rather than fragmenting into "Customer" + " Billing Master".
- Page navigation chips. When the answer is best resolved on a specific page, the assistant ends the reply with a green pill-shaped "Open" chip — e.g. asking about orphans drops an *Orphan Assets →* chip; asking about coverage drops a *Process ↔ Data Map →* chip. Clicking it navigates straight there. The chip is constrained to a fixed allowlist of Procela pages, so a hallucinated path renders as plain text rather than a broken link.
- Starter prompts. The empty chat offers four one-click examples — "Where are our data gaps?", "Which assets are below 80% health and linked to critical processes?", "Which data assets do we have that no process uses?", "Which systems run our customer-facing processes?" — chosen to exercise both the gap signals and the Phase 3 surfaces (orphans, system declarations).
- Minimize, don't close. Click the `–` in the panel header (or the Ask AI top-bar button) to minimize the panel and keep working — the conversation is preserved across minimize / restore cycles for the life of the browser tab. A small message-count badge appears on the Ask AI button while a conversation is paused so you can see it's waiting; click the button to resume. Use New chat in the panel header to clear history and start fresh; that's the only way to reset the conversation.
- Scope. The active Working in… org is sent with each turn, so the assistant answers about *this* organization. Switch orgs in the header and the next question re-grounds to the new scope. The scope walk is the same one the rest of the app uses — a division user sees rows inherited from the parent and rolled up from children, so the assistant sees the same rows you do on the Systems / Data Assets pages.
- What it won't do. It doesn't take destructive actions (delete, change ownership, transition status); for now it answers and points, you act. The page-navigation chip is a one-click handoff; deeper "do it for me" actions stay manual.
- **Turning AI off.** Every AI integration feature — this assistant, industry-template generation, the data/asset suggestions, the sensitivity classifier, and the AI governance agents — is gated behind a single deployment switch, `AI_FEATURES_ENABLED` (default on). Set it to `false` and the whole AI surface disappears: the backend refuses the AI endpoints and the frontend hides their entry points (the Ask AI button, "Suggest" actions, template wizard, AI settings panel, and the "Perform with agent" trigger). It's the one knob an on-prem or FedRAMP deployment flips to run Procela without ever calling an external model — the rest of the platform works unchanged. Existing sensitivity tags stay visible, and the Agents registry stays available (only the AI *execution* trigger is gated).

## 11. Key Concepts

### DAMA Framework

Procela follows the DAMA (Data Management Association) framework for data governance. The governance
 structure, roles, and processes align with DAMA best practices.

### Org scoping and inheritance

Every value stream, data asset, and system is owned by exactly one org. Only the company and division levels can own — departments and teams inherit visibility from above but can't themselves be owners. The org you pick in the Working in… header decides which artefacts you see and which you can edit, following the same rule everywhere in the app.

- Visibility rolls down, never sideways. Scoping to Tidewater Water shows Water-owned artefacts plus everything owned at Tidewater Utilities (the parent company). Sibling divisions (Electric, Shared Services) don't show up. Scoping to the parent company shows the full rollup view — Water, Electric, Shared Services and the company-owned artefacts together.
- Editing is local. A row whose owner doesn't match the active scope renders with a small lock badge next to the name and its edit / delete / inline-cell affordances are disabled. Hover the lock to see who owns it — "Owned by Tidewater Utilities. Switch the Working in… scope to Tidewater Utilities to edit." The same rule applies whether the row is inherited from above (a Water user seeing a corporate asset) or rolled up from below (a corporate user seeing a Water asset). The badge used to spell out "Owned by X" inline; a wall of the parent org's name repeated on every inherited row was noise, so it collapsed to a lock icon that says the same thing — read-only from your current scope — with the tooltip surfacing the org name on demand.
- Create flows enforce the rule on both ends. The + Add value stream, + Add data asset, and + Add system buttons hide when the active scope is a department or team, and the backend rejects a direct API call with a non-owning orgId with a 400. For value streams there's a second guard: generating operational processes at a multi-division company is blocked (with one-click Switch to: <Division> chips in the warning) because each division should own its own process catalog. Governance processes are exempt from that second guard — corporate governance is one enterprise-wide program by design, so the Generate governance processes wand still works at the parent.
- Cross-division links warn before saving. Linking a Water activity to an Electric asset (sibling divisions, neither an ancestor of the other) pops a confirm — the reference almost always means the wrong asset was picked. Cross-axis links to shared parent-company assets (a Water activity using the corporate Customer Master) go through silently because the asset is in scope by inheritance.

### Plain English vs. DAMA terminology

The user menu (click your name / avatar in the top-right corner) has a Plain / DAMA toggle under Display preferences that flips jargon-heavy labels between business-friendly and canonical DAMA wording. Plain is the default so business users aren't met with unfamiliar terms; data professionals can switch to DAMA mode for the formal vocabulary.

- Custodian (DAMA) ↔ Operator (Plain)
- Governance Tier (DAMA) ↔ Trust Level (Plain)
- Uncertified / Managed / Certified ↔ Untrusted / Managed / Trusted

### Trust Level (Governance Tier)

- Untrusted (Uncertified) — Catalogued but not yet governed. No formal ownership or quality rules.
- Managed — Owner and steward assigned, basic quality rules in place.
- Trusted (Certified) — Fully governed, audit-ready data with complete documentation.

### Governance Roles

Click any role chip anywhere in the app to open the Role Detail drawer for a full breakdown of what each role does.

- Strategic / Executive: Chief Data Officer (CDO), Data Governance Lead
- Business accountability: Data Owner, Business Data Steward
- Technical: Technical Data Steward, Data Architect, Data Engineer, Database Administrator
- Specialty: Data Quality Analyst, Data Custodian (Operator)

### Automation Modes

- Human — Task performed entirely by a person.
- Agent — Task performed by an AI agent.
- Hybrid — Agent recommends, human approves.

### Export formats

Every list page has an Export button with format choices: CSV (open in any spreadsheet), Excel (.xlsx with proper types and sheet names), JSON (re-import or feed to the AI assistant), and Copy to clipboard (paste straight into Sheets / Numbers / a doc).

## 12. Frequently Asked Questions

### What is Procela?

Procela connects your business processes to the data and systems that support them, giving you a single
 place to define how the business works, assign ownership, and govern data quality across every level.

### Where did the Governance Program page go?

It was folded into **Get Started** (`/setup`) — the old `/governance-program` URL now redirects there. The 4-phase
approach (Foundation, Structural Design, People & Processes, Operationalization) is now the **Govern** and **Operate**
stages of the Get Started journey, with the lifecycle bar (Planning → Active → Paused → Completed) and Next Actions
right there. Progress is tracked automatically from your actual data as a per-stage "n / m done" count — there's no
single overall percentage, because that number could move backward as your catalog changed. Phase 1 groundwork
(scope, guiding principles, operating model) is authored on the **Governance → Foundation** page.

### How do SOPs work?

Open Governance → Documentation and switch to the Procedures tab. Standard Operating Procedures are step-by-step guides for common governance activities. You can seed 5 standard SOPs or create your own. Each step includes a description and estimated time.

### Why is "Add value stream" or the Process Wizard hidden?

The Process Catalog only lets you create value streams at the company or division level, and it blocks the parent if the company has divisions in its subtree. The two cases:

- The active org is a department or team. Pick a parent (company or division) from the Working in… header.
- The active org is a multi-division company (e.g. Tidewater Utilities with Electric / Water). Generating operational processes at the parent would silently create one shared catalog the divisions don't actually share. The banner on the page lists the divisions as one-click Switch to: chips, so you can drop into one without going back to the header. The Working in… dropdown also lists divisions nested under their parent company. The Generate governance processes wand stays available at the parent even when divisions exist — corporate data governance is intentionally one enterprise-wide program, not a per-division thing.

Read-only surfaces (Visualize, Compare, Export) stay available even when create is blocked. Single-tier companies with no divisions keep working normally at the company level. The same guard applies to the Process Wizard, so navigating to /processes/wizard with a blocked scope shows the same banner there.

### Why can't I edit this data asset (or system)?

The row carries an Owned by <Org> badge — its owner is a different org from the one you're scoped to. The list shows it because visibility rolls down (corporate assets are visible to every division) and up (the parent rolls up everything below), but edits are local: you can only edit a row from the scope where it's owned. Hover the disabled Edit pencil for a switch-scope tooltip, or use the Working in… dropdown directly. Sibling divisions never see each other's rows, so if you're scoped to Tidewater Water you'll never see a Tidewater Electric asset at all.

### Why am I being warned about a cross-division link?

You're linking a process activity to a data asset whose owner org is on a different vertical axis from the activity's value-stream org — typically a Water activity reaching for an Electric asset when both are scoped from the parent company. Cross-division references almost always mean the wrong asset was picked; the warning is your chance to pick again. Confirming the warning creates the link normally (it's a warn, not block), so genuine shared dependencies can still be modelled. Same-axis links — a Water activity using the corporate Customer Master at the parent company — don't trigger the warning because the asset is in scope by inheritance.

### Where did Control Tower go?

Control Tower folded into Insights → Enterprise View. The operational dashboard view — open issues, active tasks, policy coverage, automation rate, coverage gaps across domains / assets / processes — is being reworked as a preset there. Old /control-tower deep links redirect automatically.

### I used to open Operations Manual or SOPs directly — do those links still work?

Yes. Both surfaces now live under Governance → Documentation as tabs. Old /operations-manual and /sops bookmarks redirect to the right tab, and shareable links use a ?tab= query param so you can deep-link to a tab.

### How do I open the RACI Matrix?

Open Governance → Roles and switch to the RACI Matrix tab. RACI is a derived view of role assignments, so editing assignments and inspecting RACI now sit together. Old /raci links redirect to the matrix tab.

### How do I publish a Data Dictionary?

Go to Data → Data Dictionary. Filter by domain, classification, or trust level if needed, then click the Export button and choose Excel, CSV, JSON, or copy to clipboard.

### How do I learn what a governance role does?

Click any role chip or label anywhere in the app — on Governance Groups, on the Governance Roles page, on a person's profile. A side drawer opens with the role's plain-language summary, day-to-day responsibilities, typical RACI decision authority, the governance groups that need it, who currently holds it in your org, and the skills typically needed.

### How do I switch between plain English and DAMA terminology?

Click your name / avatar in the top-right corner of any page to open the user menu, then flip the Plain / DAMA toggle (alongside the Cozy / Compact density toggle). Plain is the default; the choice persists in your browser. It flips labels like Custodian / Operator, Governance Tier / Trust Level, and Uncertified / Untrusted across the app.

### Why are there two ways to remove someone from a governance group?

The x next to a role chip removes one role assignment (the person stays in the group). Remove from group in the members table is the destructive option — the person leaves the group entirely, but their governance role assignments at the org level survive.

### How do I automate lineage from dbt?

Go to Data → Data Lineage → + Connect a dbt Cloud job. Fill in your dbt Cloud account ID, job ID, and an API token. Set the polling schedule to Hourly / Daily / Weekly (or leave Manual). Procela pulls the manifest from the latest successful run of that job and reconciles models, edges, and dbt tests into the catalog. The same flow works as a one-off via Import dbt manifest if you'd rather upload manifest.json by hand from dbt Core.

### What's a "stale" lineage edge?

An auto-derived edge (dbt) whose lastSeenAt is older than 30 days — meaning no recent import has confirmed it still exists. Stale edges render as dashed lines in the visualization and get a STALE badge in the table. Re-import the manifest to clear them, or remove them manually if the upstream model is genuinely gone.

### How do I save a filtered view of a list page?

On a list page with the Views button (Data Assets, Systems, Connections, Data Dictionary, Decision Rights, Governance Roles, Business Glossary, People), set your filters, click Views, then + Save current filters as view and name it. Views are org-visible; only the owner can rename or delete their own.

### How do I mention someone in a comment?

Type @ in any Discussion composer. A popover appears with people in the active org; arrow-key or click to pick one. The mentioned person sees an in-app notification with a link back to the comment.

### Why does Custodian on a system look different from Data Custodian on the Governance Roles page?

They're different roles. System Custodian is the technical caretaker of one specific system — per-system scope. Data Custodian (DAMA) is an enterprise-level role covering data storage, security, and access broadly. Click either badge to open the Role Detail drawer, where the scope badge ("Per system" vs. nothing) and the responsibilities list make the difference clear.

### Can I undo a delete?

Yes — when you delete a single item (data asset, system, person), a toast notification appears with an
 "Undo" button. Click it within 6 seconds to restore the item.

### What governance framework does Procela follow?

Procela follows the DAMA (Data Management Association) framework for data governance. Roles, groups,
 processes, and the governance hierarchy are all aligned with DAMA best practices.

### Where is my data stored?

Your data lives in a **PostgreSQL** database that Procela manages. Deployment is flexible: in the cloud it
 runs on a managed PostgreSQL service (Amazon RDS), and for on-premise installs it runs on PostgreSQL inside
 your own environment (self-hosted or a customer-managed, RDS-compatible database) — the same application,
 pointed at your infrastructure.

Key protections:

- **Multi-tenancy.** Every record carries an organization identifier, and that scope is enforced on every
 query, so one organization's catalog, data assets, and mappings are never visible to another.
- **Encryption.** Data is encrypted in transit (TLS) and at rest. Database credentials and API keys are held
 in a secrets manager, never hard-coded in the application.
- **Backups & recovery.** The database is backed up automatically with point-in-time recovery, so data can be
 restored after an incident.
- **Auditability.** Every create, edit, and delete is written to an append-only audit log tied to the
 authenticated user, and that log is queryable and exportable for compliance.

Source-system data (the databases and warehouses you connect to) is **not** copied into Procela. Procela stores
 your business definitions and the catalog metadata it discovers — table names, row counts, freshness — while the
 underlying records stay in your systems. See **What's the difference between a Connection and an on-prem
 connector?** below for how that metadata is gathered.

### What's the difference between a Connection and an on-prem connector?

A **Connection** is Procela reaching **into** your source system — you give Procela a host, port, and credentials, and Procela's servers make live outbound calls to your database. It's the right choice when Procela can route to the source (cloud databases, VPN-tunnelled internal databases, warehouses like Snowflake). It supports the richest feature surface today: Test, Discover, data-quality rule execution, live column-level introspection.

An **on-prem connector** is a small container that runs **inside your network** and reaches **out to** Procela over HTTPS. It's the right choice when Procela cannot route to your database — the classic "our security team won't open inbound firewall rules" case. It ships catalog metadata (table names, row counts, freshness) plus aggregate data-quality results (pass/fail counts); connection strings and row data never leave the on-prem host. Today it supports Postgres, MySQL/MariaDB, SQL Server, and Oracle; more adapters are added case-by-case.

An org can use both — some sources on Connections, some on connectors — and the resulting Data Assets look identical downstream. See **6. Systems → On-prem connectors** for the freshness-state and pairing details.

### How do I install the on-prem connector?

1. In Procela, open **Settings → On-prem connectors → Add connector**. Give it a name (e.g. `warehouse-prod`), pick which Systems it should report assets for, and click **Generate pairing code**. You'll see an 8-digit code valid for 10 minutes.

2. On the host that will run the connector (a VM inside your network with outbound HTTPS to Procela), create `/etc/procela/connector.yaml`:

    ```yaml
    procelaUrl: https://procela.example.com/api/v1
    pairingCode: "12345678"          # remove after first successful pair
    heartbeatSeconds: 60
    scanSeconds: 1800

    sources:
      - type: postgres               # or: sqlserver, mysql
        name: warehouse-prod
        connectionString: postgres://procela_ro:PASSWORD@db.internal:5432/warehouse
        schemas: [public, analytics]
        systemId: sys_warehouse_prod
    ```

3. Pull the image and start the container. `:0.3.0` and `:latest` are both fine; pin to a specific semver for production.

    ```bash
    docker pull ghcr.io/datalign-technology/procela-connector:0.3.0
    docker run --restart unless-stopped \
      -v /etc/procela/connector.yaml:/etc/procela/connector.yaml \
      ghcr.io/datalign-technology/procela-connector:0.3.0
    ```

4. Within ~60 seconds the row in **Settings → On-prem connectors** flips from "Awaiting first heartbeat" to **Online**. After the first scan (default 30 min) the affected Data Assets pick up **Synced N min ago** chips.

The container rewrites the YAML with the issued token on first pair and drops the pairing code. If the mount is read-only (common in production), the token is printed to stdout instead — paste it into the config under `token:` and restart.

For Kubernetes / systemd / ECS deployment shapes, see the connector README bundled in the source repo. `PROCELA_PAIRING_CODE=…` as an environment variable also works on first boot if you'd rather not put the code in the file.

### I lost my authenticator app. How do I get back in?

Use one of the backup codes you saved at enrolment — the sign-in MFA prompt has a Use backup code instead link. Each code is single-use. If you've burned through them, an admin can reset your two-step verification from the Person detail page Security panel; you'll be re-enrolled on your next sign-in. If you registered a security key, you can also use that to sign in passwordlessly and then re-enrol TOTP from Settings.

### Why am I being asked to confirm I'm human?

Three failed sign-in attempts from your network inside 15 minutes flips the CAPTCHA gate on for that IP. A successful sign-in clears the counter; the gate also lifts automatically after the window passes. If you're seeing it without having mistyped, someone else on the same network may be hammering the login — the gate is doing its job.

### My account is locked. What now?

10 failed sign-ins inside a 30-minute window lock the account for the next 30 minutes. Wait for the auto-unlock, use the password-reset link to set a new password (success there clears the lock), or ask an admin to clear it manually from the Person detail page after verifying you over another channel.

### I see a session in Active sessions I don't recognise.

Click Revoke on that row — the device gets booted to the login screen on its next API call. Then change your password from Settings (or use the forgot-password flow if you've forgotten it). If multiple unknown sessions show up, hit Sign out everywhere to invalidate everything in one shot and re-sign in from a known device.

## 13. Keyboard shortcuts

Procela has a small set of keyboard chords for the things you'll do most often. Press `Shift + ?` anywhere to open the full reference in-app.

| Keys | Action |
|---|---|
| `/` or `Ctrl / Cmd + K` | Open the command palette |
| `Shift + ?` | Show all keyboard shortcuts |
| `g` then `d` | Go to Dashboard |
| `g` then `o` | Go to Organizations |
| `g` then `p` | Go to People |
| `g` then `c` | Go to Processes |
| `g` then `a` | Go to Data Assets |
| `g` then `s` | Go to Systems |
| `g` then `m` | Go to Data Mapping |
| `g` then `l` | Go to Data Lineage |
| `g` then `q` | Go to Data Quality |
| `g` then `g` | Go to Governance Foundation |
| `g` then `r` | Go to Reports |
| `g` then `e` | Go to Enterprise View |
| `g` then `h` | Go to Help |
| `Escape` | Close the palette, drawers, modals, and dropdowns |
