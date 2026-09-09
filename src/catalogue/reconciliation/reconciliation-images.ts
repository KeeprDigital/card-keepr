import { type CataloguePrintingImage, sha256 } from "../shared";
import { printingImageDimensions } from "./printing-image-dimensions";
import type { PrintingImageSnapshotRow } from "./reconciliation-evidence-types";

type Image = Omit<CataloguePrintingImage, "id" | "printing_id" | "object_key">;
export type VerifiedPrintingImage = Pick<
  Image,
  "media_type" | "width" | "height" | "content_sha256" | "content_byte_length"
>;

/** Storage transport failures must reach Workflow retry handling. */
export class CandidateImageStorageError extends Error {
  constructor(cause: unknown) {
    super("Candidate image storage is temporarily unavailable.", { cause });
    this.name = "CandidateImageStorageError";
  }
}

export async function imageStorage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new CandidateImageStorageError(cause);
  }
}

/** Authenticate the retained evidence before its metadata can enter an observation. */
export async function verifiedRetainedPrintingImage(
  evidenceObjects: R2Bucket,
  row: PrintingImageSnapshotRow,
): Promise<VerifiedPrintingImage> {
  if (row.media_type === null || !row.media_type.startsWith("image/"))
    throw new Error("Retained Printing Image media type is invalid.");
  const object = await imageStorage(() => evidenceObjects.get(row.content_object_key));
  if (object === null || object.size !== row.content_byte_length)
    throw new Error("Retained Printing Image bytes are unavailable.");
  const dimensions = printingImageDimensions(row.media_type);
  let byteLength = 0;
  const digest = new crypto.DigestStream("SHA-256");
  await imageStorage(() =>
    object.body
      .pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(bytes, controller) {
            byteLength += bytes.byteLength;
            dimensions.write(bytes);
            controller.enqueue(bytes);
          },
        }),
      )
      .pipeTo(digest),
  );
  if (byteLength !== row.content_byte_length || hexDigest(await digest.digest) !== row.content_digest)
    throw new Error("Retained Printing Image digest is invalid.");
  return {
    media_type: row.media_type as `image/${string}`,
    ...dimensions.read(),
    content_sha256: row.content_digest,
    content_byte_length: row.content_byte_length,
  };
}

/** Verify and retain one image at a time; candidates carry only immutable references. */
export async function retainCandidateImage(
  bucket: R2Bucket,
  image: Image,
  retained?: { bucket: R2Bucket; key: string },
): Promise<Image> {
  const { content_base64: encoded, ...metadata } = image;
  let bytes: Uint8Array | ReadableStream;
  if (retained) {
    const object = await imageStorage(() => retained.bucket.get(retained.key));
    if (object === null || object.size !== image.content_byte_length)
      throw new Error("Retained Printing Image bytes are unavailable.");
    bytes = object.body;
  } else {
    // Historical synthetic observations may explicitly carry inline bytes.
    if (encoded === undefined) throw new Error("Captured Printing Image bytes are unavailable.");
    bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    if (bytes.byteLength !== image.content_byte_length || (await sha256(bytes)) !== image.content_sha256)
      throw new Error("Captured Printing Image bytes failed verification.");
  }
  const key = `printing-images/${image.content_sha256}`;
  await imageStorage(() =>
    bucket.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: image.content_sha256,
      httpMetadata: { contentType: image.media_type, cacheControl: "private, max-age=31536000, immutable" },
      customMetadata: { sha256: image.content_sha256 },
    }),
  );
  const stored = await imageStorage(() => bucket.get(key));
  if (stored === null || stored.size !== image.content_byte_length)
    throw new Error("Retained Printing Image bytes are unavailable.");
  const digest = new crypto.DigestStream("SHA-256");
  await imageStorage(() => stored.body.pipeTo(digest));
  const actual = hexDigest(await digest.digest);
  if (actual !== image.content_sha256) throw new Error("Immutable Printing Image object key collision.");
  return metadata;
}

function hexDigest(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
