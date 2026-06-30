import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";

import { evaluators, guards } from "./schema.js";

// M36 — evaluators + guards tables are workspace-leading (T1.1)
describe("M36 evaluators/guards schema (T1.1)", () => {
  it("test_evaluators_table_is_workspace_leading", () => {
    const cfg = getTableConfig(evaluators);
    const uq = cfg.uniqueConstraints.find(
      (u) => u.name === "evaluators_workspace_id_name_uq",
    );
    expect(uq).toBeDefined();
    expect(uq!.columns.map((c) => c.name)).toEqual(["workspace_id", "name"]);
  });

  it("test_guards_table_is_workspace_leading", () => {
    const cfg = getTableConfig(guards);
    const uq = cfg.uniqueConstraints.find(
      (u) => u.name === "guards_workspace_id_dedup_uq",
    );
    expect(uq).toBeDefined();
    expect(uq!.columns[0]!.name).toBe("workspace_id");
  });
});
