import { createHash } from "node:crypto";
import { canonicalJson } from "../shared";
import type { CompositionVerificationQuery } from "./composition-verification-repository";

type ParentContextQuery = (
  query: Extract<CompositionVerificationQuery, { kind: "composition-parent-context-artifacts" }>,
) => Promise<Record<string, unknown>[]>;

export type ParentContextEvidence = {
  contract: "card-keepr-composition-parent-context-evidence@1";
  objects: number;
  bytes: number;
  sha256: string;
};
type ParentArtifact = { object_key: string; sha256: string; byte_length: number };

async function* parentArtifacts(query: ParentContextQuery) {
  let after = "";
  for (;;) {
    const page = await query({ kind: "composition-parent-context-artifacts", after });
    if (!page.length) return;
    if (page.length > 64) throw new Error("Parent evidence artifact page exceeds its row bound.");
    for (const row of page) {
      if (row.consistent !== 1) throw new Error("Parent evidence physical object receipts conflict.");
      if (
        typeof row.object_key !== "string" ||
        row.object_key <= after ||
        row.object_key.length > 2048 ||
        typeof row.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(row.sha256) ||
        typeof row.byte_length !== "number" ||
        !Number.isSafeInteger(row.byte_length) ||
        row.byte_length < 0
      )
        throw new Error("Parent evidence artifact receipt is invalid.");
      after = row.object_key;
      yield { object_key: row.object_key, sha256: row.sha256, byte_length: row.byte_length } satisfies ParentArtifact;
    }
  }
}

async function parentEvidence(query: ParentContextQuery, bucket?: R2Bucket): Promise<ParentContextEvidence> {
  const hash = createHash("sha256");
  let objects = 0,
    bytes = 0;
  for await (const row of parentArtifacts(query)) {
    if (bucket) {
      const object = await bucket.get(row.object_key);
      if (!object || object.size !== row.byte_length)
        throw new Error("Required parent evidence is missing or truncated.");
      const reader = object.body.getReader(),
        bodyHash = createHash("sha256");
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > row.byte_length) throw new Error("Required parent evidence length changed.");
          bodyHash.update(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (length !== row.byte_length || bodyHash.digest("hex") !== row.sha256)
        throw new Error("Required parent evidence failed digest verification.");
    }
    hash.update(canonicalJson(row) + "\n");
    objects++;
    bytes += row.byte_length;
    if (!Number.isSafeInteger(bytes)) throw new Error("Parent evidence total byte count is invalid.");
  }
  return { contract: "card-keepr-composition-parent-context-evidence@1", objects, bytes, sha256: hash.digest("hex") };
}

export const captureParentContextArtifacts = (query: ParentContextQuery) => parentEvidence(query);

/** The query addresses the fenced source database or the actual restored SQL database. */
export async function verifyParentContextArtifacts(
  query: ParentContextQuery,
  bucket: R2Bucket | undefined,
  expected: ParentContextEvidence | undefined,
) {
  if (!expected) return;
  if (!bucket && expected.objects > 0) throw new Error("Source evidence storage is required to verify parent context.");
  if (canonicalJson(await parentEvidence(query, bucket)) !== canonicalJson(expected))
    throw new Error("Restored parent evidence closure changed.");
}
