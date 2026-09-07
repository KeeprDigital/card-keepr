import { publicExportPreparationStatement } from "./game-publication-repository";
import { publicationRecord, type PublicationEnvelope } from "./publication-record";
import { preparePublicLifecycle } from "./publication-lifecycle";
import { retainPublicLifecycle } from "./publication-lifecycle-repository";
import { logProtectedFailure } from "../../http/protected-failure";
import {
  normalizeCardSearchText,
  maximumNormalizedSearchQueryCodePoints,
  maximumSearchChunkCodePoints,
  searchChunkStride,
} from "../shared";
import {
  AdministrationProblem,
  canonicalJson,
  consumerContent,
  type CatalogueStore,
  sha256Text,
  StreamingSha256,
} from "../shared";
import { assertIdentifier } from "../source-evidence";
import { inspectGameCandidate } from "./game-candidate";
import { gameCandidatePartitionStatement } from "./game-candidate-repository";
import { reconciliationTextStatement } from "./reconciliation-text-repository";
import { retainPublicationObject, verifyPublicationObject } from "./publication-artifact-storage";
import * as repository from "./publication-preparation-repository";
import {
  PublicationIntegrityError,
  type ArtifactReference,
  type PreparationCursor,
  type PreparationState,
  type PublicationPreparationIntent,
} from "./publication-preparation-types";

type Environment = { CATALOGUE_DB: CatalogueStore; PRINTING_IMAGES: R2Bucket; CATALOGUE_EXPORTS: R2Bucket };
type Candidate = Awaited<ReturnType<typeof inspectGameCandidate>>;
type Envelope = PublicationEnvelope;
const catalogueKinds = new Set([
  "selected_games",
  "cards",
  "printings",
  "printing_images",
  "products",
  "releases",
  "distribution_contexts",
  "errata",
  "relationships",
  "product_relationships",
  "identity_corrections",
  "game_profiles",
]);

function document(state: PreparationState, candidate: Candidate) {
  const { cursor_json, ...status } = state;
  return {
    contract: "card-keepr-publication-preparation@1",
    ...status,
    preparation_id: candidate.preparation_id,
    ingestion_run_id: candidate.ingestion_run_id,
    supported_game: candidate.supported_game,
    expected_game_revision_id: candidate.expected_game_revision_id,
    deadline: candidate.deadline,
    progress: JSON.parse(cursor_json) as PreparationCursor,
  };
}
export async function inspectPublicationPreparation(db: CatalogueStore, id: string) {
  const candidate = await inspectGameCandidate(db, id);
  const row = await repository.publicationPreparationStatement(db, id).first<PreparationState>();
  if (!row)
    throw new AdministrationProblem(
      404,
      "publication_preparation_not_found",
      "Prepare this sealed candidate's publication artifacts first.",
    );
  return document(row, candidate);
}
export async function inspectPublicationArtifacts(db: CatalogueStore, id: string, after: string | null) {
  const ordinal = after === null ? -1 : Number(after);
  if (!Number.isSafeInteger(ordinal) || ordinal < -1)
    throw new AdministrationProblem(422, "invalid_cursor", "Use the returned artifact cursor.");
  const status = await inspectPublicationPreparation(db, id);
  const artifacts = (await repository.publicationArtifacts(db, id, ordinal).all<ArtifactReference>()).results;
  return {
    contract: "card-keepr-publication-artifacts@1",
    candidate_id: id,
    manifest_digest: status.manifest_digest,
    artifacts,
    next_cursor: artifacts.length === 32 ? String(artifacts.at(-1)!.ordinal) : null,
  };
}

/** One request performs one bounded unit. Cursor, output receipts and response commit together. */
export async function advancePublicationPreparation(
  env: Environment,
  id: string,
  input: PublicationPreparationIntent,
  at: string,
) {
  const db = env.CATALOGUE_DB;
  assertIdentifier(input.idempotency_key, "idempotency_key");
  if (
    !/^[a-f0-9]{64}$/.test(input.manifest_digest) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 0 ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0
  )
    throw new AdministrationProblem(
      422,
      "invalid_publication_preparation_intent",
      "Use the candidate manifest, generation and current preparation sequence.",
    );
  const request = canonicalJson({ candidate_id: id, ...input });
  const replay = await repository
    .publicationPreparationActionStatement(db, input.idempotency_key)
    .first<{ request_json: string; result_json: string }>();
  if (replay) return replayResult(replay, request);
  const candidate = await inspectGameCandidate(db, id);
  const current = await repository.publicationPreparationStatement(db, id).first<PreparationState>();
  try {
    await repository
      .publicationPreparationGuard(db, id, input.manifest_digest, input.generation, at, input.sequence)
      .first();
    if (current && current.state !== "preparing" && !(current.state === "retry_paused" && input.resume))
      throw new AdministrationProblem(
        409,
        "publication_preparation_not_active",
        "Inspect retained status; only a retry pause can resume.",
      );
    if (input.resume && current?.state !== "retry_paused")
      throw new AdministrationProblem(
        409,
        "publication_preparation_not_paused",
        "Only an exhausted transient retry can resume.",
      );
    const initial = await initialCursor(db, candidate);
    const state: PreparationState = current
      ? { ...current }
      : {
          candidate_id: id,
          manifest_digest: input.manifest_digest,
          generation: input.generation,
          sequence: 0,
          state: "preparing",
          phase: "images",
          cursor_json: canonicalJson(initial),
          failures: 0,
          failure_code: null,
          artifact_count: 0,
          root_digest: null,
          created_at: at,
        };
    const statements: D1PreparedStatement[] = [];
    if (!current) statements.push(repository.createPublicationPreparation(db, state));
    else if (input.resume) {
      state.state = "preparing";
      state.failures = 0;
      state.failure_code = null;
    } else {
      try {
        const cursor = JSON.parse(state.cursor_json) as PreparationCursor;
        await prepareUnit(env, candidate, state, cursor, statements);
        state.cursor_json = canonicalJson(cursor);
        state.failures = 0;
        state.failure_code = null;
      } catch (error) {
        statements.length = 0;
        // No output receipt or cursor from a partially staged unit is committed.
        Object.assign(state, current);
        if (error instanceof PublicationIntegrityError) {
          state.state = "failed";
          state.failure_code = error.code;
        } else {
          await logProtectedFailure("ingestion", `publication-${id}-${state.sequence}`, error);
          state.failures++;
          state.failure_code = "publication_storage_retry";
          if (state.failures >= 3) {
            state.state = "retry_paused";
            state.failure_code = "publication_retry_exhausted";
          }
        }
      }
    }
    state.sequence++;
    const result = document(state, candidate);
    await db.batch([
      repository.publicationPreparationGuard(
        db,
        id,
        input.manifest_digest,
        input.generation,
        new Date().toISOString(),
        input.sequence,
      ),
      ...statements,
      repository.updatePublicationPreparation(db, state),
      repository.retainPublicationAction(db, id, input.idempotency_key, request, canonicalJson(result)),
    ]);
    return result;
  } catch (error) {
    const winner = await repository
      .publicationPreparationActionStatement(db, input.idempotency_key)
      .first<{ request_json: string; result_json: string }>();
    if (winner) return replayResult(winner, request);
    if (error instanceof Error)
      for (const code of [
        "publication_ownership_conflict",
        "publication_deadline_expired",
        "publication_sequence_conflict",
        "game_revision_mismatch",
        "recovery_not_verified",
      ])
        if (error.message.includes(code))
          throw new AdministrationProblem(
            409,
            code,
            "The candidate's original manifest, predecessor, deadline and owned generation must remain current.",
          );
    throw error;
  }
}
function replayResult(row: { request_json: string; result_json: string }, request: string) {
  if (row.request_json !== request)
    throw new AdministrationProblem(
      409,
      "idempotency_conflict",
      "This key binds a different publication preparation request.",
    );
  return JSON.parse(row.result_json) as Record<string, unknown>;
}
async function initialCursor(db: CatalogueStore, c: Candidate): Promise<PreparationCursor> {
  const operation = await repository
    .publicationManifestPrefix(db, c.id)
    .first<{ preparation_manifest_digest: string }>();
  return {
    partition: 0,
    record: 0,
    text: 0,
    chunk: 0,
    level: 0,
    after: -1,
    node: 0,
    chain: await sha256Text(
      canonicalJson({
        contract: "card-keepr-game-candidate-manifest@1",
        candidate_id: c.id,
        ingestion_run_id: c.preparation_id,
        supported_game: c.supported_game,
        expected_game_revision_id: c.expected_game_revision_id,
        created_at: c.created_at,
        deadline: c.deadline,
        preparation_manifest: operation?.preparation_manifest_digest,
      }),
    ),
  };
}
async function prepareUnit(
  env: Environment,
  candidate: Candidate,
  state: PreparationState,
  cursor: PreparationCursor,
  statements: D1PreparedStatement[],
) {
  const db = env.CATALOGUE_DB,
    id = candidate.id;
  const artifact = (
    kind: string,
    ref: { object_key: string; sha256: string; byte_length: number; reused: boolean },
  ) => {
    statements.push(
      repository.retainPublicationArtifact(
        db,
        id,
        state.artifact_count++,
        kind,
        ref.object_key,
        ref.sha256,
        ref.byte_length,
        ref.reused,
      ),
    );
  };
  if (state.phase === "composition") {
    const refs = (
      await (cursor.level === 0
        ? repository.publicationArtifacts(db, id, cursor.after)
        : repository.publicationNodes(db, id, cursor.level - 1, cursor.after)
      ).all<ArtifactReference>()
    ).results;
    if (!refs.length) {
      if (cursor.level === 0 && cursor.node === 0) {
        const empty = await retainPublicationObject(
          env.CATALOGUE_EXPORTS,
          canonicalJson({ contract: "card-keepr-publication-composition-node@1", level: 0, children: [] }),
        );
        statements.push(
          repository.retainPublicationNode(db, id, 0, 0, empty.object_key, empty.sha256, empty.byte_length),
        );
        cursor.node = 1;
        return;
      }
      if (cursor.node === 1) {
        const root = (await repository.publicationNodes(db, id, cursor.level, -1).all<ArtifactReference>()).results[0]!;
        const sealed = await retainPublicationObject(
          env.CATALOGUE_EXPORTS,
          canonicalJson({
            contract: "card-keepr-game-publication-artifacts@1",
            candidate_id: id,
            preparation_id: candidate.preparation_id,
            manifest_digest: state.manifest_digest,
            expected_game_revision_id: candidate.expected_game_revision_id,
            supported_game: candidate.supported_game,
            deadline: candidate.deadline,
            artifacts: root,
          }),
        );
        state.root_digest = sealed.sha256;
        state.state = "verified";
      } else {
        cursor.level++;
        cursor.after = -1;
        cursor.node = 0;
      }
      return;
    }
    const ref = await retainPublicationObject(
      env.CATALOGUE_EXPORTS,
      canonicalJson({
        contract: "card-keepr-publication-composition-node@1",
        level: cursor.level,
        children: refs.map(({ ordinal: _, ...reference }) => {
          const { reused: __, ...immutable } = reference as ArtifactReference & { reused?: number };
          return immutable;
        }),
      }),
    );
    if (ref.byte_length > 16384) throw new PublicationIntegrityError("publication_capacity_exceeded");
    statements.push(
      repository.retainPublicationNode(
        db,
        id,
        cursor.level,
        cursor.node++,
        ref.object_key,
        ref.sha256,
        ref.byte_length,
      ),
    );
    cursor.after = refs.at(-1)!.ordinal;
    return;
  }
  if (cursor.partition === candidate.partition_count) {
    if (state.phase === "images" && cursor.chain !== candidate.manifest_digest)
      throw new PublicationIntegrityError("publication_manifest_corrupt");
    state.phase = state.phase === "images" ? "exports" : state.phase === "exports" ? "projections" : "composition";
    cursor.partition = cursor.record = cursor.text = cursor.chunk = cursor.subrecord = 0;
    return;
  }
  const partition = await gameCandidatePartitionStatement(db, id, cursor.partition).first<{
    kind: string;
    content: string;
    sha256: string;
    byte_length: number;
    record_count: number;
  }>();
  if (
    !partition ||
    new TextEncoder().encode(partition.content).byteLength !== partition.byte_length ||
    partition.byte_length > 524288 ||
    (await sha256Text(partition.content)) !== partition.sha256
  )
    throw new PublicationIntegrityError("publication_partition_corrupt");
  const records = JSON.parse(partition.content) as Envelope[];
  if (!Array.isArray(records) || records.length !== partition.record_count || records.length > 500)
    throw new PublicationIntegrityError("publication_partition_corrupt");
  const nextPartition = async () => {
    if (state.phase === "images")
      cursor.chain = await sha256Text(
        canonicalJson({
          previous: cursor.chain,
          ordinal: cursor.partition,
          kind: partition.kind,
          sha256: partition.sha256,
          record_count: partition.record_count,
          byte_length: partition.byte_length,
        }),
      );
    cursor.partition++;
    cursor.record = cursor.text = cursor.chunk = cursor.subrecord = 0;
  };
  if (state.phase === "images") {
    if (partition.kind !== "printing_images" || cursor.record === records.length) {
      await nextPartition();
      return;
    }
    const image = records[cursor.record++]!.value;
    if (
      image.object_key !== `printing-images/${image.content_sha256}` ||
      typeof image.content_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(image.content_sha256)
    )
      throw new PublicationIntegrityError("publication_image_reference_invalid");
    await verifyPublicationObject(
      env.PRINTING_IMAGES,
      String(image.object_key),
      image.content_sha256,
      Number(image.content_byte_length),
    );
    artifact("printing_images", {
      object_key: String(image.object_key),
      sha256: image.content_sha256,
      byte_length: Number(image.content_byte_length),
      reused: true,
    });
    return;
  }
  if (!catalogueKinds.has(partition.kind) || cursor.record === records.length) {
    await nextPartition();
    return;
  }
  const derived = await publicationRecord(partition.kind, records[cursor.record]!, cursor.subrecord ?? 0);
  const { kind, envelope } = derived;
  const value = consumerContent(envelope.value) as Record<string, unknown>;
  if (kind === "products")
    for (const field of ["included", "source_observations", "observed", "withdrawal", "reference"]) delete value[field];
  if (kind === "distribution_contexts" || kind === "product_relationships")
    for (const field of ["observed", "key", "resolution"]) delete value[field];
  if (kind === "printing_images") {
    delete value.source_url;
    delete value.content_base64;
    if (state.phase === "exports") delete value.object_key;
  }
  const textParts = envelope.text_parts.filter((part) => {
    let current: unknown = value;
    for (const key of part.path) {
      if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return false;
      current = (current as Record<string, unknown>)[key];
    }
    return true;
  });
  if (state.phase === "exports" && cursor.text < textParts.length) {
    const part = textParts[cursor.text]!;
    const chunk = await reconciliationTextStatement(db, candidate.preparation_id, part.sha256, cursor.chunk).first<{
      content: string;
    }>();
    if (!chunk || part.chunks < 1) throw new PublicationIntegrityError("publication_text_corrupt");
    const bytes = new TextEncoder().encode(chunk.content);
    if (bytes.byteLength > 131072) throw new PublicationIntegrityError("publication_capacity_exceeded");
    const hash = new StreamingSha256(cursor.text_hash);
    hash.update(bytes);
    cursor.text_hash = hash.checkpoint;
    cursor.text_bytes = (cursor.text_bytes ?? 0) + bytes.byteLength;
    const ref = await retainPublicationObject(
      env.CATALOGUE_EXPORTS,
      chunk.content,
      `publication-text/${part.sha256}/${cursor.chunk}`,
    );
    artifact("text", ref);
    statements.push(repository.retainPublicReadText(db, id, part.sha256, cursor.chunk, chunk.content));
    cursor.chunk++;
    if (cursor.chunk === part.chunks) {
      if (hash.digestHex() !== part.sha256 || cursor.text_bytes !== part.byte_length)
        throw new PublicationIntegrityError("publication_text_corrupt");
      cursor.text++;
      cursor.chunk = 0;
      delete cursor.text_hash;
      delete cursor.text_bytes;
    }
    return;
  }
  if (state.phase === "projections" && kind === "cards" && cursor.text < 3) {
    const paths = [["official_identity", "value"], ["name"], ["effective_rules_text"]];
    const path = paths[cursor.text]!;
    const part = textParts.find((part) => canonicalJson(part.path) === canonicalJson(path));
    let text: string;
    if (part) {
      const source = await reconciliationTextStatement(db, candidate.preparation_id, part.sha256, cursor.chunk).first<{
        content: string;
      }>();
      if (!source) throw new PublicationIntegrityError("publication_text_corrupt");
      let previous = "";
      if (cursor.chunk > 0) {
        const prior = await reconciliationTextStatement(
          db,
          candidate.preparation_id,
          part.sha256,
          cursor.chunk - 1,
        ).first<{ content: string }>();
        if (!prior) throw new PublicationIntegrityError("publication_text_corrupt");
        previous = [...prior.content].slice(-maximumNormalizedSearchQueryCodePoints).join("");
      }
      text = previous + source.content;
    } else {
      let source: unknown = value;
      for (const key of path)
        source = source && typeof source === "object" ? (source as Record<string, unknown>)[key] : null;
      text = typeof source === "string" ? source : "";
    }
    // Same normalization and 9-Ki-scalar overlap as the accepted card search contract.
    const points = [...normalizeCardSearchText(text)];
    if (points.length > 768000) throw new PublicationIntegrityError("publication_capacity_exceeded");
    const offset = cursor.search_offset ?? 0;
    const chunk = points.slice(offset, offset + maximumSearchChunkCodePoints).join("");
    const content = canonicalJson({
      contract: "card-keepr-game-search-chunk@1",
      card_id: value.id,
      field: cursor.text,
      ordinal: cursor.search_ordinal ?? 0,
      text: chunk,
    });
    const ref = await retainPublicationObject(env.CATALOGUE_EXPORTS, content);
    statements.push(
      repository.retainPublicationSearchChunk(db, id, String(value.id), cursor.text, cursor.search_ordinal ?? 0, chunk),
    );
    artifact("search", ref);
    cursor.search_ordinal = (cursor.search_ordinal ?? 0) + 1;
    if (offset + maximumSearchChunkCodePoints >= points.length) {
      cursor.search_offset = 0;
      cursor.chunk++;
      if (!part || cursor.chunk === part.chunks) {
        cursor.text++;
        cursor.chunk = 0;
        cursor.search_ordinal = 0;
      }
    } else cursor.search_offset = offset + searchChunkStride;
    return;
  }
  const content = canonicalJson({
    contract: "card-keepr-game-export-record@1",
    kind: kind,
    value,
    text_parts: textParts,
  });
  if (new TextEncoder().encode(content).byteLength > 524288)
    throw new PublicationIntegrityError("publication_capacity_exceeded");
  if (state.phase === "exports") artifact(kind, await retainPublicationObject(env.CATALOGUE_EXPORTS, content));
  else {
    const projection = canonicalJson({
      contract: "card-keepr-game-query-batch@1",
      kind: kind,
      records: [{ value, text_parts: textParts }],
      search:
        kind === "cards"
          ? [
              {
                id: value.id,
                name: value.name,
                official_identity: value.official_identity,
                effective_rules_text: value.effective_rules_text,
                game: candidate.supported_game,
                text_parts: textParts,
              },
            ]
          : [],
    });
    if (new TextEncoder().encode(projection).byteLength > 524288)
      throw new PublicationIntegrityError("publication_capacity_exceeded");
    const ref = await retainPublicationObject(env.CATALOGUE_EXPORTS, projection);
    statements.push(repository.retainPublicationProjection(db, id, state.artifact_count, kind, projection, ref.sha256));
    statements.push(repository.retainPublicationQueryDocument(db, id, kind, String(value.id), state.artifact_count));
    statements.push(
      ...repository.retainPublicReadFacts(
        db,
        id,
        state.artifact_count,
        candidate.preparation_id,
        candidate.supported_game,
      ),
    );
    artifact("query_search", ref);
    const lifecycle = await preparePublicLifecycle(db, candidate, kind, envelope.value);
    if (lifecycle) {
      statements.push(retainPublicLifecycle(db, lifecycle));
      artifact(
        "public_lifecycle",
        await retainPublicationObject(
          env.CATALOGUE_EXPORTS,
          canonicalJson({
            contract: "card-keepr-game-export-record@1",
            kind: "public_lifecycle",
            value: lifecycle,
            text_parts: [],
          }),
        ),
      );
    }
  }
  if (derived.more) cursor.subrecord = (cursor.subrecord ?? 0) + 1;
  else {
    cursor.record++;
    cursor.subrecord = 0;
  }
  cursor.text = cursor.chunk = 0;
}

/** Preparation of a composition only retains references; #228 owns selecting a published head. */
export async function composePublicationArtifacts(env: Environment, ids: unknown, requirePublicExports = false) {
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 4 ||
    ids.some((id) => typeof id !== "string") ||
    new Set(ids).size !== ids.length
  )
    throw new AdministrationProblem(
      422,
      "invalid_publication_composition",
      "Select one verified candidate per game, at most four.",
    );
  const games: { supported_game: string; candidate_id: string; root_digest: string; public_root_digest?: string }[] =
    [];
  for (const id of ids) {
    const status = await inspectPublicationPreparation(env.CATALOGUE_DB, id);
    if (status.state !== "verified" || !status.root_digest)
      throw new AdministrationProblem(
        409,
        "publication_artifacts_unverified",
        "Each selected game must have verified publication artifacts.",
      );
    const root = await env.CATALOGUE_EXPORTS.head(`publication-artifacts/${status.root_digest}`);
    if (!root || root.size > 16384)
      throw new AdministrationProblem(
        409,
        "publication_composition_corrupt",
        "A verified game's root is missing or corrupt.",
      );
    await verifyPublicationObject(env.CATALOGUE_EXPORTS, root.key, status.root_digest, root.size);
    const publicExport = await publicExportPreparationStatement(env.CATALOGUE_DB, id).first<{
      state: string;
      root_digest: string;
      root_object_key: string;
      root_bytes: number;
    }>();
    if (requirePublicExports && publicExport?.state !== "verified")
      throw new AdministrationProblem(
        409,
        "public_export_unverified",
        "Stage and verify the public export before selecting this composition.",
      );
    if (publicExport?.state === "verified")
      await verifyPublicationObject(
        env.CATALOGUE_EXPORTS,
        publicExport.root_object_key,
        publicExport.root_digest,
        publicExport.root_bytes,
      );
    games.push({
      supported_game: status.supported_game,
      candidate_id: id,
      root_digest: status.root_digest,
      ...(publicExport?.state === "verified" ? { public_root_digest: publicExport.root_digest } : {}),
    });
  }
  games.sort((a, b) => (a.supported_game < b.supported_game ? -1 : 1));
  if (new Set(games.map((game) => game.supported_game)).size !== games.length)
    throw new AdministrationProblem(422, "duplicate_composition_game", "Select only one candidate for each game.");
  const content = canonicalJson({ contract: "card-keepr-prepared-publication-composition@1", games });
  const root = await retainPublicationObject(env.CATALOGUE_EXPORTS, content);
  await repository.retainVerifiedPublicationComposition(env.CATALOGUE_DB, root.sha256, content).run();
  return {
    ...JSON.parse(content),
    root_digest: root.sha256,
    object_key: root.object_key,
    byte_length: root.byte_length,
  };
}

/** Reservations survive Workflow replay; each is charged a full 100-call callback allowance. */
export async function reservePublicationWork(db: CatalogueStore, id: string, first: number) {
  return Boolean(await repository.reservePublicationWorkflowAttempt(db, id, first).first());
}
export async function pausePublicationWorkflow(
  env: Environment,
  id: string,
  manifest: string,
  generation: number,
  code: string,
  ownership: { sequence: number; action_key?: string },
) {
  const current = await repository.publicationPreparationStatement(env.CATALOGUE_DB, id).first<PreparationState>();
  if (!current || current.state !== "preparing") return;
  if (current.sequence !== ownership.sequence) {
    if (current.sequence !== ownership.sequence + 1 || !ownership.action_key) return;
    const receipt = await repository
      .publicationPreparationActionStatement(env.CATALOGUE_DB, ownership.action_key)
      .first<{ result_json: string }>();
    if (!receipt) return;
    const result = JSON.parse(receipt.result_json) as Record<string, unknown>;
    if (
      result.candidate_id !== id ||
      result.manifest_digest !== manifest ||
      result.generation !== generation ||
      result.sequence !== current.sequence
    )
      return;
  }
  await env.CATALOGUE_DB.batch([
    repository.publicationPreparationGuard(
      env.CATALOGUE_DB,
      id,
      manifest,
      generation,
      new Date().toISOString(),
      current.sequence,
    ),
    repository.updatePublicationPreparation(env.CATALOGUE_DB, {
      ...current,
      sequence: current.sequence + 1,
      state: "retry_paused",
      failure_code: code,
    }),
  ]);
}

export async function inspectPreparedQuery(db: CatalogueStore, id: string, query: URLSearchParams) {
  const status = await inspectPublicationPreparation(db, id);
  const kind = query.get("kind") ?? "cards",
    after = query.get("after") ?? "",
    raw = query.get("q");
  if (!catalogueKinds.has(kind) || after.length > 200 || (raw !== null && (kind !== "cards" || [...raw].length > 500)))
    throw new AdministrationProblem(
      422,
      "invalid_prepared_query",
      "Select a catalogue kind and an at-most-500-character Card search.",
    );
  const search = raw === null ? null : normalizeCardSearchText(raw);
  const rows = (
    await repository
      .publicationQueryDocuments(db, id, kind, after, search)
      .all<{ entity_id: string; content: string }>()
  ).results;
  return {
    contract: "card-keepr-prepared-query@1",
    candidate_id: id,
    manifest_digest: status.manifest_digest,
    state: status.state,
    records: rows.map((row) => JSON.parse(row.content)),
    next_cursor: rows.length ? rows.at(-1)!.entity_id : null,
  };
}

/** Terminal bookkeeping may outlive a candidate's slot; it never authorizes artifact writes. */
export async function retainPublicationFence(
  env: Environment,
  id: string,
  manifest: string,
  generation: number,
  sequence: number,
  code: string,
) {
  const state = await repository.publicationPreparationStatement(env.CATALOGUE_DB, id).first<PreparationState>();
  if (
    !state ||
    state.state !== "preparing" ||
    state.sequence !== sequence ||
    state.manifest_digest !== manifest ||
    state.generation !== generation
  )
    return;
  await env.CATALOGUE_DB.batch([
    repository.publicationTerminalGuard(env.CATALOGUE_DB, id, manifest, generation, sequence),
    repository.updatePublicationPreparation(env.CATALOGUE_DB, {
      ...state,
      sequence: sequence + 1,
      state: "failed",
      failure_code: code,
    }),
  ]);
}
