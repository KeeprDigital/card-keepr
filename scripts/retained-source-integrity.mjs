import { createHash } from "node:crypto";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateGolden(golden) {
  const url = new URL(golden.source_url);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Capture URL must be public HTTPS without credentials.");
  if (![golden.body_sha256, golden.full_body_sha256].every((value) => /^[a-f0-9]{64}$/u.test(value)))
    throw new Error("Capture digests must be SHA-256 hex.");
  if (
    ![golden.range_start, golden.range_end_exclusive, golden.full_body_size].every(Number.isSafeInteger) ||
    golden.range_start < 0 ||
    golden.range_end_exclusive < golden.range_start ||
    golden.range_end_exclusive > golden.full_body_size
  )
    throw new Error("Invalid retained range.");
  const bytes = Buffer.from(golden.body_base64, "base64");
  if (bytes.length !== golden.range_end_exclusive - golden.range_start || sha256(bytes) !== golden.body_sha256)
    throw new Error("Retained bytes do not match their range and digest.");
  if (
    golden.range_start === 0 &&
    golden.range_end_exclusive === golden.full_body_size &&
    sha256(bytes) !== golden.full_body_sha256
  )
    throw new Error("Full retained response digest does not match.");
}
