import { createHash, randomBytes } from "node:crypto";

export type CognitoCfg = { domain: string; clientId: string };
export type AuthDeps = {
  cognito: CognitoCfg;
  verifyIdToken(token: string): Promise<{ sub: string; email?: string }>;
  fetch: typeof fetch;
};
export type Session = { sub: string; email?: string; setCookies: string[] };

const ID = "__Host-rsed_id";
const RT = "__Host-rsed_rt";
const PKCE = "__Host-rsed_pkce";
const MONTH = 30 * 24 * 3600;

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const b64url = (b: Buffer) => b.toString("base64url");
const callbackUrl = (req: Request) => `${new URL(req.url).origin}/auth/callback`;

export function login(req: Request, deps: AuthDeps): Response {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const q = new URLSearchParams({
    response_type: "code", client_id: deps.cognito.clientId, redirect_uri: callbackUrl(req),
    scope: "openid email", state, code_challenge_method: "S256",
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
  });
  return new Response(null, {
    status: 302,
    headers: { location: `${deps.cognito.domain}/oauth2/authorize?${q}`, "set-cookie": cookie(PKCE, `${state}.${verifier}`, 600) },
  });
}

async function tokenRequest(deps: AuthDeps, params: Record<string, string>) {
  const r = await deps.fetch(`${deps.cognito.domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: deps.cognito.clientId, ...params }).toString(),
  });
  if (!r.ok) return null;
  return (await r.json()) as { id_token?: string; refresh_token?: string };
}

export async function callback(req: Request, deps: AuthDeps): Promise<Response> {
  const url = new URL(req.url);
  const [state, verifier] = (parseCookies(req.headers.get("cookie"))[PKCE] ?? "").split(".");
  const code = url.searchParams.get("code");
  if (!state || !verifier || !code || url.searchParams.get("state") !== state) {
    return new Response("Sign-in failed (state mismatch). Try again from /login.", { status: 400 });
  }
  const t = await tokenRequest(deps, { grant_type: "authorization_code", code, redirect_uri: callbackUrl(req), code_verifier: verifier });
  if (!t?.id_token) return new Response("Sign-in failed (token exchange).", { status: 400 });
  await deps.verifyIdToken(t.id_token);
  const h = new Headers({ location: "/" });
  h.append("set-cookie", cookie(ID, t.id_token, MONTH));
  if (t.refresh_token) h.append("set-cookie", cookie(RT, t.refresh_token, MONTH));
  h.append("set-cookie", cookie(PKCE, "", 0));
  return new Response(null, { status: 302, headers: h });
}

export function logout(req: Request, deps: AuthDeps): Response {
  const h = new Headers({
    location: `${deps.cognito.domain}/logout?${new URLSearchParams({ client_id: deps.cognito.clientId, logout_uri: `${new URL(req.url).origin}/` })}`,
  });
  h.append("set-cookie", cookie(ID, "", 0));
  h.append("set-cookie", cookie(RT, "", 0));
  return new Response(null, { status: 302, headers: h });
}

/** Cookie session; transparently refreshes an expired id token. */
export async function session(req: Request, deps: AuthDeps): Promise<Session | null> {
  const c = parseCookies(req.headers.get("cookie"));
  if (c[ID]) {
    try {
      return { ...(await deps.verifyIdToken(c[ID])), setCookies: [] };
    } catch {
      /* expired or invalid: try refresh */
    }
  }
  if (!c[RT]) return null;
  const t = await tokenRequest(deps, { grant_type: "refresh_token", refresh_token: c[RT] });
  if (!t?.id_token) return null;
  try {
    return { ...(await deps.verifyIdToken(t.id_token)), setCookies: [cookie(ID, t.id_token, MONTH)] };
  } catch {
    return null;
  }
}

/** Blocks cross-site state-changing requests that ride on the session cookie. */
export function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(req.url).origin;
}
