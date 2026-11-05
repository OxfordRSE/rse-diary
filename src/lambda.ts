import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { timingSafeEqual } from "node:crypto";
import { route, type Deps } from "./app.ts";
import { S3BlobStore } from "./store.ts";

/** Viewer host comes from x-forwarded-host, which a CloudFront Function sets from the viewer's Host. */
export function fromEvent(e: LambdaFunctionURLEvent): Request {
  const h = new Headers();
  for (const [k, v] of Object.entries(e.headers ?? {})) if (v !== undefined) h.set(k, v);
  if (e.cookies?.length) h.set("cookie", e.cookies.join("; "));
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const method = e.requestContext.http.method;
  const body = e.body && method !== "GET" && method !== "HEAD" ? (e.isBase64Encoded ? Buffer.from(e.body, "base64") : e.body) : undefined;
  return new Request(`https://${host}${e.rawPath}${e.rawQueryString ? `?${e.rawQueryString}` : ""}`, { method, headers: h, body });
}

export async function toResult(res: Response): Promise<{ statusCode: number; headers: Record<string, string>; body: string; cookies?: string[] }> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k !== "set-cookie") headers[k] = v;
  });
  const cookies = res.headers.getSetCookie();
  return { statusCode: res.status, headers, body: await res.text(), ...(cookies.length ? { cookies } : {}) };
}

let deps: Deps | undefined;
async function getDeps(): Promise<Deps> {
  if (deps) return deps;
  const env = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  // The app client's callback URL needs the CloudFront domain, which needs this function,
  // so Terraform passes the client id via SSM rather than an env var (avoids a cycle).
  const clientId = process.env.CLIENT_ID ?? (await new SSMClient({}).send(new GetParameterCommand({ Name: env("CLIENT_ID_PARAM") }))).Parameter!.Value!;
  const verifier = CognitoJwtVerifier.create({ userPoolId: env("USER_POOL_ID"), tokenUse: "id", clientId });
  return (deps = {
    store: new S3BlobStore(env("DATA_BUCKET")),
    cognito: { domain: env("COGNITO_DOMAIN"), clientId },
    verifyIdToken: async (t) => {
      const p = await verifier.verify(t);
      return { sub: p.sub, email: typeof p.email === "string" ? p.email : undefined };
    },
    now: () => new Date(),
    fetch,
  });
}

// The function URL is public (CloudFront OAC can't sign plain form POST bodies), so
// CloudFront adds a secret header and anything without it is refused.
function fromCloudFront(e: LambdaFunctionURLEvent): boolean {
  const want = Buffer.from(process.env.ORIGIN_SECRET ?? "");
  const got = Buffer.from(e.headers?.["x-origin-secret"] ?? "");
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

export async function handler(e: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  if (!fromCloudFront(e)) return { statusCode: 403, body: "Forbidden" };
  try {
    return await toResult(await route(fromEvent(e), await getDeps()));
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: { "content-type": "text/plain" }, body: "Something went wrong. Nothing was lost; try again." };
  }
}
