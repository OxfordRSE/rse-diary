import { addDays, mondayOf } from "../dates.ts";
import { html, type Html } from "../html.ts";
import type { Bin, DayTotal } from "../totals.ts";
import type { Project } from "../types.ts";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (d: string) => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

export type CalendarOpts = {
  from: string;
  to: string;
  days: Map<string, DayTotal>;
  projects: Project[];
  today: string;
  selected?: string;
  href: (d: string) => string;
  mode: "neutral" | { colour: string };
  before?: Bin;
  after?: Bin;
};

function level(d: DayTotal | undefined): number {
  if (!d || d.projects.length === 0) return 0;
  if (d.fte === 0) return 1;
  return Math.min(4, Math.max(1, Math.ceil(d.fte * 4)));
}

function binCell(label: string, b: Bin, col: number): Html {
  return html`<td rowspan="7" class="bin" style="--w:${col}"><strong>${label}</strong> <span>${b.fteDays} FTE-days</span> <span>${b.touchOnlyDays} touched days</span></td>`;
}

/**
 * A real table (weeks as columns, Mon–Sun as rows) so it reads without CSS.
 * Each cell carries --w/--d so CSS can lay it out either way round.
 */
export function calendarTable(o: CalendarOpts): Html {
  const start = mondayOf(o.from);
  const weeks: string[] = [];
  for (let w = start; w <= o.to; w = addDays(w, 7)) weeks.push(w);
  const byId = new Map(o.projects.map((p) => [p.id, p]));
  const offset = o.before ? 1 : 0;
  const style = o.mode === "neutral" ? "" : `--accent:${o.mode.colour}`;

  const cell = (d: string, wi: number, di: number): Html => {
    const pos = `--w:${wi + 1 + offset};--d:${di + 1}`;
    if (d < o.from || d > o.to) return html`<td class="out" style="${pos}"></td>`;
    const t = o.days.get(d);
    const cls = ["day", d === o.today && "today", d === o.selected && "selected", d > o.today && "future"].filter(Boolean).join(" ");
    const names = (t?.projects ?? []).map((id) => byId.get(id) ?? { id, name: id, colour: "#888" });
    const detail = names.map((p) => {
      const v = t!.byProject.get(p.id);
      return `${p.name} ${v === "touch" ? "touch" : `${v} FTE`}`;
    });
    const title = `${d}: ${detail.join(", ") || "nothing logged"}`;
    const inner = html`<span class="fte">${t ? (t.fte ? t.fte : "touch") : ""}</span>${names.length >= 5
      ? html`<span class="sparkle" aria-hidden="true">✨</span><ul class="dots vh">${names.map((p) => html`<li>${p.name}</li>`)}</ul>`
      : names.length ? html`<ul class="dots">${names.map((p) => html`<li style="--c:${p.colour}">${p.name}</li>`)}</ul>` : ""}`;
    return html`<td class="${cls}" data-date="${d}" data-level="${level(t)}" title="${title}" style="${pos}">${d > o.today
      ? html`<span class="vh">${d}</span>`
      : html`<a href="${o.href(d)}"><span class="vh">${d}</span>${inner}</a>`}</td>`;
  };

  return html`<div class="cal-wrap"><table class="cal${o.mode === "neutral" ? "" : " accent"}" style="${style}">
<caption class="vh">Days worked, ${o.from} to ${o.to}</caption>
<thead><tr><td></td>${o.before ? html`<td></td>` : ""}${weeks.map((w, i) => html`<th scope="col" style="--w:${i + 1 + offset}"${i === 0 || addDays(w, 6).slice(5, 7) !== w.slice(5, 7) || w.endsWith("-01") ? html` class="month" data-month="${MONTHS[Number(addDays(w, 6).slice(5, 7)) - 1]}"` : ""}>${short(w)}</th>`)}${o.after ? html`<td></td>` : ""}</tr></thead>
<tbody>
${DAYS.map((name, di) => html`<tr><th scope="row" style="--d:${di + 1}">${name}</th>${di === 0 && o.before ? binCell("Before start", o.before, 1) : ""}${weeks.map((w, wi) => cell(addDays(w, di), wi, di))}${di === 0 && o.after ? binCell("After deadline", o.after, weeks.length + 1 + offset) : ""}</tr>
`)}</tbody>
</table></div>`;
}
