import { reconciliationCheckpointsStatement } from "./reconciliation-checkpoint-repository";
import {
  createGamePreparationStatement,
  type GamePreparationCreation,
  failGamePreparationStatement,
  releaseGamePreparationSlotStatement,
} from "./game-reconciliation-repository";
import {
  createGameCandidateIdentitiesStatement,
  gameCandidatesForPreparationStatement,
  synchronizeGameCandidatePauseStatement,
} from "./game-candidate-repository";
import { correctionPinStatementsForPreparation } from "./identity-correction-pins";
import { failReconciliationWorkflow, retainedReconciliationResult } from "./reconciliation-candidate-store";
import {
  reconciliationInputPartitionStatement,
  reconciliationInputPartitionsStatement,
} from "./reconciliation-input-repository";
import { entityAdmissionPinStatementsForPreparation } from "./entity-admission-pins";
import { reconciliationSelectedGamesStatement } from "./reconciliation-progress-repository";
import {
  failedReconciliationWorkflowStatement,
  releaseFailedReconciliationWorkflowStatement,
} from "./reconciliation-state-repository";
import { gameProfileRegistrations, sourceAdapterRegistrations } from "../adapters";
import { reconciliationPartitionStatement } from "./reconciliation-progress-repository";
import {
  createReconciliationOperationStatement,
  reconciliationWriterGuard,
} from "./reconciliation-progress-repository";
import { pauseFailedReconciliationStatement } from "./reconciliation-progress-repository";
import {
  reconciliationActionStatement,
  reconciliationActionGuard,
  reconciliationActionUpdate,
  retainReconciliationAction,
} from "./reconciliation-progress-repository";
import {
  AdministrationProblem,
  canonicalJson,
  type CatalogueStore,
  guardedCatalogueStore,
  sha256Text,
} from "../shared";
import {
  reconciliationOperationStatement,
  reconciliationOperationHeaderStatement,
  reconciliationPartitionsStatement,
} from "./reconciliation-progress-repository";

export async function inspectReconciliationProgress(
  database: CatalogueStore,
  runId: string,
): Promise<Record<string, unknown> & { state: string }> {
  const operation = await reconciliationOperationStatement(database, runId).first<{
    state: string;
    [key: string]: unknown;
  }>();
  if (!operation)
    throw new AdministrationProblem(
      404,
      "reconciliation_not_found",
      "No reconciliation has started for this Ingestion Run.",
    );
  return {
    contract: "card-keepr-reconciliation-status@1",
    ...operation,
    candidates: (await gameCandidatesForPreparationStatement(database, runId).all()).results,
    checkpoints: (
      await reconciliationCheckpointsStatement(database, runId).all<{
        phase: string;
        ordinal: number;
        content: string;
        sha256: string;
      }>()
    ).results.map((row) => ({
      phase: row.phase,
      ordinal: row.ordinal,
      cursor: JSON.parse(row.content),
      sha256: row.sha256,
    })),
  };
}

export async function inspectReconciliationPartitions(database: CatalogueStore, runId: string, after: string | null) {
  const cursor = after === null ? -1 : Number(after);
  if (!Number.isSafeInteger(cursor) || cursor < -1)
    throw new AdministrationProblem(422, "invalid_cursor", "Use the returned partition cursor.");
  const operation = await inspectReconciliationProgress(database, runId);
  const rows = (
    await reconciliationPartitionsStatement(database, runId, cursor).all<{
      ordinal: number;
      kind: string;
      sha256: string;
      byte_length: number;
      record_count: number;
      content: string;
    }>()
  ).results;
  return {
    contract: "card-keepr-candidate-partitions@1",
    ingestion_run_id: runId,
    sealed: operation.state === "sealed",
    manifest:
      operation.state === "sealed"
        ? {
            contract: "card-keepr-sealed-candidate-manifest@1",
            sha256: operation.manifest_digest,
            partition_count: operation.completed_partitions,
          }
        : null,
    partitions: rows,
    next_cursor: rows.length === 100 ? String(rows[99]!.ordinal) : null,
  };
}

export async function changeReconciliationProgress(
  database: CatalogueStore,
  runId: string,
  action: "pause" | "resume" | "abandon",
  input: { generation: number; idempotency_key: string },
  observedAt = new Date().toISOString(),
) {
  if (!Number.isSafeInteger(input.generation) || input.generation < 0)
    throw new AdministrationProblem(422, "invalid_generation", "Use the generation returned by status.");
  const request = canonicalJson({ ingestion_run_id: runId, action, ...input });
  const replay = await reconciliationActionStatement(database, input.idempotency_key).first<{
    request_json: string;
    result_json: string;
  }>();
  if (replay) {
    if (replay.request_json !== request)
      throw new AdministrationProblem(409, "idempotency_conflict", "This key binds another reconciliation action.");
    return JSON.parse(replay.result_json) as Record<string, unknown>;
  }
  const current = await inspectReconciliationProgress(database, runId);
  if (action === "resume" && Date.parse(String(current.deadline)) <= Date.parse(observedAt))
    throw new AdministrationProblem(
      409,
      "reconciliation_deadline_expired",
      "This candidate's original seven-day deadline has passed; abandon it and create a fresh candidate.",
    );
  const result = {
    ...current,
    state: action === "resume" ? "preparing" : action === "pause" ? "paused" : "abandoned",
    generation: input.generation + (action === "resume" ? 0 : 1),
    candidates: (current.candidates as Record<string, unknown>[]).map((candidate) =>
      candidate.state === "preparing" || candidate.state === "paused"
        ? {
            ...candidate,
            state: action === "resume" ? "preparing" : action === "pause" ? "paused" : "abandoned",
            generation: input.generation + (action === "resume" ? 0 : 1),
          }
        : candidate,
    ),
  };
  try {
    await database.batch([
      reconciliationActionGuard(database, runId, action, input.generation),
      reconciliationActionUpdate(database, runId, action, input.generation),
      synchronizeGameCandidatePauseStatement(database, runId),
      ...(action === "abandon"
        ? [
            failedReconciliationWorkflowStatement(database, {
              runId,
              terminalAt: observedAt,
              failureCode: "reconciliation_abandoned",
              diagnosticsJson: canonicalJson([
                { code: "reconciliation_abandoned", detail: "The owner abandoned this paused reconciliation." },
              ]),
            }),
            releaseFailedReconciliationWorkflowStatement(database, {
              activeRunId: runId,
              runId,
              failureCode: "reconciliation_abandoned",
            }),
          ]
        : []),
      retainReconciliationAction(database, runId, input.idempotency_key, request, canonicalJson(result)),
    ]);
  } catch {
    const winner = await reconciliationActionStatement(database, input.idempotency_key).first<{
      request_json: string;
      result_json: string;
    }>();
    if (winner?.request_json === request) return JSON.parse(winner.result_json) as Record<string, unknown>;
    if (winner)
      throw new AdministrationProblem(409, "idempotency_conflict", "This key binds another reconciliation action.");
    throw new AdministrationProblem(
      409,
      "reconciliation_generation_conflict",
      "Inspect the current reconciliation state and generation before acting.",
    );
  }
  return result;
}

export async function pauseFailedReconciliation(
  database: CatalogueStore,
  runId: string,
  generation: number,
  detail: string,
) {
  if (detail.startsWith("reconciliation_capacity_exceeded:")) {
    const base = database;
    const scoped = guardedCatalogueStore(base, () => reconciliationWriterGuard(base, runId, generation));
    const operation = await reconciliationOperationHeaderStatement(database, runId).first<{
      supported_game: string | null;
      ingestion_run_id: string;
      state: string;
      generation: number;
    }>();
    if (operation?.supported_game) {
      if (operation.state !== "preparing" || operation.generation !== generation)
        return {
          preparation_id: runId,
          run_id: operation.ingestion_run_id,
          state: operation.generation !== generation ? "superseded" : operation.state,
          publishable: false,
        };
      await scoped.batch([
        failGamePreparationStatement(scoped, runId, "reconciliation_capacity_exceeded"),
        synchronizeGameCandidatePauseStatement(scoped, runId),
        releaseGamePreparationSlotStatement(scoped, runId),
      ]);
      return {
        preparation_id: runId,
        run_id: operation.ingestion_run_id,
        state: "failed",
        publishable: false,
        diagnostics: [{ code: "reconciliation_capacity_exceeded", detail: detail.slice(0, 1024) }],
      };
    }
    return failReconciliationWorkflow(scoped, runId, new Date().toISOString(), detail);
  }
  await database.batch([
    pauseFailedReconciliationStatement(database, runId, generation, detail),
    synchronizeGameCandidatePauseStatement(database, runId),
  ]);
  const current = await reconciliationOperationHeaderStatement(database, runId).first<{
    state: string;
    supported_game: string | null;
    ingestion_run_id: string;
    candidate_digest: string | null;
    failure_code: string | null;
  }>();
  if (!current) throw new Error("The durable reconciliation operation is unavailable.");
  if (current.supported_game)
    return {
      preparation_id: runId,
      run_id: current.ingestion_run_id,
      state: current.state,
      publishable: current.state === "sealed",
      failure_code: current.failure_code,
      ...(current.state === "sealed" ? { candidate_digest: current.candidate_digest } : {}),
    };
  if (current.state === "sealed" || current.state === "failed") return retainedReconciliationResult(database, runId);
  return { state: current.state, publishable: false, run_id: runId };
}

export async function initializeReconciliationProgress(
  database: CatalogueStore,
  runId: string,
  at: string,
  gamePreparation?: GamePreparationCreation,
) {
  const definitions = JSON.stringify({
    profiles: gameProfileRegistrations(),
    adapters: sourceAdapterRegistrations.map((adapter) =>
      Object.fromEntries(
        Object.entries(adapter).filter(([, value]) => typeof value !== "function" && value !== undefined),
      ),
    ),
  });
  const existing = await reconciliationOperationHeaderStatement(database, runId).first<{
    definition_pins_json: string;
  }>();
  if (existing) {
    assertPinnedDefinitions(existing.definition_pins_json, definitions);
    return;
  }
  const selected = gamePreparation
    ? { games_json: canonicalJson([gamePreparation.supported_game]) }
    : await reconciliationSelectedGamesStatement(database, runId).first<{ games_json: string }>();
  const admissionPins = await entityAdmissionPinStatementsForPreparation(
    database,
    runId,
    JSON.parse(selected?.games_json ?? "[]") as string[],
  );
  try {
    await database.batch([
      gamePreparation
        ? createGamePreparationStatement(database, gamePreparation, at, definitions)
        : createReconciliationOperationStatement(database, runId, at, definitions),
      ...admissionPins,
      ...correctionPinStatementsForPreparation(database, runId, JSON.parse(selected?.games_json ?? "[]") as string[]),
      ...(gamePreparation ? [] : [createGameCandidateIdentitiesStatement(database, runId)]),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("game_candidate_slot_occupied"))
      throw new AdministrationProblem(
        409,
        "game_candidate_slot_occupied",
        "Inspect or finish the existing Catalogue Candidate for this Supported Game first.",
      );
    const winner = await reconciliationOperationHeaderStatement(database, runId).first<{
      definition_pins_json: string;
    }>();
    if (!winner) throw error;
  }
  const retained = await reconciliationOperationHeaderStatement(database, runId).first<{
    definition_pins_json: string;
  }>();
  assertPinnedDefinitions(retained?.definition_pins_json, definitions);
}

function assertPinnedDefinitions(retained: string | undefined, definitions: string) {
  if (retained !== definitions)
    throw new AdministrationProblem(
      409,
      "reconciliation_definition_changed",
      "This reconciliation pins different profile or adapter definitions; create a fresh candidate from retained evidence.",
    );
}

export async function inspectReconciliationPartition(database: CatalogueStore, runId: string, ordinal: string) {
  if (!/^\d+$/.test(ordinal) || !Number.isSafeInteger(Number(ordinal)))
    throw new AdministrationProblem(422, "invalid_cursor", "Use a retained partition ordinal.");
  const row = await reconciliationPartitionStatement(database, runId, Number(ordinal)).first<{
    content: string;
    sha256: string;
    kind: string;
  }>();
  if (!row)
    throw new AdministrationProblem(404, "partition_not_found", "This reconciliation partition is unavailable.");
  const envelopes = JSON.parse(row.content) as { value: unknown; text_parts: unknown[] }[];
  return {
    kind: row.kind,
    sha256: row.sha256,
    records: envelopes.map((record) => record.value),
    text_parts: envelopes.map((record) => record.text_parts),
  };
}

export async function inspectReconciliationInputs(database: CatalogueStore, runId: string, after: string | null) {
  const cursor = after === null ? -1 : Number(after);
  if (!Number.isSafeInteger(cursor) || cursor < -1)
    throw new AdministrationProblem(422, "invalid_cursor", "Use the returned input cursor.");
  const operation = await inspectReconciliationProgress(database, runId);
  const partitions = (await reconciliationInputPartitionsStatement(database, runId, cursor).all<{ ordinal: number }>())
    .results;
  return {
    contract: "card-keepr-reconciliation-input-partitions@1",
    ingestion_run_id: runId,
    verified: operation.input_manifest_digest !== null,
    manifest_digest: operation.input_manifest_digest,
    partitions,
    next_cursor: partitions.length === 100 ? String(partitions.at(-1)!.ordinal) : null,
  };
}

export async function inspectReconciliationInput(database: CatalogueStore, runId: string, ordinal: string) {
  if (!/^\d+$/.test(ordinal) || !Number.isSafeInteger(Number(ordinal)))
    throw new AdministrationProblem(422, "invalid_cursor", "Use a retained input ordinal.");
  const partition = await reconciliationInputPartitionStatement(database, runId, Number(ordinal)).first<{
    kind: string;
    content: string;
    sha256: string;
  }>();
  if (!partition)
    throw new AdministrationProblem(404, "input_partition_not_found", "The requested input partition does not exist.");
  return {
    contract: "card-keepr-reconciliation-input-partition@1",
    ingestion_run_id: runId,
    ordinal: Number(ordinal),
    kind: partition.kind,
    sha256: partition.sha256,
    records: (JSON.parse(partition.content) as { value: unknown }[]).map((record) => record.value),
    text_parts: (JSON.parse(partition.content) as { text_parts: unknown[] }[]).map((record) => record.text_parts),
  };
}

export async function inspectReconciliationText(
  database: CatalogueStore,
  runId: string,
  digest: string,
  ordinal: string,
) {
  if (!/^[a-f0-9]{64}$/.test(digest) || !/^\d+$/.test(ordinal) || !Number.isSafeInteger(Number(ordinal)))
    throw new AdministrationProblem(
      422,
      "invalid_text_reference",
      "Use the digest and ordinal from a retained text reference.",
    );
  const chunk = await reconciliationTextStatement(database, runId, digest, Number(ordinal)).first<{
    content: string;
  }>();
  if (!chunk) throw new AdministrationProblem(404, "text_chunk_not_found", "This retained text chunk does not exist.");
  return {
    contract: "card-keepr-reconciliation-text-chunk@1",
    ingestion_run_id: runId,
    text_sha256: digest,
    ordinal: Number(ordinal),
    content: chunk.content,
    sha256: await sha256Text(chunk.content),
  };
}
import { reconciliationTextStatement } from "./reconciliation-text-repository";
