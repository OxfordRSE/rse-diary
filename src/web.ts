import { createProject, patchEntry, updateProject } from "./api.ts";
import { addDays, isDate } from "./dates.ts";
import { historyStart, logEntries } from "./entries.ts";
import { summaryRows, toLog, toProjectJson, toSummaryCsv } from "./exports.ts";
import type { Repo } from "./repo.ts";
import type { BlobStore } from "./store.ts";
import { createToken, listTokens, revokeToken } from "./tokens.ts";
import {
  confirmDeletePage, daySection, entryFormPage, errorPage, overviewPage,
  projectFormPage, projectPage, projectsPage, tokensPage,
} from "./views/pages.ts";
import type { Entry } from "./types.ts";

export type WebCtx = { repo: Repo; store: BlobStore; user: string; today: string };

const page = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const redirect = (to: string) => new Response(null, { status: 303, headers: { location: to } });
const download = (body: string, type: string, filename: string) =>
  new Response(body, { headers: { "content-type": `${type}; charset=utf-8`, "content-disposition": `attachment; filename="${filename}"` } });

async function form(req: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of await req.formData()) if (typeof v === "string") out[k] = v;
  return out;
}

/** Form fields -> project patch (empty strings clear optional fields). */
function projectFields(f: Record<string, string>, editing: boolean): Record<string, unknown> {
  const b: Record<string, unknown> = { name: f.name ?? "", start: f.start ?? "", deadline: f.deadline ?? "" };
  b.estimate_fte_days = f.estimate_fte_days ? Number(f.estimate_fte_days) : null;
  if (f.colour) b.colour = f.colour;
  if (editing) b.archived = f.archived === "1";
  return b;
}

const entryFields = (f: Record<string, string>) => ({
  date: f.date, project_id: f.project_id, notes: (f.notes ?? "").replace(/\r\n/g, "\n"),
  fte: f.touch === "1" ? null : f.fte || null,
});

export async function handleWeb(req: Request, ctx: WebCtx): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/(.)\/+$/, "$1");
  const post = req.method === "POST";
  const { repo, user, today } = ctx;
  const notFound = () => page(errorPage(404, "Not found.", user), 404);
  const q = (k: string) => url.searchParams.get(k);

  if (path === "/" && !post) {
    const cfg = await repo.getConfig();
    const day = isDate(q("day")) ? q("day")! : today;
    const ids = new Set(cfg.projects.map((p) => p.id));
    const asked = url.searchParams.getAll("p").filter((id) => ids.has(id));
    const selected = asked.length ? asked : cfg.projects.filter((p) => !p.archived).map((p) => p.id);
    const all = await repo.getEntries(historyStart(cfg, today), today);
    if (q("fragment") === "day") {
      const sel = new Set(selected);
      return page(daySection({ day, entries: all.filter((e) => sel.has(e.project_id)), projects: cfg.projects }).toString());
    }
    const from = addDays(today, -7 * 26);
    return page(overviewPage({ user, today, day, projects: cfg.projects, selected, entries: all.filter((e) => e.date >= from), allEntries: all }));
  }

  if (path === "/projects" && !post) {
    const cfg = await repo.getConfig();
    return page(projectsPage({ user, projects: cfg.projects, entries: await repo.getEntries(historyStart(cfg, today), today) }));
  }

  if (path === "/projects/new") {
    if (!post) return page(projectFormPage({ user, action: "/projects/new", project: {} }));
    const r = await createProject(repo, projectFields(await form(req), false));
    if ("error" in r) return page(projectFormPage({ user, action: "/projects/new", project: {}, error: r.error }), 422);
    return redirect(`/projects/${(r.created ?? r.existing)!.id}`);
  }

  const pm = path.match(/^\/projects\/([^/]+)(\/edit|\/export\.log|\/export\.json)?$/);
  if (pm) {
    const id = decodeURIComponent(pm[1]!);
    const cfg = await repo.getConfig();
    const p = cfg.projects.find((x) => x.id === id);
    if (!p) return notFound();
    if (pm[2] === "/edit") {
      const action = `/projects/${p.id}/edit`;
      if (!post) return page(projectFormPage({ user, action, project: p }));
      const r = await updateProject(repo, p.id, projectFields(await form(req), true));
      if ("error" in r) return page(projectFormPage({ user, action, project: p, error: r.error }), 422);
      return redirect(`/projects/${p.id}`);
    }
    if (post) return notFound();
    // Read from the earliest of the project's own start and the history window, so pre-start work is binned.
    const from = [historyStart(cfg, today), p.start ? addDays(p.start, -365) : today].sort()[0]!;
    const entries = (await repo.getEntries(from, today)).filter((e) => e.project_id === p.id);
    if (pm[2] === "/export.log") return download(toLog(p, entries, today), "text/plain", `${p.id}.log`);
    if (pm[2] === "/export.json") return download(JSON.stringify(toProjectJson(p, entries, today), null, 2), "application/json", `${p.id}.json`);
    return page(projectPage({ user, today, project: p, entries }));
  }

  if (path === "/entries/new") {
    const cfg = await repo.getConfig();
    const action = "/entries/new";
    const blank: Partial<Entry> = { date: isDate(q("date")) ? q("date")! : today, project_id: q("project") ?? undefined, fte: undefined };
    if (!post) return page(entryFormPage({ user, projects: cfg.projects, action, entry: blank }));
    const f = entryFields(await form(req));
    const r = await logEntries(repo, [{ ...f, source: "web" }], { today, source: "web" });
    if ("errors" in r) {
      const fte = f.fte === null ? null : Number(f.fte);
      return page(entryFormPage({ user, projects: cfg.projects, action, entry: { ...f, fte }, error: (r.errors ?? []).map((e) => e.message).join("; ") }), 422);
    }
    return redirect(`/?day=${r.entries[0]!.date}`);
  }

  const em = path.match(/^\/entries\/([^/]+)\/(edit|delete)$/);
  if (em) {
    const anchor = isDate(q("date")) ? q("date")! : today;
    const entry = await repo.findEntry(decodeURIComponent(em[1]!), anchor > today ? anchor : today);
    if (!entry) return notFound();
    const cfg = await repo.getConfig();
    const self = `/entries/${entry.id}`;
    if (em[2] === "delete") {
      if (!post) return page(confirmDeletePage({ user, entry, project: cfg.projects.find((p) => p.id === entry.project_id) }));
      await repo.replaceEntry(entry, null);
      return redirect(`/?day=${entry.date}`);
    }
    const action = `${self}/edit?date=${entry.date}`;
    const deleteHref = `${self}/delete?date=${entry.date}`;
    if (!post) return page(entryFormPage({ user, projects: cfg.projects, action, entry, deleteHref }));
    const f = entryFields(await form(req));
    const r = await patchEntry(repo, entry, f);
    if ("error" in r) return page(entryFormPage({ user, projects: cfg.projects, action, entry, deleteHref, error: r.error }), 422);
    return redirect(`/?day=${r.entry.date}`);
  }

  if (path === "/export/summary" && !post) {
    const cfg = await repo.getConfig();
    const ids = url.searchParams.getAll("p");
    const projects = ids.length ? cfg.projects.filter((p) => ids.includes(p.id)) : cfg.projects;
    const from = isDate(q("from")) ? q("from")! : undefined;
    const to = isDate(q("to")) ? q("to")! : undefined;
    const rows = summaryRows(projects, await repo.getEntries(historyStart(cfg, today), today), from, to);
    if (q("format") === "json") return download(JSON.stringify({ exported_at: today, from, to, projects: rows }, null, 2), "application/json", `rse-diary-summary-${today}.json`);
    return download(toSummaryCsv(rows), "text/csv", `rse-diary-summary-${today}.csv`);
  }

  if (path === "/tokens") {
    const origin = url.origin;
    if (!post) return page(tokensPage({ user, tokens: await listTokens(ctx.store, repo.sub), appUrl: origin }));
    const label = ((await form(req)).label ?? "").trim().slice(0, 40) || "token";
    const { token } = await createToken(ctx.store, repo.sub, label);
    // Rendered directly (not redirected) so the token is shown exactly once.
    return page(tokensPage({ user, tokens: await listTokens(ctx.store, repo.sub), appUrl: origin, newToken: { label, token } }));
  }

  const tm = path.match(/^\/tokens\/([0-9a-f]{64})\/revoke$/);
  if (tm && post) {
    await revokeToken(ctx.store, repo.sub, tm[1]!);
    return redirect("/tokens");
  }

  return notFound();
}
