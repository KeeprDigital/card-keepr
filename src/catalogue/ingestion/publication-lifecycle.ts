import {
  nextPublicationToReconcileStatement,
  candidateLegalityEvidenceStatement,
  catalogueRevisionDigestStatement,
} from "./publication-storage-repository";
import { type BuiltCatalogueExport, buildCatalogueExport } from "../export";
import { digestBoundCandidatePayload, reconciliationPublication } from "../reconciliation";
import {
  AdministrationProblem,
  byteBoundedJsonArrays,
  type CatalogueCandidate,
  CatalogueExportLimitError,
  canonicalJson,
  catalogueRevisionIdentity,
  retainedPayload,
  type SupportedGame,
  sha256,
} from "../shared";
import {
  currentAdministrationClaimOwner,
  idempotentAdministration,
  replayAfterConflict,
} from "./administration-idempotency";
import { attemptPublicationCleanup, failReservedPublication, failUnreservedPublication } from "./publication-cleanup";
import { commitVerifiedPublication, publishNoChange } from "./publication-commit";
import {
  assertBuiltPublicationBudget,
  assertPublicationAggregateBudget,
  assertReservedPublicationOwnsUnpublishedPrefix,
  isExactVerifiedExport,
  listCatalogueExportPrefix,
  PublicationPrefixOwnershipError,
  requiredCandidateCatalogueDigest,
  reservedPublicationOwnsUnpublishedPrefix,
  reservePublication,
  storeAndVerifyExport,
  storeAndVerifyPrintingImages,
} from "./publication-storage";
import { approvalInProgress, parseApproval } from "./run-document-codec";
import { checkedFreshnessAreasForRun, sourceFreshnessForExport } from "./run-freshness";
import {
  assertRunIsApprovable,
  currentCatalogueState,
  currentOperationState,
  expireOverdueRuns,
  publicationFailureProblem,
  requiredRun,
  throwApprovalFailure,
} from "./run-storage";
import type { ApproveRunRequest, IdempotencyClaimOwner, RunRow } from "./run-types";
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
  database: D1Database,
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
  database: D1Database,
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
  const sourceFreshness = await sourceFreshnessForExport(
    database,
    candidate.selected_games,
    await checkedFreshnessAreasForRun(
      database,
      parseSelectedGames(run.selected_games_json),
      run.id,
      candidate,
      publishedAt,
    ),
    publishedAt,
  );
  const exportCandidate = await candidateWithCanonicalLegalityProvenance(database, candidate);
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
    sourceFreshness,
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

export function assertRulesClockFresh(
  candidate: CatalogueCandidate,
  selectedGames: readonly SupportedGame[],
  candidateCreatedAt: string | null,
  approvalObservedAt: string,
): void {
  if (candidateCreatedAt === null) {
    throw new Error("The persisted candidate has no reconciliation clock.");
  }
  const reconciledDate = candidateCreatedAt.slice(0, 10);
  const approvalDate = approvalObservedAt.slice(0, 10);
  const selected = new Set(selectedGames);
  const crossedBoundary = (candidate.errata ?? []).some(
    (erratum) =>
      selected.has(erratum.game) &&
      erratum.effective_from !== null &&
      erratum.effective_from > reconciledDate &&
      erratum.effective_from <= approvalDate,
  );
  if (crossedBoundary) {
    throw new AdministrationProblem(
      409,
      "candidate_errata_stale",
      "An Erratum became applicable after reconciliation; reconcile a fresh candidate before approval.",
    );
  }
  const crossedLegalityBoundary = (candidate.legality_rules ?? []).some((rule) =>
    [
      rule.effective_from,
      rule.effective_until,
      rule.effect.type === "release_timing" ? rule.effect.legal_from : null,
    ].some((boundary) => boundary !== null && boundary > reconciledDate && boundary <= approvalDate),
  );
  if (crossedLegalityBoundary) {
    throw new AdministrationProblem(
      409,
      "candidate_legality_stale",
      "A Legality Rule applicability boundary passed after reconciliation; reconcile a fresh candidate before approval.",
    );
  }
}

type CanonicalLegalityProvenance = {
  id: string;
  source_lineage: string;
  source_snapshot_id: string;
  source_observation_set_id: string;
  source_observation_id: string;
  source_observation_pointer: string;
  source_field_pointers_json: string;
};

export async function candidateWithCanonicalLegalityProvenance(
  database: D1Database,
  candidate: CatalogueCandidate,
): Promise<CatalogueCandidate> {
  const rules = candidate.legality_rules ?? [];
  if (rules.length === 0) return candidate;
  const canonical = new Map<string, CanonicalLegalityProvenance>();
  for (const chunk of byteBoundedJsonArrays(rules.map((rule) => rule.id))) {
    const rows = await candidateLegalityEvidenceStatement(database, chunk).all<CanonicalLegalityProvenance>();
    for (const row of rows.results) canonical.set(row.id, row);
  }
  return {
    ...candidate,
    legality_rules: rules.map((rule) => {
      const retained = canonical.get(rule.id);
      if (retained === undefined) return rule;
      return {
        ...rule,
        source_lineage: retained.source_lineage,
        source_snapshot_id: retained.source_snapshot_id,
        source_observation_set_id: retained.source_observation_set_id,
        source_observation_id: retained.source_observation_id,
        source_observation_pointer: retained.source_observation_pointer,
        source_field_pointers: JSON.parse(retained.source_field_pointers_json) as typeof rule.source_field_pointers,
      };
    }),
  };
}

export async function approveRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  request: ApproveRunRequest,
  observedAt = new Date().toISOString(),
  printingImages?: R2Bucket,
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
  return idempotentAdministration(
    database,
    {
      key: request.idempotency_key,
      operation: "approve_ingestion_run",
      requestJson,
      observedAt,
    },
    async (claimOwner) => {
      await expireOverdueRuns(database, observedAt);
      await reconcileAbandonedPublication(database, catalogueExports, observedAt);
      return approveRunAttempt(
        database,
        catalogueExports,
        runId,
        request,
        requestJson,
        observedAt,
        claimOwner,
        printingImages,
      );
    },
  );
}

async function approveRunAttempt(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  request: ApproveRunRequest,
  requestJson: string,
  now: string,
  claimOwner: IdempotencyClaimOwner,
  printingImages?: R2Bucket,
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, now);
  const run = await requiredRun(database, runId);
  if (run.state === "publishing") {
    return approvalInProgress(run, request, requestJson);
  }
  assertRunIsApprovable(run, request);
  const [catalogueState, operationState] = await Promise.all([
    currentCatalogueState(database),
    currentOperationState(database),
  ]);
  if (
    catalogueState.current_revision_id !== request.expected_current_revision_id ||
    run.expected_current_revision_id !== request.expected_current_revision_id
  ) {
    throw new AdministrationProblem(
      409,
      "current_revision_mismatch",
      "The current Catalogue Revision no longer matches the requested approval.",
    );
  }
  if (operationState.active_ingestion_run_id !== run.id) {
    throw new AdministrationProblem(409, "run_not_active", "The active Ingestion Run identity no longer matches.");
  }
  if (operationState.recovery_health !== "healthy") {
    throw new AdministrationProblem(
      409,
      "recovery_not_verified",
      "Recovery is not healthy, so publication is blocked.",
    );
  }

  const candidate = JSON.parse(
    await retainedPayload(database, run.id, "candidate", run.candidate_json),
  ) as CatalogueCandidate;
  assertRulesClockFresh(candidate, parseSelectedGames(run.selected_games_json), run.candidate_created_at, now);
  const approval = {
    action: "approved",
    approved_at: now,
    candidate_digest: request.candidate_digest,
    expected_current_revision_id: request.expected_current_revision_id,
  };
  const currentRevision = await catalogueRevisionDigestStatement(database, catalogueState.current_revision_id).first<{
    content_digest: string;
  }>();
  if (run.candidate_catalogue_digest !== null && currentRevision?.content_digest === run.candidate_catalogue_digest) {
    return publishNoChange(database, run, request, requestJson, approval, now, claimOwner, candidate);
  }
  try {
    assertPublicationAggregateBudget(candidate);
  } catch (error) {
    const problem = error instanceof AdministrationProblem ? error : publicationFailureProblem(error);
    await failUnreservedPublication(database, run, request, requestJson, now, claimOwner, problem);
    throw problem;
  }
  const revisionId = await catalogueRevisionIdentity({
    runId: run.id,
    candidateDigest: request.candidate_digest,
    expectedCurrentRevisionId: request.expected_current_revision_id,
  });
  const writerToken = publicationWriterToken(revisionId);
  const reconciliation = await reconciliationPublication(database, run.id, revisionId, now);
  const sourceFreshness = await sourceFreshnessForExport(
    database,
    candidate.selected_games,
    await checkedFreshnessAreasForRun(database, parseSelectedGames(run.selected_games_json), run.id, candidate, now),
    now,
  );
  const exportCandidate = await candidateWithCanonicalLegalityProvenance(database, candidate);
  let catalogueExport: BuiltCatalogueExport;
  try {
    catalogueExport = await buildCatalogueExport(
      exportCandidate,
      requiredCandidateCatalogueDigest(run),
      revisionId,
      now,
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
      sourceFreshness,
    );
    assertBuiltPublicationBudget(catalogueExport);
  } catch (error) {
    const problem = publicationFailureProblem(error);
    await failUnreservedPublication(database, run, request, requestJson, now, claimOwner, problem);
    throw problem;
  }
  try {
    await reservePublication(
      database,
      run.id,
      approval,
      request.idempotency_key,
      revisionId,
      catalogueExport.manifest.manifest_sha256,
      writerToken,
      now,
    );
  } catch (error) {
    const reserved = await requiredRun(database, run.id);
    if (reserved.state === "publishing") {
      return approvalInProgress(reserved, request, requestJson);
    }
    await throwApprovalFailure(database, run, error, now);
  }
  try {
    await assertReservedPublicationOwnsUnpublishedPrefix(database, run.id);
    await storeAndVerifyExport(database, catalogueExports, run.id, revisionId, writerToken, catalogueExport.objects);
    await assertReservedPublicationOwnsUnpublishedPrefix(database, run.id);
    await storeAndVerifyPrintingImages(candidate, printingImages);
    await assertReservedPublicationOwnsUnpublishedPrefix(database, run.id);
    if (!(await isExactVerifiedExport(catalogueExports, revisionId, catalogueExport))) {
      throw new Error("The Catalogue Export attempt contains unexpected objects.");
    }
    return await commitVerifiedPublication(database, {
      run: await requiredRun(database, run.id),
      candidate,
      catalogueExport,
      reconciliation,
      requestJson,
      completedAt: now,
      claimOwner,
    });
  } catch (error) {
    const concurrentReplay = await replayAfterConflict(
      database,
      request.idempotency_key,
      "approve_ingestion_run",
      requestJson,
      error,
    );
    if (concurrentReplay !== null) return concurrentReplay;
    const reserved = await requiredRun(database, run.id);
    const ownershipLost =
      error instanceof PublicationPrefixOwnershipError ||
      (reserved.state === "publishing" && !(await reservedPublicationOwnsUnpublishedPrefix(database, reserved)));
    const problem = ownershipLost
      ? new AdministrationProblem(
          500,
          "publication_abandoned",
          "The reserved publication could not be safely reconciled.",
        )
      : publicationFailureProblem(error);
    const cleanupKeys = ownershipLost ? null : await listCatalogueExportPrefix(catalogueExports, revisionId);
    await failReservedPublication(database, reserved, cleanupKeys, now, problem);
    try {
      await attemptPublicationCleanup(database, catalogueExports, run.id, now);
    } catch {
      // Cleanup is durable and independently retryable. The terminal
      // publication outcome must remain the original problem.
    }
    throw problem;
  }
}
