import { failIndependentGamePreparation } from "./game-reconciliation-outcome";
import { prepareRunWarningSummary } from "./reconciliation-warning-summary";
import type { ObservationPlan } from "./reconciliation-plan-state";
import { stageCandidatePreparation, type EvidencePartitionInput } from "./reconciliation-staging";
import { prepareGameCandidateManifests } from "./game-candidate";
import { preparationCompleteGuard } from "./reconciliation-preparation-repository";
import { persistCandidatePartitions } from "./reconciliation-partitions";
import { sealReconciliationOperationStatement } from "./reconciliation-progress-repository";
import {
  type CatalogueCandidate,
  type CatalogueDraft,
  type CatalogueStore,
  canonicalJson,
  chunkedPayloadMarker,
  guardedAtomicBatch,
  retainedPayload,
} from "../shared";
import type { ReconciliationWarning } from "./reconciliation-model";
import {
  type ReconciliationTerminalResultRow,
  terminalResultInsertion,
  terminalResultStatement,
} from "./reconciliation-repository";
import {
  beginReconciliationStatement,
  blockedCandidateStatement,
  failedReconciliationStatement,
  failedReconciliationWorkflowStatement,
  reconciliationCandidatePlansStatement,
  reconciliationDigestPayloadStatement,
  releaseFailedReconciliationWorkflowStatement,
  releaseReconciliationRunStatement,
  retainedCandidateResultStatement,
  reviewableCandidateStatement,
} from "./reconciliation-state-repository";

export type CandidatePlanRow = {
  ingestion_run_id: string;
  source_observation_set_id: string;
  source_snapshot_id: string;
  source_observation_id: string;
  observation_kind: "card_printing" | "official_erratum";
  card_id: string;
  printing_id: string | null;
  source_lineage: string;
  locator: string | null;
  variant_key: string | null;
  compatibility_json: string | null;
  memberships_json: string;
  warnings_json: string;
  withdrawal_json: string | null;
  source_card_facts_json: string | null;
  digest_payload_json: string;
};

export async function persistReviewableCandidate(
  database: CatalogueStore,
  input: {
    runId: string;
    independentGame?: boolean;
    partitions: AsyncIterable<EvidencePartitionInput>;
    plans: AsyncIterable<ObservationPlan>;
    warnings:
      | Iterable<ReconciliationWarning | Record<string, unknown>>
      | AsyncIterable<ReconciliationWarning | Record<string, unknown>>;
    candidate: Record<string, unknown>;
    draft: CatalogueDraft;
    digestPayload: Record<string, unknown>;
    candidateDigest: string;
    candidateCatalogueDigest: string;
    observedAt: string;
    yieldAtCheckpoint?: boolean;
  },
): Promise<void> {
  const manifest = await persistCandidatePartitions(
    database,
    input.runId,
    input.candidate,
    input.warnings,
    input.yieldAtCheckpoint,
  );
  if (input.independentGame) {
    const gameSeals = await prepareGameCandidateManifests(
      database,
      input.runId,
      input.draft,
      manifest.digest,
      input.partitions,
      input.yieldAtCheckpoint,
    );
    await database.batch([
      ...gameSeals,
      sealReconciliationOperationStatement(
        database,
        input.runId,
        input.candidateDigest,
        manifest.digest,
        manifest.count,
      ),
    ]);
    return;
  }
  const approvalDeadline = new Date(Date.parse(input.observedAt) + 7 * 24 * 60 * 60 * 1_000).toISOString();
  const runWarnings = await prepareRunWarningSummary(database, input.runId, input.warnings, input.yieldAtCheckpoint);
  const preparationCount = await stageCandidatePreparation(database, input);
  const gameSeals = await prepareGameCandidateManifests(
    database,
    input.runId,
    input.draft,
    manifest.digest,
    input.partitions,
    input.yieldAtCheckpoint,
  );
  const statements = [
    preparationCompleteGuard(database, input.runId, preparationCount),
    ...gameSeals,
    beginReconciliationStatement(database, input.runId),
    sealReconciliationOperationStatement(database, input.runId, input.candidateDigest, manifest.digest, manifest.count),
    reviewableCandidateStatement(database, {
      candidatePayload: chunkedPayloadMarker("candidate"),
      candidateDigest: input.candidateDigest,
      catalogueDigest: input.candidateCatalogueDigest,
      createdAt: input.observedAt,
      approvalDeadline: approvalDeadline,
      warningsJson: canonicalJson(runWarnings),
      runId: input.runId,
    }),
  ];
  await database.batch(guardedAtomicBatch(statements));
}

export async function persistBlockedCandidate(
  database: CatalogueStore,
  input: {
    runId: string;
    partitions: AsyncIterable<EvidencePartitionInput>;
    plans: AsyncIterable<ObservationPlan>;
    diagnostics: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>;
    candidate: Record<string, unknown>;
    draft: CatalogueDraft;
    digestPayload: Record<string, unknown>;
    candidateDigest: string;
    candidateCatalogueDigest: string;
    observedAt: string;
    yieldAtCheckpoint?: boolean;
    failureCode?: string;
  },
): Promise<void> {
  const approvalDeadline = new Date(Date.parse(input.observedAt) + 7 * 24 * 60 * 60 * 1_000).toISOString();
  const failureCode = input.failureCode ?? "printing_reconciliation_blocked";
  await persistCandidatePartitions(database, input.runId, input.candidate, input.diagnostics, input.yieldAtCheckpoint);
  const runDiagnostics = await prepareRunWarningSummary(
    database,
    input.runId,
    input.diagnostics,
    input.yieldAtCheckpoint,
  );
  const preparationCount = await stageCandidatePreparation(database, input);
  const statements = [
    preparationCompleteGuard(database, input.runId, preparationCount),
    beginReconciliationStatement(database, input.runId),
    blockedCandidateStatement(database, {
      candidatePayload: chunkedPayloadMarker("candidate"),
      candidateDigest: input.candidateDigest,
      catalogueDigest: input.candidateCatalogueDigest,
      createdAt: input.observedAt,
      approvalDeadline: approvalDeadline,
      terminalAt: input.observedAt,
      failureCode: failureCode,
      diagnosticsJson: canonicalJson(runDiagnostics),
      runId: input.runId,
    }),
    releaseReconciliationRunStatement(database, input.runId),
  ];
  await database.batch(guardedAtomicBatch(statements));
}

export async function failReconciliation(
  database: CatalogueStore,
  runId: string,
  diagnostics: readonly Record<string, unknown>[],
  observedAt: string,
): Promise<Record<string, unknown>> {
  const native = await failIndependentGamePreparation(
    database,
    runId,
    String(diagnostics[0]?.code ?? "retained_evidence_invalid"),
    diagnostics,
  );
  if (native) return native;
  const runDiagnostics = diagnostics.map((diagnostic) => ({
    code: String(diagnostic.code),
    detail: String(diagnostic.detail),
  }));
  const result = terminalFailureResult(runId, diagnostics);
  await database.batch([
    terminalResultInsertion(database, runId, result),
    beginReconciliationStatement(database, runId),
    failedReconciliationStatement(database, {
      terminalAt: observedAt,
      diagnosticsJson: canonicalJson(runDiagnostics),
      runId: runId,
    }),
    releaseReconciliationRunStatement(database, runId),
  ]);
  return requiredTerminalResult(database, runId);
}

export async function failReconciliationWorkflow(
  database: CatalogueStore,
  runId: string,
  observedAt: string,
  detail: string,
): Promise<Record<string, unknown>> {
  const failureCode = detail.startsWith("reconciliation_capacity_exceeded:")
    ? "reconciliation_capacity_exceeded"
    : detail.includes("curated_revision_reconfirmation_required")
      ? "curated_revision_reconfirmation_required"
      : "reconciliation_workflow_failed";
  const diagnostic = {
    code: failureCode,
    detail,
  };
  const result = terminalFailureResult(runId, [diagnostic]);
  await database.batch([
    terminalResultInsertion(database, runId, result),
    failedReconciliationWorkflowStatement(database, {
      terminalAt: observedAt,
      failureCode: failureCode,
      diagnosticsJson: canonicalJson([diagnostic]),
      runId: runId,
    }),
    releaseFailedReconciliationWorkflowStatement(database, {
      activeRunId: runId,
      runId: runId,
      failureCode: failureCode,
    }),
  ]);
  return requiredTerminalResult(database, runId);
}

export async function reconciliationCandidatePlans(
  database: CatalogueStore,
  runId: string,
): Promise<CandidatePlanRow[]> {
  const rows = await reconciliationCandidatePlansStatement(database, runId).all<CandidatePlanRow>();
  return rows.results;
}

export async function digestBoundCandidatePayload(database: CatalogueStore, runId: string): Promise<string | null> {
  const row = await reconciliationDigestPayloadStatement(database, runId).first<{ digest_payload_json: string }>();
  return row === null ? null : retainedPayload(database, runId, "digest", row.digest_payload_json);
}

export async function retainedReconciliationResult(
  database: CatalogueStore,
  runId: string,
): Promise<Record<string, unknown>> {
  const terminal = await terminalResult(database, runId);
  if (terminal !== null) return terminal;
  const row = await retainedCandidateResultStatement(database, runId).first<{
    candidate_json: string;
    candidate_digest: string | null;
    expected_current_revision_id: string;
    digest_payload_json: string;
  }>();
  if (row?.candidate_digest === null || row === null) {
    throw new Error("The retained reconciliation result is unavailable.");
  }
  const candidate = JSON.parse(
    await retainedPayload(database, runId, "candidate", row.candidate_json),
  ) as CatalogueCandidate;
  const digestPayload = JSON.parse(await retainedPayload(database, runId, "digest", row.digest_payload_json)) as {
    reconciliation_response?: unknown;
  };
  const response = reconciliationResponseMetadata(digestPayload.reconciliation_response);
  const cardIds = new Set(response.observed_card_ids);
  const printingIds = new Set(response.observed_printing_ids);
  const productIds = new Set(response.observed_product_ids);
  return {
    contract: "card-keepr-card-printing-reconciliation@2",
    run_id: runId,
    state: response.state,
    publishable: response.publishable,
    candidate_digest: row.candidate_digest,
    expected_current_revision_id: row.expected_current_revision_id,
    source_observation_set_id: response.source_observation_set_id,
    cards: candidate.cards.filter(({ id }) => cardIds.has(id)),
    printings: candidate.printings.filter(({ id }) => printingIds.has(id)),
    products: (candidate.products ?? []).filter(({ id }) => productIds.has(id)),
    errata: candidate.errata ?? [],
    diagnostics: response.diagnostics,
    warnings: response.warnings,
  };
}

function terminalFailureResult(
  runId: string,
  diagnostics: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    contract: "card-keepr-card-printing-reconciliation@2",
    run_id: runId,
    state: "failed",
    publishable: false,
    cards: [],
    printings: [],
    products: [],
    errata: [],
    diagnostics,
    warnings: [],
  };
}

async function requiredTerminalResult(database: CatalogueStore, runId: string): Promise<Record<string, unknown>> {
  const result = await terminalResult(database, runId);
  if (result === null) {
    throw new Error("The terminal reconciliation result is unavailable.");
  }
  return result;
}

async function terminalResult(database: CatalogueStore, runId: string): Promise<Record<string, unknown> | null> {
  const row = await terminalResultStatement(database, runId).first<ReconciliationTerminalResultRow>();
  if (row === null) return null;
  const parsed = JSON.parse(row.result_json) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("contract" in parsed) ||
    parsed.contract !== "card-keepr-card-printing-reconciliation@2" ||
    !("run_id" in parsed) ||
    parsed.run_id !== runId ||
    !("state" in parsed) ||
    parsed.state !== "failed" ||
    !("publishable" in parsed) ||
    parsed.publishable !== false
  ) {
    throw new Error("The retained terminal reconciliation result is invalid.");
  }
  return parsed as Record<string, unknown>;
}

function reconciliationResponseMetadata(value: unknown): {
  state: "awaiting_approval" | "failed";
  publishable: boolean;
  source_observation_set_id: string;
  observed_card_ids: string[];
  observed_printing_ids: string[];
  observed_product_ids: string[];
  diagnostics: Record<string, unknown>[];
  warnings: Record<string, unknown>[];
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The retained reconciliation response is invalid.");
  }
  const response = value as Record<string, unknown>;
  if (
    !["awaiting_approval", "failed"].includes(String(response.state)) ||
    typeof response.publishable !== "boolean" ||
    typeof response.source_observation_set_id !== "string" ||
    !stringArray(response.observed_card_ids) ||
    !stringArray(response.observed_printing_ids) ||
    !stringArray(response.observed_product_ids) ||
    !recordArray(response.diagnostics) ||
    !recordArray(response.warnings)
  ) {
    throw new Error("The retained reconciliation response is invalid.");
  }
  return response as ReturnType<typeof reconciliationResponseMetadata>;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function recordArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) && value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))
  );
}
