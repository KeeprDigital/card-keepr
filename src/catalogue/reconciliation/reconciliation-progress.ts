import { retainedReconciliationResult } from "./reconciliation-candidate-store";
import {
  reconciliationInputPartitionStatement,
  reconciliationInputPartitionsStatement,
} from "./reconciliation-input-repository";
import { entityAdmissionPinStatementsForNewRun } from "./entity-admission-pins";
import { reconciliationSelectedGamesStatement } from "./reconciliation-progress-repository";
import {
  failedReconciliationWorkflowStatement,
  releaseFailedReconciliationWorkflowStatement,
} from "./reconciliation-state-repository";
import { gameProfileRegistrations, sourceAdapterRegistrations } from "../adapters";
import { reconciliationPartitionStatement } from "./reconciliation-progress-repository";
import { createReconciliationOperationStatement } from "./reconciliation-progress-repository";
import { pauseFailedReconciliationStatement } from "./reconciliation-progress-repository";
import {
  reconciliationActionStatement,
  reconciliationActionGuard,
  reconciliationActionUpdate,
  retainReconciliationAction,
} from "./reconciliation-progress-repository";
import { AdministrationProblem, canonicalJson, type CatalogueStore } from "../shared";
import {
  reconciliationOperationStatement,
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
  return { contract: "card-keepr-reconciliation-status@1", ...operation };
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
  };
  try {
    await database.batch([
      reconciliationActionGuard(database, runId, action, input.generation),
      reconciliationActionUpdate(database, runId, action, input.generation),
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
  await pauseFailedReconciliationStatement(database, runId, generation, detail).run();
  const current = await reconciliationOperationStatement(database, runId).first<{ state: string }>();
  if (!current) throw new Error("The durable reconciliation operation is unavailable.");
  if (current.state === "sealed" || current.state === "failed") return retainedReconciliationResult(database, runId);
  return { state: current.state, publishable: false, run_id: runId };
}

export async function initializeReconciliationProgress(database: CatalogueStore, runId: string, at: string) {
  const definitions = JSON.stringify({
    profiles: gameProfileRegistrations(),
    adapters: sourceAdapterRegistrations.map((adapter) =>
      Object.fromEntries(
        Object.entries(adapter).filter(([, value]) => typeof value !== "function" && value !== undefined),
      ),
    ),
  });
  const existing = await reconciliationOperationStatement(database, runId).first<{ definition_pins_json: string }>();
  if (existing) {
    assertPinnedDefinitions(existing.definition_pins_json, definitions);
    return;
  }
  const selected = await reconciliationSelectedGamesStatement(database, runId).first<{ games_json: string }>();
  const admissionPins = await entityAdmissionPinStatementsForNewRun(
    database,
    runId,
    JSON.parse(selected?.games_json ?? "[]") as string[],
  );
  try {
    await database.batch([createReconciliationOperationStatement(database, runId, at, definitions), ...admissionPins]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("game_candidate_slot_occupied"))
      throw new AdministrationProblem(
        409,
        "game_candidate_slot_occupied",
        "Inspect or finish the existing Catalogue Candidate for this Supported Game first.",
      );
    const winner = await reconciliationOperationStatement(database, runId).first<{ definition_pins_json: string }>();
    if (!winner) throw error;
  }
  const retained = await reconciliationOperationStatement(database, runId).first<{ definition_pins_json: string }>();
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
  return { kind: row.kind, sha256: row.sha256, records: JSON.parse(row.content) };
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
    records: JSON.parse(partition.content) as unknown[],
  };
}
