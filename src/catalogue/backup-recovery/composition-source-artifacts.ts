import { createHash } from "node:crypto";
import { canonicalJson } from "../shared";
import type { CompositionQuery } from "./composition-verification-repository";

export type CompositionSourceEvidence = {
  contract: "card-keepr-composition-source-evidence@1";
  objects: number;
  bytes: number;
  sha256: string;
};
type SourceArtifact = {
  object_key: string;
  sha256: string;
  byte_length: number;
  kind: "raw" | "observations" | "derived";
};

async function* sourceArtifacts(query: CompositionQuery) {
  let after = "";
  for (;;) {
    const page = await query({ kind: "composition-source-artifacts", after });
    if (!page.length) break;
    if (page.length > 64) throw new Error("Source evidence artifact page exceeds its row bound.");
    for (const row of page) {
      if (
        typeof row.object_key !== "string" ||
        row.object_key <= after ||
        row.object_key.length > 2048 ||
        typeof row.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(row.sha256) ||
        typeof row.byte_length !== "number" ||
        !Number.isSafeInteger(row.byte_length) ||
        row.byte_length < 0 ||
        row.byte_length > 96 * 1024 * 1024 ||
        !["raw", "observations", "derived"].includes(String(row.kind))
      )
        throw new Error("Source evidence artifact receipt is invalid.");
      after = row.object_key;
      yield row as SourceArtifact;
    }
  }
}

export async function captureCompositionSourceArtifacts(query: CompositionQuery): Promise<CompositionSourceEvidence> {
  const hash = createHash("sha256");
  let objects = 0,
    bytes = 0;
  for await (const row of sourceArtifacts(query)) {
    hash.update(canonicalJson(row) + "\n");
    objects++;
    bytes += row.byte_length;
    if (!Number.isSafeInteger(bytes)) throw new Error("Source evidence total byte count is invalid.");
  }
  return { contract: "card-keepr-composition-source-evidence@1", objects, bytes, sha256: hash.digest("hex") };
}

/** The query must address the fenced snapshot or actual restored database. */
export async function verifyCompositionSourceArtifacts(
  query: CompositionQuery,
  bucket: R2Bucket | undefined,
  expected: CompositionSourceEvidence | undefined,
) {
  if (!expected) return;
  const hash = createHash("sha256");
  let objects = 0,
    bytes = 0;
  for await (const row of sourceArtifacts(query)) {
    if (!bucket) throw new Error("Source evidence storage is required to verify this backup.");
    const object = await bucket.get(row.object_key);
    if (!object || object.size !== row.byte_length)
      throw new Error("Required source evidence is missing or truncated.");
    const reader = object.body.getReader(),
      bodyHash = createHash("sha256");
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > row.byte_length) throw new Error("Required source evidence length changed.");
        bodyHash.update(next.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (length !== row.byte_length || bodyHash.digest("hex") !== row.sha256)
      throw new Error("Required source evidence failed digest verification.");
    hash.update(canonicalJson(row) + "\n");
    objects++;
    bytes += length;
  }
  const actual: CompositionSourceEvidence = {
    contract: "card-keepr-composition-source-evidence@1",
    objects,
    bytes,
    sha256: hash.digest("hex"),
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("Restored source evidence closure changed.");
}
