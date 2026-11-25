import { Badge, DataTable, Timestamp, type DataTableColumn } from "@usetheo/ui";
import type { Agent } from "../../api/types.js";
import { EmptyState } from "../primitives/States.js";

const DASH = "—";

function isoToMs(iso: string): number | undefined {
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/** Health badges for an agent row (stale / high-churn / anonymous), a11y-labelled. */
function HealthBadges({ agent }: { agent: Agent }) {
  const flags: { on: boolean; label: string; text: string; variant: "warning" | "destructive" }[] = [
    { on: agent.stale, label: "stale", text: "stale", variant: "warning" },
    { on: agent.highChurn, label: "high churn", text: "high churn", variant: "warning" },
    { on: agent.anonymous, label: "anonymous", text: "anonymous", variant: "destructive" },
  ];
  const active = flags.filter((f) => f.on);
  if (active.length === 0) {
    return <Badge variant="success" size="sm" aria-label="healthy">healthy</Badge>;
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      {active.map((f) => (
        <Badge key={f.label} variant={f.variant} size="sm" aria-label={f.label}>
          {f.text}
        </Badge>
      ))}
    </span>
  );
}

const columns: DataTableColumn<Agent>[] = [
  {
    key: "name",
    label: "Agent",
    render: (a) => <span className="font-display">{a.name || "(unnamed)"}</span>,
  },
  { key: "runs", label: "Runs", align: "right", render: (a) => a.runCount },
  {
    key: "versions",
    label: "Versions",
    align: "right",
    render: (a) => (
      <span title={a.versions.join(", ")} className="tabular-nums">
        {a.versionCount}
      </span>
    ),
  },
  {
    key: "tools",
    label: "Tools",
    render: (a) =>
      a.tools.length === 0 ? (
        <span className="text-muted-foreground">{DASH}</span>
      ) : (
        <span className="block max-w-[28ch] truncate text-muted-foreground" title={a.tools.join(", ")}>
          {a.tools.join(", ")}
        </span>
      ),
  },
  {
    key: "prompt",
    label: "System prompt",
    render: (a) => (
      <span className="block max-w-[36ch] truncate text-muted-foreground" title={a.systemPrompt}>
        {a.systemPrompt ?? DASH}
      </span>
    ),
  },
  {
    key: "latest",
    label: "Latest seen",
    render: (a) => {
      const ms = isoToMs(a.latestSeenAt);
      return ms == null ? DASH : <Timestamp value={ms} format="relative" />;
    },
  },
  { key: "health", label: "Health", render: (a) => <HealthBadges agent={a} /> },
];

/**
 * Agents catalog table (M32): one row per declared agent (by `agent.name`), with
 * versions / tools / latest system prompt / latest-seen + health badges. Read-only,
 * derived — built on the shared UI kit DataTable. Dark + token-based.
 */
export function AgentCatalogTable({ agents }: { agents: Agent[] }) {
  if (agents.length === 0) {
    return (
      <EmptyState message="No agents yet — agents are derived from spans carrying an agent.name attribute (the agent.* convention). Seed the demo or send agent telemetry to populate this catalog." />
    );
  }
  return (
    <DataTable
      data={agents}
      columns={columns}
      rowKey={(a) => a.name}
      emptyState={<span className="text-muted-foreground">No agents yet</span>}
    />
  );
}
