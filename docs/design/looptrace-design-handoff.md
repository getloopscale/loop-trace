# LoopTrace — Design Handoff

**For:** the (external) professional design team
**From:** the LoopTrace engineering team
**Date:** 2026-06-26
**Status:** Ready for design — engineering has frozen the data model & screen inventory below; the team owns the visual design.
**Current build:** v0.35.0 · live dev instance: `http://localhost:4318/`

---

## 0. How to use this document

This is a **complete brief** so the design team can design **every screen** without needing to read the codebase. It contains: product context, the design constraints you MUST work within (tech stack + design system + accessibility + honesty rules), the full information architecture, a **per-screen spec** (purpose, the *real* data fields each screen renders, user tasks, current pain points, and what to design), the design-system inventory (tokens, type scale, primitives), the states every screen needs, and the deliverables we expect back.

What is **fixed** (engineering owns): the data model / fields, the routes, the underlying design-system package (`@getloopscale/ui`).
What is **yours** (design owns): visual hierarchy, layout, density, color application, typography application, motion, states, iconography, the trace-detail experience, charts.

---

## 1. Product context

**LoopTrace** is an **OpenTelemetry-native observability platform for AI agents** — think *"Jaeger / Arize / Grafana for AI agents."* Teams point their agents' OpenTelemetry traces at LoopTrace and use it to **see what their agents did**, debug failures, and track cost/latency/quality.

- **Primary users:** AI engineers, platform/observability engineers, ML/agent developers debugging multi-step agent runs in dev and production.
- **Core job-to-be-done:** "My agent did something weird / slow / expensive — show me exactly what happened, step by step, with the inputs and outputs, so I can fix it."
- **Data it ingests:** OTLP traces from agent frameworks (LangChain/LangGraph-style), from **Claude Code** (a first-class producer), and from any OpenTelemetry-instrumented app.
- **Direct competitors / the bar to beat:** **Arize Phoenix**, **Grafana** (+ its "Sigil" agent UI), **Langfuse**, **Jaeger**. Reference screenshots of the experience we benchmark against live in `../MODELOS/` (Arize/Sigil teardowns).

### The core domain vocabulary (design must reflect these correctly)

| Term | Meaning |
|---|---|
| **Trace** (a.k.a. *Execution*) | One end-to-end agent run. A tree of spans. The unit of the main list. |
| **Span** | One step within a trace (an LLM call, a tool call, a retrieval, an agent node). Has a parent → forms a tree. |
| **Span kind** | The semantic type of a span, derived from its signals: **LLM**, **TOOL**, **RETRIEVER**, **EMBEDDING**, **AGENT/CHAIN**, **UNKNOWN**. Each has a canonical color (see §6). |
| **Session** | A group of traces sharing a `session.id` (e.g. one conversation across many turns). |
| **Agent** | A first-class entity tracked across versions/tools/generations (distinct from the per-trace tree). |
| **Tool** | A named capability an agent calls (Bash, Read, a search API…). Tracked with call counts + latency. |
| **Evaluation (eval)** | A score/label/explanation attached to a span by an automated evaluator (e.g. hallucination=0.2). |
| **Annotation** | A human's 👍/👎 + note on a trace or span (human feedback). |
| **Dataset** | A curated set of example traces (snapshots of input/output), for regression/eval. |
| **Waterfall** | The trace-detail view of spans laid out by start time + duration (the Gantt-like bars). |

---

## 2. The hard constraints (non-negotiable — design within these)

1. **Tech stack:** React 18 + TypeScript, Vite. No design tool export will be hand-translated blindly — deliverables must map to the component system below.
2. **Design system — `@getloopscale/ui`.** This is the locked foundation. It ships:
   - **Fonts:** Geist (sans) + Geist Mono. *Do not introduce new font families* — design with Geist. (If a display accent is desired, propose it as a theme-level change, not per-screen.)
   - **Theme:** currently **Violet Forge, dark mode**. The package also ships alternative themes the team MAY evaluate/match: `violetForge`, `vercelMono`, `githubDark`, `dracula`, `oneDark`, `anthropicStyle`, `openaiStyle`, `linearGlass`, `classicPaper`, `auroraTerminal`. **Recommendation:** stay dark-first (observability tools are used in dark IDEs); a light mode is a *nice-to-have*, not in scope unless the team argues for it.
   - **Tokens, type scale, and primitives:** see §6. **Design using these tokens** (semantic color roles, the type scale, the spacing scale) rather than raw hex/px — anything off-scale creates engineering drift.
3. **Accessibility (required):** WCAG AA contrast on the dark theme; full keyboard navigation; visible focus states; color is **never the only signal** (always pair a kind/status color with its text label or icon); charts carry text alternatives. The current build already does keyboard nav + sr-only chart summaries — keep that bar.
4. **Honesty / public-copy rules (brand):** No invented numbers, no "production-ready/battle-tested/enterprise-grade" claims, no competitor names in-product. Empty/zero states must be truthful ("No data in this range"), never fake content. (Full rules: `.claude/rules/public-copy.md`.)
5. **Information density:** This is a **professional observability tool**, not a marketing site. Favor **scannable density** (Linear/Grafana/Arize level) over big marketing whitespace. Rows over cards for lists. Every pixel should earn its place with data.
6. **Performance:** lists can hold thousands of traces; the trace tree can be deep (5+ levels, 100+ spans). Designs must work at high cardinality (virtualization-friendly rows, truncation rules, "+N more" patterns).

---

## 3. Why we're engaging design (the problem)

A staff-level heuristic audit of the current build found the foundation is sound but the **execution is flat and reads like a beta prototype**, not a premium observability product. The systemic problems (these are the brief's targets):

1. **Weak information hierarchy** — page titles don't separate from content; section headings are flat; the most important data isn't visually dominant.
2. **Ad-hoc spacing** — no consistent rhythm; toolbars and sections lack breathing room and containment.
3. **Missing affordances** — table rows without hover, actions that look like inputs, near-invisible selection, links that look like text.
4. **Bare states** — loading/empty/error exist but offer no next step or polish.
5. **The trace-detail 3-pane (our most important, most-used screen)** — the waterfall tree lacks structure/connectors and column headers; the I/O panel shows monochrome JSON with no syntax highlighting/copy; typography is cramped.
6. **Charts** — no per-series color, no legend, no gridlines.

**The mandate:** a cohesive visual system with clear hierarchy, observability-appropriate density, polished states, and a trace-detail experience that **rivals Arize/Grafana**.

---

## 4. Information architecture

Persistent app chrome: **left Sidebar** (primary nav) + **TopNav** (page title + global controls: date-range picker, Live toggle, span-query bar, Cmd/Ctrl+K command palette) + per-project **Tabs** (Traces · Spans · Agent Graph · Agent Path) on trace-scoped views.

### Sidebar nav (every destination)

| Nav item | Route | Screen |
|---|---|---|
| Executions | `/` | Trace list (primary screen) |
| ↳ (drill) | `/traces/:traceId` | Trace detail (3-pane) |
| Sessions | `/sessions`, `/sessions/:id` | Sessions list + detail |
| Dashboards | `/dashboards` | Pinned charts + north-star metrics |
| Evals & Metrics | `/evals` | Online-evaluator cards |
| Datasets | `/datasets`, `/datasets/:id` | Dataset list + detail |
| Agents | `/agents` | Agent catalog |
| Tools | `/tools`, `/tools/:toolName` | Tool analytics + per-tool traces |
| Cost | `/analytics` | Cost analytics |
| (project tabs) | `/spans` `/agent-graph` `/agent-path` | Spans (placeholder), Agent Graph, Agent Path |

Global top-bar controls present on most screens: **Date-range picker** (Last 1h / 24h / 7d / 30d, default 7d), **Live toggle** (continuous refresh + pulsing badge), **Span-query bar** (`kind:llm status:error model:gpt-4o`), **Command palette** (Cmd/Ctrl+K → jump to any view or open a trace by ID).

---

## 5. Per-screen specs

> For each screen: **Purpose**, **Real data fields** (what the API actually returns — design around these exact fields, nothing invented), **User tasks**, **Current pain**, **Design ask**.

### 5.1 Executions — Trace list (`/`) — PRIMARY SCREEN

- **Purpose:** the home; scan/find/triage agent runs. Equivalent to Arize's traces table.
- **Data per row (`TraceListItem`):** `name`, `startTimeUnixNano` (→ relative time), `durationMs`, `statusCode` (ok/error), `totalTokens`, `model`, `costUsd`, derived **span-kind** (from `model`/`rootOperationName`/`rootToolName`), `inputPreview`, `outputPreview`, `evaluationsCount`, `sessionId`.
- **Above the table:** a **summary strip** (4 stat tiles + sparkbars: trace count, error rate, cost, tokens over the range), a **filter/toolbar** (status, model, tag, full-text search `q`, span-query DSL, date range, saved-view selector, CSV export, column toggle).
- **User tasks:** find the failing/slow/expensive run; filter by model/status/tag/free-text; sort by recent/latency/tokens/cost; open a trace; save a filter view; export.
- **Current pain:** title flush with controls; summary strip + filters uncontained; rows lack hover/selection; preview text too dim/narrow; empty state is bare text.
- **Design ask:** a clear **page header** zone; contained **summary strip** with real KPIs (label + value + trend); a structured, grouped **filter bar** where the export/primary action reads as an action; a **dense, scannable table** with hover + row affordance, legible kind/status/model badges, readable I/O previews (consider 2-line clamp), clear sort indicators; a helpful empty state ("No executions in this range" + adjust-filters / docs action).

### 5.2 Trace detail — 3-pane (`/traces/:traceId`) — MOST IMPORTANT SCREEN

- **Purpose:** understand one agent run step-by-step. This is where users spend debugging time. **Beat Arize here.**
- **Layout today:** **left** = span **waterfall tree**; **center** = **Span Info** (tabbed: Trace Info · Attributes · Events · Evaluations · Annotations); **right** = **Input/Output** panel. A **replay** control steps through spans (next/prev + ArrowKeys); the active span drives center+right.
- **Span data (`SpanNodeData`):** `name`, `kind`, `parentSpanId` (tree), `startTimeUnixNano`/`endTimeUnixNano` (→ duration + waterfall position), `statusCode`/`statusMessage`, `model`, `provider`, `inputTokens`/`outputTokens`, `toolName`, `inputValue`/`outputValue` (capped text), `ttftMs` (time-to-first-token), `cacheReadTokens`/`cacheCreationTokens`, `events[]`, `evaluations[]` (name/score/label/explanation), `attributes` (arbitrary key/values).
- **User tasks:** read the tree top-to-bottom; spot the slow/errored span via the waterfall; click a span to read its **input** (prompt/command) and **output** (response/result); inspect tokens/cost/TTFT/cache; read attributes/events; see eval verdicts; leave a 👍/👎 annotation; step through with replay.
- **Current pain:** tree has no containment/connectors/column header; waterfall bar dominates and lacks a scale/legend; selected span barely visible; Span-Info rows cramped & inconsistently spaced; **I/O is monochrome JSON, no syntax highlight, no copy, small font**.
- **Design ask (high priority):**
  - A **structured waterfall**: column header (Span · Kind · Duration · Waterfall), indentation guides/connectors, per-kind color on the bar, a clear **selected** state, sticky header, virtualization-friendly rows; a duration scale/legend.
  - A **scannable Span-Info**: a definition-list / metric-grid layout (label ↔ value), grouped sections (Identity, Timing, Tokens & cost, Cache & TTFT), consistent rhythm; clean tabbed sub-views.
  - A **premium I/O panel**: syntax-highlighted JSON/markdown (keys≠values), copy button, Pretty/Raw toggle that reads as a real control, comfortable font size, graceful handling of huge/truncated payloads.
  - Eval verdicts (score + label + explanation) and human annotations as first-class, legible elements.

### 5.3 Sessions — list (`/sessions`) + detail (`/sessions/:id`)

- **Purpose:** view multi-turn conversations (traces grouped by `session.id`).
- **List data (`SessionListItem`):** `sessionId`, `firstSeenAt`/`lastSeenAt`, `traceCount`, `costUsd`, `totalTokens`, `errorRate`, `firstMessagePreview`, `evaluationsCount`.
- **Detail data (`SessionDetail`):** the above + `latencyP50Ms`/`latencyP95Ms` + the member `traces[]`.
- **User tasks:** find a conversation; see its size/cost/health at a glance; drill into the member traces.
- **Design ask:** make "this is a *group* of traces" visually obvious (e.g. a count badge + grouped affordance); a session-detail header with scoped aggregates (turns, cost, tokens, error rate, p50/p95) + the member-traces table; helpful empty state.

### 5.4 Dashboards — pinned charts + north-star (`/dashboards`)

- **Purpose:** the metrics home. Time-series health: **traffic** (count + error rate), **latency** (p50/p75/p95/p99), **tokens & cost by model**; plus a north-star (traces/day, replay sessions/week). A chart-type segmented toggle.
- **Data:** `TrafficBucket`, `LatencyBucket` (4 percentile series), `ModelTokenBucket`, `NorthStarBucket`.
- **Current pain:** flat sections; weak toggle feedback; **single-color charts with no legend/gridlines/axes** (multi-series latency is unreadable).
- **Design ask:** sectioned dashboard with clear "floors"; **multi-series chart spec** (distinct token colors per series, legend, subtle gridlines, axis/units, hover tooltip); each pinned chart as a card with headline stats above the chart.

### 5.5 Evals & Metrics (`/evals`)

- **Purpose:** show automated evaluator results. One **Online Evaluator** card per evaluator.
- **Data (`EvaluatorSummary`):** `name`, `count`, `avgScore`, `labels` (a label→count distribution).
- **Design ask:** evaluator card with a strong headline (avg score + count) and a readable label distribution (mini bar/segmented). Simplify the empty state to plain language + a docs action.

### 5.6 Datasets — list (`/datasets`) + detail (`/datasets/:id`)

- **Purpose:** curate example traces. List of datasets; a create form; per-dataset items (input/output snapshots).
- **Data:** `Dataset` (`name`, `createdAt`, `itemCount`); `DatasetDetail.items[]` (`traceId`, `inputSnapshot`, `outputSnapshot`, `createdAt`).
- **Design ask:** polished create form (proper input/button primitives, submit feedback), a dataset list, a dataset-detail table of snapshots with input/output preview + remove; helpful empty state.

### 5.7 Agents — catalog (`/agents`)

- **Purpose:** agents as first-class entities tracked across versions/tools.
- **Data (`Agent`):** `name`, `firstSeenAt`/`latestSeenAt`, `runCount`, `versions[]`/`versionCount`, `tools[]`, `systemPrompt`, health flags (`stale`, `highChurn`, `anonymous`).
- **Design ask:** a catalog (table or card grid) with each agent's run count, version history, tools used, latest system prompt (expandable), and **health badges** (stale > 30d · high churn · anonymous) as clear, color+label signals.

### 5.8 Tools — analytics (`/tools`) + per-tool traces (`/tools/:toolName`)

- **Purpose:** rank tools by usage + reliability + latency.
- **Data (`ToolStat`):** `toolName`, `callCount`, `errorCount`, `errorRate`, `p50Ms`, `p95Ms`.
- **Design ask:** a ranked tool table (sortable), error-rate + latency rendered as glanceable signals (bar/heat), drill-down to the traces using a tool.

### 5.9 Cost (`/analytics`)

- **Purpose:** cost over time + by model. Data: `CostBucket` / `CostByPeriodResponse`.
- **Design ask:** cost trend chart + by-model breakdown; consistent with the Dashboards chart spec.

### 5.10 Agent Graph (`/agent-graph`) & Agent Path (`/agent-path`)

- **Purpose:** visualize the agent topology / the path through a multi-agent run (node-link). Nodes colored by span-kind.
- **Design ask:** a clean node-link layout (nodes = agents/spans, edges = calls), kind-colored nodes with labels, readable at 4+ agents; a "path" emphasis variant.

### 5.11 Cross-cutting: Command palette, Date-range picker, Live toggle, Span-query bar

These global controls appear across screens — design them as a coherent top-bar system (compact, keyboard-first, with the Live "pulsing" affordance and a clear active-filter state).

---

## 6. Design-system inventory (the levers to design with)

### Type scale (Geist) — semantic classes already in the system
`text-display-md` (~32) · `text-display-sm` (~24) · `text-title-md` (~20) · `text-title-sm` (~16) · `text-label` (~14) · `text-body-sm` (~12) · plus `font-display` (Geist display weight) and `font-mono` (Geist Mono for code/IDs/numbers — use `tabular-nums` for metrics).

### Color — semantic token roles (Violet Forge dark; design in roles, not hex)
`background` · `card` · `muted` · `foreground` · `muted-foreground` · `border` · and accent roles `primary` · `accent` · `warning` · `info` · `success` · `destructive` (each with a `-foreground` pair). Subtle fills via `/10`–`/20` opacity (e.g. selected row = `primary/20`).

### Span-kind canonical colors (already defined — keep the mapping, refine the application)
**AGENT** = violet · **LLM** = orange · **TOOL** = amber/yellow · **RETRIEVER** = blue · **EMBEDDING** = green · **UNKNOWN** = muted. Always paired with the text label.

### Spacing — propose a strict scale (today it's ad-hoc)
Recommend: page sections `24px`, card/section inner `16px`, item/row `8–12px`. The team should codify a rhythm and apply it everywhere.

### Primitives available in `@getloopscale/ui` (build on these — don't reinvent)
`Button` (+variants) · `Badge` (+variants: default/outline/accent/primary/success/warning/destructive) · `Card` · `Input` · `Textarea` · `Select` · `Checkbox` · `RadioGroup` · `Switch` · `Label` · `FormField` · `Tabs` · `Dialog` · `Tooltip` · `ScrollArea` · `Toast`/`Toaster` · `Skeleton` · `EmptyState` · `Avatar` · `Sidebar` · `TopNav` · `DataTable` · `Timestamp` · `StatTile` · `CostMeter` · `ContextWindowBar` · `RunStatusPill` · plus AI-specific parts (`ToolsList`, `SkillCard`, `TaskPlan`, `SystemPromptEditor`, `PermissionMatrix`). Icons: **lucide-react**.

> If a needed pattern isn't a primitive yet (e.g. a richer code-viewer, a multi-series chart, a tree/waterfall), specify it as a **new component** in the deliverables and we'll build it into the app (and ideally upstream into `@getloopscale/ui`).

---

## 7. States every screen must specify

For each screen/region, design the full set — these are first-class, not afterthoughts:
- **Loading** — skeletons matching the final layout (no "Loading…" text).
- **Empty** — truthful copy ("No X in this range") + a **next action** (adjust filters / change range / docs / create).
- **Error** — clear message + a **Retry** affordance (and/or docs link). Never a dead end.
- **Zero-but-valid** vs **filtered-to-empty** (distinguish "no data yet" from "your filter matched nothing").
- **Partial / truncated** — large payloads, deep trees, "+N more", capped text markers.
- **Live** — the active/streaming state (Live toggle on).
- **Dense / high-cardinality** — the table at thousands of rows; the tree at 100+ spans.

---

## 8. Deliverables we expect back

1. **Foundations:** confirmed theme (dark-first), the spacing scale, the type-scale application rules, the semantic-color application (incl. span-kind usage), elevation/border rules, motion guidelines (load reveals, hover/focus, the Live pulse).
2. **Core components (specs + Figma):** PageHeader, Toolbar/FilterBar, dense DataTable (row states, badges, previews), the **Waterfall tree**, **Span-Info metric grid**, **Code/IO viewer** (syntax-highlighted + copy + Pretty/Raw), **multi-series Chart** (legend/gridlines/tooltip), StatTile/summary strip, health Badges, empty/error/loading templates, the global top-bar (date range + Live + span-query + palette).
3. **Every screen in §5**, designed in dark theme, at realistic data density, with all §7 states. Use the real fields in §5 (and the live instance / `../MODELOS/` references) — no lorem, no invented metrics.
4. **Redlines / token mapping:** annotate spacing, type, and color **as `@getloopscale/ui` tokens** (so engineering implements without guessing).
5. **Accessibility notes:** contrast pairs used, focus-state spec, keyboard order, color-blind-safe kind palette confirmation.
6. **A prioritized rollout** (what ships first): we suggest **(a) foundations + PageHeader + table/toolbar**, then **(b) the trace-detail 3-pane**, then **(c) charts/dashboards**, then **(d) the remaining list screens** — but the team may re-sequence.

---

## 9. References & access

- **Live dev instance:** `http://localhost:4318/` (dark, Violet Forge, seedable demo data via the team — multi-agent travel-agent traces + real Claude Code traces).
- **Benchmark screenshots (the bar):** `../MODELOS/` (Arize / Sigil teardowns).
- **Design-system package:** `@getloopscale/ui` (Geist, tokens, primitives — see §6).
- **Brand/voice rules:** `.claude/rules/public-copy.md` (honesty, banned framings).
- **Studied peers (for prior-art, in repo, read-only):** `knowledge-base/references/` — `langfuse`, `laminar`, `openlit` (their `globals.css` + screens are fair inspiration for an observability aesthetic).
- **Engineering point of contact:** the LoopTrace eng team (this repo). Questions about a field's meaning → the domain glossary (§1) or ask eng.

---

## 10. Out of scope (for this engagement)

- Changing the data model / API shape (fields in §5 are fixed).
- Replacing `@getloopscale/ui` or introducing a new font family (theme-level proposals welcome, but not per-screen forks).
- Net-new product features/screens beyond §4 (this is a **redesign of existing screens**, not new scope).
- Marketing site / landing pages (this is the in-product app).

---

*Engineering will translate the approved designs into `@getloopscale/ui`-based React under the standard cycle (plan → implement → review → release), screen by screen per the §8 rollout.*
