import { createHash, randomBytes } from "node:crypto";
import { readJson, updateJson, type BlobStore } from "./store.ts";
import type { TokenIndex, TokenRecord } from "./types.ts";

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const indexKey = (sub: string) => `users/${sub}/tokens.json`;
const emptyIndex = (): TokenIndex => ({ tokens: [] });

export async function createToken(store: BlobStore, sub: string, label: string) {
  const token = `rsed_${randomBytes(32).toString("base64url")}`;
  const hash = hashOf(token);
  const created_at = new Date().toISOString();
  const rec: TokenRecord = { sub, label, created_at, expires_at: null };
  await store.put(`tokens/${hash}.json`, JSON.stringify(rec), { ifNoneMatch: "*" });
  await updateJson(store, indexKey(sub), emptyIndex, (i) => ({ tokens: [...i.tokens, { hash, label, created_at }] }));
  return { token, hash };
}

export async function lookupToken(store: BlobStore, token: string, now = new Date()): Promise<TokenRecord | null> {
  if (!/^rsed_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const key = `tokens/${hashOf(token)}.json`;
  const cur = await store.get(key);
  if (!cur) return null;
  const rec = JSON.parse(cur.body) as TokenRecord;
  if (rec.expires_at && rec.expires_at < now.toISOString()) return null;
  // At most one write an hour; losing this race just skips one timestamp update.
  if (!rec.last_used_at || now.getTime() - Date.parse(rec.last_used_at) > 3600e3) {
    store.put(key, JSON.stringify({ ...rec, last_used_at: now.toISOString() }), { ifMatch: cur.etag }).catch(() => {});
  }
  return rec;
}

export async function listTokens(store: BlobStore, sub: string): Promise<TokenIndex["tokens"]> {
  return (await readJson(store, indexKey(sub), emptyIndex)).tokens;
}

export async function revokeToken(store: BlobStore, sub: string, hash: string): Promise<void> {
  const owned = (await listTokens(store, sub)).some((t) => t.hash === hash);
  if (!owned || !/^[0-9a-f]{64}$/.test(hash)) return;
  await store.del(`tokens/${hash}.json`);
  await updateJson(store, indexKey(sub), emptyIndex, (i) => ({ tokens: i.tokens.filter((t) => t.hash !== hash) }));
}
