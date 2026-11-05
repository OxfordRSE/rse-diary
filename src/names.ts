import type { Project } from "./types.ts";

// NFKD + dropping combining marks folds accents ("Café" = "cafe") but keeps other scripts distinct.
export const normaliseName = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

export function closestNames(name: string, projects: Project[], n = 5): string[] {
  const key = normaliseName(name);
  return projects
    .map((p) => {
      const k = normaliseName(p.name);
      const sub = key && (k.includes(key) || key.includes(k));
      return { name: p.name, score: sub ? -1 : levenshtein(key, k) };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, n)
    .map((x) => x.name);
}
