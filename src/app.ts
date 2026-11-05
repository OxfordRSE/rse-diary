import { handleApi } from "./api.ts";
import { callback, login, logout, sameOrigin, session, type AuthDeps } from "./auth.ts";
import { today } from "./dates.ts";
import { Repo } from "./repo.ts";
import type { BlobStore } from "./store.ts";
import { lookupToken } from "./tokens.ts";
import { errorPage } from "./views/pages.ts";
import { handleWeb } from "./web.ts";

export type Deps = AuthDeps & { store: BlobStore; now(): Date };

const apiError = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function withCookies(res: Response, cookies: string[]): Response {
  if (!cookies.length) return res;
  const h = new Headers(res.headers);
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(res.body, { status: res.status, headers: h });
}

export async function route(req: Request, deps: Deps): Promise<Response> {
  const path = new URL(req.url).pathname;
  const day = today("Europe/London", deps.now());

  if (path === "/login") return login(req, deps);
  if (path === "/auth/callback") return callback(req, deps);
  if (path === "/logout") return logout(req, deps);

  if (path.startsWith("/api/")) {
    if (path === "/api/instructions") return handleApi(req, { repo: null as never, today: day });
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Bearer ")) {
      const rec = await lookupToken(deps.store, auth.slice(7).trim(), deps.now());
      if (!rec) return apiError(401, "invalid or revoked token");
      return handleApi(req, { repo: new Repo(deps.store, rec.sub), tokenLabel: rec.label, today: day });
    }
    const s = await session(req, deps);
    if (!s) return apiError(401, "send Authorization: Bearer <token>");
    if (req.method !== "GET" && !sameOrigin(req)) return apiError(403, "cross-site request refused");
    return withCookies(await handleApi(req, { repo: new Repo(deps.store, s.sub), tokenLabel: "web", today: day }), s.setCookies);
  }

  const s = await session(req, deps);
  if (!s) return new Response(null, { status: 302, headers: { location: "/login" } });
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
    return new Response(errorPage(403, "Cross-site request refused."), { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const res = await handleWeb(req, { repo: new Repo(deps.store, s.sub), store: deps.store, user: s.email ?? s.sub, today: day });
  return withCookies(res, s.setCookies);
}
