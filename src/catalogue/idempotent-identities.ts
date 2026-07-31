import { sha256 } from "./serialization";

const encoder = new TextEncoder();

/**
 * Stable opaque identity for the single operation owned by an evidence
 * idempotency key. The ID does not embed the caller-provided key.
 */
export async function evidenceRunIdentity(
  idempotencyKey: string,
): Promise<string> {
  return `run_${await framedDigest(
    "card-keepr-evidence-run-identity@1",
    ["idempotency_key", idempotencyKey],
  )}`;
}

/** Stable identity for one digest-bound Catalogue publication attempt. */
export async function catalogueRevisionIdentity(input: {
  runId: string;
  candidateDigest: string;
  expectedCurrentRevisionId: string;
}): Promise<string> {
  return `catrev_${await framedDigest(
    "card-keepr-catalogue-revision-identity@1",
    [
      "run_id",
      input.runId,
      "candidate_digest",
      input.candidateDigest,
      "expected_current_revision_id",
      input.expectedCurrentRevisionId,
    ],
  )}`;
}

async function framedDigest(
  domain: string,
  fields: readonly string[],
): Promise<string> {
  const chunks = [domain, ...fields].map((value) => encoder.encode(value));
  const bytes = new Uint8Array(
    chunks.reduce((length, chunk) => length + 4 + chunk.byteLength, 0),
  );
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.byteLength, false);
    offset += 4;
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return sha256(bytes);
}
