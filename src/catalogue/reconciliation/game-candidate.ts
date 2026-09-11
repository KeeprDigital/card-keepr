import {
  verifyInspectionArtifacts,
  inspectionIntegrityReceipt,
  type InspectionIntegrityCursor,
} from "./game-inspection-integrity";
import { inspectionEvidenceClasses, inspectionEvidenceStatement } from "./game-inspection-evidence-repository";
import {
  prepareCandidateInspection,
  verifiedCandidatePartition,
  type InspectionCursor,
} from "./game-candidate-inspection";
import { retainPartitionedRecord } from "./reconciliation-text";
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
  gameCandidatesForCollectionStatement,
  gameCandidateStatement,
  inspectionGameHeadStatement,
  gameCandidateInspectionSummaryStatement,
  gameCandidateInspectionCountsStatement,
  gameCandidatePartitionsStatement,
  gameCandidatePartitionStatement,
  insertGameCandidatePartitionStatement,
  retainGameEntityScopesStatement,
  scopedGamePartitionStatement,
  sealGameCandidateStatement,
} from "./game-candidate-repository";
import { sourceAdapterRegistrations } from "../adapters";
import { newestReconciliationCheckpointStatement } from "./reconciliation-checkpoint-repository";

type GameCandidate = {
  id: string;
  preparation_id: string;
  ingestion_run_id: string;
  supported_game: string;
  expected_game_revision_id: string;
  created_at: string;
  deadline: string;
  state: string;
  generation: number;
  failure_code: string | null;
  terminal_result_json: string | null;
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
  inspection?: InspectionCursor;
  contentPartitions?: number;
  integrity?: InspectionIntegrityCursor;
};

/** Legacy run adapter: each game manifest is prepared through durable bounded scans. */
export async function prepareGameCandidateManifests(
  database: CatalogueStore,
  runId: string,
  candidate: CatalogueDraft,
  inputManifest: string,
  lineages: AsyncIterable<{ supportedGame: string; sourceLineage: string }>,
  printingImageObjects: R2Bucket,
  yieldAtCheckpoint = false,
  terminalState: "sealed" | "failed" = "sealed",
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
    let scopes: { id: string; game?: string; card_id?: string }[] = [];
    const flush = async () => {
      if (!scopes.length) return;
      await documentStorage(() => retainGameEntityScopesStatement(database, runId, kind, canonicalJson(scopes)).run());
      scopes = [];
    };
    for await (const record of candidate.values(kind, cursor.after)) {
      const scope =
        "game" in record ? { id: record.id, game: record.game } : { id: record.id, card_id: record.card_id };
      scopes.push(scope);
      cursor.after = record.id;
      bytes += new TextEncoder().encode(canonicalJson(record)).byteLength;
      if (++work === 64 || bytes >= 512000) {
        await flush();
        await save();
      }
    }
    await flush();
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
    const headers = (
      await documentStorage(() => gameCandidatesForPreparationStatement(database, runId).all<GameCandidate>())
    ).results;
    if (headers.length > 5) throw new Error("reconciliation_capacity_exceeded: unsupported number of selected games.");
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
          if (++work === 8 || bytes >= 512000) await save();
        }
      }
      cursor.contentPartitions ??= cursor.ordinal;
      await prepareCandidateInspection(
        database,
        header,
        cursor.inspection,
        cursor.contentPartitions,
        async (inspection) => {
          cursor.inspection = inspection;
          await save();
        },
        async (values) => {
          const envelopes = [];
          for (const value of values) envelopes.push(await retainPartitionedRecord(database, runId, value));
          const content = canonicalJson(envelopes);
          if (new TextEncoder().encode(content).byteLength > 524288)
            throw new Error("reconciliation_capacity_exceeded: inspection record exceeds 512 KiB.");
          const sha256 = await sha256Text(content);
          await documentStorage(() =>
            insertGameCandidatePartitionStatement(
              database,
              header.id,
              cursor.ordinal,
              "inspection",
              content,
              sha256,
              values.length,
            ).run(),
          );
          const retained = await documentStorage(() =>
            gameCandidatePartitionStatement(database, header.id, cursor.ordinal).first<{ content: string }>(),
          );
          if (retained?.content !== content) throw new Error("Inspection replay differs from its immutable content.");
          cursor.digest = await sha256Text(
            canonicalJson({
              previous: cursor.digest,
              ordinal: cursor.ordinal,
              kind: "inspection",
              sha256,
              record_count: values.length,
              byte_length: new TextEncoder().encode(content).byteLength,
            }),
          );
          cursor.ordinal++;
        },
      );
      const integrity = await verifyInspectionArtifacts(
        database,
        printingImageObjects,
        header,
        cursor.ordinal,
        cursor.digest!,
        cursor.integrity,
        async (integrity) => {
          cursor.integrity = integrity;
          await save();
        },
      );
      const summaryContent = canonicalJson([
        {
          contract: "card-keepr-partitioned-record@1",
          value: {
            game: header.supported_game,
            approval_scope: "whole_candidate",
            expected_game_revision_id: header.expected_game_revision_id,
            integrity: await inspectionIntegrityReceipt(integrity),
            counts: cursor.inspection!.counts,
            record_count: cursor.inspection!.count,
            content_partitions: cursor.contentPartitions,
          },
          text_parts: [],
        },
      ]);
      const summarySha = await sha256Text(summaryContent);
      await documentStorage(() =>
        insertGameCandidatePartitionStatement(
          database,
          header.id,
          cursor.ordinal,
          "inspection_summary",
          summaryContent,
          summarySha,
          1,
        ).run(),
      );
      cursor.digest = await sha256Text(
        canonicalJson({
          previous: cursor.digest,
          ordinal: cursor.ordinal,
          kind: "inspection_summary",
          sha256: summarySha,
          record_count: 1,
          byte_length: new TextEncoder().encode(summaryContent).byteLength,
        }),
      );
      cursor.ordinal++;
      cursor.seals.push({ id: header.id, digest: cursor.digest!, count: cursor.ordinal });
      cursor.game++;
      delete cursor.inspection;
      delete cursor.integrity;
      delete cursor.contentPartitions;
      cursor.partition = -1;
      cursor.ordinal = 0;
      cursor.digest = null;
      await save();
    }
    cursor.stage = "complete";
    await save();
  }
  return cursor.seals.map((seal) =>
    sealGameCandidateStatement(database, runId, seal.id, seal.digest, seal.count, inputManifest, terminalState),
  );
}

export async function inspectGameCandidate(database: CatalogueStore, candidateId: string) {
  const candidate = await gameCandidateStatement(database, candidateId).first<GameCandidate>();
  if (!candidate)
    throw new AdministrationProblem(404, "game_candidate_not_found", "This Game Catalogue Candidate does not exist.");
  const { terminal_result_json, ...identity } = candidate;
  return {
    contract: "card-keepr-game-candidate@1",
    ...identity,
    outcome: terminal_result_json ? JSON.parse(terminal_result_json) : null,
  };
}

export async function listCollectionGameCandidates(database: CatalogueStore, runId: string, after: string | null) {
  if (after !== null && !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/.test(after))
    throw new AdministrationProblem(422, "invalid_cursor", "Use the returned candidate cursor.");
  const rows = (await gameCandidatesForCollectionStatement(database, runId, after ?? "").all<{ id: string }>()).results;
  return {
    contract: "card-keepr-collection-game-candidates@1",
    ingestion_run_id: runId,
    candidates: rows.slice(0, 100),
    next_cursor: rows.length > 100 ? rows[99]!.id : null,
  };
}

export async function inspectGameCandidateProgress(database: CatalogueStore, candidateId: string) {
  const candidate = await inspectGameCandidate(database, candidateId);
  return {
    contract: "card-keepr-game-preparation-progress@1",
    preparation_id: candidate.preparation_id,
    candidate,
    checkpoint: await newestReconciliationCheckpointStatement(database, candidate.preparation_id).first(),
  };
}

export async function inspectGameCandidatePartitions(
  database: CatalogueStore,
  candidateId: string,
  after: string | null,
  manifest: string | null = null,
) {
  const candidate = await inspectGameCandidate(database, candidateId);
  if (manifest !== null && manifest !== candidate.manifest_digest)
    throw new AdministrationProblem(409, "candidate_pin_mismatch", "Use pages from the exact candidate manifest.");
  const parts = after?.split(":");
  if (parts && (parts.length !== 2 || parts[0] !== candidate.manifest_digest))
    throw new AdministrationProblem(409, "candidate_pin_mismatch", "Use the returned manifest-bound cursor.");
  const cursor = after === null ? -1 : Number(parts![1]);
  if (!Number.isSafeInteger(cursor) || cursor < -1)
    throw new AdministrationProblem(422, "invalid_cursor", "Use the returned partition cursor.");
  const partitions = (await gameCandidatePartitionsStatement(database, candidateId, cursor).all<{ ordinal: number }>())
    .results;
  return {
    contract: "card-keepr-game-candidate-partitions@1",
    candidate,
    partitions,
    next_cursor: partitions.length === 100 ? `${candidate.manifest_digest}:${partitions.at(-1)!.ordinal}` : null,
  };
}

export async function inspectGameCandidatePartition(
  database: CatalogueStore,
  candidateId: string,
  ordinal: string,
  manifest: string | null = null,
) {
  const candidate = await inspectGameCandidate(database, candidateId);
  if (manifest !== null && manifest !== candidate.manifest_digest)
    throw new AdministrationProblem(409, "candidate_pin_mismatch", "Use pages from the exact candidate manifest.");
  if (!/^\d+$/.test(ordinal) || !Number.isSafeInteger(Number(ordinal)))
    throw new AdministrationProblem(422, "invalid_cursor", "Use a retained partition ordinal.");
  const partition = await verifiedCandidatePartition(database, candidateId, Number(ordinal));
  const envelopes = partition.records;
  return {
    candidate_id: candidate.id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: candidate.expected_game_revision_id,
    kind: partition.kind,
    sha256: partition.sha256,
    records: envelopes.map((record) => record.value),
    text_parts: envelopes.map((record) => record.text_parts),
  };
}

export async function inspectGameCandidateReadiness(
  database: CatalogueStore,
  candidateId: string,
  manifest: string | null,
  observedAt = new Date().toISOString(),
) {
  const candidate = await inspectGameCandidate(database, candidateId);
  if (manifest !== null && manifest !== candidate.manifest_digest)
    throw new AdministrationProblem(409, "candidate_pin_mismatch", "Use the exact candidate manifest.");
  const summary = await gameCandidateInspectionSummaryStatement(database, candidateId).first<{ ordinal: number }>();
  if (!summary || !candidate.manifest_digest)
    return {
      contract: "card-keepr-candidate-inspection@1",
      candidate_id: candidate.id,
      preparation_id: candidate.preparation_id,
      manifest_digest: candidate.manifest_digest,
      expected_game_revision_id: candidate.expected_game_revision_id,
      ready: false,
      reason: "inspection_not_prepared",
      approval_scope: "whole_candidate",
    };
  const partition = await verifiedCandidatePartition(database, candidateId, summary.ordinal);
  const value = partition.records[0]!.value as {
    counts: Record<string, Record<string, number>>;
    record_count: number;
    content_partitions: number;
    integrity: {
      manifest_prefix: string;
      partitions: number;
      texts: number;
      images: number;
      complete: boolean;
      sha256: string;
    };
  };
  if (!value.integrity?.complete || value.integrity.partitions !== summary.ordinal)
    throw new AdministrationProblem(
      409,
      "candidate_artifact_invalid",
      "Candidate inspection has no complete integrity receipt.",
    );
  const { sha256: receiptSha, ...receipt } = value.integrity;
  if (
    (await sha256Text(canonicalJson(receipt))) !== receiptSha ||
    (await sha256Text(
      canonicalJson({
        previous: receipt.manifest_prefix,
        ordinal: summary.ordinal,
        kind: "inspection_summary",
        sha256: partition.sha256,
        record_count: 1,
        byte_length: partition.byte_length,
      }),
    )) !== candidate.manifest_digest
  )
    throw new AdministrationProblem(
      409,
      "candidate_artifact_invalid",
      "Inspection integrity receipt is not bound to this candidate manifest.",
    );
  const counts = (
    await gameCandidateInspectionCountsStatement(database, candidateId).all<{
      kind: string;
      partitions: number;
      records: number;
    }>()
  ).results;
  if (
    counts.reduce((sum, row) => sum + row.partitions, 0) !== candidate.partition_count ||
    counts.find((row) => row.kind === "inspection")?.records !== value.record_count ||
    Object.values(value.counts)
      .flatMap(Object.values)
      .reduce((sum, count) => sum + count, 0) !== value.record_count
  )
    throw new AdministrationProblem(
      409,
      "candidate_artifact_invalid",
      "Candidate inspection counts do not reconcile with retained details.",
    );
  const head = await inspectionGameHeadStatement(database, candidate.supported_game).first<{ revision_id: string }>();
  const reason =
    candidate.state !== "sealed"
      ? "candidate_not_sealed"
      : candidate.deadline <= observedAt
        ? "candidate_expired"
        : head?.revision_id !== candidate.expected_game_revision_id
          ? "game_predecessor_changed"
          : null;
  return {
    contract: "card-keepr-candidate-inspection@1",
    candidate_id: candidate.id,
    preparation_id: candidate.preparation_id,
    ingestion_run_id: candidate.ingestion_run_id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: candidate.expected_game_revision_id,
    deadline: candidate.deadline,
    ready: reason === null,
    reason,
    approval_scope: "whole_candidate",
    integrity: value.integrity,
    counts: value.counts,
    record_count: value.record_count,
    evidence_counts: Object.fromEntries(
      await Promise.all(
        inspectionEvidenceClasses.map(async (kind) => [
          kind,
          (await inspectionEvidenceStatement(
            database,
            candidate.preparation_id,
            candidate.supported_game,
            kind,
            "",
            true,
          ).first<{ count: number }>())!.count,
        ]),
      ),
    ),
  };
}
