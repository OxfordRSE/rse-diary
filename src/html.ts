export class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

export const raw = (s: string) => new Html(s);

type Value = Html | string | number | null | undefined | false | Value[];

function render(v: Value): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return escape(String(v));
}

/** Tagged template: every interpolation is escaped unless it is already Html. */
export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let out = strings[0]!;
  values.forEach((v, i) => (out += render(v) + strings[i + 1]));
  return new Html(out);
}

export function layout(title: string, body: Html, opts: { user?: string } = {}): string {
  return html`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · RSE diary</title>
<link rel="stylesheet" href="/static/pico.min.css">
<link rel="stylesheet" href="/static/app.css">
<script>try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
<script type="module" src="/static/enhance.js"></script>
</head>
<body>
<header class="container">
<nav>
<ul><li><a href="/"><strong>RSE diary</strong></a></li></ul>
${opts.user ? html`<ul>
<li><a href="/entries/new">Log work</a></li>
<li><a href="/projects">Projects</a></li>
<li><a href="/tokens">Tokens</a></li>
<li><a href="/logout">Sign out</a></li>
</ul>` : ""}
</nav>
</header>
<main class="container">
${body}
</main>
</body>
</html>
`.toString();
}
