import { addDays, monthKey, monthsBetween } from "./dates.ts";
import { normaliseName } from "./names.ts";
import { readJson, updateJson, type BlobStore } from "./store.ts";
import type { Config, Entry, Project } from "./types.ts";

// Categorical, no greys: the calendar's neutral shade ramp must never be mistaken for a project.
export const PALETTE = ["#2f81f7", "#a371f7", "#3fb950", "#f778ba", "#d29922", "#db6d28", "#39c5cf", "#e5534b", "#8957e5", "#57ab5a", "#c69026", "#1f6feb"];

export function newProject(cfg: Config, name: string, extra: Partial<Project> = {}, now = new Date().toISOString()): Project {
  const base = normaliseName(name) || "project";
  let id = base;
  for (let i = 2; cfg.projects.some((p) => p.id === id); i++) id = `${base}-${i}`;
  return {
    id, name: name.trim(), kind: "project", created_at: now,
    colour: PALETTE[cfg.projects.length % PALETTE.length]!,
    ...extra,
  };
}

const emptyConfig = (): Config => ({ projects: [] });

export class Repo {
  constructor(private store: BlobStore, readonly sub: string) {}

  private key = (rest: string) => `users/${this.sub}/${rest}`;

  async getConfig(): Promise<Config> {
    const cfg = await readJson(this.store, this.key("config.json"), emptyConfig);
    if (cfg.projects.some((p) => p.kind === "overhead")) return cfg;
    return this.updateConfig((c) => c);
  }

  /** Every config write also guarantees the Overheads bucket exists. */
  updateConfig(fn: (c: Config) => Config): Promise<Config> {
    return updateJson(this.store, this.key("config.json"), emptyConfig, (c) => {
      const next = fn(c);
      if (!next.projects.some((p) => p.kind === "overhead")) {
        next.projects.unshift({ ...newProject(next, "Overheads"), kind: "overhead" });
      }
      return next;
    });
  }

  private monthKeyPath = (m: string) => this.key(`entries/${m}.json`);

  async getMonth(month: string): Promise<Entry[]> {
    return (await readJson(this.store, this.monthKeyPath(month), () => ({ entries: [] as Entry[] }))).entries;
  }

  async getEntries(from: string, to: string): Promise<Entry[]> {
    const months = await Promise.all(monthsBetween(from, to).map((m) => this.getMonth(m)));
    return months.flat().filter((e) => e.date >= from && e.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  }

  async updateMonth(month: string, fn: (es: Entry[]) => Entry[]): Promise<Entry[]> {
    const r = await updateJson(this.store, this.monthKeyPath(month), () => ({ entries: [] as Entry[] }), (f) => ({ entries: fn(f.entries) }));
    return r.entries;
  }

  /** Entry ids don't encode the entry's date, so search back from `fromDate` (36 months max). */
  async findEntry(id: string, fromDate: string): Promise<Entry | null> {
    const months = monthsBetween(addDays(fromDate, -365 * 3), fromDate).reverse();
    for (let i = 0; i < months.length; i += 6) {
      const batch = await Promise.all(months.slice(i, i + 6).map((m) => this.getMonth(m)));
      const hit = batch.flat().find((e) => e.id === id);
      if (hit) return hit;
    }
    return null;
  }

  /** Replace or remove one entry, moving it between month files if its date changed. */
  async replaceEntry(old: Entry, next: Entry | null): Promise<void> {
    const oldM = monthKey(old.date);
    if (next && monthKey(next.date) === oldM) {
      await this.updateMonth(oldM, (es) => es.map((e) => (e.id === old.id ? next : e)));
      return;
    }
    if (next) await this.updateMonth(monthKey(next.date), (es) => [...es.filter((e) => e.id !== next.id), next]);
    await this.updateMonth(oldM, (es) => es.filter((e) => e.id !== old.id));
  }
}
