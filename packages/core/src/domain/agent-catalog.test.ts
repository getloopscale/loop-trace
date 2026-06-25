import { describe, it, expect } from "vitest";
import { classifyAgentHealth, shapeAgent, type RawAgent } from "./agent-catalog.js";

const NOW = new Date("2026-06-25T00:00:00.000Z");

describe("classifyAgentHealth (M32)", () => {
  it("test_classify_stale_when_last_seen_old", () => {
    const old = classifyAgentHealth(
      { name: "a", latestSeenAt: "2026-05-01T00:00:00.000Z", versionCount: 1 },
      { now: NOW, staleDays: 30 },
    );
    expect(old.stale).toBe(true);
    const recent = classifyAgentHealth(
      { name: "a", latestSeenAt: "2026-06-20T00:00:00.000Z", versionCount: 1 },
      { now: NOW, staleDays: 30 },
    );
    expect(recent.stale).toBe(false);
  });

  it("test_classify_high_churn", () => {
    expect(
      classifyAgentHealth({ name: "a", latestSeenAt: NOW.toISOString(), versionCount: 3 }, { now: NOW, churnThreshold: 3 }).highChurn,
    ).toBe(true);
    expect(
      classifyAgentHealth({ name: "a", latestSeenAt: NOW.toISOString(), versionCount: 2 }, { now: NOW, churnThreshold: 3 }).highChurn,
    ).toBe(false);
  });

  it("test_classify_anonymous_blank_name", () => {
    expect(
      classifyAgentHealth({ name: "   ", latestSeenAt: NOW.toISOString(), versionCount: 1 }, { now: NOW }).anonymous,
    ).toBe(true);
    expect(
      classifyAgentHealth({ name: "local_agent", latestSeenAt: NOW.toISOString(), versionCount: 1 }, { now: NOW }).anonymous,
    ).toBe(false);
  });

  it("test_classify_stale_safe_on_bad_timestamp", () => {
    // a non-parseable timestamp must not throw / must default to not-stale
    expect(
      classifyAgentHealth({ name: "a", latestSeenAt: "not-a-date", versionCount: 1 }, { now: NOW }).stale,
    ).toBe(false);
  });
});

describe("shapeAgent (M32)", () => {
  const raw: RawAgent = {
    name: "research_agent",
    firstSeenAt: "2026-06-20T00:00:00.000Z",
    latestSeenAt: "2026-06-24T00:00:00.000Z",
    runCount: 8,
    versions: ["1.2.0", "1.0.0", "1.1.0"],
    tools: ["essential_info", "hidden_gems"],
    systemPrompt: "  You are a travel researcher.  ",
  };

  it("test_shape_sorts_versions_and_counts", () => {
    const a = shapeAgent(raw, { now: NOW, churnThreshold: 3 });
    expect(a.versions).toEqual(["1.0.0", "1.1.0", "1.2.0"]); // sorted
    expect(a.versionCount).toBe(3);
    expect(a.highChurn).toBe(true); // 3 ≥ 3
    expect(a.tools).toEqual(["essential_info", "hidden_gems"]);
    expect(a.systemPrompt).toBe("You are a travel researcher."); // trimmed
  });

  it("test_shape_caps_system_prompt", () => {
    const a = shapeAgent({ ...raw, systemPrompt: "x".repeat(600) }, { now: NOW });
    expect(a.systemPrompt).toHaveLength(501); // 500 + ellipsis
  });

  it("test_shape_omits_blank_system_prompt", () => {
    const a = shapeAgent({ ...raw, systemPrompt: "   " }, { now: NOW });
    expect(a).not.toHaveProperty("systemPrompt");
  });
});
