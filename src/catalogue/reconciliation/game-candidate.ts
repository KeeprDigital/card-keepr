import { AdministrationProblem, canonicalJson, type CatalogueDraft, type CatalogueStore, sha256Text } from "../shared";
import type { CanonicalRecordSource } from "./reconciliation-canonical-digest";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { documentStorage } from "./reconciliation-document";
import {
  reconciliationPartitionsStatement,
  reconciliationPartitionStatement,
} from "./reconciliation-progress-repository";
import {
  gameCandidatesForPreparationStatement,
  gameCandidateStatement,
  gameCandidatePartitionsStatement,
  gameCandidatePartitionStatement,
  insertGameCandidatePartitionStatement,
  retainGameEntityScopesStatement,
  scopedGamePartitionStatement,
  sealGameCandidateStatement,
} from "./game-candidate-repository";
import { sourceAdapterRegistrations } from "../adapters";

type GameCandidate = {
  id: string;
  ingestion_run_id: string;
  supported_game: string;
  expected_game_revision_id: string;
  created_at: string;
  deadline: string;
  state: string;
  manifest_digest: string | null;
  partition_count: number;
};

type PreparationCursor = {
  stage: "cards" | "printings" | "lineages" | "partitions" | "complete";
  inputManifest: string;
  after: string;
  lineages: { sourceLineage: string; supportedGame: string }[];
  game: number;
  partition: number;
  ordinal: number;
  digest: string | null;
  seals: { id: string; digest: string; count: number }[];
};

/** Legacy run adapter: each game manifest is prepared through durable bounded scans. */
export async function prepareGameCandidateManifests(
  database: CatalogueStore,
  runId: string,
  candidate: CatalogueDraft,
  inputManifest: string,
  lineages: AsyncIterable<{ supportedGame: string; sourceLineage: string }>,
  yieldAtCheckpoint = false,
) {
  const checkpoint = await reconciliationCheckpoint<PreparationCursor>(database, runId, "game_preparation");
  const cursor: PreparationCursor = checkpoint?.value ?? {
    stage: "cards",
    inputManifest,
    after: "",
    lineages: sourceAdapterRegistrations.map(({ sourceLineage, supportedGame }) => ({ sourceLineage, supportedGame })),
    game: 0,
    partition: -1,
    ordinal: 0,
    digest: null,
    seals: [],
  };
  if (cursor.inputManifest !== inputManifest) throw new Error("Game preparation manifest prefix changed.");
  let checkpointOrdinal = (checkpoint?.ordinal ?? -1) + 1;
  let work = 0,
    bytes = 0;
  const save = async () => {
    await retainReconciliationCheckpoint(database, runId, "game_preparation", checkpointOrdinal, cursor);
    if (yieldAtCheckpoint)
      throw new ReconciliationContinuation({ phase: "game_preparation", ordinal: checkpointOrdinal });
    checkpointOrdinal++;
    work = bytes = 0;
  };
  for (const kind of ["cards", "printings"] as const) {
    if (cursor.stage !== kind) continue;
    for await (const record of candidate.values(kind, cursor.after)) {
      const scope =
        "game" in record ? { id: record.id, game: record.game } : { id: record.id, card_id: record.card_id };
      await documentStorage(() => retainGameEntityScopesStatement(database, runId, kind, canonicalJson([scope])).run());
      cursor.after = record.id;
      bytes += new TextEncoder().encode(canonicalJson(record)).byteLength;
      if (++work === 4 || bytes >= 512000) await save();
    }
    cursor.after = "";
    cursor.stage = kind === "cards" ? "printings" : "lineages";
    await save();
  }
  if (cursor.stage === "lineages") {
    if (!("canonicalEntries" in lineages)) throw new Error("Game preparation requires resumable lineage evidence.");
    const source = lineages as CanonicalRecordSource<{ supportedGame: string; sourceLineage: string }>;
    for await (const entry of source.canonicalEntries(cursor.after)) {
      const index = cursor.lineages.findIndex((lineage) => lineage.sourceLineage === entry.value.sourceLineage);
      const lineage = { sourceLineage: entry.value.sourceLineage, supportedGame: entry.value.supportedGame };
      if (index < 0) cursor.lineages.push(lineage);
      else cursor.lineages[index] = lineage;
      cursor.after = entry.key;
      if (++work === 4) await save();
    }
    cursor.after = "";
    cursor.stage = "partitions";
    await save();
  }
  if (cursor.stage === "partitions") {
    const headers = (await documentStorage(() => gameCandidatesForPreparationStatement(database, runId).all<GameCandidate>()))
      .results;
    if (headers.length > 4) throw new Error("reconciliation_capacity_exceeded: unsupported number of selected games.");
    const scopedLineages = canonicalJson(cursor.lineages);
    while (cursor.game < headers.length) {
      const header = headers[cursor.game]!;
      cursor.digest ??= await sha256Text(
        canonicalJson({
          contract: "card-keepr-game-candidate-manifest@1",
          candidate_id: header.id,
          ingestion_run_id: runId,
          supported_game: header.supported_game,
          expected_game_revision_id: header.expected_game_revision_id,
          created_at: header.created_at,
          deadline: header.deadline,
          preparation_manifest: inputManifest,
        }),
      );
      for (;;) {
        const page = (
          await documentStorage(() =>
            reconciliationPartitionsStatement(database, runId, cursor.partition).all<{
              ordinal: number;
              kind: string;
            }>(),
          )
        ).results;
        if (!page.length) break;
        for (const partition of page) {
          const source = await documentStorage(() =>
            reconciliationPartitionStatement(database, runId, partition.ordinal).first<{ content: string }>(),
          );
          if (!source) throw new Error("The retained candidate partition is unavailable.");
          for (const kind of partition.kind === "warnings" ? ["warnings", "shared_warnings"] : [partition.kind]) {
            const rows = (
              await documentStorage(() =>
                scopedGamePartitionStatement(
                  database,
                  runId,
                  header.supported_game,
                  kind,
                  source.content,
                  scopedLineages,
                ).all<{ value: string; type: string }>(),
              )
            ).results;
            const records = rows.map((row) =>
              row.type === "object" || row.type === "array" ? JSON.parse(row.value) : row.value,
            );
            if (!records.length) continue;
            const content = canonicalJson(records),
              sha256 = await sha256Text(content);
            await documentStorage(() =>
              insertGameCandidatePartitionStatement(
                database,
                header.id,
                cursor.ordinal,
                kind,
                content,
                sha256,
                records.length,
              ).run(),
            );
            const retained = await documentStorage(() =>
              gameCandidatePartitionStatement(database, header.id, cursor.ordinal).first<{
                content: string;
                kind: string;
              }>(),
            );
            if (retained?.content !== content || retained.kind !== kind)
              throw new Error("Game candidate partition replay differs from its immutable content.");
            cursor.digest = await sha256Text(
              canonicalJson({
                previous: cursor.digest,
                ordinal: cursor.ordinal,
                kind,
                sha256,
                record_count: records.length,
                byte_length: new TextEncoder().encode(content).byteLength,
              }),
            );
            cursor.ordinal++;
          }
          cursor.partition = partition.ordinal;
          bytes += new TextEncoder().encode(source.content).byteLength;
          if (++work === 4 || bytes >= 512000) await save();
        }
      }
      cursor.seals.push({ id: header.id, digest: cursor.digest!, count: cursor.ordinal });
      cursor.game++;
      cursor.partition = -1;
      cursor.ordinal = 0;
      cursor.digest = null;
      await save();
    }
    cursor.stage = "complete";
    await save();
  }
  return cursor.seals.map((seal) =>
    sealGameCandidateStatement(database, runId, seal.id, seal.digest, seal.count, inputManifest),
  );
}

export async function inspectGameCandidate(database: CatalogueStore, candidateId: string) {
  const candidate = await gameCandidateStatement(database, candidateId).first<GameCandidate>();
  if (!candidate)
    throw new AdministrationProblem(404, "game_candidate_not_found", "This Game Catalogue Candidate does not exist.");
  return { contract: "card-keepr-game-candidate@1", ...candidate };
}

export async function inspectGameCandidatePartitions(
  database: CatalogueStore,
  candidateId: string,
  after: string | null,
) {
  const cursor = after === null ? -1 : Number(after);
  if (!Number.isSafeInteger(cursor) || cursor < -1)
    throw new AdministrationProblem(422, "invalid_cursor", "Use the returned partition cursor.");
  const candidate = await inspectGameCandidate(database, candidateId);
  const partitions = (await gameCandidatePartitionsStatement(database, candidateId, cursor).all<{ ordinal: number }>())
    .results;
  return {
    contract: "card-keepr-game-candidate-partitions@1",
    candidate,
    partitions,
    next_cursor: partitions.length === 100 ? String(partitions.at(-1)!.ordinal) : null,
  };
}

export async function inspectGameCandidatePartition(database: CatalogueStore, candidateId: string, ordinal: string) {
  if (!/^\d+$/.test(ordinal) || !Number.isSafeInteger(Number(ordinal)))
    throw new AdministrationProblem(422, "invalid_cursor", "Use a retained partition ordinal.");
  const partition = await gameCandidatePartitionStatement(database, candidateId, Number(ordinal)).first<{
    kind: string;
    content: string;
    sha256: string;
  }>();
  if (!partition)
    throw new AdministrationProblem(404, "partition_not_found", "This game candidate partition does not exist.");
  const envelopes = JSON.parse(partition.content) as { value: unknown; text_parts: unknown[] }[];
  return {
    kind: partition.kind,
    sha256: partition.sha256,
    records: envelopes.map((record) => record.value),
    text_parts: envelopes.map((record) => record.text_parts),
  };
}
