import { sha256Text } from "../shared";
import { PublicationIntegrityError } from "./publication-preparation-types";

/** Bounded metadata objects are content-addressed; a conflicting object is never repaired silently. */
export async function retainPublicationObject(bucket: R2Bucket, content: string, key?: string) {
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes > 524288) throw new PublicationIntegrityError("publication_capacity_exceeded");
  const sha256 = await sha256Text(content);
  key ??= `publication-artifacts/${sha256}`;
  const existing = await bucket.head(key);
  if (!existing) {
    await bucket.put(key, content, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256,
      httpMetadata: {
        contentType: key.startsWith("publication-text/") ? "text/plain; charset=utf-8" : "application/json",
        cacheControl: "private, max-age=31536000, immutable",
      },
    });
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
  const digest = new crypto.DigestStream("SHA-256");
  let received = 0;
  await object.body
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > bytes) throw new PublicationIntegrityError("publication_artifact_corrupt");
          controller.enqueue(chunk);
        },
      }),
    )
    .pipeTo(digest);
  const actual = Array.from(new Uint8Array(await digest.digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (received !== bytes || actual !== sha) throw new PublicationIntegrityError("publication_artifact_corrupt");
}
