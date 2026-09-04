import { AdministrationProblem, type CatalogueStore, canonicalJson, isTerminalIngestionRunState } from "../shared";
import {
  acquireAdministrationClaimStatement,
  administrationClaimStatement,
  administrationOutcomeStatement,
  completeAdministrationStatement,
  legacyAdministrationRunStatement,
  recordAdministrationProblemStatement,
  releaseAdministrationClaimStatement,
  takeOverAdministrationClaimStatement,
} from "./administration-idempotency-repository";

import { decodePublicRunDocument, publicRun } from "./run-document-codec";
import { publicationCleanup } from "./run-storage";
import {
  type IdempotencyClaimOwner,
  type IdempotencyClaimRow,
  type IdempotencyContext,
  type IdempotencyRow,
  publicationLeaseMilliseconds,
  type RunRow,
} from "./run-types";
import { errorMessage, hasOnlyKeys, isIsoInstant, isRecord, parseJson } from "./run-values";

export async function administrationClaim(database: CatalogueStore, key: string): Promise<IdempotencyClaimRow | null> {
  return administrationClaimStatement(database, key).first<IdempotencyClaimRow>();
}

export async function currentAdministrationClaimOwner(
  database: CatalogueStore,
  key: string,
  operation: string,
  requestJson: string,
): Promise<IdempotencyClaimOwner | null> {
  const claim = await administrationClaim(database, key);
  if (claim === null) return null;
  if (claim.operation !== operation || claim.request_json !== requestJson) {
    throw new Error("The administration claim does not match its domain operation.");
  }
  return {
    ownerToken: claim.owner_token,
    version: claim.claim_version,
  };
}

export function administrationClaimDeleteStatement(
  database: CatalogueStore,
  context: {
    key: string;
    operation: string;
    requestJson: string;
  },
  owner: IdempotencyClaimOwner | null,
): D1PreparedStatement {
  return releaseAdministrationClaimStatement(database, {
    key: context.key,
    operation: context.operation,
    requestJson: context.requestJson,
    ownerToken: owner?.ownerToken ?? null,
    claimVersion: owner?.version ?? null,
  });
}

export function idempotencyCompletionStatements(
  database: CatalogueStore,
  input: {
    key: string;
    operation: string;
    requestJson: string;
    response: Record<string, unknown>;
    status: number;
    createdAt: string;
    claimOwner?: IdempotencyClaimOwner | null;
  },
): D1PreparedStatement[] {
  return [
    completeAdministrationStatement(database, {
      key: input.key,
      operation: input.operation,
      requestJson: input.requestJson,
      responseJson: canonicalJson(input.response),
      status: input.status,
      createdAt: input.createdAt,
      ownerToken: input.claimOwner?.ownerToken ?? null,
      claimVersion: input.claimOwner?.version ?? null,
    }),
    administrationClaimDeleteStatement(database, input, input.claimOwner ?? null),
  ];
}

export async function replayAdministration(
  database: CatalogueStore,
  key: string,
  operation: string,
  requestJson: string,
): Promise<Record<string, unknown> | null> {
  const prior = await administrationOutcomeStatement(database, key).first<IdempotencyRow>();
  if (prior === null) {
    return replayLegacyAdministration(database, key, operation, requestJson);
  }
  if (prior.operation !== operation || prior.request_json !== requestJson) {
    throw new AdministrationProblem(
      409,
      "idempotency_key_reused",
      "The idempotency key was already used for a different administration request.",
    );
  }
  const persisted = parseJson(prior.response_json, "Administration idempotency outcome");
  if (prior.outcome === "problem") {
    if (
      !isRecord(persisted) ||
      !hasOnlyKeys(persisted, ["code", "detail"]) ||
      typeof persisted.code !== "string" ||
      typeof persisted.detail !== "string" ||
      !Number.isInteger(prior.http_status) ||
      prior.http_status < 400 ||
      prior.http_status > 599
    ) {
      throw new Error("The persisted administration problem outcome is invalid.");
    }
    throw new AdministrationProblem(prior.http_status, persisted.code, persisted.detail);
  }
  const result = decodePublicRunDocument(persisted);
  await assertSuccessfulReplayCorrelation(database, result, prior, key, requestJson);
  return result;
}

async function assertSuccessfulReplayCorrelation(
  database: CatalogueStore,
  run: Record<string, unknown>,
  prior: IdempotencyRow,
  key: string,
  requestJson: string,
): Promise<void> {
  const request = parseJson(requestJson, "Administration idempotency request");
  const expectedStatus = prior.operation === "retry_ingestion_run" ? 201 : 200;
  let correlated = false;
  if (isRecord(request)) {
    if (prior.operation === "retry_ingestion_run") {
      correlated =
        hasOnlyKeys(request, ["source_run_id"]) &&
        typeof request.source_run_id === "string" &&
        run.linked_run_id === request.source_run_id &&
        run.idempotency_key === key &&
        (run.state === "awaiting_approval" ||
          (run.state === "failed" && run.failure_code === "curated_revision_reconfirmation_required"));
    } else if (prior.operation === "approve_ingestion_run") {
      correlated =
        hasOnlyKeys(request, ["run_id", "candidate_digest", "expected_current_revision_id"]) &&
        run.id === request.run_id &&
        run.state === "published" &&
        isRecord(run.approval) &&
        run.approval.candidate_digest === request.candidate_digest &&
        run.approval.expected_current_revision_id === request.expected_current_revision_id;
    } else if (prior.operation === "reject_ingestion_run") {
      correlated =
        hasOnlyKeys(request, ["run_id", "candidate_digest"]) &&
        run.id === request.run_id &&
        run.state === "rejected" &&
        Array.isArray(run.approval_history) &&
        run.approval_history.length === 1 &&
        isRecord(run.approval_history[0]) &&
        run.approval_history[0].action === "rejected" &&
        run.approval_history[0].candidate_digest === request.candidate_digest;
    } else if (prior.operation === "retry_publication_cleanup") {
      const currentCleanup =
        typeof request.run_id === "string" ? await publicationCleanup(database, request.run_id) : null;
      correlated =
        hasOnlyKeys(request, ["run_id"]) &&
        run.id === request.run_id &&
        run.state === "failed" &&
        isRecord(run.publication_cleanup) &&
        run.publication_cleanup.state === "completed" &&
        currentCleanup?.state === "completed" &&
        currentCleanup.claim_version === run.publication_cleanup.generation;
    }
  }
  if (prior.outcome !== "success" || prior.http_status !== expectedStatus || !correlated) {
    throw new Error("The persisted administration success outcome does not match its request.");
  }
}

export async function idempotentAdministration(
  database: CatalogueStore,
  context: IdempotencyContext,
  operation: (owner: IdempotencyClaimOwner) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const replay = await replayAdministration(database, context.key, context.operation, context.requestJson);
  if (replay !== null) return replay;
  const acquisition = await claimAdministration(database, context);
  if (acquisition.owner === null) {
    const concurrentReplay = await replayAdministration(database, context.key, context.operation, context.requestJson);
    if (concurrentReplay !== null) return concurrentReplay;
    return pendingAdministrationOperation(context, acquisition.claim);
  }
  const owner = acquisition.owner;
  const takeoverReplay = await replayAdministration(database, context.key, context.operation, context.requestJson);
  if (takeoverReplay !== null) return takeoverReplay;
  if (!isReplaySafeAdministrationOperation(context.operation)) {
    return pendingAdministrationOperation(context, acquisition.claim);
  }
  try {
    const result = await operation(owner);
    return isAdministrationInProgress(result)
      ? pendingAdministrationOperation(context, {
          operation: context.operation,
          request_json: context.requestJson,
          claimed_at: context.observedAt,
          owner_token: owner.ownerToken,
          claim_version: owner.version,
          claim_expires_at: acquisition.claim.claim_expires_at,
        })
      : result;
  } catch (error) {
    if (!(error instanceof AdministrationProblem)) throw error;
    if (!error.persistOutcome) {
      await releaseAdministrationClaim(database, context, owner);
      throw error;
    }
    try {
      await database.batch([
        recordAdministrationProblemStatement(database, {
          key: context.key,
          operation: context.operation,
          requestJson: context.requestJson,
          responseJson: canonicalJson({
            code: error.code,
            detail: error.message,
          }),
          status: error.status,
          createdAt: context.observedAt,
          ownerToken: owner.ownerToken,
          claimVersion: owner.version,
        }),
        administrationClaimDeleteStatement(database, context, owner),
      ]);
    } catch (persistError) {
      const ownerChanged = errorMessage(persistError).includes("administration_idempotency_owner_changed");
      if (!ownerChanged && !errorMessage(persistError).includes("administration_idempotency.idempotency_key")) {
        throw persistError;
      }
      const concurrentReplay = await replayAdministration(
        database,
        context.key,
        context.operation,
        context.requestJson,
      );
      if (concurrentReplay !== null) return concurrentReplay;
      if (ownerChanged) {
        const currentClaim = await administrationClaim(database, context.key);
        if (
          currentClaim !== null &&
          currentClaim.operation === context.operation &&
          currentClaim.request_json === context.requestJson
        ) {
          return pendingAdministrationOperation(context, currentClaim);
        }
      }
    }
    throw error;
  }
}

function isReplaySafeAdministrationOperation(operation: string): boolean {
  return ["retry_ingestion_run", "approve_ingestion_run", "reject_ingestion_run", "retry_publication_cleanup"].includes(
    operation,
  );
}

function isAdministrationInProgress(value: Record<string, unknown>): boolean {
  return value.contract === "card-keepr-administration-operation@1" && value.status === "in_progress";
}

async function claimAdministration(
  database: CatalogueStore,
  context: IdempotencyContext,
): Promise<{
  claim: IdempotencyClaimRow;
  owner: IdempotencyClaimOwner | null;
}> {
  const ownerToken = `administration-claim:${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.parse(context.observedAt) + publicationLeaseMilliseconds).toISOString();
  try {
    const inserted = await acquireAdministrationClaimStatement(database, {
      key: context.key,
      operation: context.operation,
      requestJson: context.requestJson,
      claimedAt: context.observedAt,
      ownerToken: ownerToken,
      expiresAt: expiresAt,
    }).first<IdempotencyClaimRow>();
    if (inserted === null) {
      throw new Error("The administration claim was not inserted.");
    }
    return {
      claim: inserted,
      owner: { ownerToken, version: inserted.claim_version },
    };
  } catch (error) {
    if (
      errorMessage(error).includes("administration_idempotency_claims.idempotency_key") ||
      errorMessage(error).includes("administration_idempotency_completed")
    ) {
      const prior = await administrationClaim(database, context.key);
      if (prior === null) {
        const replay = await replayAdministration(database, context.key, context.operation, context.requestJson);
        if (replay !== null) {
          return {
            claim: {
              operation: context.operation,
              request_json: context.requestJson,
              claimed_at: context.observedAt,
              owner_token: ownerToken,
              claim_version: 0,
              claim_expires_at: context.observedAt,
            },
            owner: null,
          };
        }
        throw new Error("The administration idempotency claim changed without an outcome.");
      }
      if (prior.operation !== context.operation || prior.request_json !== context.requestJson) {
        throw new AdministrationProblem(
          409,
          "idempotency_key_reused",
          "The idempotency key was already used for a different administration request.",
        );
      }
      if (
        !isIsoInstant(prior.claim_expires_at) ||
        Date.parse(context.observedAt) < Date.parse(prior.claim_expires_at)
      ) {
        return { claim: prior, owner: null };
      }
      const takenOver = await takeOverAdministrationClaimStatement(database, {
        claimedAt: context.observedAt,
        ownerToken: ownerToken,
        expiresAt: expiresAt,
        key: context.key,
        operation: context.operation,
        requestJson: context.requestJson,
        priorOwnerToken: prior.owner_token,
        priorVersion: prior.claim_version,
        priorExpiresAt: prior.claim_expires_at,
      }).first<IdempotencyClaimRow>();
      if (takenOver === null) {
        const winner = await administrationClaim(database, context.key);
        if (winner === null) {
          const replay = await replayAdministration(database, context.key, context.operation, context.requestJson);
          if (replay !== null) {
            return { claim: prior, owner: null };
          }
          throw new Error("The administration claim takeover changed without an outcome.");
        }
        return { claim: winner, owner: null };
      }
      return {
        claim: takenOver,
        owner: {
          ownerToken,
          version: takenOver.claim_version,
        },
      };
    }
    throw error;
  }
}

function pendingAdministrationOperation(
  context: IdempotencyContext,
  claim: IdempotencyClaimRow,
): Record<string, unknown> {
  const request = parseJson(context.requestJson, "Administration idempotency claim request");
  const runId = isRecord(request) && typeof request.run_id === "string" ? request.run_id : null;
  return {
    contract: "card-keepr-administration-operation@1",
    operation: context.operation,
    status: "in_progress",
    idempotency_key: context.key,
    claimed_at: claim.claimed_at,
    retry_after: claim.claim_expires_at,
    ...(runId === null ? {} : { run_id: runId }),
    links: {
      ...(runId === null ? {} : { run: `/v1/ingestion-runs/${runId}` }),
      status: "/v1/status",
    },
  };
}

async function releaseAdministrationClaim(
  database: CatalogueStore,
  context: IdempotencyContext,
  owner: IdempotencyClaimOwner,
): Promise<void> {
  await administrationClaimDeleteStatement(database, context, owner).run();
}

async function replayLegacyAdministration(
  database: CatalogueStore,
  key: string,
  operation: string,
  requestJson: string,
): Promise<Record<string, unknown> | null> {
  const run = await legacyAdministrationRunStatement(database, key).first<RunRow>();
  if (run === null) return null;

  if (operation === "approve_ingestion_run" && run.approval_idempotency_key === key) {
    const legacyRequestJson = canonicalJson({
      run_id: run.id,
      candidate_digest: run.candidate_digest,
      expected_current_revision_id: run.expected_current_revision_id,
    });
    if (legacyRequestJson === requestJson && isTerminalIngestionRunState(run.state)) {
      return publicRun(run);
    }
    if (legacyRequestJson === requestJson) return null;
  }
  throw new AdministrationProblem(
    409,
    "idempotency_key_reused",
    "The idempotency key was already used for a different administration request.",
  );
}

export async function replayAfterConflict(
  database: CatalogueStore,
  key: string,
  operation: string,
  requestJson: string,
  error: unknown,
): Promise<Record<string, unknown> | null> {
  if (
    !errorMessage(error).includes("administration_idempotency.idempotency_key") &&
    !errorMessage(error).includes("active_ingestion_run") &&
    !errorMessage(error).includes("publication_writer_fenced")
  ) {
    return null;
  }
  return replayAdministration(database, key, operation, requestJson);
}
