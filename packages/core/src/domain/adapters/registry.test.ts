import { describe, it, expect } from "vitest";
import { selectAdapter } from "./registry.js";
import { claudeCodeAdapter } from "./claude-code-adapter.js";
import { theokitSdkAdapter } from "./theokit-sdk-adapter.js";
import { defaultAdapter } from "./default-adapter.js";

/**
 * M119 (Phase 4) — the routing seam. `selectAdapter` (registry.ts) returns the FIRST adapter that
 * matches, in the declared order `[claudeCodeAdapter, theokitSdkAdapter, defaultAdapter]`, and the
 * universal `defaultAdapter` when nothing specific matches. Pre-M119 this ordering + fallback were only
 * asserted transitively through the ingest tests; this is the direct pure unit test (no I/O — the
 * fastest layer of the pyramid). Adapters match by resource `service.name`.
 */
describe("selectAdapter — first-match-wins + universal fallback", () => {
  it("test_select_adapter_first_match_wins_claude_code", () => {
    expect(selectAdapter({ "service.name": "claude-code" })).toBe(claudeCodeAdapter);
  });

  it("test_select_adapter_first_match_wins_theokit_sdk", () => {
    expect(selectAdapter({ "service.name": "theokit-sdk" })).toBe(theokitSdkAdapter);
  });

  it("test_select_adapter_unknown_service_name_falls_back_to_default", () => {
    // A service.name none of the specific adapters claims → the universal default.
    expect(selectAdapter({ "service.name": "some-other-agent" })).toBe(defaultAdapter);
  });

  it("test_select_adapter_empty_attrs_falls_back_to_default", () => {
    expect(selectAdapter({})).toBe(defaultAdapter);
  });

  it("test_select_adapter_undefined_attrs_falls_back_to_default", () => {
    // `undefined` resource attrs (the `?? {}` guard) → default, never a throw.
    expect(selectAdapter(undefined)).toBe(defaultAdapter);
  });

  it("test_select_adapter_declared_order_is_specific_before_default", () => {
    // defaultAdapter.matches is always true, so ordering is load-bearing: a claude-code resource must
    // resolve to the SPECIFIC adapter, not the earlier-returning universal default.
    expect(selectAdapter({ "service.name": "claude-code" })).not.toBe(defaultAdapter);
    expect(selectAdapter({ "service.name": "theokit-sdk" })).not.toBe(defaultAdapter);
  });
});
