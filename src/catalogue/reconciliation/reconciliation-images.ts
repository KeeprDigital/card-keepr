import { type CataloguePrintingImage, sha256 } from "../shared";

type Image = Omit<CataloguePrintingImage, "id" | "printing_id" | "object_key">;

/** Verify and retain one image at a time; candidates carry only immutable references. */
export async function retainCandidateImage(bucket: R2Bucket, image: Image): Promise<Image> {
  const { content_base64: encoded, ...metadata } = image;
  if (encoded === undefined) throw new Error("Captured Printing Image bytes are unavailable.");
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  if (bytes.byteLength !== image.content_byte_length || (await sha256(bytes)) !== image.content_sha256) {
    throw new Error("Captured Printing Image bytes failed verification.");
  }
  const key = `printing-images/${image.content_sha256}`;
  await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: image.content_sha256,
    httpMetadata: { contentType: image.media_type, cacheControl: "private, max-age=31536000, immutable" },
    customMetadata: { sha256: image.content_sha256 },
  });
  const stored = await bucket.get(key);
  if (stored === null || stored.size !== image.content_byte_length)
    throw new Error("Retained Printing Image bytes are unavailable.");
  const digest = new crypto.DigestStream("SHA-256");
  await stored.body.pipeTo(digest);
  const actual = Array.from(new Uint8Array(await digest.digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== image.content_sha256) throw new Error("Immutable Printing Image object key collision.");
  return metadata;
}
