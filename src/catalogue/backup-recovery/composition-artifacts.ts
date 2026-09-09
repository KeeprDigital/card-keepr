import type { CompositionSnapshotEvidence } from "./composition-verification";
import { type CatalogueStore, sha256Text, StreamingSha256 } from "../shared";
import {
  compositionArtifactRootsStatement,
  acceptedEvidenceArtifactRootsStatement,
} from "./composition-verification-repository";

type Reference = { object_key: string; sha256: string; byte_length: number };
type PrivateRoot = {
  candidate_id: string;
  preparation_id: string;
  manifest_digest: string;
  supported_game: string;
  root_digest: string;
};
/** Verify private evidence and the exact retained public bytes bound into the composition. */
export async function verifyCompositionArtifacts(
  db: CatalogueStore,
  bucket: R2Bucket,
  images: R2Bucket,
  revisionId: string,
  acceptedSnapshot?: Pick<CompositionSnapshotEvidence, "schema_migration_level" | "accepted_evidence_roots">,
) {
  const members = (
    await compositionArtifactRootsStatement(db, revisionId).all<{
      candidate_id: string;
      preparation_id: string;
      manifest_digest: string;
      supported_game: string;
      root_digest: string;
      game_revision_id: string;
      publication_operation_id: string;
      revision_id: string;
      public_state: string;
      public_root_digest: string;
      root_object_key: string;
      root_bytes: number;
      component_count: number;
      deadline: string;
      composition_digest: string;
      composition_json: string;
    }>()
  ).results;
  if (!members.length) throw new Error("Published composition roots are unavailable.");
  await readRoot(bucket, members[0]!.composition_digest);
  for (const member of members) {
    await verifyPrivateRoot(bucket, images, member);
    if (
      member.public_state !== "verified" ||
      member.revision_id !== member.game_revision_id ||
      member.root_object_key !== `publication-artifacts/${member.public_root_digest}` ||
      !Number.isSafeInteger(member.component_count) ||
      member.component_count < 1 ||
      typeof member.composition_json !== "string" ||
      (await sha256Text(member.composition_json)) !== member.composition_digest
    )
      throw new Error("Public export publication binding mismatch.");
    const composition = JSON.parse(member.composition_json);
    if (
      composition.contract !== "card-keepr-prepared-publication-composition@1" ||
      !Array.isArray(composition.games) ||
      composition.games.length !== members.length ||
      !composition.games.some(
        (game: Record<string, unknown>) =>
          game.candidate_id === member.candidate_id &&
          game.supported_game === member.supported_game &&
          game.root_digest === member.root_digest &&
          game.public_root_digest === member.public_root_digest,
      )
    )
      throw new Error("Public export composition binding mismatch.");
    const publicRoot = await readRoot(bucket, member.public_root_digest, member.root_bytes);
    if (
      publicRoot.contract !== "card-keepr-game-public-export-artifacts@5" ||
      publicRoot.publication_operation_id !== member.publication_operation_id ||
      publicRoot.candidate_id !== member.candidate_id ||
      publicRoot.catalogue_revision_id !== member.revision_id ||
      publicRoot.manifest_digest !== member.manifest_digest ||
      publicRoot.private_root_digest !== member.root_digest ||
      publicRoot.deadline !== member.deadline ||
      publicRoot.component_count !== member.component_count
    )
      throw new Error("Public export root identity mismatch.");
    const components = await verifyReference(bucket, images, publicRoot.artifacts, 0, undefined, true);
    if (components !== member.component_count) throw new Error("Public export component count mismatch.");
  }
  if (acceptedSnapshot && acceptedSnapshot.schema_migration_level < 31) return;
  const accepted = acceptedSnapshot
    ? acceptedSnapshot.accepted_evidence_roots
    : (await acceptedEvidenceArtifactRootsStatement(db).all<PrivateRoot>()).results;
  if (!Array.isArray(accepted)) throw new Error("Accepted private evidence snapshot is missing.");
  if (
    accepted.length !== members.length ||
    accepted.some((candidate) => !members.some((member) => member.supported_game === candidate.supported_game))
  )
    throw new Error("Accepted evidence composition membership mismatch.");
  for (const candidate of accepted) {
    if (!members.some((member) => member.candidate_id === candidate.candidate_id))
      await verifyPrivateRoot(bucket, images, candidate);
  }
}

async function verifyPrivateRoot(bucket: R2Bucket, images: R2Bucket, member: PrivateRoot) {
  const root = await readRoot(bucket, member.root_digest);
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
async function readRoot(bucket: R2Bucket, digest: string, byteLength?: number) {
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid publication root digest.");
  const object = await bucket.get(`publication-artifacts/${digest}`);
  if (!object || object.size > 524288 || (byteLength !== undefined && object.size !== byteLength))
    throw new Error("Publication root is unavailable or oversized.");
  const content = await object.text();
  if ((await sha256Text(content)) !== digest) throw new Error("Publication root digest mismatch.");
  return JSON.parse(content);
}
async function verifyReference(
  bucket: R2Bucket,
  images: R2Bucket,
  reference: Reference,
  depth: number,
  nodeLevel?: number | null,
  publicExport = false,
): Promise<number> {
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
      let leaves = 0;
      for (const child of value.children) {
        if (
          publicExport &&
          value.level === 0 &&
          (child.descriptor?.compressed_sha256 !== child.sha256 ||
            child.descriptor?.compressed_bytes !== child.byte_length ||
            child.descriptor?.records !== 1)
        )
          throw new Error("Public export descriptor mismatch.");
        leaves += await verifyReference(
          bucket,
          images,
          child,
          depth + 1,
          value.level === 0 ? null : value.level - 1,
          publicExport,
        );
      }
      return leaves;
    } else if (
      publicExport ||
      (nodeLevel !== null && nodeLevel !== undefined) ||
      !["card-keepr-game-export-record@1", "card-keepr-game-query-batch@1", "card-keepr-game-search-chunk@1"].includes(
        value.contract,
      )
    )
      throw new Error("Invalid publication artifact contract.");
    return 1;
  } else {
    if (
      publicExport &&
      (reference.object_key !== `catalogue-public-components/${reference.sha256}.ndjson.gz` ||
        reference.byte_length > 4_000_000)
    )
      throw new Error("Invalid public export component reference.");
    if (nodeLevel !== undefined && nodeLevel !== null) throw new Error("Expected a publication composition node.");
    const digest = new StreamingSha256();
    const reader = object.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      digest.update(value);
    }
    if (digest.digestHex() !== reference.sha256) throw new Error("Publication artifact digest mismatch.");
    return 1;
  }
}
