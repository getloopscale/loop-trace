import { describe, expect, it } from "vitest";

import { ChatError } from "./chat.js";
import { ChatError as viaBarrel } from "./index.js";

/**
 * M123 findability regroup: the provider feature-subdir barrel re-exports its
 * members. This asserts the subdir seam resolves and points at the same defined
 * symbol as the direct import (a pure move — no behavior change). The provider
 * subdir must NOT re-close the M120 provider↔evaluation cycle (madge gate).
 */
describe("M123 provider subdir barrel", () => {
  it("test_chat_resolves_from_provider_subdir", () => {
    expect(viaBarrel).toBe(ChatError);
    expect(new ChatError("x")).toBeInstanceOf(Error);
  });
});
