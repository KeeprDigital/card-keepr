import { createHash } from "node:crypto";
import { canonicalJson } from "../shared";
import type { CompositionQuery } from "./composition-verification-repository";

export type ProposalEvidence = {
  contract: "card-keepr-composition-proposal-evidence@1";
  objects: number;
  bytes: number;
  sha256: string;
};

async function proposalEvidence(
  query: CompositionQuery,
  verification?: { bucket: R2Bucket | undefined },
): Promise<ProposalEvidence> {
  const hash = createHash("sha256");
  let after = "",
    objects = 0,
    bytes = 0;
  for (;;) {
    const page = await query({ kind: "composition-proposal-artifacts", after });
    if (!page.length) break;
    if (page.length > 64) throw new Error("Proposal evidence artifact page exceeds its row bound.");
    for (const row of page) {
      if (row.consistent !== 1) throw new Error("Proposal evidence physical object receipts conflict or are missing.");
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
        throw new Error("Proposal evidence artifact receipt is invalid.");
      after = row.object_key;
      if (verification) {
        if (!verification.bucket) throw new Error("Source evidence storage is required to verify proposal evidence.");
        const object = await verification.bucket.get(row.object_key);
        if (!object || object.size !== row.byte_length)
          throw new Error("Required proposal evidence is missing or truncated.");
        const reader = object.body.getReader(),
          bodyHash = createHash("sha256");
        let length = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > row.byte_length) throw new Error("Required proposal evidence length changed.");
            bodyHash.update(chunk.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        if (length !== row.byte_length || bodyHash.digest("hex") !== row.sha256)
          throw new Error("Required proposal evidence failed digest verification.");
      }
      hash.update(
        canonicalJson({
          object_key: row.object_key,
          sha256: row.sha256,
          byte_length: row.byte_length,
          kind: row.kind,
        }) + "\n",
      );
      objects++;
      bytes += row.byte_length;
      if (!Number.isSafeInteger(bytes)) throw new Error("Proposal evidence total byte count is invalid.");
    }
  }
  return { contract: "card-keepr-composition-proposal-evidence@1", objects, bytes, sha256: hash.digest("hex") };
}

export const captureProposalArtifacts = (query: CompositionQuery) => proposalEvidence(query);

/** The query addresses the fenced source or actual restored database, using the original evidence bucket. */
export async function verifyProposalArtifacts(
  query: CompositionQuery,
  bucket: R2Bucket | undefined,
  expected: ProposalEvidence | undefined,
) {
  if (expected === undefined) return;
  if (
    !expected ||
    expected.contract !== "card-keepr-composition-proposal-evidence@1" ||
    !Number.isSafeInteger(expected.objects) ||
    expected.objects < 0 ||
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 0 ||
    typeof expected.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(expected.sha256)
  )
    throw new Error("Proposal evidence receipt is invalid.");
  if (canonicalJson(await proposalEvidence(query, { bucket })) !== canonicalJson(expected))
    throw new Error("Restored proposal evidence closure changed.");
}
