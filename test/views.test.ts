import { describe, expect, it } from "vitest";
import { html, raw } from "../src/html.ts";
import { calendarTable } from "../src/views/calendar.ts";
import { sparkline } from "../src/views/spark.ts";
import { overviewPage, projectPage } from "../src/views/pages.ts";
import { dayTotals } from "../src/totals.ts";
import type { Entry, Project } from "../src/types.ts";

const P = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id.toUpperCase(), colour: "#123456", kind: "project", created_at: "", ...extra });
const E = (date: string, project_id: string, fte: number | null = 0.1, notes = ""): Entry =>
  ({ id: `${date}${project_id}`, date, project_id, fte, notes, source: "web", created_at: "", updated_at: "" });

describe("html", () => {
  it("escapes interpolated strings", () => {
    expect(html`<p>${"<script>&\"'"}</p>`.toString()).toBe("<p>&lt;script&gt;&amp;&quot;&#39;</p>");
  });
  it("passes nested html and raw through, flattens arrays", () => {
    expect(html`<ul>${["a", "b"].map((x) => html`<li>${x}</li>`)}${raw("<hr>")}</ul>`.toString()).toBe("<ul><li>a</li><li>b</li><hr></ul>");
  });
  it("renders null/undefined/false as nothing", () => {
    expect(html`${null}${undefined}${false}`.toString()).toBe("");
  });
});

describe("calendarTable", () => {
  const projects = ["a", "b", "c", "d", "e"].map((id) => P(id));
  const busy = projects.map((p) => E("2026-11-03", p.id));
  const cal = calendarTable({
    from: "2026-10-26", to: "2026-11-08", today: "2026-11-05", selected: "2026-11-04",
    days: dayTotals([...busy, E("2026-11-04", "a"), E("2026-11-04", "b", null)]),
    projects, href: (d) => `/?day=${d}`, mode: "neutral",
  }).toString();

  it("is a table with 7 weekday row headers", () => {
    expect(cal).toMatch(/^<div class="cal-wrap"><table class="cal"/);
    expect(cal.match(/<th scope="row"/g)).toHaveLength(7);
    expect(cal.match(/<th scope="col"/g)).toHaveLength(2);
  });
  it("shows sparkles for 5+ projects and one dot per project otherwise", () => {
    expect(cal).toContain("✨");
    const nov4 = cal.split('data-date="2026-11-04"')[1]!.split("</td>")[0]!;
    expect(nov4.match(/<li/g)).toHaveLength(2);
  });
  it("marks today and the selected day, and links each day", () => {
    expect(cal).toMatch(/class="[^"]*today[^"]*" data-date="2026-11-05"/);
    expect(cal).toMatch(/class="[^"]*selected[^"]*" data-date="2026-11-04"/);
    expect(cal).toContain('href="/?day=2026-11-04"');
  });
  it("leaves future days unlinked", () => {
    expect(cal).not.toContain('href="/?day=2026-11-06"');
  });
});

it("sparkline is an accessible inline SVG", () => {
  const s = sparkline([0, 0.5, 1], "#f00").toString();
  expect(s).toContain("<svg");
  expect(s).toContain('role="img"');
  expect(s).toContain("aria-label=");
});

describe("pages", () => {
  it("overview has a subset form, meters and the day's entries with notes escaped", () => {
    const projects = [P("a", { estimate_fte_days: 10 }), P("overheads", { kind: "overhead" })];
    const out = overviewPage({
      user: "me@x", today: "2026-11-05", day: "2026-11-05", projects, selected: ["a", "overheads"],
      entries: [E("2026-11-05", "a", 0.5, "<b>bold</b>")], allEntries: [E("2026-11-05", "a", 0.5, "<b>bold</b>")],
    });
    expect(out).toContain('<form method="get"');
    expect(out).toMatch(/<input type="checkbox" name="p" value="a"[^>]* checked/);
    expect(out).toContain("<meter");
    expect(out).toContain('id="day"');
    expect(out).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(out).not.toContain("<b>bold</b>");
  });

  it("project page shows before-start and after-deadline bins and export links", () => {
    const p = P("a", { start: "2026-10-01", deadline: "2026-10-20" });
    const out = projectPage({ user: "me", today: "2026-11-05", project: p, entries: [E("2026-09-01", "a"), E("2026-10-05", "a"), E("2026-11-01", "a", null)] });
    expect(out).toContain("Before start");
    expect(out).toContain("After deadline");
    expect(out).toContain('href="/projects/a/export.log"');
    expect(out).toContain('href="/projects/a/export.json"');
  });
});
