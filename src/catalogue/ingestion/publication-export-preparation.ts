import {
  type CatalogueStore,
  AdministrationProblem,
  canonicalJson,
  deterministicGzip,
  sha256,
  sha256Text,
} from "../shared";
import {
  composedPublicRecord,
  publicationExportSourceStatement,
  publicationExportDependenciesStatement,
  type DocumentRow,
} from "../read";
import { verifyExportRecord } from "../export";
import * as repository from "./publication-export-repository";
import type { PublicExportState } from "./publication-export-repository";

type Environment = { CATALOGUE_DB: CatalogueStore; CATALOGUE_EXPORTS: R2Bucket };
type Cursor = { phase: "records" | "nodes"; after: number; level: number; node: number };
type Reference = { object_key: string; sha256: string; byte_length: number };
type Source = DocumentRow & { kind: string; ordinal: number; supported_game: string; entity_id: string };
type Owner = {
  id: string;
  candidate_id: string;
  generation: number;
  state: string;
  deadline: string;
  manifest_digest: string;
  expected_game_revision_id: string;
  current_game_revision: string;
  supported_game: string;
  private_state: string;
  private_root_digest: string;
  search_state: string;
  recovery_health: string;
};
class InvalidPublicExport extends Error {}
const schemas: Record<string, string> = {
  supported_games: "SupportedGameRecord",
  game_profiles: "GameProfileRecord",
  cards: "CardRecord",
  printings: "PrintingRecord",
  printing_images: "PrintingImageRecord",
  products: "ProductRecord",
  releases: "ReleaseRecord",
  distribution_contexts: "DistributionContextRecord",
  errata: "ErratumRecord",
  relationships: "RelationshipRecord",
  product_relationships: "RelationshipRecord",
  identity_corrections: "IdentityCorrectionRecord",
};

async function verify(bucket: R2Bucket, ref: Reference) {
  if (!Number.isSafeInteger(ref.byte_length) || ref.byte_length < 0 || ref.byte_length > 4_000_000)
    throw new InvalidPublicExport("public_export_capacity_exceeded");
  const object = await bucket.get(ref.object_key);
  if (!object || object.size !== ref.byte_length) throw new InvalidPublicExport("public_export_artifact_missing");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256(bytes)) !== ref.sha256) throw new InvalidPublicExport("public_export_artifact_corrupt");
}
async function retain(bucket: R2Bucket, bytes: Uint8Array, metadata = false): Promise<Reference> {
  const digest = await sha256(bytes),
    key = metadata ? `publication-artifacts/${digest}` : `catalogue-public-components/${digest}.ndjson.gz`;
  await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: metadata ? "application/json" : "application/gzip" },
  });
  const ref = { object_key: key, sha256: digest, byte_length: bytes.byteLength };
  await verify(bucket, ref);
  return ref;
}
function result(state: PublicExportState) {
  return { contract: "card-keepr-public-export-preparation@5", ...state, cursor: JSON.parse(state.cursor_json) };
}

/** One durable unit renders at most one bounded public record, or seals 32 references. */
export async function advancePublicationExports(env: Environment, id: string, generation: number, key: string) {
  const db = env.CATALOGUE_DB,
    request = canonicalJson({ id, generation, key });
  const replay = await repository.exportReplay(db, key).first<{ request_json: string; result_json: string }>();
  if (replay) {
    if (replay.request_json !== request)
      throw new AdministrationProblem(409, "idempotency_conflict", "This key belongs to another public export unit.");
    return JSON.parse(replay.result_json) as { state: string; sequence?: number };
  }
  const owner = await repository.exportOwner(db, id).first<Owner>();
  if (!owner)
    throw new AdministrationProblem(404, "publication_not_found", "The publication operation does not exist.");
  if (owner.generation !== generation)
    throw new AdministrationProblem(409, "publication_writer_conflict", "Use the current publication generation.");
  if (["published", "failed"].includes(owner.state)) return { state: "complete" };
  if (owner.deadline <= new Date().toISOString() || owner.current_game_revision !== owner.expected_game_revision_id)
    return { state: "invalid" };
  if (owner.private_state !== "verified") return { state: "waiting_private" };
  if (owner.recovery_health !== "healthy" || owner.search_state !== "ready") return { state: "waiting_recovery" };
  const current = await repository.exportPreparation(db, id).first<PublicExportState>();
  if (current && current.state !== "preparing") return result(current);
  const state: PublicExportState = current
    ? { ...current }
    : {
        publication_operation_id: id,
        candidate_id: owner.candidate_id,
        revision_id: `catrev_${id.slice("publication_".length)}`,
        state: "preparing",
        sequence: 0,
        cursor_json: canonicalJson({ phase: "records", after: -1, level: 0, node: 0 }),
        component_count: 0,
        root_digest: null,
        root_object_key: null,
        root_bytes: null,
        failure_code: null,
      };
  const original = { ...state };
  const cursor = JSON.parse(state.cursor_json) as Cursor;
  const statements: D1PreparedStatement[] = [];
  try {
    await prepareUnit(env, owner, state, cursor, statements);
    state.cursor_json = canonicalJson(cursor);
  } catch (error) {
    if (!(error instanceof InvalidPublicExport)) throw error;
    statements.length = 0;
    Object.assign(state, original);
    state.state = "failed";
    state.failure_code = error.message;
  }
  state.sequence++;
  const output = result(state);
  await db.batch([
    repository.guardExportUnit(db, id, generation, original.sequence),
    ...statements,
    current ? repository.updateExportPreparation(db, state) : repository.createExportPreparation(db, state),
    repository.retainExportReplay(db, id, key, request, canonicalJson(output)),
  ]);
  return output;
}
async function prepareUnit(
  env: Environment,
  owner: Owner,
  state: PublicExportState,
  cursor: Cursor,
  statements: D1PreparedStatement[],
) {
  const db = env.CATALOGUE_DB,
    bucket = env.CATALOGUE_EXPORTS;
  if (cursor.phase === "records") {
    const source = await publicationExportSourceStatement(
      db,
      state.candidate_id,
      state.revision_id,
      cursor.after,
    ).first<Source>();
    if (!source) {
      cursor.phase = "nodes";
      cursor.after = -1;
      return;
    }
    if ((await sha256Text(source.content)) !== source.sha256)
      throw new InvalidPublicExport("public_export_projection_corrupt");
    const dependencies =
      source.kind === "printings"
        ? (
            await publicationExportDependenciesStatement(db, source.candidate_id, source.entity_id).all<{
              text_calls: number;
              relationship_digest: string;
              target_digest: string;
              entity_id: string;
              target_id: string;
            }>()
          ).results
        : [];
    const envelope = JSON.parse(source.content).records[0] as { text_parts: { chunks: number }[] };
    const calls =
      18 +
      envelope.text_parts.reduce((n, p) => n + p.chunks, 0) +
      Math.ceil(dependencies.length / 32) +
      dependencies.length +
      dependencies.reduce((n, d) => n + d.text_calls, 0);
    if (dependencies.length > 128 || calls > 80) throw new InvalidPublicExport("public_export_capacity_exceeded");
    const input = await sha256Text(
      canonicalJson({
        contract: "card-keepr-public-record@5",
        projection: source.sha256,
        lifecycle: source.lifecycle_json,
        dependencies,
      }),
    );
    const prior = await repository
      .priorExportComponent(
        db,
        owner.expected_game_revision_id,
        owner.supported_game,
        source.kind,
        source.entity_id,
        input,
      )
      .first<Reference & { descriptor_json: string }>();
    let ref: Reference, descriptor: Record<string, unknown>;
    if (prior) {
      ref = prior;
      await verify(bucket, ref);
      descriptor = JSON.parse(prior.descriptor_json);
    } else {
      let value: unknown;
      try {
        value = await composedPublicRecord(
          db,
          { candidateId: state.candidate_id, revisionId: state.revision_id },
          source.kind,
          source,
        );
        verifyExportRecord(value);
      } catch (error) {
        if (
          error instanceof Error &&
          /exceeds|budget|verification|failed verification|unavailable|invalid/i.test(error.message)
        )
          throw new InvalidPublicExport("public_export_record_invalid");
        throw error;
      }
      const raw = new TextEncoder().encode(`${canonicalJson(value)}\n`);
      if (raw.byteLength > 4_000_000) throw new InvalidPublicExport("public_export_capacity_exceeded");
      ref = await retain(bucket, deterministicGzip(raw));
      descriptor = {
        kind: source.kind === "product_relationships" ? "relationships" : source.kind.replaceAll("_", "-"),
        media_type: "application/x-ndjson",
        compression: "gzip",
        record_schema: `https://card-keepr.invalid/schemas/catalogue-export-record@5#/$defs/${schemas[source.kind]}`,
        records: 1,
        uncompressed_bytes: raw.byteLength,
        content_sha256: await sha256(raw),
        compressed_bytes: ref.byte_length,
        compressed_sha256: ref.sha256,
      };
    }
    descriptor.name = `${source.supported_game}.${source.ordinal}`;
    statements.push(
      repository.retainExportComponent(
        db,
        state.candidate_id,
        source.ordinal,
        source.kind,
        source.entity_id,
        input,
        ref,
        canonicalJson(descriptor),
      ),
    );
    cursor.after = source.ordinal;
    state.component_count++;
    return;
  }
  const refs = (
    await (cursor.level === 0
      ? repository.exportComponents(db, state.candidate_id, cursor.after)
      : repository.exportNodes(db, owner.id, cursor.level - 1, cursor.after)
    ).all<Reference & { ordinal: number; descriptor_json?: string }>()
  ).results;
  if (refs.length) {
    const content = canonicalJson({
      contract: "card-keepr-publication-composition-node@1",
      level: cursor.level,
      children: refs.map(({ ordinal: _, descriptor_json, ...ref }) => ({
        ...ref,
        ...(descriptor_json ? { descriptor: JSON.parse(descriptor_json) } : {}),
      })),
    });
    if (new TextEncoder().encode(content).byteLength > 16384)
      throw new InvalidPublicExport("public_export_capacity_exceeded");
    const ref = await retain(bucket, new TextEncoder().encode(content), true);
    statements.push(repository.retainExportNode(db, owner.id, cursor.level, cursor.node++, ref));
    cursor.after = refs.at(-1)!.ordinal;
    return;
  }
  if (cursor.node !== 1) {
    if (cursor.node === 0) throw new InvalidPublicExport("public_export_empty");
    cursor.level++;
    cursor.after = -1;
    cursor.node = 0;
    return;
  }
  const root = (await repository.exportNodes(db, owner.id, cursor.level, -1).all<Reference & { ordinal: number }>())
    .results[0]!;
  await verify(bucket, root);
  const sealed = await retain(
    bucket,
    new TextEncoder().encode(
      canonicalJson({
        contract: "card-keepr-game-public-export-artifacts@5",
        publication_operation_id: owner.id,
        candidate_id: state.candidate_id,
        catalogue_revision_id: state.revision_id,
        manifest_digest: owner.manifest_digest,
        private_root_digest: owner.private_root_digest,
        deadline: owner.deadline,
        component_count: state.component_count,
        artifacts: { object_key: root.object_key, sha256: root.sha256, byte_length: root.byte_length },
      }),
    ),
    true,
  );
  state.state = "verified";
  state.root_digest = sealed.sha256;
  state.root_object_key = sealed.object_key;
  state.root_bytes = sealed.byte_length;
}
