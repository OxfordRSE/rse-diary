import { addDays, isDate, monthKey } from "./dates.ts";
import { ulid } from "./ids.ts";
import { closestNames, normaliseName } from "./names.ts";
import { newProject, type Repo } from "./repo.ts";
import { dayTotals } from "./totals.ts";
import type { Config, Entry, Project } from "./types.ts";

export type EntryInput = {
  project_id?: unknown; project?: unknown; create_project?: unknown;
  date?: unknown; fte?: unknown; notes?: unknown; source?: unknown; client_id?: unknown;
};
export type ItemError = { index: number; message: string; suggestions?: string[] };

export function resolveProject(cfg: Config, nameOrId: string): Project | undefined {
  const key = normaliseName(nameOrId);
  return cfg.projects.find((p) => p.id === nameOrId) ?? cfg.projects.find((p) => normaliseName(p.name) === key);
}

/** fte: undefined/null = touch; otherwise must be a number in (0, 1]. */
export function checkFte(v: unknown): number | null | string {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 1) return "fte must be a number greater than 0 and at most 1, or null for a touch";
  return Math.round(n * 100) / 100;
}

/** The earliest date worth reading for all-time totals. */
export function historyStart(cfg: Config, today: string): string {
  // shortcut: assumes nothing is back-dated more than a year before any project's start/creation; store a first-entry month in config if that bites.
  const dates = cfg.projects.flatMap((p) => [p.start, p.created_at.slice(0, 10)]).filter(isDate);
  return addDays([...dates, today].sort()[0]!, -365);
}

export async function logEntries(repo: Repo, items: EntryInput[], opts: { today: string; source: string; now?: string }) {
  const now = opts.now ?? new Date().toISOString();
  const errors: ItemError[] = [];
  const cfg = await repo.getConfig();
  const toCreate = new Map<string, string>(); // normalised key -> display name

  const parsed = items.map((it, index) => {
    const err = (message: string, suggestions?: string[]) => (errors.push({ index, message, suggestions }), null);
    if (typeof it !== "object" || it === null) return err("each entry must be an object");
    const date = it.date ?? opts.today;
    if (!isDate(date)) return err("date must be YYYY-MM-DD");
    const fte = checkFte(it.fte);
    if (typeof fte === "string") return err(fte);
    if (it.notes !== undefined && typeof it.notes !== "string") return err("notes must be a string");
    const notes = (it.notes as string | undefined) ?? "";
    if (notes.length > 20000) return err("notes must be at most 20000 characters");
    const ref = it.project_id ?? it.project;
    if (typeof ref !== "string" || !ref.trim()) return err("project (name) or project_id is required");
    if (it.client_id !== undefined && typeof it.client_id !== "string") return err("client_id must be a string");
    const existing = resolveProject(cfg, ref);
    if (!existing) {
      if (it.create_project !== true || !normaliseName(ref)) {
        return err(`unknown project "${ref}"; use one of the suggestions, or set "create_project": true to create it`, closestNames(ref, cfg.projects));
      }
      if (!toCreate.has(normaliseName(ref))) toCreate.set(normaliseName(ref), ref.trim());
    }
    return { ref, date, fte, notes, client_id: it.client_id as string | undefined, source: typeof it.source === "string" && it.source ? it.source : opts.source };
  });
  if (errors.length) return { errors };

  const created: Project[] = [];
  const finalCfg = toCreate.size
    ? await repo.updateConfig((c) => {
        created.length = 0;
        for (const name of toCreate.values()) {
          if (resolveProject(c, name)) continue; // a concurrent writer created it
          const p = newProject(c, name, {}, now);
          c.projects.push(p);
          created.push(p);
        }
        return c;
      })
    : cfg;

  const entries: Entry[] = parsed.map((x) => {
    const p = resolveProject(finalCfg, x!.ref)!;
    return {
      id: ulid(), date: x!.date, project_id: p.id, fte: x!.fte, notes: x!.notes, source: x!.source,
      ...(x!.client_id ? { client_id: x!.client_id } : {}), created_at: now, updated_at: now,
    };
  });

  const byMonth = Map.groupBy(entries, (e) => monthKey(e.date));
  const saved: Entry[] = [];
  const warnings: string[] = [];
  for (const [month, batch] of byMonth) {
    const after = await repo.updateMonth(month, (es) => {
      const out = [...es];
      for (const e of batch) {
        const i = e.client_id ? out.findIndex((o) => o.client_id === e.client_id && o.date === e.date) : -1;
        if (i >= 0) out[i] = { ...e, id: out[i]!.id, created_at: out[i]!.created_at };
        else out.push(e);
      }
      return out;
    });
    const totals = dayTotals(after);
    for (const e of batch) {
      saved.push(after.find((a) => a.client_id && a.client_id === e.client_id && a.date === e.date) ?? e);
    }
    for (const d of new Set(batch.map((e) => e.date))) {
      const t = totals.get(d)!.fte;
      if (t > 1) warnings.push(`${d} now totals ${t} FTE (over 1.0)`);
    }
  }
  // Return in request order.
  const order = new Map(entries.map((e, i) => [e.client_id ? `${e.client_id}|${e.date}` : e.id, i]));
  saved.sort((a, b) => (order.get(a.client_id ? `${a.client_id}|${a.date}` : a.id) ?? 0) - (order.get(b.client_id ? `${b.client_id}|${b.date}` : b.id) ?? 0));
  return { entries: saved, created_projects: created, warnings };
}
