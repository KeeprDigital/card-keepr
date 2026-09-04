import { authenticateBearer } from "../../../src/http/authentication";
import { AdministrationProblem } from "../../../src/catalogue/shared";
import {
  administrationStatus,
  approveRun,
  inspectCandidate,
  rejectRun,
  retryPublicationCleanup,
  retryRun,
  showRun,
  prepareProductionRelease,
  runGuardedCardSearchRepair,
} from "../../../src/catalogue/ingestion";
import { isLivenessRequest, livenessRequest, readinessResponse } from "../../../src/http/health";
import { problemResponse } from "../../../src/http/problem";
import { rateLimitFailure } from "../../../src/http/rate-limit";
import { readBoundedJsonObject } from "../../../src/http/bounded-json";
import { ingestionCapabilities } from "../../../src/runtime-capabilities.mjs";
import {
  extendRunRequestCapacity,
  reparseSourceSnapshot,
  retryEvidenceRun,
  showEvidenceRun,
  sourceObservationSetContent,
  sourceSnapshotContent,
  startEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import { showReconciledPrinting, startOrObserveReconciliationWorkflow } from "../../../src/catalogue/reconciliation";
import {
  startOrObserveCatalogueBackupWorkflow,
  catalogueBackupAttemptStatus,
  catalogueRevisionBackupStatus,
  publicationBackupReservation,
  acceptCatalogueRecovery,
  beginCatalogueRecovery,
  enforceRecoveryRestoreGuard,
  inspectCatalogueRecovery,
  verifyCatalogueRecovery,
} from "../../../src/catalogue/backup-recovery";
import { pauseEvidenceCollection, resumeEvidenceRun, terminateEvidenceCollection } from "./evidence-administration";
import {
  createCuratedRevision,
  listCuratedRevisions,
  reaffirmCuratedRevision,
  retireCuratedRevision,
  showCuratedRevision,
  supersedeCuratedRevision,
  validateCuratedRevision,
} from "../../../src/catalogue/curated";
import {
  CatalogueExportDeletionProblem,
  catalogueExportDeletionStatus,
  confirmCatalogueExportDeletion,
  prepareCatalogueExportDeletion,
  retryCatalogueExportDeletion,
} from "../../../src/catalogue/export";
import { withOperationalRequestLog } from "../../../src/http/operational-log";
import {
  absoluteDocumentLinks,
  mountedRequest,
  publicBase,
  routePath,
  type PublicBase,
} from "../../../src/http/public-base";
import {
  sourceHostPacingIntervalMilliseconds,
  sourceHostPacingMode,
} from "../../../src/catalogue/source-evidence-capture";
import type { EvidenceInspectionOptions } from "../../../src/catalogue/source-evidence-repository";

// The live facts the evidence status document reads beyond D1: hostname-shard
// Workflow statuses and the configured per-host pacing that grounds its
// advisory remaining-time estimate.
function evidenceInspectionOptions(env: Env): EvidenceInspectionOptions {
  return {
    parentWorkflow: env.EVIDENCE_INGESTION_WORKFLOW,
    hostWorkflow: env.EVIDENCE_HOST_WORKFLOW,
    pacing: {
      mode: sourceHostPacingMode(env.SOURCE_HOST_PACING_MODE),
      interval_ms: sourceHostPacingIntervalMilliseconds(env.SOURCE_HOST_PACING_INTERVAL_MS),
    },
  };
}
export {
  EvidenceHostWorkflow,
  EvidenceIngestionWorkflow,
} from "./evidence-workflows";
export { ReconciliationWorkflow } from "./reconciliation-workflow";
export { CatalogueBackupWorkflow } from "./backup-workflow";
export { OfficialSourceTransport } from "./official-source-transport";

async function handleIngestionRequest(
  request: Request,
  env: Env,
  context: ExecutionContext | undefined,
  requestId: string,
  base: PublicBase,
): Promise<Response> {
  try {
    const rateLimited = await rateLimitFailure(request, env.ADMINISTRATION_RATE_LIMIT, requestId);
    if (rateLimited !== null) return rateLimited;

    const authenticationFailure = await authenticateBearer(
      request,
      [env.ADMINISTRATION_KEY, env.ADMINISTRATION_KEY_REPLACEMENT],
      requestId,
      {
        missing: "authentication_required",
        invalid: "invalid_administration_key",
      },
    );
    if (authenticationFailure !== null) return authenticationFailure;

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return readinessResponse("ingestion", ingestionCapabilities, {
        database: env.CATALOGUE_DB,
        configuredDatabaseId: env.CATALOGUE_D1_DATABASE_ID,
        buckets: {
          EVIDENCE_OBJECTS: env.EVIDENCE_OBJECTS,
          PRINTING_IMAGES: env.PRINTING_IMAGES,
          CATALOGUE_EXPORTS: env.CATALOGUE_EXPORTS,
          BACKUPS: env.BACKUPS,
        },
        workflows: {
          EVIDENCE_INGESTION_WORKFLOW: env.EVIDENCE_INGESTION_WORKFLOW,
          EVIDENCE_HOST_WORKFLOW: env.EVIDENCE_HOST_WORKFLOW,
          RECONCILIATION_WORKFLOW: env.RECONCILIATION_WORKFLOW,
          CATALOGUE_BACKUP_WORKFLOW: env.CATALOGUE_BACKUP_WORKFLOW,
        },
        publicBase: base,
        request,
        version: env.CF_VERSION_METADATA,
      });
    }
    const observedAt = administrationObservedAt(request, env);
    await enforceRecoveryRestoreGuard(env.CATALOGUE_DB);

    if (request.method === "POST" && url.pathname === "/v1/production-releases") {
      const body = await readAdministrationBody(request);
      return Response.json(await prepareProductionRelease(env.CATALOGUE_DB, body, productionTarget(env), observedAt), {
        status: 201,
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/catalogue-export-deletion-plans") {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["catalogue_revision_id", "manifest_digest", "expected_current_revision_id", "plan_id"]);
      const document = await prepareCatalogueExportDeletion(
        env.CATALOGUE_DB,
        env.CATALOGUE_EXPORTS,
        {
          catalogue_revision_id: requiredString(body, "catalogue_revision_id"),
          manifest_digest: requiredString(body, "manifest_digest"),
          expected_current_revision_id: requiredString(body, "expected_current_revision_id"),
          plan_id: requiredString(body, "plan_id"),
        },
        observedAt,
      );
      return Response.json(document, { status: 201 });
    }

    if (request.method === "POST" && url.pathname === "/v1/catalogue-export-deletions") {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, [
        "plan_id",
        "plan_digest",
        "catalogue_revision_id",
        "manifest_digest",
        "expected_current_revision_id",
        "confirmation_revision_id",
        "deletion_id",
        "idempotency_key",
      ]);
      const document = await confirmCatalogueExportDeletion(
        env.CATALOGUE_DB,
        env.CATALOGUE_EXPORTS,
        {
          plan_id: requiredString(body, "plan_id"),
          plan_digest: requiredString(body, "plan_digest"),
          catalogue_revision_id: requiredString(body, "catalogue_revision_id"),
          manifest_digest: requiredString(body, "manifest_digest"),
          expected_current_revision_id: requiredString(body, "expected_current_revision_id"),
          confirmation_revision_id: requiredString(body, "confirmation_revision_id"),
          deletion_id: requiredString(body, "deletion_id"),
          idempotency_key: requiredString(body, "idempotency_key"),
        },
        observedAt,
      );
      return Response.json(document, {
        status: catalogueExportDeletionResultStatus(document),
      });
    }

    const exportDeletionRetryMatch = /^\/v1\/catalogue-export-deletions\/([^/]+)\/retry$/.exec(url.pathname);
    if (request.method === "POST" && exportDeletionRetryMatch !== null) {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["object_set_digest", "idempotency_key"]);
      const document = await retryCatalogueExportDeletion(
        env.CATALOGUE_DB,
        env.CATALOGUE_EXPORTS,
        decodeURIComponent(exportDeletionRetryMatch[1]!),
        {
          object_set_digest: requiredString(body, "object_set_digest"),
          idempotency_key: requiredString(body, "idempotency_key"),
        },
        observedAt,
      );
      return Response.json(document, {
        status: catalogueExportDeletionResultStatus(document),
      });
    }

    const exportDeletionMatch = /^\/v1\/catalogue-export-deletions\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && exportDeletionMatch !== null) {
      return Response.json(
        await catalogueExportDeletionStatus(env.CATALOGUE_DB, decodeURIComponent(exportDeletionMatch[1]!)),
      );
    }

    if (request.method === "POST" && url.pathname === "/admin/v1/curated-revisions/validate") {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["proposal", "catalogue_revision_id"]);
      return Response.json(
        await validateCuratedRevision(env.CATALOGUE_DB, body.proposal, requiredString(body, "catalogue_revision_id")),
      );
    }
    if (request.method === "GET" && url.pathname === "/admin/v1/curated-revisions") {
      const unexpected = [...url.searchParams.keys()].find(
        (parameter) => !["game", "target", "status"].includes(parameter),
      );
      if (unexpected !== undefined) {
        throw new AdministrationProblem(
          422,
          "invalid_parameter",
          `${unexpected} is not accepted for this administration operation.`,
        );
      }
      return Response.json(
        await listCuratedRevisions(env.CATALOGUE_DB, {
          ...(url.searchParams.has("game") ? { game: url.searchParams.get("game")! } : {}),
          ...(url.searchParams.has("target") ? { target: url.searchParams.get("target")! } : {}),
          ...(url.searchParams.has("status") ? { status: url.searchParams.get("status")! } : {}),
        }),
      );
    }
    if (request.method === "POST" && url.pathname === "/admin/v1/curated-revisions") {
      const result = await createCuratedRevision(env.CATALOGUE_DB, await readAdministrationBody(request), observedAt);
      return Response.json(result.document, {
        status: result.created ? 201 : 200,
      });
    }
    const curatedRevisionMutationMatch = /^\/admin\/v1\/curated-revisions\/([^/]+)\/(reaffirm|supersede|retire)$/.exec(
      url.pathname,
    );
    if (request.method === "POST" && curatedRevisionMutationMatch !== null) {
      const revisionId = decodeURIComponent(curatedRevisionMutationMatch[1]!);
      const body = await readAdministrationBody(request);
      const operation = curatedRevisionMutationMatch[2];
      const result =
        operation === "reaffirm"
          ? await reaffirmCuratedRevision(env.CATALOGUE_DB, revisionId, body, observedAt)
          : operation === "supersede"
            ? await supersedeCuratedRevision(env.CATALOGUE_DB, revisionId, body, observedAt)
            : await retireCuratedRevision(env.CATALOGUE_DB, revisionId, body, observedAt);
      return Response.json(result.document, {
        status: result.created && operation === "supersede" ? 201 : 200,
      });
    }
    const curatedRevisionMatch = /^\/admin\/v1\/curated-revisions\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && curatedRevisionMatch !== null) {
      return Response.json(await showCuratedRevision(env.CATALOGUE_DB, decodeURIComponent(curatedRevisionMatch[1]!)));
    }

    if (request.method === "POST" && url.pathname === "/v1/ingestion-runs/evidence") {
      const body = await readAdministrationBody(request);
      if (body.plans !== undefined) {
        assertOnlyFields(body, ["plans", "idempotency_key"]);
        return Response.json(
          await startEvidenceRun(env.CATALOGUE_DB, {
            plans: requiredEvidencePlans(body, "plans"),
            idempotency_key: requiredString(body, "idempotency_key"),
            operational_request_id: requestId,
          }),
          { status: 201 },
        );
      }
      assertOnlyFields(body, ["supported_game", "source_lineage", "adapter_version", "idempotency_key", "requests"]);
      return Response.json(
        await startEvidenceRun(env.CATALOGUE_DB, {
          supported_game: requiredString(body, "supported_game"),
          source_lineage: requiredString(body, "source_lineage"),
          adapter_version: requiredString(body, "adapter_version"),
          idempotency_key: requiredString(body, "idempotency_key"),
          operational_request_id: requestId,
          requests: requiredSourceRequests(body, "requests"),
        }),
        { status: 201 },
      );
    }

    const reconciliationMatch = /^\/v1\/ingestion-runs\/([^/]+)\/reconciliation$/.exec(url.pathname);
    if (request.method === "POST" && reconciliationMatch !== null) {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["expected_current_revision_id", "idempotency_key"]);
      const result = await startOrObserveReconciliationWorkflow(
        env.CATALOGUE_DB,
        env.RECONCILIATION_WORKFLOW,
        {
          ingestion_run_id: decodeURIComponent(reconciliationMatch[1]!),
          expected_current_revision_id: requiredString(body, "expected_current_revision_id"),
          idempotency_key: requiredString(body, "idempotency_key"),
        },
        observedAt,
      );
      return Response.json(result.document, {
        status: result.created && result.document.status !== "complete" ? 202 : 200,
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/catalogue-search-materialization/repair") {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["target_revision_id", "expected_current_revision_id", "idempotency_key"]);
      return Response.json(
        await runGuardedCardSearchRepair(
          env.CATALOGUE_DB,
          {
            target_revision_id: requiredString(body, "target_revision_id"),
            expected_current_revision_id: requiredString(body, "expected_current_revision_id"),
            idempotency_key: requiredString(body, "idempotency_key"),
          },
          observedAt,
        ),
      );
    }

    const backupStatusMatch = /^\/v1\/backups\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && backupStatusMatch !== null) {
      return Response.json(
        await catalogueBackupAttemptStatus(env.CATALOGUE_DB, decodeURIComponent(backupStatusMatch[1]!)),
      );
    }

    const revisionBackupsMatch = /^\/v1\/catalogue-revisions\/([^/]+)\/backups$/.exec(url.pathname);
    if (request.method === "GET" && revisionBackupsMatch !== null) {
      return Response.json(
        await catalogueRevisionBackupStatus(env.CATALOGUE_DB, decodeURIComponent(revisionBackupsMatch[1]!)),
      );
    }

    if (request.method === "POST" && url.pathname === "/v1/backups") {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, [
        "expected_current_revision_id",
        "idempotency_key",
        "failed_attempt_id",
        "failed_attempt_digest",
      ]);
      const result = await startOrObserveCatalogueBackupWorkflow(
        env.CATALOGUE_DB,
        env.CATALOGUE_BACKUP_WORKFLOW,
        {
          expected_current_revision_id: requiredString(body, "expected_current_revision_id"),
          idempotency_key: requiredString(body, "idempotency_key"),
          ...(body.failed_attempt_id === undefined
            ? {}
            : {
                failed_attempt_id: requiredString(body, "failed_attempt_id"),
              }),
          ...(body.failed_attempt_digest === undefined
            ? {}
            : {
                failed_attempt_digest: requiredString(body, "failed_attempt_digest"),
              }),
        },
        observedAt,
      );
      return Response.json(result.document, {
        status: result.created && result.document.status !== "complete" ? 202 : 200,
      });
    }

    const recoveryMatch = /^\/v1\/recoveries\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && recoveryMatch !== null) {
      return Response.json(
        await inspectCatalogueRecovery(env.CATALOGUE_DB, env.BACKUPS, decodeURIComponent(recoveryMatch[1]!)),
      );
    }

    if (request.method === "POST" && url.pathname === "/v1/recoveries") {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, [
        "environment",
        "recovery_id",
        "method",
        "target_revision_id",
        "target_bookmark",
        "target_digest",
        "backup_attempt_id",
        "expected_current_revision_id",
        "idempotency_key",
        "linked_operation_id",
      ]);
      if (requiredString(body, "environment") !== "production") {
        throw new AdministrationProblem(
          422,
          "production_target_required",
          "Catalogue recovery requires environment production.",
        );
      }
      const method = requiredString(body, "method");
      if (method !== "time_travel" && method !== "replacement_database") {
        throw new AdministrationProblem(
          422,
          "invalid_recovery_method",
          "method must be time_travel or replacement_database.",
        );
      }
      const document = await beginCatalogueRecovery(env.CATALOGUE_DB, env.BACKUPS, {
        recoveryId: requiredString(body, "recovery_id"),
        method,
        targetRevisionId: requiredString(body, "target_revision_id"),
        targetBookmark: requiredString(body, "target_bookmark"),
        targetDigest: requiredString(body, "target_digest"),
        backupAttemptId: requiredString(body, "backup_attempt_id"),
        expectedCurrentRevisionId: requiredString(body, "expected_current_revision_id"),
        idempotencyKey: requiredString(body, "idempotency_key"),
        ...(body.linked_operation_id === undefined
          ? {}
          : {
              linkedOperationId: requiredString(body, "linked_operation_id"),
            }),
        observedAt,
        cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
        catalogueDatabaseId: env.CATALOGUE_D1_DATABASE_ID,
        verificationToken: env.D1_VERIFICATION_TOKEN,
      });
      return Response.json(document, { status: 201 });
    }

    const recoveryVerificationMatch = /^\/v1\/recoveries\/([^/]+)\/verification$/.exec(url.pathname);
    if (request.method === "POST" && recoveryVerificationMatch !== null) {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["target_digest", "idempotency_key"]);
      return Response.json(
        await verifyCatalogueRecovery(
          env.CATALOGUE_DB,
          env.BACKUPS,
          decodeURIComponent(recoveryVerificationMatch[1]!),
          {
            targetDigest: requiredString(body, "target_digest"),
            idempotencyKey: requiredString(body, "idempotency_key"),
            observedAt,
            cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
            verificationToken: env.D1_VERIFICATION_TOKEN,
          },
        ),
      );
    }

    const recoveryAcceptanceMatch = /^\/v1\/recoveries\/([^/]+)\/acceptance$/.exec(url.pathname);
    if (request.method === "POST" && recoveryAcceptanceMatch !== null) {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, [
        "expected_restored_revision_id",
        "target_digest",
        "confirmation_recovery_id",
        "idempotency_key",
      ]);
      return Response.json(
        await acceptCatalogueRecovery(env.CATALOGUE_DB, env.BACKUPS, decodeURIComponent(recoveryAcceptanceMatch[1]!), {
          expectedRestoredRevisionId: requiredString(body, "expected_restored_revision_id"),
          targetDigest: requiredString(body, "target_digest"),
          confirmationRecoveryId: requiredString(body, "confirmation_recovery_id"),
          idempotencyKey: requiredString(body, "idempotency_key"),
          observedAt,
          boundDatabaseId: env.CATALOGUE_D1_DATABASE_ID,
        }),
      );
    }

    const reconciledPrintingMatch = /^\/v1\/reconciliation\/printings\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && reconciledPrintingMatch !== null) {
      return Response.json(
        await showReconciledPrinting(env.CATALOGUE_DB, decodeURIComponent(reconciledPrintingMatch[1]!)),
      );
    }

    const evidenceResumeMatch = /^\/v1\/ingestion-runs\/([^/]+)\/collection\/resume$/.exec(url.pathname);
    if (request.method === "POST" && evidenceResumeMatch !== null) {
      return Response.json(
        await resumeEvidenceRun(
          env.CATALOGUE_DB,
          env.EVIDENCE_INGESTION_WORKFLOW,
          decodeURIComponent(evidenceResumeMatch[1]!),
        ),
        { status: 202 },
      );
    }

    const evidencePauseMatch = /^\/v1\/ingestion-runs\/([^/]+)\/collection\/pause$/.exec(url.pathname);
    if (request.method === "POST" && evidencePauseMatch !== null) {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["idempotency_key"]);
      return Response.json(
        await pauseEvidenceCollection(
          env.CATALOGUE_DB,
          env.EVIDENCE_INGESTION_WORKFLOW,
          env.EVIDENCE_HOST_WORKFLOW,
          decodeURIComponent(evidencePauseMatch[1]!),
          requiredString(body, "idempotency_key"),
        ),
        { status: 200 },
      );
    }

    const evidenceTerminationMatch = /^\/v1\/ingestion-runs\/([^/]+)\/collection\/termination$/.exec(url.pathname);
    if (request.method === "POST" && evidenceTerminationMatch !== null) {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["idempotency_key"]);
      return Response.json(
        await terminateEvidenceCollection(
          env.CATALOGUE_DB,
          env.EVIDENCE_INGESTION_WORKFLOW,
          env.EVIDENCE_HOST_WORKFLOW,
          decodeURIComponent(evidenceTerminationMatch[1]!),
          requiredString(body, "idempotency_key"),
        ),
        { status: 200 },
      );
    }

    const capacityExtensionMatch = /^\/v1\/ingestion-runs\/([^/]+)\/capacity\/extension$/.exec(url.pathname);
    if (request.method === "POST" && capacityExtensionMatch !== null) {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, [
        "expected_request_capacity",
        "expected_capacity_generation",
        "request_capacity",
        "idempotency_key",
      ]);
      return Response.json(
        await extendRunRequestCapacity(env.CATALOGUE_DB, decodeURIComponent(capacityExtensionMatch[1]!), {
          expected_request_capacity: body.expected_request_capacity,
          expected_capacity_generation: body.expected_capacity_generation,
          request_capacity: body.request_capacity,
          idempotency_key: requiredString(body, "idempotency_key"),
        }),
        { status: 200 },
      );
    }

    const evidenceRetryMatch = /^\/v1\/ingestion-runs\/([^/]+)\/collection\/retry$/.exec(url.pathname);
    if (request.method === "POST" && evidenceRetryMatch !== null) {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["idempotency_key"]);
      return Response.json(
        await retryEvidenceRun(
          env.CATALOGUE_DB,
          decodeURIComponent(evidenceRetryMatch[1]!),
          requiredString(body, "idempotency_key"),
          requestId,
        ),
        { status: 201 },
      );
    }

    const sourceSnapshotObservationsMatch = /^\/v1\/source-snapshots\/([^/]+)\/observations$/.exec(url.pathname);
    if (request.method === "POST" && sourceSnapshotObservationsMatch !== null) {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["adapter_version", "idempotency_key"]);
      return Response.json(
        await reparseSourceSnapshot(
          env.CATALOGUE_DB,
          env.EVIDENCE_OBJECTS,
          decodeURIComponent(sourceSnapshotObservationsMatch[1]!),
          requiredString(body, "adapter_version"),
          requiredString(body, "idempotency_key"),
        ),
        { status: 201 },
      );
    }

    const sourceSnapshotContentMatch = /^\/v1\/source-snapshots\/([^/]+)\/content$/.exec(url.pathname);
    if (request.method === "GET" && sourceSnapshotContentMatch !== null) {
      return sourceSnapshotContent(
        env.CATALOGUE_DB,
        env.EVIDENCE_OBJECTS,
        decodeURIComponent(sourceSnapshotContentMatch[1]!),
      );
    }

    const sourceObservationSetContentMatch = /^\/v1\/source-observation-sets\/([^/]+)\/content$/.exec(url.pathname);
    if (request.method === "GET" && sourceObservationSetContentMatch !== null) {
      return sourceObservationSetContent(
        env.CATALOGUE_DB,
        env.EVIDENCE_OBJECTS,
        decodeURIComponent(sourceObservationSetContentMatch[1]!),
      );
    }

    const evidenceMatch = /^\/v1\/ingestion-runs\/([^/]+)\/evidence$/.exec(url.pathname);
    if (request.method === "GET" && evidenceMatch !== null) {
      return Response.json(
        await showEvidenceRun(env.CATALOGUE_DB, decodeURIComponent(evidenceMatch[1]!), evidenceInspectionOptions(env)),
      );
    }

    if (request.method === "GET" && url.pathname === "/v1/status") {
      return Response.json(
        await administrationStatus(env.CATALOGUE_DB, env.CATALOGUE_EXPORTS, observedAt, productionTarget(env)),
      );
    }

    const candidateMatch = /^\/v1\/ingestion-runs\/([^/]+)\/candidate$/.exec(url.pathname);
    if (request.method === "GET" && candidateMatch !== null) {
      return Response.json(
        await inspectCandidate(
          env.CATALOGUE_DB,
          env.CATALOGUE_EXPORTS,
          decodeURIComponent(candidateMatch[1]!),
          observedAt,
        ),
      );
    }

    const approvalMatch = /^\/v1\/ingestion-runs\/([^/]+)\/approval$/.exec(url.pathname);
    if (request.method === "POST" && approvalMatch !== null) {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["candidate_digest", "expected_current_revision_id", "idempotency_key"]);
      const result = await approveRun(
        env.CATALOGUE_DB,
        env.CATALOGUE_EXPORTS,
        decodeURIComponent(approvalMatch[1]!),
        {
          candidate_digest: requiredString(body, "candidate_digest"),
          expected_current_revision_id: requiredString(body, "expected_current_revision_id"),
          idempotency_key: requiredString(body, "idempotency_key"),
        },
        observedAt,
        env.PRINTING_IMAGES,
      );
      if (result.publication_outcome === "revision" && typeof result.resulting_revision_id === "string") {
        const reservation = await publicationBackupReservation(result.resulting_revision_id);
        const clockMode = String(env.ADMINISTRATION_CLOCK_MODE);
        const dispatch = async () => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const observed = await startOrObserveCatalogueBackupWorkflow(
              env.CATALOGUE_DB,
              env.CATALOGUE_BACKUP_WORKFLOW,
              {
                expected_current_revision_id: result.resulting_revision_id as string,
                idempotency_key: reservation.idempotencyKey,
              },
              observedAt,
            );
            if (clockMode !== "request" || observed.document.status === "complete") return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error("Publication backup did not complete in the test observation window.");
        };
        const reportDispatchFailure = (_error: unknown) => {
          console.error(
            JSON.stringify({
              contract: "card-keepr-operational-log@1",
              event: "workflow.failed",
              runtime: "ingestion",
              failure_code: "catalogue_backup_dispatch_failed",
              request_id: requestId,
              workflow_step: "catalogue_backup_dispatch",
              catalogue_revision_id: result.resulting_revision_id,
              retry_count: 0,
              retry_classification: "retryable",
            }),
          );
        };
        if (clockMode === "request") {
          await dispatch().catch(reportDispatchFailure);
        } else {
          context?.waitUntil(dispatch().catch(reportDispatchFailure));
        }
      }
      return Response.json(absoluteDocumentLinks(result, base), {
        status: administrationResultStatus(result, 200),
      });
    }

    const rejectionMatch = /^\/v1\/ingestion-runs\/([^/]+)\/rejection$/.exec(url.pathname);
    if (request.method === "POST" && rejectionMatch !== null) {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["candidate_digest", "idempotency_key"]);
      const result = await rejectRun(
        env.CATALOGUE_DB,
        env.CATALOGUE_EXPORTS,
        decodeURIComponent(rejectionMatch[1]!),
        {
          candidate_digest: requiredString(body, "candidate_digest"),
          idempotency_key: requiredString(body, "idempotency_key"),
        },
        observedAt,
      );
      return Response.json(absoluteDocumentLinks(result, base), {
        status: administrationResultStatus(result, 200),
      });
    }

    const retryMatch = /^\/v1\/ingestion-runs\/([^/]+)\/retry$/.exec(url.pathname);
    if (request.method === "POST" && retryMatch !== null) {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["idempotency_key"]);
      const result = await retryRun(
        env.CATALOGUE_DB,
        env.CATALOGUE_EXPORTS,
        decodeURIComponent(retryMatch[1]!),
        {
          idempotency_key: requiredString(body, "idempotency_key"),
          operational_request_id: requestId,
        },
        observedAt,
      );
      return Response.json(absoluteDocumentLinks(result, base), {
        status: administrationResultStatus(result, 201),
      });
    }

    const cleanupMatch = /^\/v1\/ingestion-runs\/([^/]+)\/publication-cleanup$/.exec(url.pathname);
    if (request.method === "POST" && cleanupMatch !== null) {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["idempotency_key"]);
      const result = await retryPublicationCleanup(
        env.CATALOGUE_DB,
        env.CATALOGUE_EXPORTS,
        decodeURIComponent(cleanupMatch[1]!),
        {
          idempotency_key: requiredString(body, "idempotency_key"),
        },
        observedAt,
      );
      return Response.json(absoluteDocumentLinks(result, base), {
        status: administrationResultStatus(result, 200),
      });
    }

    const runMatch = /^\/v1\/ingestion-runs\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && runMatch !== null) {
      const runId = decodeURIComponent(runMatch[1]!);
      if (await hasEvidencePlan(env.CATALOGUE_DB, runId)) {
        return Response.json(await showEvidenceRun(env.CATALOGUE_DB, runId, evidenceInspectionOptions(env)));
      }
      return Response.json(await showRun(env.CATALOGUE_DB, env.CATALOGUE_EXPORTS, runId, observedAt));
    }

    return problemResponse({
      requestId,
      status: 404,
      code: "not_found",
      title: "Not found",
      detail: "The requested administration operation does not exist.",
    });
  } catch (error) {
    if (error instanceof AdministrationProblem || error instanceof CatalogueExportDeletionProblem) {
      return problemResponse({
        requestId,
        status: error.status,
        code: error.code,
        title: administrationProblemTitle(error.status),
        detail: error.message,
      });
    }
    return problemResponse({
      requestId,
      status: 500,
      code: "internal_error",
      title: "Internal server error",
      detail: "The administration request could not be completed.",
    });
  }
}

const ingestionWorker = {
  async fetch(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
    // The worker is mounted at the path of PUBLIC_BASE_URL (ADR 0007). A
    // request outside the mount is not routed at all: no rate limit, no
    // authentication, just a 404 problem. Everything under the mount is
    // handled as if the worker served the root.
    const base = publicBase(env);
    const route = routePath(new URL(request.url), base.basePath);
    if (route === null) {
      return withOperationalRequestLog("ingestion", request, env, async (_observedEnv, requestId) =>
        problemResponse({
          requestId,
          status: 404,
          code: "not_found",
          title: "Not found",
          detail: "The requested resource does not exist.",
        }),
      );
    }
    const mounted = mountedRequest(request, route);
    // Liveness (issue #144) is unauthenticated, behind its own rate limit,
    // and kept out of the operational request log.
    if (isLivenessRequest(request.method, route)) {
      return withOperationalRequestLog(
        "ingestion",
        mounted,
        env,
        (observedEnv, requestId) =>
          livenessRequest(mounted, observedEnv.INGESTION_LIVENESS_RATE_LIMIT, "ingestion", requestId),
        { logged: false },
      );
    }
    return withOperationalRequestLog("ingestion", mounted, env, (observedEnv, requestId) =>
      handleIngestionRequest(mounted, observedEnv, context, requestId, base),
    );
  },
} satisfies ExportedHandler<Env>;

export default ingestionWorker;

async function readAdministrationBody(request: Request): Promise<Record<string, unknown>> {
  return readBoundedJsonObject(
    request,
    16_384,
    (status, code, detail) => new AdministrationProblem(status, code, detail),
  );
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AdministrationProblem(422, "invalid_parameter", `${field} must be a non-empty string.`);
  }
  return value;
}

function productionTarget(env: Env) {
  return {
    cloudflare_account_id: env.CLOUDFLARE_ACCOUNT_ID,
    worker_scripts: ["card-keepr-api", "card-keepr-ingestion"],
    d1_databases: [
      { name: "card-keepr-catalogue", id: env.CATALOGUE_D1_DATABASE_ID },
      { name: "card-keepr-disposable-verification", id: env.DISPOSABLE_D1_DATABASE_ID },
    ],
    r2_buckets: [
      "card-keepr-evidence",
      "card-keepr-printing-images",
      "card-keepr-catalogue-exports",
      "card-keepr-backups",
    ],
  } as const;
}

function requiredStringArray(body: Record<string, unknown>, field: string): readonly string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    throw new AdministrationProblem(422, "invalid_parameter", `${field} must be a non-empty array of strings.`);
  }
  return value;
}

function requiredEvidencePlans(
  body: Record<string, unknown>,
  field: string,
): {
  supported_game: string;
  source_lineage: string;
  adapter_version: string;
  requests: ReturnType<typeof requiredSourceRequests>;
}[] {
  const value = body[field];
  if (!Array.isArray(value)) {
    throw new AdministrationProblem(422, "invalid_parameter", `${field} must be an array.`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new AdministrationProblem(422, "invalid_parameter", `${field}[${index}] must be an object.`);
    }
    const plan = item as Record<string, unknown>;
    assertOnlyFields(plan, ["supported_game", "source_lineage", "adapter_version", "requests"]);
    return {
      supported_game: requiredString(plan, "supported_game"),
      source_lineage: requiredString(plan, "source_lineage"),
      adapter_version: requiredString(plan, "adapter_version"),
      requests: requiredSourceRequests(plan, "requests"),
    };
  });
}

function requiredSourceRequests(
  body: Record<string, unknown>,
  field: string,
): {
  id: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
}[] {
  const value = body[field];
  if (!Array.isArray(value)) {
    throw new AdministrationProblem(422, "invalid_parameter", `${field} must be an array.`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new AdministrationProblem(422, "invalid_parameter", `${field}[${index}] must be an object.`);
    }
    const sourceRequest = item as Record<string, unknown>;
    assertOnlyFields(sourceRequest, ["id", "url", "method", "headers"]);
    const headersValue = sourceRequest.headers;
    let headers: Record<string, string> | undefined;
    if (headersValue !== undefined) {
      if (
        headersValue === null ||
        typeof headersValue !== "object" ||
        Array.isArray(headersValue) ||
        Object.values(headersValue).some((header) => typeof header !== "string")
      ) {
        throw new AdministrationProblem(
          422,
          "invalid_parameter",
          `${field}[${index}].headers must contain only string values.`,
        );
      }
      headers = headersValue as Record<string, string>;
    }
    return {
      id: requiredString(sourceRequest, "id"),
      url: requiredString(sourceRequest, "url"),
      ...(sourceRequest.method === undefined ? {} : { method: requiredString(sourceRequest, "method") }),
      ...(headers === undefined ? {} : { headers }),
    };
  });
}

function assertOnlyFields(body: Record<string, unknown>, allowedFields: readonly string[]): void {
  const unexpected = Object.keys(body).find((field) => !allowedFields.includes(field));
  if (unexpected !== undefined) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      `${unexpected} is not accepted for this administration operation.`,
    );
  }
}

function administrationObservedAt(request: Request, env: Env): string {
  const requested = request.headers.get("x-keepr-test-now");
  const clockMode: string = env.ADMINISTRATION_CLOCK_MODE;
  if (clockMode !== "request" || requested === null) {
    return new Date().toISOString();
  }
  const parsed = new Date(requested);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== requested) {
    throw new AdministrationProblem(422, "invalid_parameter", "x-keepr-test-now must be a canonical UTC timestamp.");
  }
  return requested;
}

function administrationProblemTitle(status: number): string {
  if (status === 404) return "Not found";
  if (status === 409) return "Conflict";
  if (status === 413) return "Request too large";
  if (status === 422) return "Invalid request";
  return "Administration operation failed";
}

function administrationResultStatus(result: Record<string, unknown>, completedStatus: number): number {
  return result.contract === "card-keepr-administration-operation@1" && result.status === "in_progress"
    ? 202
    : completedStatus;
}

function catalogueExportDeletionResultStatus(result: Record<string, unknown>): number {
  return result.contract === "card-keepr-catalogue-export-deletion@1" && result.state === "deleting" ? 202 : 200;
}

async function hasEvidencePlan(database: D1Database, runId: string): Promise<boolean> {
  const row = await database
    .prepare("SELECT 1 AS present FROM ingestion_evidence_plans WHERE ingestion_run_id = ?")
    .bind(runId)
    .first<{ present: number }>();
  return row?.present === 1;
}
