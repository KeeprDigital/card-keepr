import { buildCatalogueExport } from "../export";
import { digestBoundCandidatePayload, reconciliationPublication } from "../reconciliation";
import {
  AdministrationProblem,
  type CatalogueCandidate,
  CatalogueExportLimitError,
  type CatalogueStore,
  canonicalJson,
  retainedPayload,
  type SupportedGame,
  sha256,
} from "../shared";
import {
  administrationClaim,
  currentAdministrationClaimOwner,
  pendingAdministrationOperation,
  replayAdministration,
} from "./administration-idempotency";
import { failReservedPublication } from "./publication-cleanup";
import { commitVerifiedPublication } from "./publication-commit";
import {
  assertReservedPublicationOwnsUnpublishedPrefix,
  isExactVerifiedExport,
  listCatalogueExportPrefix,
  PublicationPrefixOwnershipError,
  requiredCandidateCatalogueDigest,
  reservedPublicationOwnsUnpublishedPrefix,
} from "./publication-storage";
import { nextPublicationToReconcileStatement } from "./publication-storage-repository";
import { approvalInProgress, parseApproval } from "./run-document-codec";
import {
  currentCatalogueState,
  currentOperationState,
  expireOverdueRuns,
  publicationFailureProblem,
  requiredRun,
} from "./run-storage";
import type { ApproveRunRequest, RunRow } from "./run-types";
import {
  assertOpaqueId,
  assertSha256,
  errorMessage,
  isIsoInstant,
  isOpaqueIdentity,
  isSha256Digest,
  parseSelectedGames,
  publicationWriterToken,
  requiredPublicationValue,
} from "./run-values";

export async function reconcileAbandonedPublication(
  database: CatalogueStore,
  bucket: R2Bucket,
  observedAt: string,
): Promise<void> {
  const run = await nextPublicationToReconcileStatement(database, observedAt).first<RunRow>();
  if (run === null) return;
  if (!(await reservedPublicationOwnsUnpublishedPrefix(database, run))) {
    await failReservedPublication(
      database,
      run,
      null,
      observedAt,
      new AdministrationProblem(
        500,
        "publication_abandoned",
        "The reserved publication could not be safely reconciled.",
      ),
    );
    return;
  }
  try {
    await reconcileReservedPublication(database, bucket, run, observedAt);
  } catch (error) {
    const revisionId = run.publication_revision_id;
    const ownershipLost =
      error instanceof PublicationPrefixOwnershipError ||
      !(await reservedPublicationOwnsUnpublishedPrefix(database, run));
    const objectKeys =
      !ownershipLost && revisionId !== null && isOpaqueIdentity(revisionId)
        ? await listCatalogueExportPrefix(bucket, revisionId)
        : ownershipLost
          ? null
          : [];
    await failReservedPublication(
      database,
      run,
      objectKeys,
      observedAt,
      error instanceof AdministrationProblem
        ? error
        : error instanceof CatalogueExportLimitError
          ? publicationFailureProblem(error)
          : errorMessage(error).includes("publication_guard_failed")
            ? new AdministrationProblem(
                409,
                "publication_precondition_failed",
                "The publication guards changed while the reserved publication was interrupted.",
              )
            : new AdministrationProblem(
                500,
                "publication_abandoned",
                "The reserved publication could not be safely reconciled.",
              ),
    );
  }
}

async function reconcileReservedPublication(
  database: CatalogueStore,
  bucket: R2Bucket,
  run: RunRow,
  observedAt: string,
): Promise<void> {
  const candidate = JSON.parse(
    await retainedPayload(database, run.id, "candidate", run.candidate_json),
  ) as CatalogueCandidate;
  const approval = parseApproval(run.approval_json);
  const revisionId = requiredPublicationValue(run.publication_revision_id, "revision ID");
  const publishedAt = requiredPublicationValue(run.publication_started_at, "start time");
  const manifestDigest = requiredPublicationValue(run.publication_manifest_digest, "manifest digest");
  requiredPublicationValue(run.approval_idempotency_key, "idempotency key");
  const digestPayload = (await digestBoundCandidatePayload(database, run.id)) ?? canonicalJson(candidate);
  if (
    approval.candidate_digest !== run.candidate_digest ||
    approval.expected_current_revision_id !== run.expected_current_revision_id ||
    approval.approved_at !== publishedAt ||
    !isIsoInstant(publishedAt) ||
    !isSha256Digest(manifestDigest) ||
    !isOpaqueIdentity(revisionId) ||
    run.publication_writer_token !== publicationWriterToken(revisionId) ||
    !parseSelectedGames(run.selected_games_json).every((game) =>
      candidate.selected_games.includes(game as SupportedGame),
    ) ||
    (await sha256(new TextEncoder().encode(digestPayload))) !== run.candidate_digest
  ) {
    throw new Error("The reserved publication metadata is invalid.");
  }
  const requestJson = canonicalJson({
    run_id: run.id,
    candidate_digest: approval.candidate_digest,
    expected_current_revision_id: approval.expected_current_revision_id,
  });
  const reconciliation = await reconciliationPublication(database, run.id, revisionId, publishedAt);
  const exportCandidate = candidate;
  const catalogueExport = await buildCatalogueExport(
    exportCandidate,
    requiredCandidateCatalogueDigest(run),
    revisionId,
    publishedAt,
    reconciliation === null
      ? undefined
      : {
          cards: reconciliation.cardLifecycles,
          printings: reconciliation.printingLifecycles,
          products: reconciliation.productLifecycles,
          productRelationships: reconciliation.productRelationshipLifecycles,
          erratumTargets: reconciliation.erratumTargetLifecycles,
          relationships: reconciliation.relationshipEvidence,
          locators: reconciliation.locatorEvidence,
          cardEvidence: reconciliation.cardEvidence,
          printingEvidence: reconciliation.printingEvidence,
        },
  );
  await assertReservedPublicationOwnsUnpublishedPrefix(database, run.id);
  const exactExport =
    catalogueExport.manifest.manifest_sha256 === manifestDigest &&
    (await isExactVerifiedExport(bucket, revisionId, catalogueExport));
  await assertReservedPublicationOwnsUnpublishedPrefix(database, run.id);
  const [catalogue, operation] = await Promise.all([currentCatalogueState(database), currentOperationState(database)]);
  const guardsValid =
    catalogue.current_revision_id === approval.expected_current_revision_id &&
    run.expected_current_revision_id === approval.expected_current_revision_id &&
    operation.active_ingestion_run_id === run.id &&
    operation.recovery_health === "healthy";
  if (exactExport && guardsValid) {
    const claimOwner = await currentAdministrationClaimOwner(
      database,
      requiredPublicationValue(run.approval_idempotency_key, "idempotency key"),
      "approve_ingestion_run",
      requestJson,
    );
    await commitVerifiedPublication(database, {
      run,
      candidate,
      catalogueExport,
      reconciliation,
      requestJson,
      completedAt: observedAt,
      ...(claimOwner === null ? {} : { claimOwner }),
    });
    return;
  }

  const problem = guardsValid
    ? new AdministrationProblem(
        500,
        "publication_abandoned",
        "The reserved publication did not contain the complete verified Catalogue Export.",
      )
    : new AdministrationProblem(
        409,
        "publication_precondition_failed",
        "The publication guards changed while the reserved publication was interrupted.",
      );
  const cleanupKeys = await listCatalogueExportPrefix(bucket, revisionId);
  await failReservedPublication(database, run, cleanupKeys, observedAt, problem);
}

// This boundary observes only an approval that was durably reserved before
// aggregate publication was retired. It cannot acquire a claim or start writes.
export async function observeHistoricalRunApproval(
  database: CatalogueStore,
  catalogueExports: R2Bucket,
  runId: string,
  request: ApproveRunRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  assertOpaqueId(runId, "run_id");
  assertSha256(request.candidate_digest, "candidate_digest");
  assertOpaqueId(request.expected_current_revision_id, "expected_current_revision_id");
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({
    run_id: runId,
    candidate_digest: request.candidate_digest,
    expected_current_revision_id: request.expected_current_revision_id,
  });
  const replay = () => replayAdministration(database, request.idempotency_key, "approve_ingestion_run", requestJson);
  const prior = await replay();
  if (prior !== null) return prior;
  const claim = await administrationClaim(database, request.idempotency_key);
  if (claim !== null && (claim.operation !== "approve_ingestion_run" || claim.request_json !== requestJson))
    throw new AdministrationProblem(
      409,
      "idempotency_key_reused",
      "The idempotency key was already used for a different administration request.",
    );
  const run = await requiredRun(database, runId);
  if (run.state !== "publishing")
    throw new AdministrationProblem(
      410,
      "run_approval_retired",
      "New run approval is retired. Inspect and approve the exact whole game candidate through /v1/game-candidates and /v1/publications/start; use publication status for pending completion.",
    );
  // Validate the existing key, digest and predecessor before any recovery work.
  approvalInProgress(run, request, requestJson);
  if (claim !== null && Date.parse(claim.claim_expires_at) > Date.parse(observedAt))
    return pendingAdministrationOperation(
      { key: request.idempotency_key, operation: "approve_ingestion_run", requestJson, observedAt },
      claim,
    );
  await expireOverdueRuns(database, observedAt);
  await reconcileAbandonedPublication(database, catalogueExports, observedAt);
  const recovered = await replay();
  if (recovered !== null) return recovered;
  return approvalInProgress(await requiredRun(database, runId), request, requestJson);
}
