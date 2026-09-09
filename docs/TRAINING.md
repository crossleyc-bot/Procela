# Procela Training Guide

A hands-on walkthrough of Procela. The exercises below use the
fictional **Tidewater Utilities** demo fixture that ships with the
platform — a mid-size investor-owned utility with electric, water,
and shared-services divisions. Every module works the same way
against your own organization once it's loaded: same pages, same
buttons, same expected behaviours. Swap the sample names for yours.

By the end you will have:

- A populated environment with two utility divisions (electric + water)
  and shared services
- Defined business processes for each division
- Linked data assets, systems, ownership, and skills
- Exercised every value-loop feature Procela ships with
- Built a real cross-entity report and watched the gaps you'd care
  about light up

Plan on **90 minutes** end-to-end the first time through. The setup
phase (Module 1) is a one-time cost; modules 2–9 can be done in any
order once setup is complete.

---

## Prerequisites

| Item | What you need |
|---|---|
| **Running dev environment** | Backend on `:3001`, frontend on `:5173` (`npm run dev` from the repo root) |
| **Signed in** | As a `SUPER_ADMIN` or `ORG_ADMIN` so you can import and create |
| **Fresh data store** | Recommended for a clean walkthrough. Use **Settings → Reset everything** to wipe before starting (super-admins only) |
| **Test data files** | `test-data/utility/` — already in the repo |

---

## Module 1 — Load the data (10 min)

This is the foundation. Every subsequent module assumes the org tree,
systems, and people listed below have been imported.

### 1.1 Organizations

1. Navigate to **Organizations** (left nav).
2. Click **Import** in the page header.
3. Paste the contents of `test-data/utility/organizations.csv`.
4. Leave the **Parent** dropdown blank (these are top-level orgs).
5. Click **Import**.

You'll see the whole hierarchy appear:

```
Tidewater Utilities (company)
├── Tidewater Electric (division)
│   ├── Power Generation
│   ├── Transmission & Distribution
│   ├── Electric Customer Service
│   ├── Electric Engineering
│   └── Electric Asset Management
├── Tidewater Water (division)
│   ├── Water Production
│   ├── Water Distribution
│   ├── Wastewater Operations
│   ├── Water Customer Service
│   └── Water Engineering
└── Shared Services (division)
    ├── Information Technology
    ├── Finance & Accounting
    ├── Human Resources
    ├── Regulatory Affairs
    └── Safety & Environmental
```

### 1.2 Systems

1. Set the **Working in…** picker (top of every page) to **Tidewater
   Utilities**.
2. Go to **Systems** → **Import**.
3. Paste `test-data/utility/systems.csv`. Import.

You'll get ~25 systems: SCADA, GIS, CIS, AMI, hydraulic modelling,
plus shared corporate systems (ERP, HRIS, data warehouse).

### 1.3 People

People are imported **one file per department**. Set the *Working in…*
picker for each, then import:

| File | Scope to |
|---|---|
| `people-executives.csv` | Tidewater Utilities |
| `people-data-owners.csv` | Tidewater Utilities |
| `people-electric.csv` | Tidewater Electric |
| `people-water.csv` | Tidewater Water |
| `people-shared-services.csv` | Shared Services |
| `people-electric-generation.csv` | Power Generation |
| `people-electric-td.csv` | Transmission & Distribution |
| `people-electric-customer.csv` | Electric Customer Service |
| `people-electric-engineering.csv` | Electric Engineering |
| `people-electric-assets.csv` | Electric Asset Management |
| `people-water-production.csv` | Water Production |
| `people-water-distribution.csv` | Water Distribution |
| `people-water-wastewater.csv` | Wastewater Operations |
| `people-water-customer.csv` | Water Customer Service |
| `people-water-engineering.csv` | Water Engineering |
| `people-it.csv` | Information Technology |
| `people-finance.csv` | Finance & Accounting |
| `people-hr.csv` | Human Resources |
| `people-regulatory.csv` | Regulatory Affairs |
| `people-safety.csv` | Safety & Environmental |

### 1.4 Agents

1. Working in… **Tidewater Utilities**.
2. **Agents** → **Import** → paste `agents.csv`.

Five agents land — one of each type (AI, PIPELINE, BOT,
SERVICE_ACCOUNT, OTHER) so you see the shape of the concept without
being buried in owner-assignments. Extend the CSV once the model
clicks.

Every imported agent arrives as **Paused**. That's not a bug —
Procela enforces a *responsible-person invariant*: an agent can only
be Active when it has a real person assigned as accountable for its
behaviour. Assign a Responsible Person to each row, then flip the
Status from Paused to Active. Use these picks — they match the
imported roster and the accountability shape you'd expect in a real
utility:

| Agent | Type | Responsible Person | Why this person |
|---|---|---|---|
| Outage Prediction Model | AI | **Amara Wambui** (Manager Data & Analytics) | Owns ML models against operational data |
| AMI Meter Ingestion Pipeline | PIPELINE | **Kwame Osei** (Lead Data Engineer) | Pipeline delivery is his team |
| Customer Notification Bot | BOT | **Samira Farooq** (Manager Contact Center) | Customer-facing bot; contact-center accountable |
| PI Historian Service Account | SERVICE_ACCOUNT | **Tobias Reinholt** (Manager OT Cybersecurity) | Non-human identity into OT/SCADA lands with OT security |
| Compliance Report Generator | OTHER | **Isabella Rossi** (Manager Water Compliance) | NPDES/DMR filings are water-compliance owned |

Try setting an agent to Active *without* picking a person first —
the option is greyed out and the form warns you inline. That's the
invariant in action.

Later, if you delete or deactivate one of the people above on the
**Organizations → People** page, every active agent they own
auto-pauses and a governance issue opens. Look for the *"N active
agents were auto-paused"* toast; the issues land in **Governance →
Tasks & Issues** with severity HIGH for a lead to pick up.

### 1.5 Seed the skill catalog

1. Navigate to **Organizations → Skills**.
2. Click **Seed standard skills**.

About 40 DAMA-aligned skills will land. The catalog feeds the qualified-
person checks you'll exercise in Module 6.

### Checkpoint

- Switch *Working in…* to **Tidewater Electric**. The People count in
  the left nav should drop to electric-division staff.
- Switch to **Tidewater Water**. Same again, different roster.
- This is **multi-tenant scoping** in action — every read filters by
  the active org.

---

## Module 2 — Get oriented (10 min)

### 2.1 The Working in… picker

Top of every page. This is the single most important control in
Procela. It scopes *everything* — what you see, what you can edit,
what AI runs against. Spend a minute switching between **Tidewater
Utilities**, **Tidewater Electric**, and **Tidewater Water** and
watching the Dashboard KPIs recompute.

### 2.2 Dashboard

The Dashboard's **Overview** strip shows the live KPI tiles. Each is a
hyperlink:

- **Value Streams** / **Processes** → Process Catalog
- **Data Assets** → Data Assets page
- **Systems** → Systems page
- **Coverage** → Data Mapping (where unmapped activities + unlinked
  assets surface)
- **Avg Health** → Data Assets sorted by health ascending (worst at
  top)

The personal **My Dashboard** strip at the top has its own four tiles
— also hyperlinks — that scope to the signed-in user:

- **Open Tasks** → Governance Work (Tasks tab)
- **Open Issues** → Governance Work (Issues tab)
- **My Domains** → Data Domains (the ones you own or steward)
- **Upcoming Events** → Governance Calendar

Sub-counts surface when relevant (e.g. *"3 overdue"* in red under
Open Tasks). Zero-count tiles fade the number but still link through.

Below the KPIs the Dashboard shows its state as charts, not just
numbers:

- **Governance Posture** — a tier-mix donut (Certified / Managed /
  Uncertified assets) beside semicircular **Coverage** and **Avg
  Health** gauges.
- **Trends** — sparklines of Coverage, Avg Health and Open Gaps over
  the last several weeks, each with a ▲/▼ delta; the headline matches
  the live Overview tile.
- **Governance Gaps** — the open gap signals as a critical-vs-warning
  severity bar over a list of counts, each linking to its fix.
- **Catalog Shape** — bars for the size of each process level (Value
  Streams → Processes → Sub-processes → Activities).

**Make it yours.** Click **Customize** to reorder each section
(arrows), set its width **Half** (two-up, tighter) or **Full** (own
row), and show/hide it. The layout is saved automatically per browser;
**Reset to Default** restores the shipped importance-ordered
arrangement.

Skim the rest of the page: **Program Maturity** (current governance
phase), **Skill Gaps** (more on this in Module 6).

### 2.3 The org tree

Open **Organizations → Structure**. The visualization shows the full
hierarchy you imported. Click any node — counts on the right pane
recompute, drill into a division or department to see its people.

### 2.4 People

Open **Organizations → People** with *Working in…* set to **Tidewater
Electric**. You should see the electric-division roster only. Try:

- The **Skill** filter (top toolbar) — narrow to everyone who holds a
  given competency
- The **Skill gaps** column (right side) — currently `—` for everyone
  because activities don't have required-skill data yet. We'll come
  back to this in Module 6.

### 2.5 The Get Started page

Open **Get Started** in the sidebar (the page is titled **Set up
Procela**). It's a resumable, data-driven journey from an empty org
to a running governance program, in **one spine** of four stages:
**Capture → Assign → Govern → Operate**. Onboarding the org (Capture,
Assign) and standing up the program (Govern, Operate) are the same
path, not two separate tracks.

Across the top, the program's **lifecycle** — Planning → Active →
Paused → Completed — governs the whole arc. Its valid next transitions
(*Launch*, *Pause*, *Complete*, *Reopen*) are buttons right there,
role-gated and audited; **Launch stays disabled until Foundation
(Phase 1) is complete**, and once the program goes live its actual
**Launched** date shows next to the status. A one-line **stage summary**
("Stage X of 4 · <name>") names where you are; there's deliberately
**no overall %** (one number mixing "added my systems" with "program
launched" just oscillates). A **four-column board** then lists each
stage's items with **HERE / AUTO** source badges — *Here* = you define
it in Procela, *Auto* = derived from your catalog — and every row
deep-links to where the work happens. *Operate* reads strictly
top-to-bottom: *Program launched* only ticks once the structure and
roles & policies it depends on are in place. Below the board,
**Next Actions** lists the board's still-unchecked items in stage order
(HIGH for the current stage, NEXT for later ones).

There is no separate Governance Program page — the four-phase program
tracker (Foundation → Structure → People → Operations), its lifecycle,
and Next Actions all live here on Get Started, with **Governance →
Foundation** for scope, principles, and operating model. (The old
`/governance-program` URL redirects to `/setup`.)

By default (the **Auto** setting) the sidebar entry auto-hides once you
reach 100% across **all four stages** — i.e. once the program is stood
up and running, not merely when the org is onboarded. You can change
this under **Settings → Get Started guide** with an
**Auto / Always / Hidden** control — *Always* keeps the entry pinned
even after you finish, *Hidden* removes it entirely. That choice is a
global, per-user preference: it follows you across every organization
rather than being set per org. Nothing else on the platform is gated by
finishing the stages — you can drive straight to the Process Catalog
from a fresh org — but the hub makes it obvious what's still missing.

### 2.6 Where's Help?

The Help button lives in the **top bar next to Ask AI**, not in
the sidebar. Clicking it opens the guide in a popup window so
you keep whatever page you were on. The Training Guide follows
the same pattern, and a **Product roadmap ↗** button on the Help
guide's header opens the live product roadmap — rendered from
`docs/ROADMAP.md`, the single source of truth. Direct-URL deep
links (like `/help#connectors` and `/roadmap`) still resolve.

---

## Module 3 — Define processes (15 min)

### 3.1 AI-generated process hierarchy for Electric

1. *Working in…* → **Tidewater Electric**.
2. Navigate to **Processes** → click the wand (**Generate processes**).
3. Procela calls Claude with the active org context. After 10–30
   seconds, a preview hierarchy appears.
4. Review: you should see electric-utility value streams — Outage
   Management, Generation, Transmission & Distribution, Customer
   Operations, Regulatory Compliance.
5. Click **Apply**.

### 3.2 Same wand, different division

1. Switch *Working in…* → **Tidewater Water**.
2. **Processes** → wand again.
3. Different output: Water Treatment, Distribution, Wastewater
   Operations, Customer Operations.

That's the active-org context driving Claude differently — same code
path, different result. The first run for each (industry + org) pair
hits Claude live; subsequent runs return the cached result instantly.
The badge on the review screen says *Specialised: <Org>*.

### 3.3 Walk the catalog

With *Working in…* on **Tidewater Electric**:

- Expand a value stream → process → sub-process → activity.
- Click an **Activity** node. The right panel shows level-specific
  fields: Owner, Responsible Role, Responsible Person, Systems,
  Required Skills, Inputs/Outputs, Status, Frequency, Risk Level.
- Concrete example — on an **Outage Management → Outage triage**
  activity, set:
  - **Responsible Role** = `System Operator Lead`
  - **Responsible Person** = **Melissa Patel** (System Operator
    Lead, T&D) — search "Melissa" in the picker
  - **Owner** = **Harold Lindstrom** (Manager Distribution Control
    Center)
  - **Systems** = SCADA + OMS
  - Save.
- The **Status lifecycle** is Draft → Active → Deprecated. Click the
  status pill to advance it — leave this one on Active.

### 3.4 Inputs / Outputs panel

On the same activity, click **+ Add Input** in the I/O panel. The
segmented picker has three tabs:

- **Data Asset** — operational data this activity consumes
- **Governance Document** — a charter / policy / standard the activity
  references
- **Attachment** — uploaded file or URL

Try adding a Data Asset (we'll create some in Module 4).

### 3.5 Dependencies

Expand any **Activity** in the catalog and scroll to the
**Dependencies** panel — two columns, *Predecessors* and
*Successors*. This is where you declare "what has to run before
this activity" and "what this activity unblocks."

Try it on the **Outage Management → Outage triage** activity from
Module 3.3:

1. Add a Predecessor: *Field crew dispatched* (or the closest
   preceding activity the wand generated).
2. Add a Successor: *Customer notification sent*.

Watch what the platform enforces:

- **Cycles are blocked.** Try adding *Customer notification sent*
  as a Predecessor of *Outage triage* — Procela rejects it with
  *"Adding this flow would create a cycle. Use a LOOP-type flow if
  the cycle is intentional."*
- **Cross-value-stream warnings.** Adding an activity from a
  different value stream tags the row with a small amber
  `CROSS-STREAM` chip — legal (some dependencies really do cross
  streams), but usually a wrong pick.
- **Delete cascades.** When you delete an activity, every
  dependency edge touching it goes with it. No dangling references.

The compact `←N →M` chip on collapsed activity rows in the tree
shows incoming/outgoing counts at a glance.

### 3.6 BCM + measurable-target attributes

Switch the tree view to **Advanced** (top of the Process Catalog).
Several extra fields appear on each Activity, right below Automation
and Estimated Duration:

| Field | What it's for | Try on *Outage triage* |
|---|---|---|
| **Criticality** | Business-continuity tier | *Tier 1 — Mission critical* |
| **RTO (hours)** | Recovery Time Objective — how fast must it recover? | `4` |
| **RPO (hours)** | Recovery Point Objective — how much data loss (in time) is tolerable? The BCM pair to RTO | `1` |
| **Trigger** | What initiates the activity (Scheduled / Event-driven / Upstream completion / Manual / External request) | *Event-driven* |
| **Volume** | Processing scale / throughput — Frequency is cadence, this is *how much* | *~200 outages/yr* |
| **Target / SLA** | Measurable target / SLA (this one field absorbed the former separate *Success Measure* and *SLA Target*) | *Field crew on site within 30 min; P95 30 min from detection* |

Then scroll one more field down to **Controls** — a multi-select
tied to the controls you defined on **Governance → Documents**. If
you haven't defined any controls yet, the picker reads *"Define
controls on Governance Documents first"* — a small hint pointing
you to the right page rather than leaving you guessing.

Add one control if you have any defined (e.g. NERC CIP-007 R2.1
from your Governance seed). Delete that control later on Governance
Documents and watch this picker — the chip disappears
automatically. No dangling references.

Activities also carry free-form **Compliance tags** (SOX, HIPAA,
GDPR, …). The *set you can pick from* is curated per tenant under
**Settings → Data → Compliance frameworks**, so each org tags
against the frameworks it actually answers to — add your own, or
reset to the built-in list. (For the tighter policy↔execution loop,
prefer Controls above; Compliance tags are the lightweight label.)

Why this matters: a regulator asking *"what's the RTO and RPO for
outage triage?"* now gets a real answer from the platform — recovery
speed and tolerable data loss as a pair, the way a BCM/DR plan states
them. Dashboards can group activities by criticalityTier. And the
Controls link closes
the loop between a policy definition and the concrete work that
implements it — the reverse view (which activities implement this
control?) is available from Governance Documents.

### 3.7 Change-management review workflow

For enterprise buyers, "who approved this?" isn't optional. Switch
your org into review mode and watch the workflow appear:

1. Go to **Settings → Process & Asset Lifecycle**. The picker is a
   three-way segmented control: **Simple** (default), **Review**,
   **Advanced**. Click **Review** and confirm the switch.
2. Back on the Process Catalog, find an **Active** activity (e.g.
   *Outage triage*) and change its status pill to **Draft** — you'll
   need to make it draft to trigger a change cycle.
3. Edit any field (say, bump the RTO from 4 to 2 hours).
4. Click the status pill again — the only option is **Pending
   Review**. Pick it. A yellow banner drops with a text box asking
   *"What are you changing?"* Type "Tightened RTO after Q3
   incident review" and click **Submit for review**.
5. Watch the status pill change to **Pending Review** and a yellow
   banner appear on the row: *"Pending review — submitted by
   Melissa Patel · 2 min ago"* with your comment underneath.
6. Open the notifications bell — a new item lands:
   *"Change submitted for review: Outage triage"*.

Now switch to a different user (e.g. Harold Lindstrom, Melissa's
manager) and act as reviewer:

7. Open the same activity and click the status pill. Two options:
   **Active** (approve) and **Draft** (request changes). Pick
   **Active** → a comment box appears; type *"Approved — noted the
   incident postmortem"* → click **Approve**. Status flips to
   **Active**.
8. Sign back in as Melissa — the bell shows *"Change approved:
   Outage triage"*.

Two things Procela enforces you'll want to demo:

- **Segregation of duties.** Sign in as Melissa (the submitter) and
  try to approve her own submission — the platform blocks it with
  *"The submitter cannot approve their own change. A different
  reviewer must sign off."* She can still **Request changes** on
  her own submission (self-withdrawal).
- **Fresh cycle after rejection.** If a reviewer requests changes,
  Melissa's next Submit for review starts clean — the earlier
  reviewer's decision doesn't carry over, so nothing looks
  pre-approved that isn't.

Switch back to **Simple** mode when you're done to keep the rest
of the training uncluttered — the migration confirmation dialog
walks any Pending Review rows back to Draft.

### 3.8 Phase 3 suggestion panels

Scroll past the I/O panel on an expanded activity. You'll see three
"Suggested…" cards: **Suggested data assets**, **Suggested systems**,
and **Suggested people**. Procela ranks candidates against the
activity's name, description, declared systems, and required skills.
Each row carries a High / Medium / Low confidence chip and a one-line
rationale ("Same system as the step (SAP)", "Has 2 of 2 required
skills").

- **Accept** wires the candidate into the right slot in one click
  (asset → adds a mapping; system → appended to the step's systems;
  person → assigned as Responsible).
- **Dismiss** tells Procela not to suggest this candidate again for
  this step. The decision persists across sessions (learning loop).
- Panels hide themselves when nothing scores above threshold — fully
  mapped activities don't accumulate dead UI.

We'll come back to this in Module 5 once we have assets to map.

---

## Module 4 — Register data + systems (10 min)

### 4.1 Data Assets

1. *Working in…* → **Tidewater Electric**.
2. **Data Assets** page → **+ Add data asset**.
3. Create these four — the *Domain* column is which Data Domain
   you'll assign each to once you create the domains in step 4.3.
   The *Owner Override* column tells you which assets need a
   specific person (leave blank to inherit the domain owner):

| Name | Description | Data Type | Trust Level | Domain | Owner Override |
|---|---|---|---|---|---|
| Outage Logs | Per-event SCADA records of distribution outages | Operational | Bronze | Operational Data | — (inherit) |
| Customer Master | Service addresses, account status, billing terms | Master | Silver | Customer Data | — (inherit) |
| Meter Reads | AMI 15-min interval consumption | Operational | Silver | Operational Data | **Andre Ferguson** (Manager Billing & Revenue) — revenue owns the billed reads even though the data lives in Operational |
| Generation Output | Plant-level MWh by hour | Operational | Bronze | Operational Data | **Deborah Kwon** (Data Steward Generation) — as override Owner because Generation is a separate accountability line from T&D |

4. Assign Owners and Stewards using the person picker — but only
   when the asset needs someone different from the domain's default.
   By default, an asset inherits its Owner and Stewards from its
   Data Domain. Look under the Owner picker: if you leave it empty
   and the domain has an owner assigned, you'll see a hint reading
   *"Inherits from domain — <person>"*. The row still renders with
   the domain's owner as the effective one. Same for Stewards.
   Pick a specific person only when the asset has its own
   accountable person (regulatory scope, cross-functional dataset,
   delegation) — the hint switches to *"Overrides domain (…) —
   Reset to domain owner"*. In the table above, only Meter Reads
   and Generation Output override the domain owner — the other two
   inherit cleanly. Set the Domain first in step 4.3 below.

### 4.2 Connect Assets to Systems

In each asset's edit form, set **System of Record** (e.g. Outage Logs
→ SCADA; Customer Master → CIS; Meter Reads → AMI). This is how
Procela knows which system carries the canonical copy.

### 4.3 Data Domains

1. **Data Domains** page → create three domains with these exact
   owners and stewards — each pick matches a real person on the
   imported roster and matches how a mid-sized utility organises
   accountability:

| Domain | Owner | Steward(s) |
|---|---|---|
| Customer Data | **Devon Kershaw** (Data Owner Tidewater Electric) | **Natalie Greer** (Data Steward Customer Data) |
| Operational Data | **Jennifer Vasquez** (Director Transmission & Distribution Ops) | **Brandon Willis** (Data Steward Grid Operations) + **Deborah Kwon** (Data Steward Generation) |
| Regulatory Data | **Lorraine Kimura** (Director Regulatory Affairs) | **Phillip Rosenberg** (Data Steward Compliance Evidence) |

   While you're here, set **Criticality** on each domain — mark
   *Customer Data* and *Regulatory Data* as **Tier-1 (critical)** and
   leave *Operational Data* at a lower tier. Tier-1 is what the Council
   Scorecard (Module 10.4) measures for coverage, so this flag is what
   makes a domain count toward the enterprise report card.

2. Go back to each asset from step 4.1 and assign it to its domain.
   Watch the Owner picker on **Outage Logs** and **Customer Master**
   — the hint reads *"Inherits from domain — Jennifer Vasquez"* and
   *"Inherits from domain — Devon Kershaw"* respectively. That's
   the inheritance model doing its job: two assets, zero explicit
   owner assignments, still accountable.

3. On **Meter Reads** and **Generation Output**, pick the override
   owners from the 4.1 table. The hint switches to *"Overrides
   domain — Reset to domain owner"* — a one-click undo if you
   change your mind.

**Navigating the domain tree.** The left index nests each parent
domain with its sub-domains indented beneath it. Once you've added
sub-domains (or generated them with *Suggest sub-domains*), each
parent with children shows a **▾/▸ caret** — click it to fold that
branch, or use **Collapse all / Expand all** at the top of the index
to tame a long catalog. The fold state is remembered per
organization. Long domain and sub-domain names clip to one line and
reveal the full label on hover, so the rows stay a uniform height.
When you use the *Generate domains* wand, its review tree lets you
edit, add, or drop rows **and move a sub-domain to a different parent**
(a *Move to…* picker on each sub-domain row) before you apply — so a
misfiled sub-domain is a one-click reparent, not a delete-and-re-add.

The domain assignments feed the Governance Groups page in Module 8.

### 4.4 The Data Asset 360 view — Sensitivity + Impact

Click any asset in the list to open the **Data Asset 360** modal.
Two panels there are worth pausing on because they're the ones a
steward reaches for during a real change:

**Sensitivity — Suggest & Review.** Click *Suggest sensitivity
tags* on the Sensitivity chip row. Procela AI reads the asset's
name + description and proposes tags (PII, PHI, PCI, FINANCIAL,
CREDENTIAL, CONFIDENTIAL, PUBLIC) with a confidence label. Each
suggestion has its own **Accept / Reject** button — you don't
have to swallow all of them or none. Rejected tags stay
rejected across re-runs so a subsequent *Suggest* doesn't re-
propose the same thing. Try it on **Customer Master** — the
AI reliably suggests PII on the account/address content.

**Impact analysis — "If this asset changes, what breaks?"** The
*Impact* panel below the Sensitivity row runs
`GET /data-assets/:id/impact` and returns four counts: how many
activities consume the asset, how many processes those roll up
to, how many value streams that touches, and how many people
need to be told. The **Notify** list expands to a per-person
row — each entry shows *why* they'd be notified (Owner on
Outage triage, Domain steward for Customer Data, etc.). Use
this before deprecating a system or retiring a field: the
Notify list is your change-comms distribution list.

### 4.5 How real Data Assets arrive in production

In this training you're typing the assets in by hand — fine for a demo. In production most orgs seed the catalog one of two ways:

1. **Data Connections** (see *6. Systems → Connections* in the Help Guide). Procela's backend makes outbound calls to your database using credentials you provide, and the **Discover assets** button walks the schema. Works for cloud warehouses (Snowflake, BigQuery, Redshift, Databricks) and any internal database Procela can route to.

2. **On-prem connector.** A small container the customer runs *inside their network*. It scans configured Postgres, SQL Server, or MySQL databases every 30 minutes and reports catalog metadata to Procela over an outbound HTTPS connection. Connection strings never leave the on-prem host. Use this when Procela cannot reach the source directly.

Either way, discovered assets arrive as **Bronze** tier, unowned, unmapped — deliberately, so they show up in the Orphan Assets and Ungoverned dashboards as work items for stewards. This training doesn't spin up a real database, but the *behaviour* is worth knowing: a real deployment doesn't manually type in 400 tables, and it *shouldn't* auto-promote them either.

Both discovery paths also watch for change over time. Each scanned asset carries a **schema fingerprint** and an approximate **row count**: when a later scan reports a changed column set, Procela lowers the asset's liveness health and raises an auto-resolving **SCHEMA_DRIFT** governance issue (a stable rescan closes it); a row-count **shrink** is graded by magnitude, so a silent truncation surfaces as a health drop rather than a quiet number. This runs on both the on-prem connector and the direct-connect discover/reconcile flow.

If you're rolling out to a customer now, keep going with the training as-is, then read the **6. Systems → On-prem connectors** section of the Help Guide for the install commands and the pairing flow.

---

## Module 5 — Connect processes to data (10 min)

### 5.1 Inline mapping on the catalog

The day-to-day mapping workflow is **inside the Process Catalog**, not
on the Mappings page.

1. Open the **Outage Management → Outage triage** activity — the
   one Melissa Patel is Responsible for from Module 3.3.
2. In the **Inputs / Outputs** panel, click **+ Add Input** → tab
   *Data Asset* → pick *Outage Logs*.
3. Add an output: **+ Add Output** → *Customer Master* (the activity
   updates the customer record with the outage event).
4. Repeat with two more mappings to give the map in step 5.4
   something to draw:
   - **Meter Reading → Interval read ingest** (or the closest
     activity the wand generated) → **Input: Meter Reads**
   - **Customer Onboarding → Account creation** (or equivalent) →
     **Output: Customer Master**

### 5.2 Cross-process review

1. Navigate to **Insights → Explore → Data Mapping**.
2. You'll see your mappings as a flat audit list. Three column highlights:
   - **Process Activity** — full breadcrumb (Value Stream → Process →
     Activity)
   - **Target** — typed tag (ASSET / DOCUMENT / ATTACHMENT) plus the
     target name and sub-detail
   - **Link Type** — `INPUT` / `OUTPUT` / `REFERENCE`
3. Try the **Batch Mapping Wizard** (top action) — matrix interface
   for creating many mappings at once.

### 5.3 Cross-division warning

This is the moment most platforms fail silently. Try this:

1. Working in… **Tidewater Water**.
2. Open a Water activity (e.g. *Water Quality Sampling*).
3. Add an input — try picking *Outage Logs* (an Electric asset).
4. Procela warns: *"Outage Logs is owned by Tidewater Electric, but
   Water Quality Sampling sits in Tidewater Water. Cross-division
   links usually mean the wrong target was picked — pick again, or
   confirm if this is genuinely a shared dependency."*

Cancel out. The default is **warn, not block** — confirming creates
the link normally.

### 5.4 The Process ↔ Data map (visualization)

Now that you have a few mappings, navigate to **Insights → Explore →
Process ↔ Data Map** (it sits next to Data Mapping — same data,
different read: Data Mapping is the table, this is the picture).
You'll see a bipartite SVG: activities on the left grouped
by parent process, mapped data assets on the right grouped by system,
and a coloured curve for every mapping — green for produces, blue for
consumes, purple for transforms.

- The header reads `N activities · N mapped assets · N mappings ·
  M/N activities have at least one mapping`. Watch that ratio as you
  add mappings — that's your coverage in one number.
- Click an activity. Connected rows stay bright; the rest fade. The
  Clear focus button appears above the legend. Click an asset and
  the reverse holds — you see every step that touches it.
- Use the System filter to answer "what processes use SCADA" in two
  clicks.

This is the live view of what Module 5.2 audits in table form.

### 5.5 Phase 3 suggestion accept (loop closure)

Back on the Process Catalog, expand an activity that doesn't yet have
all its mappings. The **Suggested data assets** panel (from Module
3.5) should now offer the assets we created. Click **Accept** on a
high-confidence row — Procela adds the mapping, the suggestion
disappears, and the Process ↔ Data Map (Module 5.4) gains a new
edge. Refresh the map page if you want to see it.

---

## Module 6 — Exercise the skill value-loops (15 min)

The four cross-page workflows that turn the Skills catalog from data
into something operational. All four are exercised below.

### 6.1 Tag activities with required skills

1. Back on the **Outage triage** activity from Module 3.3 / 5.1.
   In the right panel, **Required Skills** is a multi-select.
2. Add these three: `Anomaly Detection`, `Stakeholder Management`,
   `Incident Response`.
3. Notice the amber chip that appears next to the picker:
   ***Responsible person lacks N required skills*** — Melissa Patel
   (the Responsible Person) doesn't hold these yet. This is the
   **qualified-person check**.

### 6.2 Skills on people

1. *Organizations → People* with *Working in…* = **Tidewater Electric**.
2. Click **Melissa Patel** to open her detail.
3. In the Skills panel, add `Anomaly Detection` and `Incident
   Response` — leave `Stakeholder Management` off on purpose.
4. Return to the Outage triage activity — the amber chip should
   now read ***lacks 1 required skill*** instead of 3. Hover for
   the tooltip that names the missing one (`Stakeholder
   Management`).

### 6.3 Find people by skill

1. People page toolbar — **Skill** dropdown.
2. Filter to `Anomaly Detection`. The roster narrows to holders.
3. Useful for staffing a new initiative.

### 6.4 Skill gaps column

Now the **Skill gaps** column on the People table is meaningful — it
shows the number of activities each person is responsible for that
require a skill they don't hold. Hover a number for the tooltip with
sample activity names.

### 6.5 Role recommendations

1. Click any DAMA role chip anywhere in the app (try **Governance →
   Roles** → click *Data Owner*).
2. The Role Detail drawer opens. Below "Skills typically needed" is
   **Best-matching people** — ranked by how many of the role's
   required skills each person already holds.
3. Click a row → jumps to that person's profile. Useful for filling
   unfilled roles.

### 6.6 Skill-gap report on the dashboard

Back to Dashboard. The **Skill Gaps** widget ranks the org's most
under-staffed required skills. Red = zero coverage (critical), amber
= tight, green = healthy. The link **Find people by skill →** jumps to
the People page.

---

## Module 7 — Assign accountability (10 min)

### 7.1 Governance Roles

1. **Governance → Roles** → **Assignments tab**.
2. Expand a category (Executive / Business / Technical) using the
   chevron. Note the **Expand all / Collapse all** controls at the
   top.
3. Click **CDO** (unfilled) → use the inline **+ Assign** → pick
   Susan Chen (from the executives import). Save.
4. Try the same for *Data Governance Lead* → Marisol Hadid.
5. Open the **Role Detail drawer** by clicking the *CDO* badge —
   you'll see the role definition, required skills, currently-held by,
   and best-matching people.

### 7.2 Per-division Data Owners

1. *Working in…* → **Tidewater Electric**.
2. **Governance → Roles** → click **Data Owner** in the sidebar.
3. **+ Assign** → Devon Kershaw, scope = **Tidewater Electric**.
4. Repeat for Tidewater Water (Yusuf Bashir) and Shared Services
   (Camille Petersen).

Data Owner is intentionally **per-division** in this fixture; one
person isn't responsible for the whole enterprise's data.

After assigning, notice each holder row shows a small kind tag next
to their scope: `ORG: Tidewater Electric` (indigo), or `DOMAIN:
Customer Data` (green) if you scoped them to a domain instead, or
`SYSTEM` / `ASSET` for entity-attached roles like System Owner.
Any holder row whose tag reads `UNKNOWN: unresolved` (amber) means
the scoped entity has been deleted — the same dangling-reference
signal you'll see on the Data Mapping page.

### 7.3 Domain coverage check

Scroll down to a domain-scoped role card (Data Owner, Data Steward,
Data Architect, etc.). Each card has a footer panel:

> **UNFILLED FOR 2 DOMAINS**
>   [Operational Data] [Regulatory Data]

That's every data domain in the org that has no holder of this
role scoped to it. Pair it with the inline holder list above
(`Devon Kershaw — DOMAIN: Customer Data`) and you can read the
coverage gap end-to-end without leaving the page.

To exercise this: assign the same trio you used in Module 4.3 as
Data Owner (scope = domain):

- *Customer Data* → **Devon Kershaw**
- *Operational Data* → **Jennifer Vasquez**
- *Regulatory Data* → **Lorraine Kimura**

Each chip should move out of the amber *Unfilled* panel into the
holder list, and the sub-line under each name lists the domain
they own. The Data Domains page and the DAMA-role assignment are
two views on the same accountability — keeping them aligned is
what closes the coverage gap.

### 7.4 Governance Groups

1. *Working in…* → **Tidewater Utilities**.
2. **Governance → Groups** → click **Generate standard structure**.
3. The DAMA hierarchy lands: Council → Office → Committee →
   Stewardship → Working Groups → Communities of Practice.
4. Click the **Data Governance Committee**.
5. The **Expected Roles** panel shows the roles the group should have.
   Notice for domain-scoped roles (Data Owner, Domain Owner, Data
   Steward, Domain Steward, Data Architect) a sub-line under each
   holder lists their owned/stewarded domains, or `no data domains
   assigned` in red if they have none.

### 7.5 RACI Matrix

1. **Governance → Roles** → **RACI Matrix tab**.
2. The matrix is auto-derived from your role assignments and
   ownership data.
3. Click any cell to cycle R → A → C → I → clear as a manual override.
4. Look for **validation warnings** — rule violations (no R, no A,
   multiple A's) surface inline.

---

## Module 8 — Build a real report (10 min)

The Report Builder (shipped recently). This is where you produce real
artifacts for stakeholders.

### 8.1 First report: Activities by Risk

1. **Insights → Review → Reports** → **+ New report**.
2. **Starting entity**: Processes.
3. **Columns**: tick `Name`, `Level`, `Status`, `Risk Level`.
4. Under **Joined fields → Responsible Person**: tick `Name`.
5. Under **Joined fields → Required Skills**: tick `Name`.
6. **Filters**: add → field = `Level`, op = `equals`, value =
   `ACTIVITY`.
7. **Sort**: Risk Level descending.
8. The preview pane refreshes live (350 ms after each edit).
9. **Name**: *Activities by Risk*, **Description**: *All electric +
   water activities ranked by risk*. **Visibility**: Shared with org.
10. Save.

### 8.2 Second report: Data Assets without Owners

1. **+ New report** again.
2. Entity: Data Assets.
3. Columns: `Name`, `Description`, `Governance Tier`, `Health Score`.
4. Under **Joined fields → Owner**: tick `Name`.
5. Filter: `Owner ID` is empty.
6. Sort by `Health Score` ascending.
7. Save as *Ownerless data assets*.

### 8.3 Run, export, and schedule a saved report

Back on **Insights → Review → Reports**, each saved report on the list
has its own **Run & export** menu. Open the one on *Activities by Risk*
and pick a format — CSV, Excel, JSON, PDF, or copy to clipboard. Procela
runs the report against live data and downloads the rows in one step,
without reopening the Builder.

Notice the row now shows a **Last run … · N rows** line — running a saved
report records it, so the catalog tells you when each report was last
executed and how big the result was.

For a recurring report, open it in the Builder and turn on **Email this
report weekly**, then add a recipient address. On the weekly sweep Procela
emails the rendered report as a CSV attachment; the catalog marks it with
a **WEEKLY EMAIL** badge. (Delivery needs SMTP configured for the
deployment — without it the schedule is saved but nothing is sent.)

### 8.4 What just happened

Every Report Builder report reads from the same **Logical Data Model**
(LDM) that the in-app pickers expose. When Procela later moves to
Postgres, the same LDM will translate to database views that Power BI
/ Tableau / Cognos can connect to with standard SQL credentials. The
business model is the source of truth on both paths.

---

## Module 9 — Find and fix gaps (10 min)

### 9.1 Gap Detection

**Insights → Review → Gap Detection** surfaces:

- **Unmapped activities** — activities with no data link
- **Ungoverned assets** — assets below Silver / Gold tier supporting
  critical processes
- **Ungoverned columns** — a column an asset is bound to (it carries a
  physical source) but with no quality rule — coverage you claimed but
  never measure
- **Ownerless items** — entities with no owner assigned

Each gap clicks through to the item where you can resolve it.

**Tip — work the coverage gap on the asset list.** The **Data Assets**
page has a rules filter (*Has rules* / *No rules* / *Rules but
unmeasured*, each with a live count). *No rules* is the same DQ-coverage
gap Gap Detection surfaces, but filterable right on the registry;
*Rules but unmeasured* catches the sneakier case — assets that *look*
governed but where no rule has produced a real measured result yet, so
their **health reads 0%** (health is earned from measured quality) and
they're flagged *Est* in the filter. Point a connector (or a CSV upload)
at those next.

### 9.2 Data Mapping orphans

If you regenerated the process hierarchy in Module 3 (or deleted
activities), the Data Mapping page may show an orphan banner: *"N
orphan mappings found"*. Click **Delete all orphans** to clean them.

### 9.3 Orphan Assets (reverse view)

Different orphan, different page. **Data → Orphan Assets** lists data
assets that exist in the catalog but no process step references them
— "what data do we have that nobody's using?". Each row links to the
asset detail so you can either retire it or map it to a step that
should be using it. The Dashboard's Governance Gaps card surfaces the
count too.

This is the reverse of the forward Discover loop (Suggested data
assets from Module 3.5): forward asks "what data supports this
step?", reverse asks "what step should use this asset?".

### 9.4 Skill Gaps revisited

Dashboard → **Skill Gaps** should now show real values now that
activities have required-skill data and people have skills.

### 9.5 Data Quality auto-issues

**Data → Data Quality** lists rules per asset/column. When you add a
rule, the *Column* picker (populated from the asset's columns) lets you
target one specific column — the bound set — or the asset as a whole.
Both the Quality and Rules tabs have a free-text search box, so you can
find an asset by name or a rule by rule name / asset / column. Set a
rule's *Frequency* to Hourly / Daily / Weekly and it runs
automatically — no cron, no external orchestrator. When a run
transitions a rule to FAILING, Procela auto-creates a
governance issue (severity HIGH), assigns it to the domain
steward, and pings the assignee via the notification bell.
Beyond rule failures, a discovered asset whose **column set
changes between scans** raises its own auto-resolving
**SCHEMA_DRIFT** issue the same way — so schema drift and a
sudden row-count drop are tracked, not silent.
When the rule recovers, the same issue auto-resolves. The
end-to-end shape: define the rule once, walk away, and the
platform does the rest — see the Data Quality section of the
Help Guide for the full mechanics.

### 9.6 Cross-page coherence

Test this end-to-end:

1. From Dashboard, click the **Coverage** KPI tile.
2. You land on Data Mapping with the unmapped-activity banner.
3. Click an unmapped activity → drops you into Process Catalog on
   that node.
4. Add a data-asset input from the panel.
5. Return to Data Mapping → the count went down by one.

The same data, different views — that's the Procela model.

---

## Module 10 — Governance program + documents (10 min)

### 10.1 Generate governance processes

1. *Working in…* → **Tidewater Utilities** (parent company).
2. **Processes** → **Generate governance processes** (a separate wand
   from the operational one). It opens the **Process Wizard** in
   governance mode — the same Review & Apply screen the operational
   wizard uses, but pre-loaded with the standard framework instead of
   an AI generation.
3. Review the hierarchy, then click **Apply … to Catalog**. It creates
   a *governance* value stream alongside the operational ones —
   **Data Governance Management**, with six processes (Data Strategy &
   Policy, Data Quality Management, Data Domain Management, Metadata &
   Catalog Management, Data Access & Security, Issue & Change
   Management) and their 30 DAMA-aligned activities.

Now switch **Working in…** back to **Tidewater Electric**. Notice
two things: the governance value stream you just created
*doesn't appear* on the division's Process Catalog, and the
**Generate governance processes** wand is not visible on this
scope either. Both are by design: enterprise governance is one
program for the whole org tree, so a division shouldn't be able
to see it in its catalog counts *or* be able to accidentally
create its own. Switch back up to Tidewater Utilities whenever
you need to touch the enterprise governance program.

### 10.2 Governance Documents

1. **Governance → Documents**.
2. The seed includes a **Charter** (CHA-001), **Data Policies**
   (POL-001), **Data Standards** (STD-001), and a few starter
   documents.
3. Add controls to a Policy: expand the row → controls panel. Each
   control has a type (Preventive / Detective / Corrective) and an
   automation mode (Human / Agent / Hybrid).

### 10.3 Governance Program Maturity

The governance program's four-phase tracker lives on **Get Started**
(Module 2.5) — the **Govern** and **Operate** stages — not a page of its
own. The **lifecycle status** (Planning → Active → Paused → Completed) is
changed right there from the lifecycle bar, each stage shows a plain
**"n / m done"** count, and **Next Actions** lists the highest-priority
pending items with deep-links. There's deliberately no single overall
percentage: that number rolled up every check and could slide *down* as
your catalog changed, which looked like a regression. (The old
`/governance-program` URL redirects to `/setup`.)

**Phase 1** is Foundation Definition; its scope, guiding principles, and
operating model are authored on **Governance → Foundation** (the Govern
stage links to it). The program can't launch until Phase 1 is complete —
the **Launch button stays disabled** (with a tooltip) until Foundation is
done, on both the Get Started lifecycle bar and the Foundation page. Because
Foundation is the prerequisite, you can also **launch straight from the
Governance → Foundation page** once it's complete. Launching with the later
phases (2–4) still incomplete pops a confirmation listing exactly what's
missing and records the reason in the audit log (an audited "early launch").

When the program first goes Active, Procela stamps an actual **Launched**
date — set once and kept through any later pause/resume/reopen — and shows it
next to the lifecycle status on Get Started and on the Foundation page.

(The Foundation page holds scope, guiding principles, and the operating model
only. The old *Target Start / Target Launch* date fields were removed — they
were never surfaced anywhere; the actual Launched date above replaces them.)

### 10.4 Council Scorecard + Exceptions

The **Council Scorecard** (**Insights → Review → Council Scorecard**)
is the monthly report card a governance council reads: each child
division reports four measures — Tier-1 domain coverage, asset
classification, open issues over 30 days, and exceptions past expiry —
and they roll up to a true **Enterprise** total (computed across the
whole subtree, not an average). Open it now and you'll see the two
domains you flagged Tier-1 in Module 4.3 driving the coverage number,
plus two auto-drafted narratives ("What moved this month", "For the
council").

1. As a **CDO** or **Data Governance Lead** (or an org admin), click
   **Edit** — every derived cell becomes editable and you can override
   any measure or rewrite a narrative. An overridden cell keeps the
   machine value underneath and is marked, so the council can see what
   was adjusted; **Reset** puts it back to derived.
2. Click **Save snapshot** to freeze this month as an immutable
   version — one click from the read-only view, or **Publish snapshot**
   from inside Edit. If a snapshot for this period already exists,
   Procela asks whether to **Replace existing** (overwrite that version
   in place) or **Save as a new snapshot** (keep both as separate dated
   versions). The version-history panel reopens any past month
   read-only — that's your historical reference for how governance moved
   quarter over quarter.

A division with nothing to assess yet — no governed domains, no
classified assets, and no open issues or exceptions — shows a neutral
**No data** status rather than being flagged **Behind**, so an
un-started division doesn't read as a failing one.

The four thresholds the scorecard grades against (coverage %,
classification %, max aged open issues, max past-expiry exceptions, and
the open-issue age in days) ship with defaults of 80 / 70 / 0 / 0 / 30.
An org admin can tune them under **Settings → Data → Council Scorecard
targets**; the change re-derives the live scorecard on its next load,
while already-saved snapshots keep the targets they were frozen with.

To feed the *Exceptions past expiry* measure, visit **Governance →
Operate → Exceptions** and grant a waiver with an expiry date in the
past — it flags red on that page and increments the exceptions column
on the scorecard. Close it and the count drops. This is the auditable
way a control gets waived instead of quietly going unmet.

---

## Module 11 — Ask AI for grounded answers (5 min)

The platform has an AI assistant that's grounded in *your* catalog —
not training data — so it answers about the org you just built.

> **Admin note — turning AI off.** This assistant and every other AI
> integration feature (template generation, data/asset suggestions, the
> sensitivity classifier, and the AI governance agents) are gated behind a
> single deployment switch, `AI_FEATURES_ENABLED` (default on). Set it to
> `false` and the whole AI surface disappears — the backend refuses the AI
> endpoints and the frontend hides their entry points, including the Ask AI
> button. It's the one knob an on-prem or FedRAMP deployment flips to run
> without calling an external model; everything else works unchanged. If AI
> is off for your deployment, skip this module.

### 11.1 Open the panel

Click **Ask AI** in the top bar. That's the only entry point — the
floating bottom-right bubble is gone; the top-bar button is where
you open, minimize, and resume the chat. Starter prompts appear when
the chat is empty, and they're **page-aware** — they lead with
questions relevant to the page you're standing on and fall back to the
cross-catalog staples. From the Dashboard you'll see the general set:

- Where are our data gaps?
- Which assets are below 80% health and linked to critical processes?
- Which data assets do we have that no process uses?
- Which systems run our customer-facing processes?

Open the panel from **Gap Detection**, **Data Assets → Orphans**, or
**Systems** and the top suggestions change to match that surface.

### 11.2 Try the orphan question

Click **Which data assets do we have that no process uses?**.

Watch the reply stream in token-by-token — there's no "Thinking…"
pause. The assistant should name one or more of the orphan assets
from Module 9.3. Each asset name is a **link** — click it and you
land on the asset's page in the catalog. That's inline citation
working: the assistant didn't just describe your data, it pointed at
the rows you can act on.

### 11.3 Notice the navigation chip

At the end of the same answer you should see a green pill-shaped
chip — *Orphan Assets →*. That's the page-navigation chip: the
assistant decided the right next step was opening the Orphan Assets
page, and gave you a one-click handoff. Click it and you land on
/data-assets/orphans.

The chip is constrained to a fixed allowlist of Procela pages so a
hallucinated route can't render as a broken button.

### 11.4 Try a coverage question

Type *"What systems run our Outage triage process?"*. The assistant
answers from the activity ↔ system declarations you made in the
Process Catalog (Module 3), with the system names rendered as links
to the Systems page. Switch the **Working in…** scope to Water and
ask the same question — the answer re-grounds to the new org.

### 11.5 Minimize, save, and revisit

Click the `–` in the panel header to close the panel and keep
working elsewhere in the app — the conversation is preserved. Notice
the **Ask AI** top-bar button now shows a small count badge telling
you a chat is paused. Click it to resume; every message is where you
left it.

Conversations are now **saved as you go**, so they survive a page
reload and a return visit — not just the current browser tab. Click
**History** in the panel header to see your past conversations (each
titled from its first question); pick one to re-open its full
transcript, or delete a row with its ×. **New chat** starts a fresh
thread — the current one is already saved and reachable from History,
so nothing is thrown away. Conversations are private to you and scoped
to the org you had active, so switching orgs starts a clean one.

### 11.6 What it won't do

The assistant answers and points; it doesn't act. It won't delete an
orphan, change ownership, or transition a process status — those
stay manual. Use it as a navigation aid and a gap-detector, not as a
mutation surface.

---

## Module 12 — Weekly digest of gap deltas (5 min)

Procela closes the loop by surfacing week-over-week movement in the
same gap signals from Module 9. Instead of you remembering to check
the dashboard every Monday, the platform pings the notifications
bell when something meaningful changes.

### 12.1 Take the baseline

The first digest run for an org records a baseline; subsequent runs
diff against it. For the prototype the trigger is manual — hit:

```
POST /api/v1/digest/run?orgId=<your-active-org-id>
```

Use the API console or `curl` with your access token. The response
includes `baseline: true` and `notificationsWritten: 0` — no bell
ping yet, just a recorded starting point.

### 12.2 Create a change worth noticing

Add three more unmapped assets in **Data Assets** (or remove a few
mappings to drop coverage by 5+ points), then run the digest endpoint
again.

### 12.3 Read the notification

Open the bell in the top bar. New entries should land — for example:

- *"3 new orphan data assets this week"* → links to **Data → Orphan Assets**
- *"Mapping coverage dropped to 72%"* → links to **Insights → Explore → Process ↔ Data Map**
- *"2 new ownerless processes"* → links to **Processes**

Each entry is one click from the affected page; thresholds are
conservative (3+ orphans, 5+ percentage points, 1+ ownerless
process) so small day-to-day noise doesn't accumulate noise in the
bell.

### 12.4 Scheduling

The digest doesn't need you to remember to run it. Procela ships a
built-in scheduler that fires every hour and, on the first tick
after Sunday 23:00 UTC each week, walks every org and runs the
digest for you. The last-fired timestamp is persisted, so a restart
in the firing window doesn't double-notify.

**Tune it per person.** Click the gear in the notifications dropdown
to open your own **Weekly digest** settings: turn the digest on or
off, choose which of the four gap-signal categories you want (new
orphans, coverage drops, ungoverned-in-use, ownerless processes), and
optionally **also email it to me**. Email is opt-in and only sends the
categories you picked — it needs SMTP configured for the deployment,
and it never changes the in-app bell notifications. Every signed-in
user sets their own, so this isn't admin-gated.

The same scheduler also runs an **overdue task sweep** every hour:
any governance task with a due date in the past — status OPEN,
IN_PROGRESS, or PENDING_APPROVAL — writes a *Task overdue: …*
warning into the notifications bell for its assignee (or org-wide
if the task is unassigned). It's idempotent — the sweep stamps the
task after firing and re-arms itself only when the due date is
pushed forward or the task cycles back to OPEN. `POST
/api/v1/governance-tasks/sweep-overdue` triggers the same code
synchronously if you want to drive it from the API console.

The manual `POST /api/v1/digest/run` trigger from 12.1 still works
— use it for one-off runs (e.g., before a demo). Disable all
background loops (this scheduler included) by setting
`PROCELA_DISABLE_SCHEDULERS=1` — set it on every replica except the one
designated to run scheduled work, so jobs fire once rather than once
per replica.

---

## Quick reference

### The Procela model in one paragraph

Procela's data model has three layers that meet in the middle. The
**business layer** (Value Streams → Processes → Sub-Processes →
Activities → Tasks) describes what the business does. The **data
layer** (Data Assets, Systems, Data Domains) describes what powers
it. **Mappings** are the bridge — they link activities to the data
assets / governance documents / attachments they consume or produce.
Wrapping all three are people (with their **skills** and **DAMA
roles**), grouped into **Governance Groups**, governed by
**Documents** (charters, policies, standards), and held accountable
via the **RACI Matrix**.

### Where things live

| If you're looking for… | Go to |
|---|---|
| The business model | Processes (Process Catalog) |
| Data registries | Data Assets, Systems, Data Domains |
| Cross-process audit of links | Insights → Data Mapping |
| Who does what | Organizations → People, Governance → Roles |
| Standing committees | Governance → Groups |
| Policies + standards | Governance → Documents |
| Reports + scorecards | Insights → Reports |
| Council report card (division rollup) | Insights → Review → Council Scorecard |
| Policy waivers / exceptions | Governance → Operate → Exceptions |
| Pivot exploration | Insights → Analysis |
| Where are the gaps? | Dashboard → Gaps section + Insights → Gap Detection |
| Live source metadata / freshness | Systems → Connections (if Procela can reach the DB) or Settings → On-prem connectors (if it can't) |
| Help / shortcuts | Top-bar **Help** button (next to Ask AI); press `?` for keyboard shortcuts |

### Keyboard shortcuts to know

- `?` — open the shortcut overlay
- `g then d` — go to Dashboard
- `g then p` — go to Processes (Catalog)
- `g then a` — go to Data Assets
- `g then s` — go to Systems
- `g then o` — go to People
- `g then r` — go to Reports
- `/` — focus search (on supported pages)

### Three things to demo to a stakeholder

1. **Generate processes for two divisions side-by-side.** Same wand,
   same code; the electric output is electric-utility, the water
   output is water-utility. That's active-org context driving AI.
2. **Cross-page link traversal.** From a Data Asset, *Where Used* →
   process steps consuming it. From a person, click a role chip →
   drawer. The cross-references make the business-process-first
   model tangible.
3. **RACI auto-derivation.** Assignments on the Catalog → RACI rows
   auto-derived → validation warnings flag rule violations (no R, no
   A, multiple A's).

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Dashboard KPIs show 0 after import | Wrong *Working in…* scope. Switch to the org you imported into. |
| Can't see imported people on People page | Same as above — *Working in…* picker. People are scoped per org. |
| AI process generation hangs > 30 s | First run for an (industry + org) is a live Claude call. Subsequent runs hit the cache. Check the *Cached* / *Fresh from AI* badge. |
| Cross-division link warning won't dismiss | It's a soft warn, not block — confirm it to create the link, cancel to skip. |
| Orphan mappings appear after wand re-run | Regenerating processes mints new UUIDs. Use **Delete all orphans** on Data Mapping. |
| Sign-in hangs in dev mode | `REDIS_URL` set in `.env` without Redis running. Either unset it or start Redis. |
| New typecheck / test failure on trunk | CI runs on push; check the GitHub Actions tab for the actual error. Locally: `npm run lint --workspaces && npm test`. |

---

## What to read next

- `CLAUDE.md` (repo root) — the product brief; what Procela is for
- `test-data/utility/README.md` — companion to this guide; the data
  reference for the Tidewater Utilities demo fixture
- In-app **Help** page — feature-by-feature reference (this guide is
  a workflow walkthrough; Help is a manual)
