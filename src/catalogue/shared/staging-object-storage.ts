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
