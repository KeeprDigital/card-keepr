import { type CatalogueStore } from "./catalogue-store-repository";
import { beginStagingWrite, finishStagingWrite, type StagingBinding } from "./staging-object-repository";

/** Each actual put has durable ownership before I/O. A rejected/abandoned call
 * keeps its ticket open: another successful call cannot settle that ticket. */
export function trackedStagingBucket(
  db: CatalogueStore,
  bucket: R2Bucket,
  binding: StagingBinding,
  preparation: string,
): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          const token = crypto.randomUUID();
          await db.batch(beginStagingWrite(db, preparation, binding, args[0], token, new Date().toISOString()));
          const result = await target.put(...args);
          await finishStagingWrite(db, token, new Date().toISOString()).run();
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
