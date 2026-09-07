import { type CatalogueStore, sha256Text, StreamingSha256 } from "../shared";
import { publishedCompositionStatement } from "../shared";

type Reference = { object_key: string; sha256: string; byte_length: number };
/** Follow the private verified roots. Consumer exports deliberately omit evidence. */
export async function verifyCompositionArtifacts(
  db: CatalogueStore,
  bucket: R2Bucket,
  images: R2Bucket,
  revisionId: string,
) {
  const members = (
    await publishedCompositionStatement(db, revisionId).all<{
      candidate_id: string;
      preparation_id: string;
      manifest_digest: string;
      supported_game: string;
      root_digest: string;
    }>()
  ).results;
  if (!members.length) throw new Error("Published composition roots are unavailable.");
  for (const member of members) {
    const key = `publication-artifacts/${member.root_digest}`;
    const object = await bucket.get(key);
    if (!object || object.size > 524288) throw new Error("Publication root is unavailable or oversized.");
    const content = await object.text();
    if ((await sha256Text(content)) !== member.root_digest) throw new Error("Publication root digest mismatch.");
    const root = JSON.parse(content);
    if (
      root.contract !== "card-keepr-game-publication-artifacts@1" ||
      root.candidate_id !== member.candidate_id ||
      root.preparation_id !== member.preparation_id ||
      root.manifest_digest !== member.manifest_digest ||
      root.supported_game !== member.supported_game
    )
      throw new Error("Publication root identity mismatch.");
    await verifyReference(bucket, images, root.artifacts, 0);
  }
}
async function verifyReference(
  bucket: R2Bucket,
  images: R2Bucket,
  reference: Reference,
  depth: number,
  nodeLevel?: number | null,
): Promise<void> {
  if (
    depth > 32 ||
    typeof reference?.object_key !== "string" ||
    !/^[a-f0-9]{64}$/.test(reference.sha256) ||
    !Number.isSafeInteger(reference.byte_length) ||
    reference.byte_length < 0 ||
    reference.byte_length > 20 * 1024 * 1024
  )
    throw new Error("Invalid publication artifact reference.");
  const object = await (reference.object_key.startsWith("printing-images/") ? images : bucket).get(
    reference.object_key,
  );
  if (!object || object.size !== reference.byte_length) throw new Error("Publication artifact missing or truncated.");
  const metadata = reference.object_key.startsWith("publication-artifacts/");
  if (metadata && object.size > 524288) throw new Error("Publication metadata capacity exceeded.");
  if (metadata) {
    const content = await object.text();
    if ((await sha256Text(content)) !== reference.sha256) throw new Error("Publication artifact digest mismatch.");
    const value = JSON.parse(content);
    if (value.contract === "card-keepr-publication-composition-node@1") {
      if (
        nodeLevel === null ||
        (nodeLevel !== undefined && nodeLevel !== value.level) ||
        !Number.isSafeInteger(value.level) ||
        value.level < 0 ||
        value.level > 32 ||
        !Array.isArray(value.children) ||
        value.children.length > 32 ||
        object.size > 16384
      )
        throw new Error("Invalid bounded publication composition node.");
      for (const child of value.children)
        await verifyReference(bucket, images, child, depth + 1, value.level === 0 ? null : value.level - 1);
    } else if (
      (nodeLevel !== null && nodeLevel !== undefined) ||
      !["card-keepr-game-export-record@1", "card-keepr-game-query-batch@1", "card-keepr-game-search-chunk@1"].includes(
        value.contract,
      )
    )
      throw new Error("Invalid publication artifact contract.");
  } else {
    if (nodeLevel !== undefined && nodeLevel !== null) throw new Error("Expected a publication composition node.");
    const digest = new StreamingSha256();
    const reader = object.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      digest.update(value);
    }
    if (digest.digestHex() !== reference.sha256) throw new Error("Publication artifact digest mismatch.");
  }
}
