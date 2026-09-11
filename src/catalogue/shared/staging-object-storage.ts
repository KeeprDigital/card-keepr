import { type CatalogueStore } from "./catalogue-store-repository";
import {
  beginStagingWrite,
  finishStagingWrite,
  finishObservedStagingWrite,
  type StagingBinding,
} from "./staging-object-repository";

/** Each actual put has durable ownership before I/O. A rejected/abandoned call
 * keeps its ticket open: another successful call cannot settle that ticket. */
export function trackedStagingBucket(
  db: CatalogueStore,
  bucket: R2Bucket,
  binding: StagingBinding,
  preparation: string,
): R2Bucket {
  const acknowledged = new Set<string>();
  async function acknowledgeObserved(key: string, object: R2Object | null) {
    const token = object?.customMetadata?.cleanup_writer_token;
    if (token && !acknowledged.has(token)) {
      await finishObservedStagingWrite(db, binding, key, token, new Date().toISOString()).run();
      acknowledged.add(token);
    }
  }
  return new Proxy(bucket, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          const token = crypto.randomUUID();
          await db.batch(beginStagingWrite(db, preparation, binding, args[0], token, new Date().toISOString()));
          args[2] = { ...args[2], customMetadata: { ...args[2]?.customMetadata, cleanup_writer_token: token } };
          const result = await target.put(...args);
          await finishStagingWrite(db, token, new Date().toISOString()).run();
          acknowledged.add(token);
          if (result === null) await acknowledgeObserved(args[0], await target.head(args[0]));
          return result;
        };
      if (property === "head")
        return async (key: string) => {
          const object = await target.head(key);
          await acknowledgeObserved(key, object);
          return object;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Own every write before starting I/O, then settle only calls with a known result. */
export async function writeStagingObjects(
  db: CatalogueStore,
  bucket: R2Bucket,
  binding: StagingBinding,
  preparation: string,
  objects: { key: string; content: string; options: R2PutOptions }[],
) {
  if (!objects.length) return;
  if (objects.length > 4) throw new Error("Staging writes exceed four objects.");
  const writes = objects.map((object) => ({ ...object, token: crypto.randomUUID() }));
  await db.batch(
    writes.flatMap(({ key, token }) =>
      beginStagingWrite(db, preparation, binding, key, token, new Date().toISOString()),
    ),
  );
  const results = await Promise.allSettled(
    writes.map(async ({ key, content, options, token }) =>
      bucket.put(key, content, {
        ...options,
        customMetadata: { ...options.customMetadata, cleanup_writer_token: token },
      }),
    ),
  );
  const completed = writes.filter((_, index) => results[index]!.status === "fulfilled");
  if (completed.length)
    await db.batch(completed.map(({ token }) => finishStagingWrite(db, token, new Date().toISOString())));
  const observed = trackedStagingBucket(db, bucket, binding, preparation);
  const observations = await Promise.allSettled(
    writes.flatMap(({ key }, index) => {
      const result = results[index]!;
      return result.status === "fulfilled" && result.value === null ? [observed.head(key)] : [];
    }),
  );
  for (const result of [...results, ...observations]) if (result.status === "rejected") throw result.reason;
}
