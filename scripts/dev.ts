// Local dev server: in-memory store seeded with demo data, sign-in bypassed.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { route, type Deps } from "../src/app.ts";
import { addDays, today } from "../src/dates.ts";
import { logEntries } from "../src/entries.ts";
import { Repo, newProject } from "../src/repo.ts";
import { MemoryBlobStore } from "../src/store.ts";

const PORT = Number(process.env.PORT ?? 8787);
const store = new MemoryBlobStore();
const deps: Deps = {
  store,
  cognito: { domain: "http://localhost", clientId: "dev" },
  verifyIdToken: async () => ({ sub: "dev", email: "dev@localhost" }),
  now: () => new Date(),
  fetch,
};

async function seed() {
  const repo = new Repo(store, "dev");
  const t = today();
  await repo.updateConfig((c) => {
    for (const [name, extra] of [
      ["Glow", { estimate_fte_days: 40, start: "2026-03-02", deadline: "2027-02-26" }],
      ["Hydra pipeline", { estimate_fte_days: 20, start: "2026-01-12", deadline: "2026-10-30" }],
      ["RSE diary", { estimate_fte_days: 5, start: addDays(t, -1) }],
      ["Teaching", { estimate_fte_days: 8 }],
    ] as const) c.projects.push(newProject(c, name, { ...extra }));
    return c;
  });
  let r = 42;
  const rand = () => ((r = (r * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const items = [];
  for (let d = addDays(t, -200); d <= t; d = addDays(d, 1)) {
    const weekend = [0, 6].includes(new Date(d).getUTCDay());
    for (const p of ["Glow", "Hydra pipeline", "Teaching", "Overheads"]) {
      if (p === "Hydra pipeline" && d > "2026-11-03") continue;
      if (rand() < (weekend ? 0.03 : 0.35)) {
        items.push({ project: p, date: d, fte: rand() < 0.15 ? null : [0.1, 0.25, 0.5][Math.floor(rand() * 3)], notes: `- Worked on ${p}\n- Notes for ${d}` });
      }
    }
  }
  items.push({ project: "RSE diary", date: t, fte: 0.25, notes: "- Designed storage layout\n- Built API and web UI" });
  items.push({ project: "Glow", date: t, fte: 0.1, notes: "Answered emails on data integrity and security model." });
  for (let i = 0; i < items.length; i += 100) await logEntries(repo, items.slice(i, i + 100), { today: t, source: "agent:demo" });
}

const TYPES: Record<string, string> = { css: "text/css", js: "text/javascript", svg: "image/svg+xml" };

createServer(async (req, res) => {
  const url = `http://localhost:${PORT}${req.url}`;
  if (req.url?.startsWith("/static/")) {
    try {
      const f = req.url.slice(8).replace(/[?#].*/, "").replace(/[^a-z0-9.\-]/gi, "");
      res.writeHead(200, { "content-type": TYPES[f.split(".").pop()!] ?? "application/octet-stream" });
      return res.end(await readFile(`dist/static/${f}`));
    } catch {
      res.writeHead(404);
      return res.end();
    }
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  headers.set("cookie", "__Host-rsed_id=dev");
  headers.delete("origin");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const out = await route(new Request(url, { method: req.method, headers, body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined, duplex: "half" } as RequestInit), deps);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(PORT, "0.0.0.0", async () => {
  await seed();
  console.log(`RSE diary dev server on http://localhost:${PORT}`);
});
