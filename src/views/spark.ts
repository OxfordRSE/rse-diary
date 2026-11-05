import { html, type Html } from "../html.ts";

export function sparkline(values: number[], colour: string, w = 140, h = 28): Html {
  const max = Math.max(...values, 0);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (max ? v / max : 0) * (h - 2)).toFixed(1)}`).join(" ");
  const label = `Weekly FTE over the last ${values.length} weeks, peak ${max} FTE-days in a week`;
  return html`<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}"><polyline fill="none" stroke="${colour}" stroke-width="1.5" points="${pts}"/></svg>`;
}
