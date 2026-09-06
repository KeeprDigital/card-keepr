import {
  AdministrationProblem,
  canonicalJson,
  type CatalogueCandidate,
  type CatalogueStore,
  sha256Text,
} from "../shared";
import { boundedRecordArrays } from "./reconciliation-preparation";
import {
  reconciliationPartitionsStatement,
  reconciliationPartitionStatement,
} from "./reconciliation-progress-repository";
import {
  gameCandidatesForRunStatement,
  gameCandidateStatement,
  gameCandidatePartitionsStatement,
  gameCandidatePartitionStatement,
  insertGameCandidatePartitionStatement,
  retainGameEntityScopesStatement,
  scopedGamePartitionStatement,
  sealGameCandidateStatement,
} from "./game-candidate-repository";

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

/** Legacy preparation adapter: scope retained partitions without constructing another game-sized object. */
export async function prepareGameCandidateManifests(
  database: CatalogueStore,
  runId: string,
  candidate: CatalogueCandidate,
  inputManifest: string,
  lineages: readonly { supportedGame: string; sourceLineage: string }[],
) {
  for (const kind of ["cards", "printings"] as const) {
    for (let offset = 0; offset < candidate[kind].length; offset += 100) {
      const scopes = candidate[kind]
        .slice(offset, offset + 100)
        .map((record) =>
          "game" in record ? { id: record.id, game: record.game } : { id: record.id, card_id: record.card_id },
        );
      for (const content of boundedRecordArrays(scopes))
        await retainGameEntityScopesStatement(database, runId, kind, content).run();
    }
  }
  const headers = (await gameCandidatesForRunStatement(database, runId).all<GameCandidate>()).results;
  const seals: D1PreparedStatement[] = [];
  for (const header of headers) {
    let digest = await sha256Text(
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
    const scopedLineages = canonicalJson([
      ...new Set(
        lineages
          .filter((lineage) => lineage.supportedGame === header.supported_game)
          .map((lineage) => lineage.sourceLineage),
      ),
    ]);
    let after = -1;
    let ordinal = 0;
    for (;;) {
      const page = (
        await reconciliationPartitionsStatement(database, runId, after).all<{ ordinal: number; kind: string }>()
      ).results;
      if (!page.length) break;
      for (const partition of page) {
        const source = await reconciliationPartitionStatement(database, runId, partition.ordinal).first<{
          content: string;
        }>();
        if (!source) throw new Error("The retained candidate partition is unavailable.");
        const rows = (
          await scopedGamePartitionStatement(
            database,
            runId,
            header.supported_game,
            partition.kind,
            source.content,
            scopedLineages,
          ).all<{ value: string; type: string }>()
        ).results;
        const records = rows.map((row) =>
          row.type === "object" || row.type === "array" ? (JSON.parse(row.value) as unknown) : row.value,
        );
        if (!records.length) continue;
        const content = canonicalJson(records);
        const sha256 = await sha256Text(content);
        await insertGameCandidatePartitionStatement(
          database,
          header.id,
          ordinal,
          partition.kind,
          content,
          sha256,
          records.length,
        ).run();
        const retained = await gameCandidatePartitionStatement(database, header.id, ordinal).first<{
          content: string;
          kind: string;
        }>();
        if (retained?.content !== content || retained.kind !== partition.kind)
          throw new Error("Game candidate partition replay differs from its immutable content.");
        digest = await sha256Text(
          canonicalJson({
            previous: digest,
            ordinal,
            kind: partition.kind,
            sha256,
            record_count: records.length,
            byte_length: new TextEncoder().encode(content).byteLength,
          }),
        );
        ordinal++;
      }
      after = page.at(-1)!.ordinal;
    }
    seals.push(sealGameCandidateStatement(database, header.id, digest, ordinal, inputManifest));
  }
  return seals;
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
