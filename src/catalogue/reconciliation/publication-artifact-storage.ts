import { createHash } from "node:crypto";
import {
  type CatalogueStore,
  sha256Text,
  trackedStagingBucket,
  registeredStagingKeys,
  writeStagingObjects,
} from "../shared";
import { PublicationIntegrityError } from "./publication-preparation-types";

type RetainedObject = { object_key: string; sha256: string; byte_length: number; reused: boolean };
type PendingObject = { content: string; reference: Omit<RetainedObject, "reused">; retained?: RetainedObject };

/** Draft references become receipts only after every bounded write and verification settles. */
export function publicationObjectBatch(db: CatalogueStore, bucket: R2Bucket, preparation: string) {
  const observed = trackedStagingBucket(db, bucket, "CATALOGUE_EXPORTS", preparation);
  let pending: PendingObject[] = [];
  let pendingBytes = 0;
  async function flush() {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    const keys = batch.map(({ reference }) => reference.object_key);
    // Unknown identities still use conditional PUT and read-back verification. A
    // registered identity can own a lost write, so observe it before retrying.
    const registered = batch.length === 1 ? new Set(keys) : await registeredStagingKeys(db, "CATALOGUE_EXPORTS", keys);
    const heads = await Promise.allSettled(
      batch.map(async ({ reference }) =>
        registered.has(reference.object_key) ? observed.head(reference.object_key) : null,
      ),
    );
    for (const head of heads) if (head.status === "rejected") throw head.reason;
    const written = await writeStagingObjects(
      db,
      bucket,
      "CATALOGUE_EXPORTS",
      preparation,
      batch.flatMap(({ content, reference }, index) => {
        const head = heads[index]!;
        return head.status === "fulfilled" && head.value === null
          ? [
              {
                key: reference.object_key,
                content,
                options: publicationObjectOptions(reference.object_key, reference.sha256),
              },
            ]
          : [];
      }),
    );
    const verified = await Promise.allSettled(
      batch.map(({ reference }) =>
        verifyPublicationObject(bucket, reference.object_key, reference.sha256, reference.byte_length),
      ),
    );
    for (const result of verified) if (result.status === "rejected") throw result.reason;
    let write = 0;
    batch.forEach((object, index) => {
      const head = heads[index]!;
      const existed = head.status === "fulfilled" && head.value !== null;
      const reused = existed || written[write++] === null;
      object.retained = { ...object.reference, reused };
      object.content = "";
    });
  }
  return {
    flush,
    async stage(content: string, key?: string) {
      const byte_length = new TextEncoder().encode(content).byteLength;
      if (byte_length > 524288) throw new PublicationIntegrityError("publication_capacity_exceeded");
      if (pending.length === 4 || pendingBytes + byte_length > 524288) await flush();
      const sha256 = await sha256Text(content);
      const object: PendingObject = {
        content,
        reference: { object_key: key ?? `publication-artifacts/${sha256}`, sha256, byte_length },
      };
      pending.push(object);
      pendingBytes += byte_length;
      return {
        ...object.reference,
        receipt() {
          if (!object.retained) throw new Error("Publication object has not been verified.");
          return object.retained;
        },
      };
    },
  };
}

function publicationObjectOptions(key: string, sha256: string): R2PutOptions {
  return {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256,
    httpMetadata: {
      contentType: key.startsWith("publication-text/") ? "text/plain; charset=utf-8" : "application/json",
      cacheControl: "private, max-age=31536000, immutable",
    },
  };
}

/** Bounded metadata objects are content-addressed; a conflicting object is never repaired silently. */
export async function retainPublicationObject(bucket: R2Bucket, content: string, key?: string) {
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes > 524288) throw new PublicationIntegrityError("publication_capacity_exceeded");
  const sha256 = await sha256Text(content);
  key ??= `publication-artifacts/${sha256}`;
  const existing = await bucket.head(key);
  if (!existing) {
    await bucket.put(key, content, publicationObjectOptions(key, sha256));
  }
  await verifyPublicationObject(bucket, key, sha256, bytes);
  return { object_key: key, sha256, byte_length: bytes, reused: existing !== null };
}

/** Stream verification keeps image bytes out of metadata buffers and enforces the declared byte bound. */
export async function verifyPublicationObject(bucket: R2Bucket, key: string, sha: string, bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 20 * 1024 * 1024)
    throw new PublicationIntegrityError("publication_capacity_exceeded");
  const object = await bucket.get(key);
  if (!object) throw new PublicationIntegrityError("publication_artifact_missing");
  if (object.size !== bytes) {
    await object.body.cancel();
    throw new PublicationIntegrityError("publication_artifact_corrupt");
  }
  const digest = createHash("sha256");
  const reader = object.body.getReader();
  let received = 0;
  let complete = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      received += value.byteLength;
      if (received > bytes) throw new PublicationIntegrityError("publication_artifact_corrupt");
      digest.update(value);
    }
    if (received !== bytes || digest.digest("hex") !== sha)
      throw new PublicationIntegrityError("publication_artifact_corrupt");
  } finally {
    try {
      if (!complete) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
