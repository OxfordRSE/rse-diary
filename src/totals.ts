import { addDays, mondayOf } from "./dates.ts";
import type { Entry, Project } from "./types.ts";

export type Bin = { fteDays: number; touchOnlyDays: number };
export type DayTotal = { fte: number; projects: string[]; byProject: Map<string, number | "touch"> };

// Float sums of 0.1s drift; two decimals is the precision anyone logs at.
const round = (x: number) => Math.round(x * 100) / 100;

function bin(entries: Entry[]): Bin {
  const byDay = new Map<string, boolean>(); // date -> has any FTE
  let fte = 0;
  for (const e of entries) {
    fte += e.fte ?? 0;
    byDay.set(e.date, (byDay.get(e.date) ?? false) || e.fte !== null);
  }
  return { fteDays: round(fte), touchOnlyDays: [...byDay.values()].filter((v) => !v).length };
}

export function projectTotals(entries: Entry[], projectId: string) {
  const mine = entries.filter((e) => e.project_id === projectId);
  const dates = mine.map((e) => e.date).sort();
  return {
    ...bin(mine),
    daysWorked: new Set(dates).size,
    first: dates[0],
    last: dates.at(-1),
  };
}

export function dayTotals(entries: Entry[]): Map<string, DayTotal> {
  const out = new Map<string, DayTotal>();
  for (const e of entries) {
    let d = out.get(e.date);
    if (!d) out.set(e.date, (d = { fte: 0, projects: [], byProject: new Map() }));
    d.fte = round(d.fte + (e.fte ?? 0));
    const cur = d.byProject.get(e.project_id);
    if (cur === undefined) d.projects.push(e.project_id);
    if (e.fte === null) {
      if (cur === undefined) d.byProject.set(e.project_id, "touch");
    } else {
      d.byProject.set(e.project_id, round((typeof cur === "number" ? cur : 0) + e.fte));
    }
  }
  return out;
}

export function projectSpan(p: Project, entries: Entry[], todayStr: string) {
  const mine = entries.filter((e) => e.project_id === p.id);
  const first = mine.map((e) => e.date).sort()[0];
  const from = p.start ?? first ?? todayStr;
  const to = p.deadline ?? (todayStr < from ? from : todayStr);
  return {
    from,
    to,
    before: bin(mine.filter((e) => e.date < from)),
    after: bin(mine.filter((e) => e.date > to)),
  };
}

export function weeklySeries(entries: Entry[], projectId: string, weeks: number, todayStr: string): number[] {
  const start = addDays(mondayOf(todayStr), -7 * (weeks - 1));
  const out = new Array<number>(weeks).fill(0);
  for (const e of entries) {
    if (e.project_id !== projectId || e.fte === null || e.date < start || e.date > todayStr) continue;
    const i = Math.floor((Date.parse(e.date) - Date.parse(start)) / (7 * 864e5));
    out[i] = round(out[i]! + e.fte);
  }
  return out;
}
