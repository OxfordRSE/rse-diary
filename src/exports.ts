import { projectTotals } from "./totals.ts";
import type { Entry, Project } from "./types.ts";

const byDate = (es: Entry[]) => [...es].sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at));

export function toLog(p: Project, entries: Entry[], exportedOn: string): string {
  const mine = byDate(entries.filter((e) => e.project_id === p.id));
  const t = projectTotals(mine, p.id);
  const est = p.estimate_fte_days === undefined ? "none" : `${p.estimate_fte_days} FTE-days`;
  let out =
    `# Project: ${p.name}\n` +
    `# Dates: ${p.start ?? "—"} → ${p.deadline ?? "—"}\n` +
    `# Estimate: ${est} | Logged: ${t.fteDays} FTE-days | Touched days: ${t.touchOnlyDays}\n` +
    `# Exported: ${exportedOn}\n`;
  for (const e of mine) {
    const amount = e.fte === null ? "touch   " : `${e.fte.toFixed(2)} FTE`;
    out += `\n${e.date}  ${amount}  [${e.source}]\n`;
    if (e.notes.trim()) out += e.notes.trimEnd().split(/\r?\n/).map((l) => `  ${l}`).join("\n") + "\n";
  }
  return out;
}

export function toProjectJson(p: Project, entries: Entry[], exportedOn: string) {
  const mine = byDate(entries.filter((e) => e.project_id === p.id));
  return { project: p, exported_at: exportedOn, totals: projectTotals(mine, p.id), entries: mine };
}

export type SummaryRow = {
  project: string; start: string; deadline: string; estimate_fte_days: number | "";
  fte_days: number; days_worked: number; touch_only_days: number; first_entry: string; last_entry: string;
};

export function summaryRows(projects: Project[], entries: Entry[], from?: string, to?: string): SummaryRow[] {
  const inRange = entries.filter((e) => (!from || e.date >= from) && (!to || e.date <= to));
  return projects.map((p) => {
    const t = projectTotals(inRange, p.id);
    return {
      project: p.name, start: p.start ?? "", deadline: p.deadline ?? "", estimate_fte_days: p.estimate_fte_days ?? "",
      fte_days: t.fteDays, days_worked: t.daysWorked, touch_only_days: t.touchOnlyDays,
      first_entry: t.first ?? "", last_entry: t.last ?? "",
    };
  });
}

const csvField = (v: unknown) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toSummaryCsv(rows: SummaryRow[]): string {
  const cols = ["project", "start", "deadline", "estimate_fte_days", "fte_days", "days_worked", "touch_only_days", "first_entry", "last_entry"] as const;
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvField(r[c])).join(","))].join("\n") + "\n";
}
