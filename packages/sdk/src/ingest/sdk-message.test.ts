import { describe, it, expect } from "vitest";
import type { SDKMessage } from "./sdk-message.js";

/** Exhaustiveness helper — a compile error here means the union grew and a mapper branch is missing. */
function assertNever(x: never): never {
  throw new Error(`unexpected SDKMessage variant: ${JSON.stringify(x)}`);
}

/** Narrow every variant of the union (compile-time exhaustiveness + runtime discrimination). */
function kindOf(m: SDKMessage): string {
  switch (m.type) {
    case "system":
      return `system:${m.run_id}`;
    case "user":
      return `user:${m.message.content.length}`;
    case "assistant":
      return `assistant:${m.message.content.length}`;
    case "thinking":
      return `thinking:${m.text}`;
    case "tool_call":
      return `tool_call:${m.call_id}:${m.status}`; // narrows to carry call_id + status
    case "status":
      return `status:${m.status}`;
    case "task":
      return `task:${m.status ?? ""}`;
    case "request":
      return `request:${m.request_id}`;
    case "object_delta":
      return `object_delta:${m.attempt}`;
    default:
      return assertNever(m);
  }
}

describe("SDKMessage union (M115 mirror)", () => {
  it("test_sdk_message_union_discriminates", () => {
    const tc: SDKMessage = { type: "tool_call", agent_id: "a", run_id: "r", call_id: "c1", name: "Bash", status: "completed" };
    expect(kindOf(tc)).toBe("tool_call:c1:completed");
  });

  it("test_union_covers_all_nine_variants", () => {
    const all: SDKMessage[] = [
      { type: "system", subtype: "init", agent_id: "a", run_id: "r" },
      { type: "user", agent_id: "a", run_id: "r", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "assistant", agent_id: "a", run_id: "r", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
      { type: "thinking", agent_id: "a", run_id: "r", text: "hmm" },
      { type: "tool_call", agent_id: "a", run_id: "r", call_id: "c", name: "X", status: "running" },
      { type: "status", agent_id: "a", run_id: "r", status: "FINISHED" },
      { type: "task", agent_id: "a", run_id: "r" },
      { type: "request", agent_id: "a", run_id: "r", request_id: "q" },
      { type: "object_delta", agent_id: "a", run_id: "r", partial: {}, attempt: 1 },
    ];
    expect(all.map(kindOf)).toHaveLength(9); // every variant discriminates without a throw
  });
});
