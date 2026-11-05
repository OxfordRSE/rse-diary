import { describe, expect, it } from "vitest";
import { MemoryBlobStore, PreconditionFailed, updateJson } from "../src/store.ts";
import { Repo } from "../src/repo.ts";
import { createToken, listTokens, lookupToken, revokeToken } from "../src/tokens.ts";
import type { Entry } from "../src/types.ts";

describe("updateJson", () => {
  it("keeps both writes when two updaters race on one key", async () => {
    const s = new MemoryBlobStore();
    const add = (x: number) =>
      updateJson<number[]>(s, "k", () => [], async (cur) => {
        await new Promise((r) => setTimeout(r, 5)); // both read before either writes
        return [...cur, x];
      });
    await Promise.all([add(1), add(2)]);
    expect(JSON.parse((await s.get("k"))!.body).sort()).toEqual([1, 2]);
  });

  it("gives up after 5 conflicts", async () => {
    const s = new MemoryBlobStore();
    s.put = async () => { throw new PreconditionFailed(); };
    let calls = 0;
    await expect(updateJson(s, "k", () => 0, (x) => (calls++, x))).rejects.toBeInstanceOf(PreconditionFailed);
    expect(calls).toBe(5);
  });
});

const e = (date: string): Entry => ({ id: date, date, project_id: "a", fte: 0.1, notes: "", source: "web", created_at: "", updated_at: "" });

describe("Repo", () => {
  it("creates and persists an Overheads project on first read", async () => {
    const s = new MemoryBlobStore();
    const cfg = await new Repo(s, "u1").getConfig();
    expect(cfg.projects).toHaveLength(1);
    expect(cfg.projects[0]).toMatchObject({ name: "Overheads", kind: "overhead", id: "overheads" });
    expect(await s.get("users/u1/config.json")).not.toBeNull();
  });

  it("reads entries across month files and filters to the range", async () => {
    const s = new MemoryBlobStore();
    const r = new Repo(s, "u1");
    await r.updateMonth("2026-10", () => [e("2026-10-29"), e("2026-10-30")]);
    await r.updateMonth("2026-11", () => [e("2026-11-02"), e("2026-11-03")]);
    const got = await r.getEntries("2026-10-30", "2026-11-02");
    expect(got.map((x) => x.date)).toEqual(["2026-10-30", "2026-11-02"]);
    expect(await s.get("users/u1/entries/2026-11.json")).not.toBeNull();
  });

  it("finds an entry in an older month and moves it when its date changes month", async () => {
    const s = new MemoryBlobStore();
    const r = new Repo(s, "u1");
    await r.updateMonth("2026-09", () => [e("2026-09-10")]);
    const found = (await r.findEntry("2026-09-10", "2026-11-05"))!;
    expect(found.date).toBe("2026-09-10");
    await r.replaceEntry(found, { ...found, date: "2026-11-01" });
    expect(await r.getMonth("2026-09")).toEqual([]);
    expect((await r.getMonth("2026-11")).map((x) => x.date)).toEqual(["2026-11-01"]);
    expect(await r.findEntry("nope", "2026-11-05")).toBeNull();
  });

  it("isolates users", async () => {
    const s = new MemoryBlobStore();
    await new Repo(s, "u1").updateMonth("2026-11", () => [e("2026-11-02")]);
    expect(await new Repo(s, "u2").getEntries("2026-11-01", "2026-11-30")).toEqual([]);
  });
});

describe("tokens", () => {
  it("round-trips, stores only the hash, and revokes", async () => {
    const s = new MemoryBlobStore();
    const { token, hash } = await createToken(s, "u1", "laptop");
    expect(token).toMatch(/^rsed_[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await s.get(`tokens/${hash}.json`)).not.toBeNull();
    expect(JSON.stringify(s.dump())).not.toContain(token);
    expect(await lookupToken(s, token)).toMatchObject({ sub: "u1", label: "laptop" });
    expect((await listTokens(s, "u1")).map((t) => t.label)).toEqual(["laptop"]);
    await revokeToken(s, "u1", hash);
    expect(await lookupToken(s, token)).toBeNull();
    expect(await listTokens(s, "u1")).toEqual([]);
  });

  it("refuses to revoke another user's token", async () => {
    const s = new MemoryBlobStore();
    const { token, hash } = await createToken(s, "u1", "laptop");
    await revokeToken(s, "u2", hash);
    expect(await lookupToken(s, token)).not.toBeNull();
  });

  it("rejects malformed tokens without touching the store", async () => {
    expect(await lookupToken(new MemoryBlobStore(), "../../users/u1/config")).toBeNull();
  });
});
