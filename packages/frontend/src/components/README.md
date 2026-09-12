# Frontend shared components

The small set of primitives every page composes from. A
design-consistency review found 50+ pages hand-rolling equivalents
of these; the sweep migrated the worst offenders and shipped these
as the durable answer.

> **Rule of thumb — before you write inline CSS on a page, check
> this list.** If a primitive here covers your case, use it. Do not
> add a variant of one of these to your page.

For the concise rules (what to use, what to avoid), see the
"Frontend Design Conventions" section in `/CLAUDE.md` — this file
is the deeper reference with props, examples, and rationale.

---

## Layout

### `<Page>`

Every routed page renders inside `<Page>`. Width comes from a
preset — never inline `maxWidth` on your page's outer div.

```tsx
import Page from '@/components/Page';

export default function MyPage() {
  return (
    <Page>            {/* default — no width constraint */}
      <PageHeader title="Systems" />
      …
    </Page>
  );
}
```

Widths:

- `default` — full page width. Tables, dashboards, most operational
  surfaces.
- `narrow` — 820px, centred. Long-form reading (HelpPage,
  HelpTrainingPage).
- `wizard` — 820px, centred. Stepped flows (ValueStreamWizard,
  SetupHubPage).

Bottom padding via `padding` prop when the page needs breathing room
before the next screen: `<Page padding="8px 0 64px">`.

---

### `<PageHeader>`

The band at the top of every page. Title (22px, on a compact band —
10px bottom padding, 1rem bottom margin) + subtitle + right-aligned
actions. Optional kicker (eyebrow) and meta row.

```tsx
<PageHeader
  kicker="Policy · POL-007"
  title="Data Retention Policy"
  subtitle="Defines how long each data class is retained."
  meta={<StatusBadge variant="success">Active</StatusBadge>}
  actions={<button className="btn-primary">Edit</button>}
/>
```

**Never hand-roll an `<h1>` at the top of a page.** The audit found
two pages doing this (AssignOwners, SetupHub) — both read a full
point smaller than every other page. Both now use PageHeader.

---

### `<SectionHeading>`

The one section title used across dashboards and reports — **18/700 ink**,
with the accent moved to an optional `underline` rule and an optional
`eyebrow`, so teal never competes with the title text. Replaces the two
drifting systems (the Dashboard's `16/600` plain `<h2>` and the Executive
Report's `18/700` teal-underlined one). A `right` slot holds a trailing
control (a toggle, a "View all" link) on the title's baseline.

```tsx
<SectionHeading title="Governance Gaps" />
<SectionHeading title="Overview" right={<LensToggle />} />
<SectionHeading eyebrow="Section 01" title="Organization Overview" underline />
```

Distinct from `<SectionLabel>` (the tiny uppercase label *inside* a card).
Do NOT hand-roll a section `<h2>`.

---

### `<FieldStack>`

The vertical-rhythm primitive. A flex column that owns the spacing
between its children from a single spacing token, so the gap between
fields is uniform no matter which fields render (a detail panel that
shows different fields per entity type / status no longer has its gaps
jump around).

```tsx
import FieldStack from '@/components/FieldStack';

<FieldStack gap="section">        {/* stacked panels — 16px */}
  <FieldStack>                     {/* form/detail rows — 8px (default) */}
    <DocField … />
    <DocRoleField … />
    <DocSystemsField … />
  </FieldStack>
  <IOPanel … />
  <DependenciesPanel … />
</FieldStack>
```

Gaps map to the `--space-*` tokens: `tight` (4px, dense chip rows /
sub-notes), `field` (8px, the default — between form fields), `section`
(16px, between panels). **Children must not add their own vertical
`margin`** — the stack owns that axis. If a child needs to sit tighter
or looser, it belongs in a different gap tier, not an ad-hoc margin.
Reference adoption: `pages/process-catalog/TreeNode.tsx`.

---

## Content containers

### `<Card>`

The standard content container. `background: var(--color-surface)`
+ `1px border` + `var(--radius-md)` + `var(--shadow-sm)` +
`padding: 16`. Do NOT repeat those five properties inline.

```tsx
import Card from '@/components/Card';

<Card>
  <SectionLabel>Governance & ownership</SectionLabel>
  <PersonPicker … />
</Card>

<Card padding="1.5rem" borderColor="#fecaca">
  {/* Destructive intent — red border */}
  <h2 style={{ color: '#991b1b' }}>Reset everything</h2>
  …
</Card>
```

Props:

- `padding` — default 16; long-form content commonly uses 24; pass 0
  to opt out (e.g. wrapping a table that supplies its own).
- `marginBottom` — for vertical stacks.
- `radius` — `sm` | `md` (default) | `lg`.
- `shadow` — `none` | `sm` (default) | `md` | `lg`.
- `borderColor` — override for destructive/warning intent
  (`#fecaca` red, `#fde68a` amber).
- `onClick` — makes the card interactive; auto-flips
  `role="button"` + keyboard focus + pointer cursor.

---

### `<SectionLabel>`

The uppercase section header used inside cards ("Governance &
Ownership", "Advanced fields", "Data Domain"). Style is
intentionally not customisable — the point is consistency.

```tsx
import SectionLabel from '@/components/SectionLabel';

<Card>
  <SectionLabel>What is this data?</SectionLabel>
  <input … />
</Card>
```

**If a label needs to look different, it's probably an `<h2>` or
`<h3>`, not a section label.** The audit found this pattern rendered
~130 times with inconsistent sizes (9/10/11/12/13) and weights
(600/700); the component ends that category.

Props:

- `marginBottom` — default 8; pass 0 for side-by-side layouts, 4
  for tight groupings.

---

## Lists

### `<DataTable>`

The shared list table. ~18 pages hand-rolled the same `<table
style={{width:'100%',borderCollapse:'collapse'}}>` shell — a header
row on `--color-bg`, a leading checkbox column, per-row imperative
hover + selected-row tint, and a colSpan "no matches" row.
`DataTable` owns all of that behind a declarative column config.

The list-consistency series migrated the app's entity-list pages onto
it — **15 pages** spanning flat and expandable lists (Systems, Skills,
Mappings, Business Glossary, Governance Issues/Tasks/Calendar, Data
Lineage, Connections, Data Quality, Decision Rights, Agents, SOPs, Data
Assets, Governance Policies). New list pages MUST compose `DataTable`
rather than re-roll the shell.

This does **not** mean every `<table>` in the app is a `DataTable`.
Some hand-rolled tables aren't flat entity lists at all and shouldn't be
forced through it — reports (Executive Report, Report Builder), the RACI
matrix, the audit log, static reference tables (Help, DAMA Roles), and
nested detail sub-tables (Governance Group detail). Before adding a new
list, ask whether it's a flat entity list (→ `DataTable`) or one of
these other shapes (→ hand-roll). See also the note at the end of this
section for the one *entity* list deliberately kept hand-rolled.

```tsx
import DataTable, { type DataTableColumn } from '@/components/DataTable';

const columns = ([
  colPicker.isVisible('title') && {
    key: 'title', header: 'Title', sortable: true, cellStyle: { fontWeight: 500 },
    render: (r) => <span style={{ color: 'var(--color-primary)' }}>{r.title}</span>,
  },
  { key: 'actions', header: 'Actions', align: 'center', width: 100, render: (r) => <RowActions row={r} /> },
].filter(Boolean) as DataTableColumn<Row>[]);

<DataTable
  rows={sorted}                 // already filtered + sorted by the page
  columns={columns}
  rowKey={(r) => r.id}
  selection={sel}               // a useRowSelection result → adds the checkbox column
  isRowDisabled={(r) => r.inherited}
  sort={{ sortKey, sortDir, onSort: toggleSort }}
  emptyMessage="No rows match the current filters."
/>
```

Column config: `key` (also the sort key), `header`, `render?` (defaults
to the row's value at `key`; accepts any `ReactNode` — badges, chips,
inline-edit selects, icon clusters), `sortable?`, `width?`, `align?`,
`cellStyle?`. Optional `rowId?(row)` sets a DOM `id` (e.g.
`row-<id>` for scroll-to-highlight).

What stays on the **page**, deliberately, so behaviour is identical
and the surface stays small:

- **Sorting** in `useSortedList` (URL-persisted). Pass the current
  `sort` state in; mark columns `sortable`.
- **Column visibility** in `useColumnPicker` with `<ColumnPicker>` in
  the `PageHeader`. Pass the already-filtered `columns` list (filter
  with `.filter(Boolean)` as above).
- **Loading skeleton** and the **"no data at all" empty hero** in the
  page's outer branch — they depend on page-specific state. `DataTable`
  only renders the inline "no *matches*" row via `emptyMessage`.

**Expandable detail rows** — pass the `expansion` prop to add a leading
caret column that toggles a full-width detail row beneath each row:

```tsx
<DataTable
  rows={filteredRows}
  columns={columns}
  rowKey={(r) => r.id}
  selection={sel}
  expansion={{
    expandedIds,                         // Set<string>; single-open pages pass a 0/1-element Set
    onToggleExpanded: toggleExpand,      // (id) => void
    renderExpandedRow: (r) => <Detail row={r} />,
    getRowExpandable: (r) => r.hasDetail, // optional; default all rows
  }}
/>
```

DataTable computes the detail row's `colSpan` internally (retiring every
hardcoded `colSpan={8}`). Everything *inside* the expanded region is
page-owned — DataTable owns only the caret column and the detail row's
`colSpan`, and never fetches. `renderExpandedRow` holds arbitrarily
complex content; the migrated pages exercise the full range:

- **Lazy-fetch-on-expand** with a spinner — Data Quality assets tab, Data
  Assets (fetch in `onToggleExpanded`, render `loading ? spinner : …`).
- **Nested sub-tables** — the per-policy Controls table (Governance
  Policies), the per-asset columns table (Data Assets).
- **An add/edit form + nested CRUD** — the control form + Controls sub-table
  (Governance Policies), kept page-owned; single-open pages can share one
  form-state set because only one detail row exists at a time.
- **Two-level expansion** — Data Assets nests a per-column rules expansion
  (its own `Set` + toggle) *inside* the per-asset `renderExpandedRow`; the
  inner level is plain markup, not a second `DataTable`.
- **Quick-add rows** — the "+ Add Step" / reorder controls (SOPs).

`trigger` controls how a row expands. Default `'caret'`: only the leading
caret button toggles. `'row-click'`: clicking anywhere on the row toggles,
and the caret stays a keyboard-focusable affordance. In `'row-click'` mode
DataTable `stopPropagation`s the cells it owns (caret + selection
checkbox) — but any interactive control you put inside a `column.render`
(action buttons, links) must `stopPropagation` itself so a click on it
doesn't also toggle the row.

**People is the one *entity* list deliberately left hand-rolled.** The
reason is one specific shape: a **pinned quick-add row** — a persistent
`<tr>` of inputs at the top of `<tbody>` for adding a person inline
(type in the column, press Enter). `DataTable` renders exactly one `<tr>`
per row (plus optional detail rows) and has no slot for a non-data row in
the body; adding a `pinnedRow` prop for a single consumer would bloat a
deliberately minimal component, and moving the quick-add out of the grid
(the only alternative) is a real UX regression on a useful affordance. So
People stays hand-rolled. Note this is the *only* blocker: People's
conditional "Skill gaps" column is **not** a reason — a boolean-gated
column is just a `.filter(Boolean)` entry in the `columns` array, which
`DataTable` already supports. It's called out here — as opposed to the
specialized non-list tables above — because it *is* a flat entity list,
the kind of page a reader would expect to find on `DataTable`.

### `<TruncatedText>`

Single-line ellipsis + hover tooltip for list-row cells. Combined
with the global `table th, table td { white-space: nowrap; }` rule,
this keeps every list uniform-height.

```tsx
import TruncatedText from '@/components/TruncatedText';

<td style={{ maxWidth: 400 }}>
  <TruncatedText text={sys.description} emptyPlaceholder="--" />
</td>
```

Parent `<td>` supplies the `maxWidth`; the child clips at that width.
Do NOT `overflow: hidden` on the `<td>` directly — that requires
`display: block` which breaks table layout.

Never re-enable wrap on a list. If a cell has genuinely long
content, use TruncatedText; if you want to show more, add a detail
panel or an accordion.

### `useRowSelection` + `<BulkActionBar>`

Checkbox selection for list pages. Every list had hand-rolled the same
`Set<string>` + select-all + "N selected" bar, and the copies drifted —
several computed select-all against the *unfiltered* source list while
the body rendered the *filtered* one, so "select all" ticked hidden rows
and the header checkbox showed the wrong state. `useRowSelection` fixes
that by construction: it is told the visible, selectable rows and derives
`allSelected` / `someSelected` / `toggleAll` from that set. Selections
that scroll out of view under a filter are preserved (bulk actions still
run over the full `selectedIds`), but the header checkbox only governs
the rows the user can see.

```tsx
import { useRowSelection } from '@/hooks/useRowSelection';
import BulkActionBar, { BulkActionButton } from '@/components/BulkActionBar';

// Pass ONLY the rows the user may tick (filter out inherited / read-only).
const sel = useRowSelection(visibleRows, (r) => r.id);

// Header cell:
<input type="checkbox"
  ref={(el) => { if (el) el.indeterminate = sel.someSelected; }}
  checked={sel.allSelected} onChange={sel.toggleAll} />

// Row cell:
<input type="checkbox" checked={sel.isSelected(r.id)} onChange={() => sel.toggle(r.id)} />

// The bar (renders nothing when count is 0, so mount it unconditionally):
<BulkActionBar count={sel.count} onClear={sel.clear}>
  <BulkActionButton onClick={bulkTag}>Set tier</BulkActionButton>
  <BulkActionButton variant="danger" onClick={confirmDelete}>Delete selected</BulkActionButton>
</BulkActionBar>
```

`<BulkActionButton>` variants are `primary` / `neutral` (default) /
`danger` — semantic intent, not colour. The bar and buttons draw from
`--color-*` tokens (the old hand-rolled bars were hardcoded blue while
the brand primary is teal). Do NOT hand-roll a selection bar.

When you delete a single row that could also be selected, call
`sel.remove(id)` in the delete handler — the hook preserves selections that
scroll out of view (so it can't tell a deleted row from a filtered one), and
without this the bar keeps counting a row that no longer exists.

---

## Badges & indicators

Small display primitives for the recurring "value that should read as a
visual, not raw text" cases. `<StatusBadge>` (documented above where it's
first used) covers semantic state pills; these three cover the other
recurring ones.

### `<Avatar>`

The initials-in-a-circle marker for a person. Background is derived
deterministically from the name, so the same person is always the same
colour across the app.

```tsx
import Avatar from '@/components/Avatar';

<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
  <Avatar name={person.name} />          {/* sm (24px), list rows */}
  <span>{person.name}</span>
</div>
```

Sizes `sm` (24) / `md` (32) / `lg` (40). The fills are a fixed decorative
hex palette (not `--color-*` tokens) — a person's colour must be stable,
not theme-derived. `initialsOf(name)` is exported for the rare case you
need the initials without the circle.

### `<HealthBar>`

Compact horizontal gauge for a 0–100 health score. Fill colour follows the
app-wide thresholds (**≥80** success / **≥50** warning / else error) via
the semantic `--color-*` tokens, so it retunes with the theme instead of
drifting to a bespoke hex. Renders an em-dash when the score is unset.

```tsx
import HealthBar from '@/components/HealthBar';

<HealthBar score={asset.healthScore} />   {/* bar + "72%" */}
```

Do NOT print a bare `{score}%` in a list cell — use `HealthBar` so health
reads consistently wherever it appears. `healthColorVar(score)` is exported
for callers that need just the token (e.g. a number coloured to match).

### `<StatTile>`

The one KPI / metric tile — a number (**24/700**) over a label, in a card.
Replaces the Dashboard's two tile systems and the Executive Report's metric
boxes. **Counts wear plain ink** — the label carries identity; spend colour
only where the number is a *state*, via `valueColor={healthColorVar(x)}`.
With `to` it's a hover-lift deep link with a zero-aware tooltip; without, a
static box (the print report). `accent` adds a left border (governance tiers);
`dense` tightens padding + number for compact grids like the printable report.

```tsx
<StatTile label="Processes" value={48} to="/processes" />
<StatTile label="Coverage" value="72%" to="/mappings" valueColor={healthColorVar(72)} />
<StatTile label="Certified" value={9} accent="var(--color-tier-gold)" valueColor="var(--color-tier-gold)" />
```

### `<Meter>`

The one horizontal progress / proportion bar — one tokenised track, one
height, one fill convention. Replaces the five hand-rolled bars (heights
4/6/8, tracks split between raw `#e5e7eb` and tokens). Brand teal for
"progress toward a goal"; pass `color={healthColorVar(x)}` when the bar
encodes health. For the labelled inline gauge with a trailing "NN%", use
`<HealthBar>` instead.

```tsx
<Meter value={pct} />
<Meter value={healthPct} color={healthColorVar(healthPct)} />
```

### `<TierBar>`

The governance-tier distribution (Certified / Managed / Uncertified) as one
stacked bar + legend, instead of three separate count tiles. Uses the
reserved `--color-tier-*` palette with a 2px surface gap between segments;
identity lives in the legend labels, never colour alone.

```tsx
<TierBar gold={9} silver={4} bronze={2} />
```

### `<TierBadge>`

The coloured pill for a governance tier (Bronze / Silver / Gold). Label
comes from `useTierLabel` so it tracks the plain↔DAMA terminology toggle;
colour comes from the `TIER_COLORS` ramp in `lib/governanceTier`.

```tsx
import TierBadge from '@/components/TierBadge';

<TierBadge tier={asset.governanceTier} />
```

Use it for the **read-only** display of a tier; keep an inline `<select>`
for the editable case (as Data Assets does — badge for viewers/inherited
rows, select for editors). Do NOT render a tier as plain `tierLabel(...)`
text.

---

## States

A data-fetching page has four render states, and every list page should
handle all four in the same order: **error → loading → empty → data**.

```tsx
{loadError ? (
  <ErrorState message={loadError} onRetry={() => { setLoadError(null); setLoading(true); fetchData(); }} />
) : loading ? (
  <SkeletonRows rows={5} columns={4} />
) : rows.length === 0 ? (
  <EmptyState title="No systems yet" description="…" action={{ label: '+ Add', onClick: openAdd }} />
) : (
  <DataTable … />
)}
```

### `<ErrorState>`

The "couldn't load this" panel — the error-branch sibling of
`<EmptyState>` (same surface / border / radius / centred padding, so the
two read as one family). Props: `title?` (default "Couldn't load this"),
`message?` (an `errorMessage(err)` string), `onRetry?` (renders a Retry
button wired to it), `retryLabel?`.

The list-consistency polish adopted it on **16 list pages** that used to
**fail silently** — their `fetchData` swallowed the error in an empty
`catch`, so a failed load rendered the *empty* state as if there were
legitimately no data. The uniform fix each page now uses:

```tsx
const [loadError, setLoadError] = useState<string | null>(null);

const fetchData = useCallback(async () => {
  try {
    setLoadError(null);          // clear on (re)load
    …
  } catch (err) {
    setLoadError(errorMessage(err, 'Failed to load systems.'));
  } finally {
    setLoading(false);
  }
}, [deps]);
```

Do NOT swallow a primary-fetch error, and do NOT only `addToast` it (a
toast is transient; the page is still blank). Set `loadError` and render
`<ErrorState>`. `EmptyState` and `SkeletonRows` (from `Skeleton`) cover the
other two branches.

### `<Spinner>`

The shared busy / loading indicator for **everything that isn't a
table** — a full-area fetch, a viz canvas, a button mid-action, an
overlay. It's a `currentColor` ring, so it tints to its context
automatically (white on a primary button, muted in a page loader).

```tsx
<Spinner center label="Loading…" />   // full-area page loader (padded, centred)
<Spinner label="Loading…" />          // inline loader inside a panel/section
<Spinner size={14} />                 // bare ring (e.g. inside a busy button)
```

Props: `size` (default 16), `thickness` (2), `label` (text after the
ring), `center` (padded centred block), `color` (defaults to
`currentColor`), `style`.

**Loader choice:** a still-loading **table/list** uses `<SkeletonRows>`
(it keeps the final layout so nothing jumps); **everything else** uses
`<Spinner>`. **Canonical copy is `Loading…`** with a real ellipsis
(U+2026) — never `Loading...`. `<Button>` renders a `<Spinner>` itself
when you pass `loading` (see below), so don't hand-roll a busy label.

---

## Interactive

### `<Button>`

The text-button primitive. Replaces the `btnPrimary` / `btnSecondary`
`CSSProperties` objects hand-rolled across ~29 pages. Extends the native
button element, so `onClick` / `type` / `title` / `disabled` / `aria-*` all
pass through, and `disabled` (or `loading`) auto-applies the dimmed /
not-allowed styling — call sites no longer hand-roll `opacity` + `cursor`.

```tsx
import Button from '@/components/Button';

<Button variant="primary" onClick={save} disabled={!valid}>Save</Button>
<Button variant="secondary" onClick={cancel}>Cancel</Button>
<Button variant="danger" onClick={remove}>Delete</Button>
<Button variant="primary" loading={saving}>Save</Button>   {/* → <Spinner> + "Save", disabled, aria-busy */}
```

Variants map to intent, not colour: **primary** (solid teal — the main
action), **secondary** (outlined neutral — default), **danger** (solid
red — destructive confirms), **ghost** (borderless — inline cancel).
Sizes: `sm` (28h, row actions) / `md` (34h, default). All colours are
`--color-*` tokens. Extras: `loading`, `fullWidth`, `leadingIcon`.

Migrating a hand-rolled button: `<button style={btnPrimary} onClick={x}>`
→ `<Button variant="primary" onClick={x}>`; drop any `opacity`/`cursor`
disabled overrides (Button owns them); map a small size override
(`padding:'4px 12px'`) to `size="sm"`. `Button`'s `secondary` matches the
old `btnSecondary` exactly, so it's a faithful swap.

### `<SecondaryButton>`

The neutral Cancel / Close / Later affordance (transparent bg + border +
muted text — distinct from `<Button variant="ghost">`, which is
borderless). Do NOT hand-roll the `transparent bg + grey border + grey
text` button style.

```tsx
import SecondaryButton from '@/components/SecondaryButton';

<SecondaryButton onClick={() => setSelectedIds(new Set())}>
  Clear Selection
</SecondaryButton>
```

Props:

- `size` — `sm` (default) matches toolbars/dialogs, `md` matches
  form-submit-adjacent cancels.

The audit found the exact same 8-property inline style copy-pasted
verbatim across 18 pages. Two of those properties (`#6b7280`,
`#d1d5db`) didn't map to any CSS variable — the component swaps them
to `var(--color-text-secondary)` + `var(--color-border)`, identical
today but coupled to the palette going forward.

### `<SearchInput>`

The free-text list-filter box shared across the Data Assets hub tabs
(Registry / Rules / Quality) so they look and behave identically. A
token-styled controlled text input with a clear (`×`) button that
appears once there's a value. Filtering stays the caller's job — this
only owns the input affordance. Do NOT hand-roll a bare
`<input placeholder="Search…">` for a list filter.

```tsx
import SearchInput from '@/components/SearchInput';

<SearchInput
  value={search}
  onChange={setSearch}
  placeholder="Search rules, asset, column…"
  ariaLabel="Search rules"
  width={230}
/>
```

Props: `value` / `onChange` (controlled), `placeholder`, `ariaLabel`
(defaults to the placeholder), `width` (number or CSS length). Pairs
naturally with `<ActiveFiltersBar>` — surface the active term as a
clearable chip there when the surface already shows filter chips.

---

### `<WizardProgress>`

Step-bar at the top of any multi-step flow.

```tsx
import WizardProgress from '@/components/WizardProgress';

<WizardProgress
  steps={['Industry', 'Generate', 'Review', 'Apply']}
  current={loading ? 1 : template ? 2 : 0}
  activeFill={loading ? Math.min(0.95, progressChars / TOTAL) : undefined}
/>
```

`activeFill` (0..1) drives a continuous fill on the active pill —
used by the Process Wizard's Generate step so the step-bar and the
big token-progress bar underneath can't disagree.

---

## Icons

### `renderNavIcon(route, { size, strokeWidth })`

Renders the same SVG the sidebar uses for a given route, at a chosen
size. Card headers, empty-state heroes, dashboards — anywhere a menu
item is visually referenced.

```tsx
import { renderNavIcon } from '@/components/navIcons';

<span>{renderNavIcon('/systems', { size: 24 })}</span>
```

Do NOT hand-pick Unicode glyphs (⚙, ⛁, ☰, ☻, etc.) for entities
that have a sidebar entry. The Enterprise View / Gap Detection /
Dashboard Quick Actions retrofits all went through this helper.

---

## Colours

CSS variables from `styles/global.css`. Never inline hex where a
variable exists.

**Semantic — swap direct:**

| Purpose | Variable | Hex today |
|---|---|---|
| Error / destructive text | `var(--color-error)` | `#dc2626` |
| Warning text | `var(--color-warning)` | `#d97706` |
| Success text | `var(--color-success)` | `#16a34a` |

**Structural:**

- `var(--color-primary)` / `--color-primary-hover` / `--color-primary-light`
- `var(--color-text)` / `--color-text-secondary` / `--color-text-muted`
- `var(--color-bg)` / `--color-surface` / `--color-border`

**When to keep hex:** palette-object entries — `{ bg: '#fee2e2',
color: '#dc2626' }` — where the hex is paired with a companion `bg`
to define a semantic-badge colour scheme. Those should NOT be
swapped to CSS variables; if the semantic variable is retuned, the
palette entry shouldn't drift.

---

## Radius + shadow tokens

```
--radius-sm: 3px   — small chips, mini-buttons
--radius-md: 6px   — cards, dialogs, form fields  (default)
--radius-lg: 10px  — modal overlays, large panels

--shadow-sm: minimal lift  (default card look)
--shadow-md: hover-lift on interactive cards
--shadow-lg: modal / dropdown overlays
```

Never hand-roll `boxShadow: '0 20px 60px rgba(0,0,0,0.25)'`. The
audit found 5 different hand-rolled shadow values across modal
panels; use `var(--shadow-lg)` for that layer.

---

## Where to look for examples

- **`Card` in the wild** — `ResetAllDataPanel.tsx`
- **`SectionLabel` in the wild** — `DataAssetsPage.tsx` (form
  section headers, 360-view section headers)
- **`TruncatedText` in the wild** — `SystemsPage.tsx` description
  column
- **`SecondaryButton` in the wild** — `AgentsPage.tsx`,
  `ConnectionsPage.tsx`, `DataQualityPage.tsx`, `DataLineagePage.tsx`
- **`WizardProgress` in the wild** — `ValueStreamWizard.tsx`,
  `SyncConnectionWizard.tsx`
- **`renderNavIcon` in the wild** — `EnterpriseViewPage.tsx`
  (`TYPE_CONFIG`), `GapDetectionPage.tsx` (`GAP_SECTIONS`),
  `DashboardPage.tsx` (Quick Actions)

Read one of these before wiring your own; the pattern is usually a
1-1 fit.
