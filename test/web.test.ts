import { beforeEach, describe, expect, it } from "vitest";
import { route, type Deps } from "../src/app.ts";
import { MemoryBlobStore } from "../src/store.ts";
import { createToken } from "../src/tokens.ts";
import { Repo } from "../src/repo.ts";

let deps: Deps;
let store: MemoryBlobStore;
const COOKIE = "__Host-rsed_id=good";

beforeEach(() => {
  store = new MemoryBlobStore();
  deps = {
    store,
    cognito: { domain: "https://auth.example", clientId: "cid" },
    verifyIdToken: async (t) => {
      if (t !== "good") throw new Error("bad token");
      return { sub: "u1", email: "me@example.org" };
    },
    now: () => new Date("2026-11-05T12:00:00Z"),
    fetch: async () => new Response("{}", { status: 500 }),
  };
});

const get = (path: string, headers: Record<string, string> = { cookie: COOKIE }) => route(new Request(`https://diary.example${path}`, { headers }), deps);
const post = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  route(new Request(`https://diary.example${path}`, {
    method: "POST", body: new URLSearchParams(form),
    headers: { cookie: COOKIE, "content-type": "application/x-www-form-urlencoded", origin: "https://diary.example", "sec-fetch-site": "same-origin", ...headers },
  }), deps);

describe("auth", () => {
  it("redirects anonymous page views to login", async () => {
    const r = await get("/", {});
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/login");
  });

  it("login redirects to Cognito with PKCE and sets a PKCE cookie", async () => {
    const r = await get("/login", {});
    const loc = new URL(r.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://auth.example/oauth2/authorize");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://diary.example/auth/callback");
    expect(r.headers.get("set-cookie")).toMatch(/__Host-rsed_pkce=.*HttpOnly.*Secure/);
  });

  it("callback exchanges the code and sets session cookies", async () => {
    const login = await get("/login", {});
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    const pkce = login.headers.get("set-cookie")!.split(";")[0]!;
    let sent: URLSearchParams | undefined;
    deps.fetch = async (_url, init) => {
      sent = new URLSearchParams(String(init!.body));
      return Response.json({ id_token: "good", refresh_token: "rt", expires_in: 3600 });
    };
    const r = await get(`/auth/callback?code=abc&state=${state}`, { cookie: pkce });
    expect(sent!.get("code")).toBe("abc");
    expect(sent!.get("code_verifier")).toBeTruthy();
    expect(r.status).toBe(302);
    const cookies = r.headers.getSetCookie().join("\n");
    expect(cookies).toContain("__Host-rsed_id=good");
    expect(cookies).toContain("__Host-rsed_rt=rt");
  });

  it("callback rejects a mismatched state", async () => {
    const login = await get("/login", {});
    const pkce = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await get("/auth/callback?code=abc&state=wrong", { cookie: pkce })).status).toBe(400);
  });

  it("refreshes an expired id token using the refresh cookie", async () => {
    deps.fetch = async () => Response.json({ id_token: "good" });
    const r = await get("/", { cookie: "__Host-rsed_id=stale; __Host-rsed_rt=rt" });
    expect(r.status).toBe(200);
    expect(r.headers.getSetCookie().join()).toContain("__Host-rsed_id=good");
  });

  it("accepts a bearer PAT on the API and rejects a bad one", async () => {
    const { token } = await createToken(store, "u1", "laptop");
    expect((await get("/api/projects", { authorization: `Bearer ${token}` })).status).toBe(200);
    const bad = await get("/api/projects", { authorization: "Bearer rsed_nope" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("content-type")).toContain("json");
  });

  it("rejects cross-site form posts", async () => {
    const r = await post("/entries/new", { project_id: "overheads", date: "2026-11-05", fte: "0.1" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    expect(r.status).toBe(403);
  });
});

describe("pages", () => {
  it("overview renders the calendar", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('<table class="cal"');
  });

  it("returns only the day section as a fragment", async () => {
    const t = await (await get("/?day=2026-11-04&fragment=day")).text();
    expect(t.startsWith('<section id="day"')).toBe(true);
  });

  it("logs work from a form and redirects", async () => {
    const r = await post("/entries/new", { project_id: "overheads", date: "2026-11-05", fte: "0.1", notes: "emails" });
    expect(r.status).toBe(303);
    const es = await new Repo(store, "u1").getMonth("2026-11");
    expect(es[0]).toMatchObject({ project_id: "overheads", fte: 0.1, notes: "emails", source: "web" });
  });

  it("a touch checkbox overrides the FTE field", async () => {
    await post("/entries/new", { project_id: "overheads", date: "2026-11-05", fte: "0.5", touch: "1" });
    expect((await new Repo(store, "u1").getMonth("2026-11"))[0]!.fte).toBeNull();
  });

  it("re-renders the form with an error for bad input", async () => {
    const r = await post("/entries/new", { project_id: "overheads", date: "2026-11-05", fte: "3" });
    expect(r.status).toBe(422);
    expect(await r.text()).toContain('role="alert"');
  });

  it("edits and deletes an entry", async () => {
    await post("/entries/new", { project_id: "overheads", date: "2026-11-05", fte: "0.1" });
    const repo = new Repo(store, "u1");
    const id = (await repo.getMonth("2026-11"))[0]!.id;
    expect((await get(`/entries/${id}/edit?date=2026-11-05`)).status).toBe(200);
    expect((await post(`/entries/${id}/edit?date=2026-11-05`, { project_id: "overheads", date: "2026-11-05", fte: "0.2", notes: "x" })).status).toBe(303);
    expect((await repo.getMonth("2026-11"))[0]!.fte).toBe(0.2);
    expect((await post(`/entries/${id}/delete?date=2026-11-05`, {})).status).toBe(303);
    expect(await repo.getMonth("2026-11")).toEqual([]);
  });

  it("creates a project and shows its page", async () => {
    const r = await post("/projects/new", { name: "Glow", estimate_fte_days: "40", start: "2026-03-02", deadline: "" });
    expect(r.headers.get("location")).toBe("/projects/glow");
    expect(await (await get("/projects/glow")).text()).toContain("Glow");
  });

  it("exports a project .log as an attachment", async () => {
    const r = await get("/projects/overheads/export.log");
    expect(r.headers.get("content-type")).toContain("text/plain");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="overheads.log"');
    expect(await r.text()).toContain("# Project: Overheads");
  });

  it("exports a summary CSV for the selected projects", async () => {
    const r = await get("/export/summary?p=overheads");
    expect(r.headers.get("content-type")).toContain("text/csv");
    expect((await r.text()).split("\n")[1]).toMatch(/^Overheads,/);
  });

  it("creates a token, shows it once, and revokes it", async () => {
    const r = await post("/tokens", { label: "laptop" });
    expect(r.status).toBe(200);
    const page = await r.text();
    const token = page.match(/rsed_[A-Za-z0-9_-]{43}/)![0];
    expect(page).toContain("RSE_DIARY_URL=https://diary.example");
    expect(await (await get("/tokens")).text()).not.toContain(token);
  });

  it("404s an unknown project", async () => {
    expect((await get("/projects/nope")).status).toBe(404);
  });
});
