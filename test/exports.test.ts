import { describe, expect, it } from "vitest";
import { summaryRows, toLog, toProjectJson, toSummaryCsv } from "../src/exports.ts";
import type { Entry, Project } from "../src/types.ts";

const glow: Project = { id: "glow", name: "Glow", colour: "#000", kind: "project", estimate_fte_days: 40, start: "2026-03-02", deadline: "2027-02-26", created_at: "" };
const mk = (date: string, fte: number | null, notes: string, source: string, project_id = "glow"): Entry =>
  ({ id: date + source, date, project_id, fte, notes, source, created_at: "", updated_at: "" });

const entries = [
  mk("2026-11-05", 0.1, "Answered emails on data integrity and security model.", "web"),
  mk("2026-11-04", null, "- Reviewed SAML options", "agent:claude-code"),
];

describe("toLog", () => {
  it("matches the spec format, oldest first", () => {
    expect(toLog(glow, entries, "2026-11-05")).toBe(
      `# Project: Glow
# Dates: 2026-03-02 → 2027-02-26
# Estimate: 40 FTE-days | Logged: 0.1 FTE-days | Touched days: 1
# Exported: 2026-11-05

2026-11-04  touch     [agent:claude-code]
  - Reviewed SAML options

2026-11-05  0.10 FTE  [web]
  Answered emails on data integrity and security model.
`);
  });

  it("handles missing dates and estimate", () => {
    const out = toLog({ ...glow, start: undefined, deadline: undefined, estimate_fte_days: undefined }, [], "2026-11-05");
    expect(out).toContain("# Dates: — → —\n");
    expect(out).toContain("# Estimate: none | Logged: 0 FTE-days | Touched days: 0\n");
  });

  it("indents every note line and keeps markup verbatim", () => {
    const out = toLog(glow, [mk("2026-11-05", 0.5, "<script>&\nline two", "web")], "2026-11-05");
    expect(out).toContain("  <script>&\n  line two\n");
  });

  it("omits the note block for empty notes", () => {
    expect(toLog(glow, [mk("2026-11-05", 1, "", "web")], "x")).toContain("2026-11-05  1.00 FTE  [web]\n");
  });
});

it("toProjectJson includes totals and entries", () => {
  const j = toProjectJson(glow, entries, "2026-11-05");
  expect(j).toMatchObject({ exported_at: "2026-11-05", project: { id: "glow" }, totals: { fteDays: 0.1, touchOnlyDays: 1 } });
  expect(j.entries.map((e) => e.date)).toEqual(["2026-11-04", "2026-11-05"]);
});

describe("summary", () => {
  const over: Project = { id: "overheads", name: "Overheads, misc", colour: "", kind: "overhead", created_at: "" };
  const es = [...entries, mk("2026-11-01", 0.5, "secret note", "web", "overheads")];

  it("CSV has a fixed header, an Overheads row, quoting, and no notes", () => {
    const csv = toSummaryCsv(summaryRows([glow, over], es));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("project,start,deadline,estimate_fte_days,fte_days,days_worked,touch_only_days,first_entry,last_entry");
    expect(lines[1]).toBe("Glow,2026-03-02,2027-02-26,40,0.1,2,1,2026-11-04,2026-11-05");
    expect(lines[2]).toBe('"Overheads, misc",,,,0.5,1,0,2026-11-01,2026-11-01');
    expect(csv).not.toContain("secret");
  });

  it("filters by date range", () => {
    const rows = summaryRows([glow], es, "2026-11-05", "2026-11-30");
    expect(rows[0]).toMatchObject({ fte_days: 0.1, days_worked: 1, touch_only_days: 0 });
  });
});
