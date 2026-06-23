import { useMemo } from "react";
import { sankey, sankeyLinkHorizontal } from "d3-sankey";
import type { SankeyModel, SankeyNode } from "../lib/agent-graph.js";
import type { SpanKind } from "../lib/span-kind.js";

/** Kind → token color class (currentColor drives the SVG fill/stroke; no raw hex). */
export function kindColorClass(kind: SpanKind | "terminal"): string {
  switch (kind) {
    case "llm":
      return "text-accent";
    case "tool":
      return "text-warning";
    case "retriever":
    case "embedding":
      return "text-primary";
    case "chain":
      return "text-foreground";
    default:
      return "text-muted-foreground";
  }
}

const W = 640;
const PAD_X = 4;

interface LaidOutNode extends SankeyNode {
  x0?: number;
  x1?: number;
  y0?: number;
  y1?: number;
}

/**
 * SankeyDiagram (M21) — renders a derived `{nodes, links}` flow with the d3-sankey
 * layout (crossing-minimized) and our own SVG draw (consistent with the M20
 * MetricChart / M11 Sparkbar approach). Nodes colored by `colorOf` (kind tokens);
 * links neutral. `role="img"` + aria-label + a visually-hidden node-count summary
 * (screen readers get the topology; the SVG itself is decorative).
 */
export function SankeyDiagram({
  model,
  ariaLabel,
  height = 320,
  colorOf = (n) => kindColorClass(n.kind),
}: {
  model: SankeyModel;
  ariaLabel: string;
  height?: number;
  colorOf?: (node: SankeyNode) => string;
}) {
  const laid = useMemo(() => {
    if (model.nodes.length === 0 || model.links.length === 0) return null;
    const gen = sankey<SankeyNode, { value: number }>()
      .nodeId((d) => d.id)
      .nodeWidth(14)
      .nodePadding(12)
      .extent([
        [PAD_X, PAD_X],
        [W - PAD_X, height - PAD_X],
      ]);
    try {
      // d3-sankey mutates copies; links reference node ids via the nodeId accessor.
      return gen({
        nodes: model.nodes.map((n) => ({ ...n })),
        links: model.links.map((l) => ({ ...l })) as never,
      });
    } catch {
      // Defense in depth: the derivation already produces a DAG, but d3-sankey
      // throws on any unforeseen cycle — degrade to empty rather than crash the app.
      return null;
    }
  }, [model, height]);

  // SR summary: nodes with counts + the dominant handoffs (a Sankey's value IS the
  // flow, so the summary names the edges too — F-1).
  const nodeSummary = model.nodes
    .filter((n) => n.kind !== "terminal")
    .map((n) => `${n.id} (${n.count})`)
    .join(", ");
  const flowSummary = model.links
    .filter((l) => l.source !== "Start" && l.target !== "End")
    .map((l) => `${l.source} to ${l.target}`)
    .join(", ");
  const summary = nodeSummary
    ? `Nodes: ${nodeSummary}.${flowSummary ? ` Flow: ${flowSummary}.` : ""}`
    : "no spans";

  return (
    <div className="sankey-diagram">
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        aria-label={ariaLabel}
      >
        {laid == null ? null : (
          <>
            <g className="text-muted-foreground" fill="none" strokeOpacity={0.25}>
              {laid.links.map((l, i) => (
                <path
                  key={i}
                  d={sankeyLinkHorizontal()(l) ?? undefined}
                  stroke="currentColor"
                  strokeWidth={Math.max(1, l.width ?? 1)}
                />
              ))}
            </g>
            {laid.nodes.map((n) => {
              const node = n as LaidOutNode;
              const x0 = node.x0 ?? 0;
              const y0 = node.y0 ?? 0;
              const w = (node.x1 ?? 0) - x0;
              const h = (node.y1 ?? 0) - y0;
              return (
                <g key={node.id} className={colorOf(node)}>
                  <rect x={x0} y={y0} width={w} height={Math.max(0, h)} fill="currentColor" />
                  <text
                    x={x0 < W / 2 ? (node.x1 ?? 0) + 4 : x0 - 4}
                    y={y0 + h / 2}
                    dy="0.35em"
                    textAnchor={x0 < W / 2 ? "start" : "end"}
                    className="fill-foreground text-body-sm"
                  >
                    {node.id} · {node.count}
                  </text>
                </g>
              );
            })}
          </>
        )}
      </svg>
      <span className="sr-only">{summary}</span>
    </div>
  );
}
