import { GetObjectCommand, NoSuchKey, PutObjectCommand, DeleteObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";

export class PreconditionFailed extends Error {}

export interface BlobStore {
  get(key: string): Promise<{ body: string; etag: string } | null>;
  /** Throws PreconditionFailed if the condition does not hold. */
  put(key: string, body: string, cond: { ifMatch?: string; ifNoneMatch?: "*" }): Promise<void>;
  del(key: string): Promise<void>;
}

export class MemoryBlobStore implements BlobStore {
  private data = new Map<string, { body: string; etag: string }>();
  private n = 0;
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async put(key: string, body: string, cond: { ifMatch?: string; ifNoneMatch?: "*" }) {
    const cur = this.data.get(key);
    if (cond.ifNoneMatch && cur) throw new PreconditionFailed(key);
    if (cond.ifMatch && cur?.etag !== cond.ifMatch) throw new PreconditionFailed(key);
    this.data.set(key, { body, etag: `"${++this.n}"` });
  }
  async del(key: string) {
    this.data.delete(key);
  }
  dump() {
    return Object.fromEntries(this.data);
  }
}

export class S3BlobStore implements BlobStore {
  constructor(private bucket: string, private client = new S3Client({})) {}
  async get(key: string) {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return { body: await r.Body!.transformToString(), etag: r.ETag! };
    } catch (e) {
      if (e instanceof NoSuchKey) return null;
      throw e;
    }
  }
  async put(key: string, body: string, cond: { ifMatch?: string; ifNoneMatch?: "*" }) {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: key, Body: body, ContentType: "application/json",
        IfMatch: cond.ifMatch, IfNoneMatch: cond.ifNoneMatch,
      }));
    } catch (e) {
      // 412: condition failed; 409: a concurrent conditional write won the race.
      const status = e instanceof S3ServiceException ? e.$metadata.httpStatusCode : undefined;
      if (status === 412 || status === 409) throw new PreconditionFailed(key);
      throw e;
    }
  }
  async del(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export async function readJson<T>(store: BlobStore, key: string, empty: () => T): Promise<T> {
  const cur = await store.get(key);
  return cur ? (JSON.parse(cur.body) as T) : empty();
}

/** Optimistic read-modify-write; retries when another writer got there first. */
export async function updateJson<T>(store: BlobStore, key: string, empty: () => T, fn: (cur: T) => T | Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const cur = await store.get(key);
    const next = await fn(cur ? (JSON.parse(cur.body) as T) : empty());
    try {
      await store.put(key, JSON.stringify(next), cur ? { ifMatch: cur.etag } : { ifNoneMatch: "*" });
      return next;
    } catch (e) {
      if (!(e instanceof PreconditionFailed) || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, Math.random() * 50 * attempt));
    }
  }
}
