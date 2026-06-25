/**
 * Travel-agent demo dataset (M28) — a PURE, DETERMINISTIC builder of an OTLP
 * envelope that, once ingested, populates every screen with a multi-agent
 * travel-planning trace set (a `TripAgentGraph` root → `local_agent` /
 * `research_agent` / `budget_agent` / `itinerary_agent`, each with a `ChatOpenAI`
 * LLM, tool, and — for `local_agent` — a `VectorStoreRetriever` child span).
 *
 * Design (M28 ADR-1/ADR-2):
 *  - Pure + deterministic: ids/timestamps come from fixed counters + an injected
 *    base time (NEVER Date.now/random), so re-seeding is idempotent and tests are
 *    stable.
 *  - Emits the standard OTLP `gen_ai.*` + OpenInference `input.value`/`output.value`
 *    attribute convention the default adapter already reads — so span-kind
 *    classification (`deriveSpanKind`) yields LLM / TOOL / RETRIEVER / chain(agent)
 *    with NO pipeline change. Agent spans are named `*_agent` with children →
 *    classify as `chain` and the Agent Graph groups them by name into agent nodes.
 *  - Content is ORIGINAL travel-planning text (Rome theme); no competitor copy/brand.
 *  - `service.name = theo-lens-demo-travel-agent` (ours) so demo telemetry is never
 *    mistaken for real production data.
 */

/** OTLP AnyValue scalar wrappers (proto-json: int64 encoded as string). */
type AnyValue = { stringValue: string } | { intValue: string };
interface KeyValue {
  key: string;
  value: AnyValue;
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status?: { code: string; message?: string };
  attributes: KeyValue[];
}
export interface OtlpEnvelope {
  resourceSpans: Array<{
    resource: { attributes: KeyValue[] };
    scopeSpans: Array<{ spans: OtlpSpan[] }>;
  }>;
}

export interface BuildTravelAgentOpts {
  /** Number of root traces to emit (default 8). */
  traces?: number;
  /** Number of sessions to group them into (clamped to 1..traces; default 3). */
  sessions?: number;
  /** Base wall-clock in unix nanos (default fixed — keeps the build deterministic). */
  baseTimeUnixNanos?: bigint;
}

export const DEMO_SERVICE_NAME = "theo-lens-demo-travel-agent";

const sv = (v: string): AnyValue => ({ stringValue: v });
const iv = (n: number): AnyValue => ({ intValue: String(n) });

/** Build a KeyValue[] from a record, dropping undefined values. */
function kvs(rec: Record<string, AnyValue | undefined>): KeyValue[] {
  return Object.entries(rec)
    .filter((e): e is [string, AnyValue] => e[1] !== undefined)
    .map(([key, value]) => ({ key, value }));
}

/** Deterministic lowercase-hex id of `len` chars from a numeric counter (M28 idempotency). */
function hexId(len: number, n: number): string {
  return n.toString(16).padStart(len, "0").slice(-len);
}

/** Default base time — fixed so the build is byte-deterministic (idempotency). */
const DEFAULT_BASE_NANOS = 1_782_300_000_000_000_000n;
const MS = 1_000_000n; // nanos per millisecond

/** Per-agent demo spec: model, the tools it calls, and whether it retrieves. */
interface AgentSpec {
  name: string;
  model: string;
  task: string;
  result: string;
  tools: Array<{ name: string; input: string; output: string }>;
  retriever?: { query: string; documents: string };
  llm: { system: string; input: string; output: string; inTok: number; outTok: number };
  /**
   * M32: the agent's declared version. A function of the trace index so one agent can
   * emit several versions across the seeded traces (research_agent → churn). The
   * agent's system prompt is its `llm.input` instruction (no separate field needed).
   */
  version: (traceIndex: number) => string;
}

const AGENTS: AgentSpec[] = [
  {
    name: "local_agent",
    model: "gpt-4o",
    task: "Find hidden gems and authentic local-food spots in Rome.",
    result:
      "Hidden gems: the Catacombs of San Callisto, the Quartiere Coppedè, and the Testaccio market. Eat where Romans eat — Testaccio and Trastevere over the tourist centre.",
    tools: [
      {
        name: "hidden_gems",
        input: '{"destination": "Rome"}',
        output:
          "Catacombs of San Callisto; Quartiere Coppedè; Aventine Keyhole; Centrale Montemartini.",
      },
      {
        name: "local_flavor",
        input: '{"city": "Rome", "interest": "food"}',
        output:
          "Testaccio market for supplì and pizza al taglio; Trastevere trattorias for cacio e pepe.",
      },
    ],
    retriever: {
      query: "Rome local food neighborhoods and offbeat sights",
      documents:
        '[{"id": "doc-testaccio", "text": "Testaccio is Rome\'s culinary heart, built around the old slaughterhouse."}, {"id": "doc-appia", "text": "The Catacombs of San Callisto lie along the Appian Way."}]',
    },
    llm: {
      system: "openai",
      input:
        "You are a local Rome guide. Use the retrieved context to suggest authentic, offbeat experiences and where locals actually eat.",
      output:
        "Start early at the Catacombs of San Callisto on the Appian Way, then lunch in Testaccio. Skip the chain cafés near the Colosseum.",
      inTok: 220,
      outTok: 180,
    },
    version: () => "2.1.0",
  },
  {
    name: "research_agent",
    model: "gpt-4o",
    task: "Summarize Rome's climate, best season, and practical travel facts.",
    result:
      "Rome has a Mediterranean climate; spring and early autumn are ideal. Most ancient sites are walkable; buy timed Colosseum tickets in advance.",
    tools: [
      {
        name: "essential_info",
        input: '{"destination": "Rome"}',
        output:
          "Currency: EUR. Plug: type F. Tap water is potable (the nasoni fountains). Many museums close Mondays.",
      },
    ],
    llm: {
      system: "openai",
      input:
        "You are a travel researcher. Provide concise, accurate practical facts for a 3-day Rome trip.",
      output:
        "Rome has a Mediterranean climate — warm dry summers, mild winters. Best in April–May or September–October. Three days comfortably covers Ancient Rome, the Vatican, and Trastevere.",
      inTok: 180,
      outTok: 150,
    },
    // M32: research_agent ships frequently → 3 versions across the 8 traces (high churn).
    version: (t) => `1.${t % 3}.0`,
  },
  {
    name: "budget_agent",
    model: "gpt-4o-mini",
    task: "Produce a mid-range 3-day Rome budget breakdown.",
    result:
      "Mid-range estimate ~€110/day: lodging €70, food €30, transit/sights €10. Total ≈ €330 for 3 days, excluding flights.",
    tools: [
      {
        name: "budget_basics",
        input: '{"city": "Rome", "tier": "mid-range"}',
        output:
          "Hotel €70/night; trattoria meal €15; Roma Pass (3 days) €52; metro ticket €1.50.",
      },
    ],
    llm: {
      system: "openai",
      input:
        "You are a budget planner. Break down a mid-range 3-day Rome trip into lodging, food, and transit.",
      output:
        "Here is a breakdown of your mid-range Rome budget: lodging €70/day, food €30/day, transit & sights €10/day — about €330 over three days, flights excluded.",
      inTok: 160,
      outTok: 140,
    },
    version: () => "1.0.0",
  },
  {
    name: "itinerary_agent",
    model: "gpt-4o",
    task: "Synthesize the local, research, and budget findings into a 3-day itinerary.",
    result:
      "Day 1: Ancient Rome (Colosseum, Forum, Palatine). Day 2: Vatican Museums & St. Peter's, evening in Trastevere. Day 3: Catacombs of San Callisto & Testaccio food crawl.",
    tools: [],
    llm: {
      system: "openai",
      input:
        "You are an itinerary planner. Combine the hidden-gems, research, and budget notes into a day-by-day plan.",
      output:
        "Day 1: Arrival and Discovering Ancient Rome — Colosseum, Roman Forum, Palatine Hill. Day 2: Vatican Museums, St. Peter's, then Trastevere for dinner. Day 3: Catacombs of San Callisto and a Testaccio food crawl.",
      inTok: 320,
      outTok: 280,
    },
    version: () => "1.3.0",
  },
];

const TRIP_REQUEST =
  "Plan a 3-day trip to Rome focused on ancient history and local food, mid-range budget.";
const TRIP_RESULT =
  "Day 1: Ancient Rome — Colosseum, Roman Forum, Palatine Hill. Day 2: Vatican Museums & St. Peter's, evening in Trastevere. Day 3: Catacombs of San Callisto and a Testaccio food crawl. Estimated mid-range cost ≈ €330 (excl. flights).";

/**
 * Build the deterministic OTLP envelope for the demo dataset. Pure: same opts →
 * byte-identical output (idempotency precondition).
 */
export function buildTravelAgentEnvelope(
  opts: BuildTravelAgentOpts = {},
): OtlpEnvelope {
  const traces = Math.max(0, Math.floor(opts.traces ?? 8));
  // EC-1: cannot group N traces into more than N sessions.
  const sessions = traces === 0 ? 0 : Math.max(1, Math.min(opts.sessions ?? 3, traces));
  const base = opts.baseTimeUnixNanos ?? DEFAULT_BASE_NANOS;

  const spans: OtlpSpan[] = [];
  let spanSeq = 1;
  const nextSpanId = (): string => hexId(16, spanSeq++);

  for (let t = 0; t < traces; t++) {
    const traceId = hexId(32, 0xde_00_00_00 + t);
    const sessionId = `demo-session-${t % sessions}`;
    // Each trace is offset by 10 minutes so they spread across the timeline.
    const traceStart = base + BigInt(t) * 600_000n * MS;
    // EC: surface an ERROR row periodically (matches the reference's failed rows).
    const errored = t % 4 === 3;

    let cursor = traceStart;
    const advance = (ms: number): { start: string; end: string } => {
      const start = cursor;
      const end = cursor + BigInt(ms) * MS;
      cursor = end;
      return { start: String(start), end: String(end) };
    };

    // Root: TripAgentGraph (chain — has children, no model/tool).
    const rootId = nextSpanId();
    const rootWindow = { start: traceStart, end: traceStart }; // patched after children
    const rootSpanIndex = spans.length;
    spans.push({
      traceId,
      spanId: rootId,
      name: "TripAgentGraph",
      startTimeUnixNano: String(traceStart),
      endTimeUnixNano: String(traceStart), // patched below
      status: { code: "1" },
      attributes: kvs({
        "session.id": sv(sessionId),
        "input.value": sv(TRIP_REQUEST),
        "output.value": sv(TRIP_RESULT),
      }),
    });

    for (const agent of AGENTS) {
      const agentWin = advance(800);
      const agentId = nextSpanId();
      const agentErrored = errored && agent.name === "budget_agent";
      spans.push({
        traceId,
        spanId: agentId,
        parentSpanId: rootId,
        name: agent.name,
        startTimeUnixNano: agentWin.start,
        endTimeUnixNano: agentWin.end,
        status: agentErrored
          ? { code: "2", message: "budget tool returned no data" }
          : { code: "1" },
        attributes: kvs({
          "session.id": sv(sessionId),
          "input.value": sv(agent.task),
          "output.value": sv(agent.result),
          // M32: the explicit agent.* convention the catalog derives from. The system
          // prompt is the agent's LLM instruction; the version varies per trace for
          // research_agent (→ multiple versions / high churn in the catalog).
          "agent.name": sv(agent.name),
          "agent.version": sv(agent.version(t)),
          "agent.system_prompt": sv(agent.llm.input),
        }),
      });

      // Retriever (local_agent only).
      if (agent.retriever) {
        const rWin = advance(120);
        spans.push({
          traceId,
          spanId: nextSpanId(),
          parentSpanId: agentId,
          name: "VectorStoreRetriever",
          startTimeUnixNano: rWin.start,
          endTimeUnixNano: rWin.end,
          status: { code: "1" },
          attributes: kvs({
            "session.id": sv(sessionId),
            "gen_ai.operation.name": sv("retrieve"),
            "input.value": sv(agent.retriever.query),
            "output.value": sv(agent.retriever.documents),
          }),
        });
      }

      // LLM (ChatOpenAI).
      const llmWin = advance(450);
      spans.push({
        traceId,
        spanId: nextSpanId(),
        parentSpanId: agentId,
        name: "ChatOpenAI",
        startTimeUnixNano: llmWin.start,
        endTimeUnixNano: llmWin.end,
        status: agentErrored
          ? { code: "2", message: "upstream tool error" }
          : { code: "1" },
        attributes: kvs({
          "session.id": sv(sessionId),
          "gen_ai.operation.name": sv("chat"),
          "gen_ai.system": sv(agent.llm.system),
          "gen_ai.request.model": sv(agent.model),
          "gen_ai.usage.input_tokens": iv(agent.llm.inTok),
          "gen_ai.usage.output_tokens": iv(agent.llm.outTok),
          "input.value": sv(agent.llm.input),
          "output.value": sv(agent.llm.output),
        }),
      });

      // Tools.
      for (const tool of agent.tools) {
        const toolWin = advance(60);
        spans.push({
          traceId,
          spanId: nextSpanId(),
          parentSpanId: agentId,
          name: tool.name,
          startTimeUnixNano: toolWin.start,
          endTimeUnixNano: toolWin.end,
          status: { code: "1" },
          attributes: kvs({
            "session.id": sv(sessionId),
            "gen_ai.operation.name": sv("execute_tool"),
            "gen_ai.tool.name": sv(tool.name),
            "input.value": sv(tool.input),
            "output.value": sv(tool.output),
          }),
        });
      }
    }

    // Patch the root end to span all children (the trace's wall-clock duration).
    spans[rootSpanIndex]!.endTimeUnixNano = String(cursor);
    void rootWindow;
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: kvs({ "service.name": sv(DEMO_SERVICE_NAME) }) },
        scopeSpans: [{ spans }],
      },
    ],
  };
}
