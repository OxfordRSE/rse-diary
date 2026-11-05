import { expect, it } from "vitest";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { fromEvent, handler, toResult } from "../src/lambda.ts";

const event = (extra: Partial<LambdaFunctionURLEvent>): LambdaFunctionURLEvent => ({
  version: "2.0", routeKey: "$default", rawPath: "/entries/new", rawQueryString: "a=1&b=2",
  cookies: ["__Host-rsed_id=x", "other=y"],
  headers: { host: "abc.lambda-url.eu-west-2.on.aws", "x-forwarded-host": "diary.example", "content-type": "application/x-www-form-urlencoded" },
  requestContext: { http: { method: "POST" } } as LambdaFunctionURLEvent["requestContext"],
  isBase64Encoded: true, body: Buffer.from("notes=hi%20there").toString("base64"),
  ...extra,
});

it("builds a Request using the viewer host, cookies and decoded body", async () => {
  const req = fromEvent(event({}));
  expect(req.url).toBe("https://diary.example/entries/new?a=1&b=2");
  expect(req.method).toBe("POST");
  expect(req.headers.get("cookie")).toBe("__Host-rsed_id=x; other=y");
  expect((await req.formData()).get("notes")).toBe("hi there");
});

it("omits the body on GET", () => {
  const req = fromEvent(event({ requestContext: { http: { method: "GET" } } as LambdaFunctionURLEvent["requestContext"], body: undefined }));
  expect(req.method).toBe("GET");
});

it("refuses requests that did not come through CloudFront", async () => {
  process.env.ORIGIN_SECRET = "s3cret";
  expect(await handler(event({}))).toMatchObject({ statusCode: 403 });
  expect(await handler(event({ headers: { ...event({}).headers, "x-origin-secret": "wrong!" } }))).toMatchObject({ statusCode: 403 });
});

it("maps multiple Set-Cookie headers to the cookies array", async () => {
  const h = new Headers({ "content-type": "text/html" });
  h.append("set-cookie", "a=1");
  h.append("set-cookie", "b=2");
  const r = await toResult(new Response("<p>hi</p>", { status: 201, headers: h }));
  expect(r).toMatchObject({ statusCode: 201, body: "<p>hi</p>", cookies: ["a=1", "b=2"], headers: { "content-type": "text/html" } });
  expect((r.headers as Record<string, string>)["set-cookie"]).toBeUndefined();
});
