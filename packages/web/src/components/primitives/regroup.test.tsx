import { describe, expect, it } from "vitest";

import { KindBadge } from "./KindBadge.js";
import { EmptyState, ErrorState, Loading } from "./States.js";

/**
 * M123 findability regroup: the two kebab-case outliers were renamed to
 * PascalCase and moved into the primitives/ bucket. This asserts both resolve at
 * their new path+case with their exported symbols intact (pure move — no
 * behavior change; the components render identically).
 */
describe("M123 primitives PascalCase rename", () => {
  it("test_states_resolves_from_primitives_pascalcase", () => {
    expect(typeof Loading).toBe("function");
    expect(typeof ErrorState).toBe("function");
    expect(typeof EmptyState).toBe("function");
  });

  it("test_kindbadge_resolves_from_primitives", () => {
    expect(typeof KindBadge).toBe("function");
  });
});
