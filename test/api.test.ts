import { beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "../src/api.ts";
import { Repo } from "../src/repo.ts";
import { MemoryBlobStore } from "../src/store.ts";

let repo: Repo;
const call = async (method: string, path: string, body?: unknown) => {
  const res = await handleApi(
    new Request(`https://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }),
    { repo, tokenLabel: "laptop", today: "2026-11-05" },
  );
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type"), json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text };
};

beforeEach(async () => {
  repo = new Repo(new MemoryBlobStore(), "u1");
  await call("POST", "/api/projects", { name: "Glow", estimate_fte_days: 40 });
});

describe("POST /api/entries", () => {
  it("logs the spec example: a new project plus an existing one in one call", async () => {
    const r = await call("POST", "/api/entries", [
      { project: "RSE diary", create_project: true, fte: 0.25, notes: "- scoped architecture" },
      { project: "glow", fte: 0.1, notes: "Answered emails" },
    ]);
    expect(r.status).toBe(201);
    expect(r.json.created_projects.map((p: { name: string }) => p.name)).toEqual(["RSE diary"]);
    expect(r.json.entries).toHaveLength(2);
    expect(r.json.entries[1]).toMatchObject({ project_id: "glow", source: "agent:laptop", date: "2026-11-05", fte: 0.1 });
    expect(await repo.getEntries("2026-11-01", "2026-11-30")).toHaveLength(2);
  });

  it("does not duplicate a project whose name differs only by case or punctuation", async () => {
    await call("POST", "/api/entries", { project: "RSE diary", create_project: true, fte: 0.1 });
    const r = await call("POST", "/api/entries", { project: "rse-Diary", create_project: true, fte: 0.1 });
    expect(r.json.created_projects).toEqual([]);
    expect((await repo.getConfig()).projects.map((p) => p.name).sort()).toEqual(["Glow", "Overheads", "RSE diary"]);
  });

  it("rejects an unknown project with suggestions and writes nothing", async () => {
    const r = await call("POST", "/api/entries", [{ project: "Glow", fte: 0.2 }, { project: "Glwo", fte: 0.1 }]);
    expect(r.status).toBe(422);
    expect(r.json.detail[0]).toMatchObject({ index: 1 });
    expect(r.json.detail[0].suggestions).toContain("Glow");
    expect(await repo.getEntries("2026-11-01", "2026-11-30")).toEqual([]);
  });

  it("writes entries in different months to their own month files", async () => {
    await call("POST", "/api/entries", [{ project: "Glow", date: "2026-10-31", fte: 0.5 }, { project: "Glow", date: "2026-11-01", fte: 0.5 }]);
    expect(await repo.getMonth("2026-10")).toHaveLength(1);
    expect(await repo.getMonth("2026-11")).toHaveLength(1);
  });

  it("treats a repeated client_id on the same date as an update", async () => {
    await call("POST", "/api/entries", { project: "Glow", fte: 0.1, client_id: "conv-1", notes: "a" });
    await call("POST", "/api/entries", { project: "Glow", fte: 0.3, client_id: "conv-1", notes: "b" });
    const es = await repo.getMonth("2026-11");
    expect(es).toHaveLength(1);
    expect(es[0]).toMatchObject({ fte: 0.3, notes: "b" });
  });

  it("validates fte and treats a missing fte as a touch", async () => {
    expect((await call("POST", "/api/entries", { project: "Glow", fte: 1.5 })).status).toBe(422);
    expect((await call("POST", "/api/entries", { project: "Glow", fte: 0 })).status).toBe(422);
    expect((await call("POST", "/api/entries", { project: "Glow", date: "2026-02-30" })).status).toBe(422);
    const r = await call("POST", "/api/entries", { project: "Glow" });
    expect(r.json.entries[0].fte).toBeNull();
  });

  it("warns when a day's total goes over 1 FTE", async () => {
    const r = await call("POST", "/api/entries", [{ project: "Glow", fte: 0.6 }, { project: "Overheads", fte: 0.6 }]);
    expect(r.status).toBe(201);
    expect(r.json.warnings[0]).toContain("2026-11-05");
  });

  it("rejects non-JSON bodies", async () => {
    const res = await handleApi(new Request("https://x/api/entries", { method: "POST", body: "nope" }), { repo, today: "2026-11-05" });
    expect(res.status).toBe(400);
  });
});

describe("projects", () => {
  it("returns the existing project on a duplicate create", async () => {
    const r = await call("POST", "/api/projects", { name: "GLOW" });
    expect(r.status).toBe(200);
    expect(r.json.project.id).toBe("glow");
    expect(r.json.note).toMatch(/already exists/);
  });

  it("lists projects with totals", async () => {
    await call("POST", "/api/entries", [{ project: "Glow", fte: 0.5 }, { project: "Glow", date: "2026-11-04" }]);
    const r = await call("GET", "/api/projects");
    const glow = r.json.projects.find((p: { id: string }) => p.id === "glow");
    expect(glow.totals).toMatchObject({ fteDays: 0.5, daysWorked: 2, touchOnlyDays: 1 });
  });

  it("patches a project", async () => {
    const r = await call("PATCH", "/api/projects/glow", { deadline: "2027-02-26" });
    expect(r.json.project.deadline).toBe("2027-02-26");
  });
});

describe("entries CRUD", () => {
  it("lists, patches and deletes", async () => {
    const { json } = await call("POST", "/api/entries", { project: "Glow", fte: 0.1 });
    const id = json.entries[0].id;
    expect((await call("GET", "/api/entries?from=2026-11-01&to=2026-11-30")).json.entries).toHaveLength(1);
    expect((await call("PATCH", `/api/entries/${id}`, { notes: "edited", fte: null })).json.entry).toMatchObject({ notes: "edited", fte: null });
    expect((await call("DELETE", `/api/entries/${id}`)).status).toBe(204);
    expect(await repo.getMonth("2026-11")).toEqual([]);
  });
  it("404s an unknown entry", async () => {
    expect((await call("PATCH", "/api/entries/nope", { notes: "x" })).status).toBe(404);
  });
});

it("serves agent instructions as markdown", async () => {
  const r = await call("GET", "/api/instructions");
  expect(r.status).toBe(200);
  expect(r.type).toContain("text/markdown");
  expect(r.json).toContain("POST");
});
