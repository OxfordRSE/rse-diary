// Dates are plain "YYYY-MM-DD" strings throughout; arithmetic happens in UTC so DST never shifts a day.

const toUtc = (d: string) => new Date(`${d}T00:00:00Z`);
const fromUtc = (t: Date) => t.toISOString().slice(0, 10);

export function today(tz = "Europe/London", now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
}

export function addDays(d: string, n: number): string {
  const t = toUtc(d);
  t.setUTCDate(t.getUTCDate() + n);
  return fromUtc(t);
}

export const monthKey = (d: string) => d.slice(0, 7);

export function mondayOf(d: string): string {
  return addDays(d, -((toUtc(d).getUTCDay() + 6) % 7));
}

/** 0 = Monday … 6 = Sunday */
export const weekday = (d: string) => (toUtc(d).getUTCDay() + 6) % 7;

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  const end = monthKey(to);
  for (;;) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    if (k > end) return out;
    out.push(k);
    if (++m > 12) { m = 1; y++; }
  }
}

export const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUtc(toUtc(s)) === s;
