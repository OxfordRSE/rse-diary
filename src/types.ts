export type Project = {
  id: string;
  name: string;
  colour: string;
  kind: "project" | "overhead";
  estimate_fte_days?: number;
  start?: string; // YYYY-MM-DD
  deadline?: string; // YYYY-MM-DD
  archived?: boolean;
  created_at: string;
};

export type Entry = {
  id: string; // ULID
  date: string; // YYYY-MM-DD, user's local date
  project_id: string;
  fte: number | null; // 0 < fte <= 1; null = touch
  notes: string;
  source: string; // "web" | "agent:<label>"
  client_id?: string;
  created_at: string;
  updated_at: string;
};

export type Config = { projects: Project[] };

export type TokenRecord = {
  sub: string;
  label: string;
  created_at: string;
  last_used_at?: string;
  expires_at?: string | null;
};

export type TokenIndex = { tokens: { hash: string; label: string; created_at: string }[] };
