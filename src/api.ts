import { isDate, monthKey } from "./dates.ts";
import { checkFte, historyStart, logEntries, resolveProject, type EntryInput } from "./entries.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { newProject, type Repo } from "./repo.ts";
import { projectTotals } from "./totals.ts";
import type { Entry, Project } from "./types.ts";

export type ApiCtx = { repo: Repo; tokenLabel?: string; today: string };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (status: number, error: string, detail?: unknown) => json(status, { error, detail });

class BadRequest extends Error {}

async function body(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequest("body must be JSON");
  }
}

/** Validates the editable project fields; returns an error message or the patch. */
export function projectPatch(b: Record<string, unknown>): Partial<Project> | string {
  const out: Partial<Project> = {};
  if ("name" in b) {
    if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 100) return "name must be 1–100 characters";
    out.name = b.name.trim();
  }
  for (const k of ["start", "deadline"] as const) {
    if (k in b) {
      if (b[k] === null || b[k] === "") out[k] = undefined;
      else if (isDate(b[k])) out[k] = b[k];
      else return `${k} must be YYYY-MM-DD or null`;
    }
  }
  if ("estimate_fte_days" in b) {
    const v = b.estimate_fte_days;
    if (v === null || v === "") out.estimate_fte_days = undefined;
    else if (typeof v === "number" && v >= 0 && Number.isFinite(v)) out.estimate_fte_days = v;
    else return "estimate_fte_days must be a non-negative number or null";
  }
  if ("colour" in b) {
    if (typeof b.colour !== "string" || !/^#[0-9a-fA-F]{6}$/.test(b.colour)) return "colour must be #rrggbb";
    out.colour = b.colour;
  }
  if ("archived" in b) out.archived = b.archived === true;
  if (out.start && out.deadline && out.start > out.deadline) return "start must be on or before deadline";
  return out;
}

export async function createProject(repo: Repo, b: Record<string, unknown>) {
  const patch = projectPatch(b);
  if (typeof patch === "string") return { error: patch };
  if (!patch.name) return { error: "name is required" };
  let existing: Project | undefined;
  let created: Project | undefined;
  await repo.updateConfig((c) => {
    existing = resolveProject(c, patch.name!);
    if (!existing) c.projects.push((created = newProject(c, patch.name!, clean(patch))));
    return c;
  });
  return { existing, created };
}

export async function updateProject(repo: Repo, id: string, b: Record<string, unknown>) {
  const patch = projectPatch(b);
  if (typeof patch === "string") return { error: patch };
  let found: Project | undefined;
  let clash = false;
  await repo.updateConfig((c) => {
    found = c.projects.find((p) => p.id === id);
    if (!found) return c;
    const other = patch.name ? resolveProject(c, patch.name) : undefined;
    if (other && other.id !== id) {
      clash = true;
      return c;
    }
    if (found.kind === "overhead") delete patch.archived;
    Object.assign(found, patch);
    for (const k of Object.keys(found) as (keyof Project)[]) if (found[k] === undefined) delete found[k];
    return c;
  });
  if (clash) return { error: "another project already has that name" };
  return { project: found };
}

const clean = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export async function patchEntry(repo: Repo, old: Entry, b: Record<string, unknown>, now = new Date().toISOString()) {
  const next: Entry = { ...old, updated_at: now };
  if ("date" in b) {
    if (!isDate(b.date)) return { error: "date must be YYYY-MM-DD" };
    next.date = b.date;
  }
  if ("fte" in b) {
    const f = checkFte(b.fte);
    if (typeof f === "string") return { error: f };
    next.fte = f;
  }
  if ("notes" in b) {
    if (typeof b.notes !== "string" || b.notes.length > 20000) return { error: "notes must be a string of at most 20000 characters" };
    next.notes = b.notes;
  }
  if ("project_id" in b) {
    const p = resolveProject(await repo.getConfig(), String(b.project_id));
    if (!p) return { error: "unknown project" };
    next.project_id = p.id;
  }
  await repo.replaceEntry(old, next);
  return { entry: next };
}

export async function handleApi(req: Request, ctx: ApiCtx): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const m = req.method;
  const { repo } = ctx;
  try {
    if (path === "/api/instructions" && m === "GET") {
      return new Response(INSTRUCTIONS, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }

    if (path === "/api/projects" && m === "GET") {
      const cfg = await repo.getConfig();
      const all = await repo.getEntries(historyStart(cfg, ctx.today), ctx.today);
      return json(200, { projects: cfg.projects.map((p) => ({ ...p, totals: projectTotals(all, p.id) })) });
    }

    if (path === "/api/projects" && m === "POST") {
      const r = await createProject(repo, (await body(req)) as Record<string, unknown>);
      if ("error" in r) return fail(422, r.error!);
      if (r.existing) return json(200, { project: r.existing, note: `a project matching that name already exists ("${r.existing.name}"); returned it instead of creating a duplicate` });
      return json(201, { project: r.created });
    }

    const pm = path.match(/^\/api\/projects\/([^/]+)$/);
    if (pm && m === "PATCH") {
      const r = await updateProject(repo, decodeURIComponent(pm[1]!), (await body(req)) as Record<string, unknown>);
      if ("error" in r) return fail(422, r.error!);
      if (!r.project) return fail(404, "no such project");
      return json(200, { project: r.project });
    }

    if (path === "/api/entries" && m === "POST") {
      const b = await body(req);
      const items = (Array.isArray(b) ? b : [b]) as EntryInput[];
      if (!items.length || items.length > 100) return fail(422, "send 1–100 entries");
      const r = await logEntries(repo, items, { today: ctx.today, source: `agent:${ctx.tokenLabel ?? "api"}` });
      if ("errors" in r) return fail(422, "invalid entries; nothing was written", r.errors);
      return json(201, r);
    }

    if (path === "/api/entries" && m === "GET") {
      const from = url.searchParams.get("from") ?? `${monthKey(ctx.today)}-01`;
      const to = url.searchParams.get("to") ?? ctx.today;
      if (!isDate(from) || !isDate(to) || from > to) return fail(422, "from/to must be YYYY-MM-DD with from <= to");
      const project = url.searchParams.get("project");
      const es = await repo.getEntries(from, to);
      return json(200, { entries: project ? es.filter((e) => e.project_id === project) : es });
    }

    const em = path.match(/^\/api\/entries\/([^/]+)$/);
    if (em && (m === "PATCH" || m === "DELETE")) {
      const old = await repo.findEntry(decodeURIComponent(em[1]!), ctx.today);
      if (!old) return fail(404, "no such entry (searched the last 3 years)");
      if (m === "DELETE") {
        await repo.replaceEntry(old, null);
        return new Response(null, { status: 204 });
      }
      const r = await patchEntry(repo, old, (await body(req)) as Record<string, unknown>);
      if ("error" in r) return fail(422, r.error!);
      return json(200, { entry: r.entry });
    }

    return fail(404, "no such endpoint; see /api/instructions");
  } catch (e) {
    if (e instanceof BadRequest) return fail(400, e.message);
    throw e;
  }
}
