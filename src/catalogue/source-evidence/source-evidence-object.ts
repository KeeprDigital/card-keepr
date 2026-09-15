export async function putImmutableEvidenceBytes(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  digest: string,
  writeToken: string,
  registerWriter: () => Promise<void>,
  contentType = "application/json",
): Promise<string | undefined> {
  const existing = await bucket.head(key);
  if (existing !== null) {
    assertMatchingObject(existing, bytes, digest);
    return existing.customMetadata?.cleanup_writer_token;
  }
  await registerWriter();
  const stored = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType,
      cacheControl: "private, max-age=31536000, immutable",
    },
    customMetadata: { sha256: digest, cleanup_writer_token: writeToken },
  });
  if (stored !== null) return writeToken;
  const concurrent = await bucket.head(key);
  if (concurrent === null) throw new Error("Immutable evidence write conflict");
  assertMatchingObject(concurrent, bytes, digest);
  return concurrent.customMetadata?.cleanup_writer_token;
}

function assertMatchingObject(object: R2Object, bytes: Uint8Array, digest: string): void {
  if (object.size !== bytes.byteLength || object.customMetadata?.sha256 !== digest) {
    throw new Error("Immutable evidence object key collision");
  }
}
