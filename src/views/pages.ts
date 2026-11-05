import { addDays } from "../dates.ts";
import { html, layout, type Html } from "../html.ts";
import { dayTotals, projectSpan, projectTotals, weeklySeries } from "../totals.ts";
import type { Entry, Project, TokenIndex } from "../types.ts";
import { calendarTable } from "./calendar.ts";
import { sparkline } from "./spark.ts";

type Base = { user: string };
const CAL_WEEKS = 26;

const dot = (p: Project) => html`<span class="pdot" style="--c:${p.colour}" aria-hidden="true"></span>`;
const amount = (e: Entry) => (e.fte === null ? "touch" : `${e.fte} FTE`);

function entryList(entries: Entry[], projects: Project[], opts: { showProject: boolean }): Html {
  const byId = new Map(projects.map((p) => [p.id, p]));
  if (!entries.length) return html`<p><em>Nothing logged.</em></p>`;
  return html`${entries.map((e) => {
    const p = byId.get(e.project_id);
    return html`<article class="entry" style="--c:${p?.colour ?? "#888"}">
<header><time datetime="${e.date}">${e.date}</time>${opts.showProject ? html` · ${p ? dot(p) : ""}<a href="/projects/${e.project_id}">${p?.name ?? e.project_id}</a>` : ""} · <strong>${amount(e)}</strong> · <small>${e.source}</small> · <a href="/entries/${e.id}/edit?date=${e.date}">Edit</a></header>
${e.notes ? html`<div class="notes">${e.notes}</div>` : ""}
</article>`;
  })}`;
}

export function daySection(o: { day: string; entries: Entry[]; projects: Project[] }): Html {
  const mine = o.entries.filter((e) => e.date === o.day);
  const total = dayTotals(mine).get(o.day)?.fte ?? 0;
  return html`<section id="day" aria-live="polite">
<h2><time datetime="${o.day}">${o.day}</time> <small>${total} FTE${total > 1 ? html` <mark>over 1.0</mark>` : ""}</small></h2>
${entryList(mine, o.projects, { showProject: true })}
<p><a href="/entries/new?date=${o.day}" role="button" class="outline">Log work on ${o.day}</a></p>
</section>`;
}

function progress(p: Project, fteDays: number): Html {
  if (p.estimate_fte_days === undefined) return html`<small>${fteDays} FTE-days logged</small>`;
  const est = p.estimate_fte_days;
  return html`<meter min="0" max="${est}" low="${est * 0.75}" high="${est * 0.9}" optimum="0" value="${fteDays}">${fteDays} of ${est}</meter>
<small>${fteDays} / ${est} FTE-days${fteDays > est ? html` <mark>over estimate</mark>` : ""}</small>`;
}

const dates = (p: Project) => (p.start || p.deadline ? `${p.start ?? "…"} → ${p.deadline ?? "…"}` : "No dates");

export type OverviewData = Base & {
  today: string;
  day: string;
  projects: Project[];
  selected: string[];
  /** Entries within the calendar window. */
  entries: Entry[];
  /** All entries ever, for running totals. */
  allEntries: Entry[];
};

export function overviewPage(o: OverviewData): string {
  const sel = new Set(o.selected);
  const visible = o.projects.filter((p) => sel.has(p.id));
  const entries = o.entries.filter((e) => sel.has(e.project_id));
  const from = addDays(o.today, -7 * CAL_WEEKS + 1);
  const query = (d: string) => `/?${new URLSearchParams([["day", d], ...o.selected.map((id) => ["p", id])])}`;
  const active = o.projects.filter((p) => !p.archived);
  const archived = o.projects.filter((p) => p.archived);

  const row = (p: Project) => {
    const t = projectTotals(o.allEntries, p.id);
    return html`<li class="project-row">
<label><input type="checkbox" name="p" value="${p.id}"${sel.has(p.id) ? " checked" : ""}> ${dot(p)}<a href="/projects/${p.id}">${p.name}</a></label>
<small class="dates">${dates(p)}${t.touchOnlyDays ? ` · ${t.touchOnlyDays} touched days` : ""}</small>
${sparkline(weeklySeries(o.allEntries, p.id, CAL_WEEKS, o.today), p.colour)}
<div class="progress">${progress(p, t.fteDays)}</div>
</li>`;
  };

  return layout("Overview", html`
<div class="overview-top">
<section class="pattern">
<h1>Working pattern</h1>
${calendarTable({ from, to: o.today, days: dayTotals(entries), projects: o.projects, today: o.today, selected: o.day, href: query, mode: "neutral" })}
<p class="legend">${visible.map((p) => html`<span>${dot(p)}${p.name}</span> `)}</p>
</section>
${daySection({ day: o.day, entries, projects: o.projects })}
</div>
<section>
<h2>Projects</h2>
<form method="get" action="/">
<input type="hidden" name="day" value="${o.day}">
<ul class="projects">${active.map(row)}</ul>
${archived.length ? html`<details><summary>Archived (${archived.length})</summary><ul class="projects">${archived.map(row)}</ul></details>` : ""}
<div class="actions">
<button type="submit">Show selected</button>
<button type="submit" formaction="/export/summary" class="secondary">Export summary (CSV)</button>
<button type="submit" formaction="/export/summary" name="format" value="json" class="secondary outline">Summary (JSON)</button>
</div>
</form>
</section>`, { user: o.user });
}

export type ProjectData = Base & { today: string; project: Project; entries: Entry[] };

export function projectPage(o: ProjectData): string {
  const p = o.project;
  const mine = o.entries.filter((e) => e.project_id === p.id);
  const t = projectTotals(mine, p.id);
  const span = projectSpan(p, mine, o.today);
  const left = p.deadline ? Math.round((Date.parse(p.deadline) - Date.parse(o.today)) / 864e5) : undefined;
  const pct = p.estimate_fte_days ? Math.round((t.fteDays / p.estimate_fte_days) * 100) : undefined;
  const newest = [...mine].sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));

  return layout(p.name, html`
<p><a href="/">← Overview</a></p>
<hgroup>
<h1>${dot(p)}${p.name}${p.archived ? html` <small>(archived)</small>` : ""}</h1>
<p>${dates(p)} · ${t.fteDays}${p.estimate_fte_days !== undefined ? ` / ${p.estimate_fte_days}` : ""} FTE-days${pct !== undefined ? ` (${pct}%)` : ""} · ${t.touchOnlyDays} touched days${left !== undefined ? ` · ${left >= 0 ? `${left} days to deadline` : `deadline passed ${-left} days ago`}` : ""}</p>
</hgroup>
${progress(p, t.fteDays)}
${calendarTable({
  from: span.from, to: span.to, days: dayTotals(mine), projects: [p], today: o.today,
  href: (d) => `#d-${d}`, mode: { colour: p.colour },
  before: p.start ? span.before : undefined, after: p.deadline ? span.after : undefined,
})}
<div class="actions">
<a href="/projects/${p.id}/export.log" role="button" class="secondary">Export .log</a>
<a href="/projects/${p.id}/export.json" role="button" class="secondary outline">Export .json</a>
<a href="/entries/new?project=${p.id}">Log work</a>
<a href="/projects/${p.id}/edit">Edit project</a>
</div>
<section>
<h2>Diary</h2>
<div class="diary">
${newest.map((e) => html`<div id="d-${e.date}">${entryList([e], [p], { showProject: false })}</div>`)}
${newest.length ? "" : html`<p><em>Nothing logged yet.</em></p>`}
</div>
</section>`, { user: o.user });
}

export type EntryFormData = Base & { projects: Project[]; action: string; entry: Partial<Entry>; error?: string; deleteHref?: string };

export function entryFormPage(o: EntryFormData): string {
  const e = o.entry;
  const touch = e.fte === null;
  return layout(e.id ? "Edit entry" : "Log work", html`
<h1>${e.id ? "Edit entry" : "Log work"}</h1>
${o.error ? html`<p role="alert"><mark>${o.error}</mark></p>` : ""}
<form method="post" action="${o.action}">
<label>Date <input type="date" name="date" required value="${e.date ?? ""}"></label>
<label>Project
<select name="project_id" required>
${o.projects.filter((p) => !p.archived || p.id === e.project_id).map((p) => html`<option value="${p.id}"${p.id === e.project_id ? " selected" : ""}>${p.name}</option>`)}
</select>
</label>
<fieldset>
<legend>How much?</legend>
<label>FTE (fraction of the day) <input type="number" name="fte" min="0.01" max="1" step="0.01" value="${e.fte ?? ""}" inputmode="decimal"></label>
<label><input type="checkbox" name="touch" value="1"${touch ? " checked" : ""}> Touch: worked on it, amount unknown</label>
</fieldset>
<label>Notes <textarea name="notes" rows="6">${e.notes ?? ""}</textarea></label>
<button type="submit">Save</button>
${o.deleteHref ? html`<a href="${o.deleteHref}" class="secondary">Delete…</a>` : ""}
</form>`, { user: o.user });
}

export function confirmDeletePage(o: Base & { entry: Entry; project?: Project }): string {
  return layout("Delete entry", html`
<h1>Delete this entry?</h1>
<p>${o.entry.date} · ${o.project?.name ?? o.entry.project_id} · ${amount(o.entry)}</p>
${o.entry.notes ? html`<div class="notes">${o.entry.notes}</div>` : ""}
<form method="post" action="/entries/${o.entry.id}/delete?date=${o.entry.date}">
<button type="submit" class="contrast">Delete</button>
<a href="/entries/${o.entry.id}/edit?date=${o.entry.date}">Cancel</a>
</form>`, { user: o.user });
}

export type ProjectFormData = Base & { action: string; project: Partial<Project>; error?: string };

export function projectFormPage(o: ProjectFormData): string {
  const p = o.project;
  return layout(p.id ? `Edit ${p.name}` : "New project", html`
<h1>${p.id ? `Edit ${p.name}` : "New project"}</h1>
${o.error ? html`<p role="alert"><mark>${o.error}</mark></p>` : ""}
<form method="post" action="${o.action}">
<label>Name <input name="name" required value="${p.name ?? ""}"></label>
<label>Estimate (FTE-days) <input type="number" name="estimate_fte_days" min="0" step="0.25" value="${p.estimate_fte_days ?? ""}"></label>
<div class="grid">
<label>Start <input type="date" name="start" value="${p.start ?? ""}"></label>
<label>Deadline <input type="date" name="deadline" value="${p.deadline ?? ""}"></label>
</div>
${p.colour ? html`<label>Colour <input type="color" name="colour" value="${p.colour}"></label>` : ""}
${p.id && p.kind !== "overhead" ? html`<label><input type="checkbox" name="archived" value="1"${p.archived ? " checked" : ""}> Archived</label>` : ""}
<button type="submit">Save</button>
</form>`, { user: o.user });
}

export function projectsPage(o: Base & { projects: Project[]; entries: Entry[] }): string {
  return layout("Projects", html`
<h1>Projects</h1>
<p><a href="/projects/new" role="button">New project</a></p>
<table class="cards">
<thead><tr><th scope="col">Project</th><th scope="col">Dates</th><th scope="col">FTE-days</th><th scope="col">Estimate</th><th scope="col">Touched days</th></tr></thead>
<tbody>
${o.projects.map((p) => {
  const t = projectTotals(o.entries, p.id);
  // data-label lets narrow screens show each row as a card with inline labels.
  return html`<tr><th scope="row">${dot(p)}<a href="/projects/${p.id}">${p.name}</a>${p.archived ? " (archived)" : ""}</th><td data-label="Dates">${dates(p)}</td><td data-label="FTE-days">${t.fteDays}</td><td data-label="Estimate">${p.estimate_fte_days ?? "—"}</td><td data-label="Touched days">${t.touchOnlyDays}</td></tr>`;
})}
</tbody>
</table>`, { user: o.user });
}

export function tokensPage(o: Base & { tokens: TokenIndex["tokens"]; appUrl: string; newToken?: { label: string; token: string } }): string {
  return layout("Tokens", html`
<h1>Agent tokens</h1>
<p>A token lets an agent (e.g. Claude Code) log work for you. Make one per machine.</p>
${o.newToken ? html`<article>
<header><strong>New token "${o.newToken.label}"</strong>: copy it now, it won't be shown again.</header>
<pre><code>export RSE_DIARY_URL=${o.appUrl}
export RSE_DIARY_TOKEN=${o.newToken.token}</code></pre>
<p>Then tell your agent: "To log work, read $RSE_DIARY_URL/api/instructions".</p>
</article>` : ""}
<form method="post" action="/tokens">
<fieldset role="group">
<input name="label" required placeholder="Label, e.g. laptop" aria-label="Token label" maxlength="40">
<button type="submit">Create token</button>
</fieldset>
</form>
${o.tokens.length ? html`<table>
<thead><tr><th scope="col">Label</th><th scope="col">Created</th><th scope="col"><span class="vh">Actions</span></th></tr></thead>
<tbody>${o.tokens.map((t) => html`<tr><td>${t.label}</td><td>${t.created_at.slice(0, 10)}</td><td>
<form method="post" action="/tokens/${t.hash}/revoke"><button type="submit" class="secondary outline">Revoke</button></form></td></tr>`)}</tbody>
</table>` : html`<p><em>No tokens yet.</em></p>`}`, { user: o.user });
}

export function errorPage(status: number, message: string, user?: string): string {
  return layout(String(status), html`<h1>${status}</h1><p>${message}</p><p><a href="/">Back to overview</a></p>`, { user });
}
