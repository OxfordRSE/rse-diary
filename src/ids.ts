import { randomBytes } from "node:crypto";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit ms timestamp + 80 random bits, Crockford base32, sorts by creation time. */
export function ulid(now = Date.now()): string {
  let t = "";
  for (let i = 0; i < 10; i++) {
    t = B32[now % 32] + t;
    now = Math.floor(now / 32);
  }
  const r = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += B32[r[i]! % 32];
  return t + rand;
}
