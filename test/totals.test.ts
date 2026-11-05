import { describe, expect, it } from "vitest";
import { addDays, mondayOf, monthKey, monthsBetween } from "../src/dates.ts";
import { dayTotals, projectSpan, projectTotals, weeklySeries } from "../src/totals.ts";
import type { Entry, Project } from "../src/types.ts";

let n = 0;
export function entry(date: string, fte: number | null, project_id = "a", notes = ""): Entry {
  return { id: `e${n++}`, date, project_id, fte, notes, source: "web", created_at: "", updated_at: "" };
}
const proj = (extra: Partial<Project> = {}): Project => ({
  id: "a", name: "A", colour: "#000", kind: "project", created_at: "", ...extra,
});

describe("dates", () => {
  it("monthsBetween spans inclusive months", () => {
    expect(monthsBetween("2026-10-15", "2026-12-01")).toEqual(["2026-10", "2026-11", "2026-12"]);
  });
  it("addDays crosses month boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("mondayOf returns the week's Monday", () => {
    expect(mondayOf("2026-11-05")).toBe("2026-11-02");
    expect(mondayOf("2026-11-08")).toBe("2026-11-02");
  });
  it("monthKey", () => expect(monthKey("2026-11-05")).toBe("2026-11"));
});

describe("projectTotals", () => {
  it("sums FTE, counts days worked and touch-only days", () => {
    const es = [entry("2026-11-01", 0.25), entry("2026-11-01", null), entry("2026-11-02", null), entry("2026-11-03", 0.5)];
    expect(projectTotals(es, "a")).toEqual({
      fteDays: 0.75, daysWorked: 3, touchOnlyDays: 1, first: "2026-11-01", last: "2026-11-03",
    });
  });
});

describe("dayTotals", () => {
  it("adds FTE across projects on the same day", () => {
    const d = dayTotals([entry("2026-11-01", 0.6, "a"), entry("2026-11-01", 0.6, "b")]).get("2026-11-01")!;
    expect(d.fte).toBeCloseTo(1.2);
    expect(d.projects).toEqual(["a", "b"]);
  });
  it("marks touch-only projects as touch", () => {
    const d = dayTotals([entry("2026-11-01", null, "a"), entry("2026-11-01", 0.1, "b"), entry("2026-11-01", null, "b")]).get("2026-11-01")!;
    expect(d.byProject.get("a")).toBe("touch");
    expect(d.byProject.get("b")).toBe(0.1);
  });
});

describe("projectSpan", () => {
  it("without dates runs from first entry to today", () => {
    const s = projectSpan(proj(), [entry("2026-09-21", 0.1), entry("2026-10-01", null)], "2026-11-05");
    expect(s.from).toBe("2026-09-21");
    expect(s.to).toBe("2026-11-05");
    expect(s.before).toEqual({ fteDays: 0, touchOnlyDays: 0 });
    expect(s.after).toEqual({ fteDays: 0, touchOnlyDays: 0 });
  });
  it("bins work before start and after deadline", () => {
    const s = projectSpan(
      proj({ start: "2026-03-02", deadline: "2026-10-30" }),
      [entry("2026-02-01", 0.5), entry("2026-05-01", 0.25), entry("2026-11-02", null)],
      "2026-11-05",
    );
    expect(s).toMatchObject({ from: "2026-03-02", to: "2026-10-30" });
    expect(s.before).toEqual({ fteDays: 0.5, touchOnlyDays: 0 });
    expect(s.after).toEqual({ fteDays: 0, touchOnlyDays: 1 });
  });
  it("with no dates and no entries is just today", () => {
    expect(projectSpan(proj(), [], "2026-11-05")).toMatchObject({ from: "2026-11-05", to: "2026-11-05" });
  });
});

describe("weeklySeries", () => {
  it("returns one FTE sum per week, oldest first, ending this week", () => {
    const s = weeklySeries([entry("2026-11-03", 0.5), entry("2026-11-05", 0.25), entry("2026-10-27", 0.1)], "a", 3, "2026-11-05");
    expect(s).toEqual([0, 0.1, 0.75]);
  });
});
