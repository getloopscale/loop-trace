import { describe, it, expect, beforeEach } from "vitest";
import { listViews, saveView, deleteView } from "./saved-views.js";

describe("saved-views (M29b)", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it("test_saved_views_round_trip", () => {
    expect(listViews()).toEqual([]);
    saveView("prod errors", { status: "error", model: "gpt-4o" });
    const views = listViews();
    expect(views).toHaveLength(1);
    expect(views[0]).toEqual({
      name: "prod errors",
      query: { status: "error", model: "gpt-4o" },
    });
    deleteView("prod errors");
    expect(listViews()).toEqual([]);
  });

  it("test_saved_views_strip_time", () => {
    saveView("with time", {
      status: "ok",
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-06-02T00:00:00.000Z",
    });
    expect(listViews()[0]!.query).toEqual({ status: "ok" }); // from/to dropped
  });

  it("test_saved_views_blank_name_is_noop", () => {
    saveView("   ", { status: "error" });
    expect(listViews()).toEqual([]);
  });

  it("test_saved_views_name_collision_replaces", () => {
    saveView("v", { status: "ok" });
    saveView("v", { status: "error" });
    const views = listViews();
    expect(views).toHaveLength(1);
    expect(views[0]!.query).toEqual({ status: "error" });
  });

  it("test_saved_views_corrupt_storage_falls_back", () => {
    localStorage.setItem("theolens.savedViews", "{not json");
    expect(listViews()).toEqual([]);
    localStorage.setItem("theolens.savedViews", '"a string not an array"');
    expect(listViews()).toEqual([]);
  });
});
