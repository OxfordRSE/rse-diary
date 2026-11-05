import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/static", { recursive: true });

await build({
  entryPoints: ["src/lambda.ts"],
  outfile: "dist/lambda/index.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["@aws-sdk/*"], // provided by the Lambda runtime
  // Bundled CommonJS deps call require(); give ESM output one.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

await build({
  entryPoints: ["static/enhance.ts"],
  outfile: "dist/static/enhance.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
});

await copyFile("static/app.css", "dist/static/app.css");
await copyFile("node_modules/@picocss/pico/css/pico.min.css", "dist/static/pico.min.css");
console.log("built dist/");
