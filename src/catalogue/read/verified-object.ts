/** Verify exact immutable content before conditionals or ranges. R2's stored
 * SHA-256 permits metadata-only HEAD; older objects are verified by streaming. */
export async function verifiedObject(bucket: R2Bucket, key: string, size: number, sha256: string) {
  const metadata = await bucket.head(key);
  if (!metadata || metadata.size !== size) return null;
  const checksum = metadata.checksums.toJSON().sha256;
  if (checksum !== undefined) return checksum === sha256 ? metadata : null;
  const object = await bucket.get(key, { onlyIf: { etagMatches: metadata.etag } });
  if (!object || !("body" in object) || object.size !== size || object.etag !== metadata.etag) return null;
  const digest = new crypto.DigestStream("SHA-256");
  let received = 0;
  await object.body
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > size) throw new Error("The immutable content exceeds its declared byte length.");
          controller.enqueue(chunk);
        },
      }),
    )
    .pipeTo(digest);
  const actual = [...new Uint8Array(await digest.digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return received === size && actual === sha256 ? metadata : null;
}

export async function verifiedObjectBody(bucket: R2Bucket, metadata: R2Object, range: R2Range | null) {
  const object = await bucket.get(metadata.key, {
    onlyIf: { etagMatches: metadata.etag },
    ...(range ? { range } : {}),
  });
  return object && "body" in object && object.etag === metadata.etag && object.size === metadata.size
    ? object.body
    : null;
}
