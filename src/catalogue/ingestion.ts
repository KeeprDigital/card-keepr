import {
  buildCatalogueExport,
  distributionContextExportId,
  type BuiltCatalogueExport,
  type ExportObject,
  type SourceFreshness,
} from "./export";
import {
  CatalogueExportLimitError,
  catalogueCandidateContract,
  type CatalogueCandidate,
  type SupportedGame,
  canonicalJson,
  sha256,
  sha256Text,
  byteBoundedJsonArrays,
  guardedAtomicBatch,
  retainedPayload,
  AdministrationProblem,
  catalogueRevisionIdentity,
  operationalDiagnostics,
} from "./shared";
import { firstCatalogueFixture, FixtureInputError, fixtureCandidate } from "./fixture";
import {
  assertCuratedGamesUnblocked,
  curatedRevisionInspectionForRun,
  prepareCuratedRevisionRunStart,
} from "./curated-revisions";
import {
  compareSourceFreshness,
  isCatalogueSourceCheck,
  sourceFreshnessFromStorage,
  sourceFreshnessKey,
  sourceFreshnessStorageScope,
  type SourceFreshnessStorageRow,
} from "./source-freshness";
import {
  reconciliationPublication,
  type PublicationEvidenceResource,
  type ReconciliationPublicationPlan,
  digestBoundCandidatePayload,
  productReleasePublicationStatements,
  typedPrintingProjections,
} from "./reconciliation";
import { inspectCatalogueCandidate } from "./candidate-inspection";
import { cardSearchChunks, cardSearchFtsQuery, cardSearchTerms, cardSearchText } from "./card-search";
import { repairableCatalogueRevisionWindow } from "./catalogue-revision-retention";
import { adapterReconciliationAreas, requiredSourceAdapter } from "./adapters";
import { legalityPublicationStatements } from "./legality";
import { publicationBackupReservation } from "./backup-recovery";
import { SPINE_REVISION_ID } from "./production-release";

const sevenDaysInMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const publicationLeaseMilliseconds = 5 * 60 * 1_000;
const maximumPublicationCandidateBytes = 16 * 1024 * 1024;
const maximumPublicationEntityBytes = 384 * 1024;
const maximumPublicationSearchMaterializationBytes = 24 * 1024 * 1024;
const maximumPublicationExportBytes = 32 * 1024 * 1024;
const activeRunStages = [
  "planning",
  "collecting",
  "parsing",
  "reconciling",
  "awaiting_approval",
  "publishing",
] as const;
// 'paused' is a non-terminal run state, not a progress stage: a paused run
// holds the active-run reservation with collection incomplete, so it never
// appears in a completed_stages list.
const runStates = new Set([...activeRunStages, "paused", "published", "rejected", "expired", "failed"]);
const terminalRunStates = new Set(["published", "rejected", "expired", "failed"]);

type RunRow = {
  id: string;
  state: string;
  selected_games_json: string;
  started_at: string;
  expected_current_revision_id: string;
  linked_run_id: string | null;
  idempotency_key: string;
  operational_request_id: string | null;
  candidate_digest: string | null;
  candidate_catalogue_digest: string | null;
  candidate_created_at: string | null;
  approval_deadline: string | null;
  approval_json: string | null;
  published_revision_id: string | null;
  export_manifest_digest: string | null;
  terminal_at: string | null;
  candidate_json: string;
  approval_idempotency_key: string | null;
  failure_code: string | null;
  progress_json: string;
  warnings_json: string;
  approval_history_json: string;
  publication_outcome: string | null;
  resulting_revision_id: string | null;
  freshness_checked_at: string | null;
  publication_revision_id: string | null;
  publication_started_at: string | null;
  publication_reconcile_after: string | null;
  publication_manifest_digest: string | null;
  publication_writer_token: string | null;
};

type CatalogueStateRow = {
  current_revision_id: string;
  published_at: string;
};

type OperationStateRow = {
  active_ingestion_run_id: string | null;
  active_production_release_id: string | null;
  active_production_release_expires_at: string | null;
  active_recovery_id: string | null;
  recovery_health: string;
};

type IdempotencyRow = {
  operation: string;
  request_json: string;
  response_json: string;
  http_status: number;
  outcome: "success" | "problem";
};

type FreshnessRow = SourceFreshnessStorageRow & {
  ingestion_run_id: string;
};

type PublicationCleanupRow = {
  ingestion_run_id: string;
  state: "pending" | "cleaning" | "completed" | "failed";
  object_keys_json: string;
  attempts: number;
  failure_code: string | null;
  last_attempt_at: string | null;
  completed_at: string | null;
  not_before: string;
  idempotency_key: string | null;
  request_json: string | null;
  claim_token: string | null;
  claim_version: number;
  claim_expires_at: string | null;
};

type IdempotencyContext = {
  key: string;
  operation: string;
  requestJson: string;
  observedAt: string;
};

type IdempotencyClaimRow = {
  operation: string;
  request_json: string;
  claimed_at: string;
  owner_token: string;
  claim_version: number;
  claim_expires_at: string;
};

type IdempotencyClaimOwner = {
  ownerToken: string;
  version: number;
};

export type StartRunRequest = {
  fixture: string;
  selected_games: readonly string[];
  idempotency_key: string;
  operational_request_id?: string;
};

export type ApproveRunRequest = {
  candidate_digest: string;
  expected_current_revision_id: string;
  idempotency_key: string;
};

export type RejectRunRequest = {
  candidate_digest: string;
  idempotency_key: string;
};

export type RetryRunRequest = {
  idempotency_key: string;
  operational_request_id?: string;
};

export type RetryPublicationCleanupRequest = {
  idempotency_key: string;
};

export async function startFixtureRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  request: StartRunRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({
    fixture: request.fixture,
    selected_games: request.selected_games,
  });
  return idempotentAdministration(
    database,
    {
      key: request.idempotency_key,
      operation: "start_ingestion_run",
      requestJson,
      observedAt,
    },
    async (claimOwner) => {
      await expireOverdueRuns(database, observedAt);
      await reconcileAbandonedPublication(database, catalogueExports, observedAt);
      const candidate = await validatedCatalogueCandidate(request);
      return startPreparedRun(database, {
        candidate: candidate.candidate,
        selectedGames: candidate.candidate.selected_games,
        idempotencyKey: request.idempotency_key,
        operationalRequestId: request.operational_request_id ?? null,
        idempotencyOperation: "start_ingestion_run",
        idempotencyRequestJson: requestJson,
        linkedRunId: null,
        observedAt,
        claimOwner,
      });
    },
  );
}

export async function retryRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  sourceRunId: string,
  request: RetryRunRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  assertOpaqueId(sourceRunId, "run_id");
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({ source_run_id: sourceRunId });
  return idempotentAdministration(
    database,
    {
      key: request.idempotency_key,
      operation: "retry_ingestion_run",
      requestJson,
      observedAt,
    },
    async (claimOwner) => {
      await expireOverdueRuns(database, observedAt);
      await reconcileAbandonedPublication(database, catalogueExports, observedAt);
      const source = await requiredRun(database, sourceRunId);
      if (!terminalRunStates.has(source.state)) {
        throw new AdministrationProblem(
          409,
          "source_run_not_terminal",
          "Only a terminal Ingestion Run can be retried.",
        );
      }
      const evidencePlan = await database
        .prepare("SELECT ingestion_run_id FROM ingestion_evidence_plans WHERE ingestion_run_id = ?")
        .bind(source.id)
        .first<{ ingestion_run_id: string }>();
      if (evidencePlan !== null) {
        throw new AdministrationProblem(
          409,
          "evidence_retry_required",
          "Evidence-backed runs must be retried through their linked collection workflow so immutable provenance is retained.",
        );
      }
      const candidate = parseCandidate(source);
      return startPreparedRun(database, {
        candidate,
        selectedGames: parseSelectedGames(source.selected_games_json),
        idempotencyKey: request.idempotency_key,
        operationalRequestId: request.operational_request_id ?? null,
        idempotencyOperation: "retry_ingestion_run",
        idempotencyRequestJson: requestJson,
        linkedRunId: source.id,
        observedAt,
        claimOwner,
      });
    },
  );
}

export async function retryPublicationCleanup(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  request: RetryPublicationCleanupRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  assertOpaqueId(runId, "run_id");
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({ run_id: runId });
  return idempotentAdministration(
    database,
    {
      key: request.idempotency_key,
      operation: "retry_publication_cleanup",
      requestJson,
      observedAt,
    },
    async (claimOwner) => {
      await expireOverdueRuns(database, observedAt);
      await reconcileAbandonedPublication(database, catalogueExports, observedAt);
      const result = await attemptPublicationCleanup(database, catalogueExports, runId, observedAt, {
        key: request.idempotency_key,
        requestJson,
        claimOwner,
      });
      if (result === null) {
        throw new Error("Publication cleanup did not produce an administration result.");
      }
      return result;
    },
  );
}

export async function showRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, observedAt);
  await reconcileAbandonedPublication(database, catalogueExports, observedAt);
  assertOpaqueId(runId, "run_id");
  const run = await requiredRun(database, runId);
  return publicRun(run, await publicationCleanup(database, run.id));
}

export async function administrationStatus(
  database: D1Database,
  catalogueExports: R2Bucket,
  observedAt: string,
  productionTarget: Readonly<{
    cloudflare_account_id: string;
    worker_scripts: readonly string[];
    d1_databases: readonly Readonly<{
      name: string;
      id: string;
    }>[];
    r2_buckets: readonly string[];
  }>,
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, observedAt);
  await reconcileAbandonedPublication(database, catalogueExports, observedAt);
  const [
    catalogue,
    operation,
    freshness,
    recentRuns,
    revisionCount,
    exportCount,
    cleanupCount,
    objectDiagnostics,
    repairableRevisions,
  ] = await Promise.all([
    currentCatalogueState(database),
    currentOperationState(database),
    database
      .prepare(
        `SELECT game, area, source_lineage, region, checked_at,
                  ingestion_run_id
          FROM source_freshness
          ORDER BY game, area, source_lineage, region`,
      )
      .all<FreshnessRow>(),
    database
      .prepare(
        `SELECT * FROM ingestion_runs
          ORDER BY started_at DESC, id DESC
          LIMIT 20`,
      )
      .all<RunRow>(),
    database.prepare("SELECT COUNT(*) AS count FROM catalogue_revisions").first<{ count: number }>(),
    database.prepare("SELECT COUNT(*) AS count FROM catalogue_exports").first<{ count: number }>(),
    database
      .prepare(
        `SELECT COUNT(*) AS count
          FROM ingestion_publication_cleanup
          WHERE state IN ('pending', 'failed')`,
      )
      .first<{ count: number }>(),
    catalogueExportObjectDiagnostics(database, catalogueExports),
    repairableCatalogueRevisionWindow(database),
  ]);
  const active =
    operation.active_ingestion_run_id === null ? null : await requiredRun(database, operation.active_ingestion_run_id);
  const cleanupByRun = await publicationCleanupsForRuns(database, [
    ...recentRuns.results.map((run) => run.id),
    ...(active === null ? [] : [active.id]),
  ]);
  const schema = await database
    .prepare("SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1")
    .first<{ migration_level: number }>();
  const recoveryBackup = await database
    .prepare(
      `SELECT idempotency_key, d1_bookmark, manifest_sha256
     FROM catalogue_backup_attempts
     WHERE state = 'verified' AND catalogue_revision_id = ?
       AND d1_bookmark IS NOT NULL AND manifest_sha256 IS NOT NULL
     ORDER BY completed_at DESC LIMIT 1`,
    )
    .bind(catalogue.current_revision_id)
    .first<{
      idempotency_key: string;
      d1_bookmark: string;
      manifest_sha256: string;
    }>();
  const retainedEvidence = await database
    .prepare(
      `WITH RECURSIVE retained(revision_id, depth) AS (
       SELECT revision.id, 0 FROM catalogue_state AS state
       JOIN catalogue_revisions AS revision ON revision.id = state.current_revision_id
       WHERE state.singleton = 1
       UNION ALL
       SELECT previous.id, retained.depth + 1 FROM retained
       JOIN catalogue_revisions AS revision ON revision.id = retained.revision_id
       JOIN catalogue_revisions AS previous
         ON previous.id = revision.expected_previous_revision_id
       WHERE retained.depth < 2
     )
     SELECT retained.revision_id, retained.depth,
       CASE WHEN export.verified = 1 AND export.maintenance_state = 'available'
         THEN 1 ELSE 0 END AS export_verified,
       CASE WHEN EXISTS (
         SELECT 1 FROM catalogue_backup_attempts AS backup
         WHERE backup.catalogue_revision_id = retained.revision_id
           AND backup.state = 'verified' AND backup.d1_bookmark IS NOT NULL
           AND backup.manifest_sha256 IS NOT NULL
       ) THEN 1 ELSE 0 END AS recovery_verified
     FROM retained LEFT JOIN catalogue_exports AS export
       ON export.catalogue_revision_id = retained.revision_id
     ORDER BY retained.depth`,
    )
    .all<{ revision_id: string; depth: number; export_verified: number; recovery_verified: number }>();
  const replacement = await database
    .prepare(
      `SELECT id, target_revision_id, target_digest, restored_database_id, retained_database_id, verification_json
     FROM catalogue_recovery_operations
     WHERE state = 'awaiting_acceptance' AND method = 'replacement_database'
     ORDER BY started_at DESC LIMIT 1`,
    )
    .first<{
      id: string;
      target_revision_id: string;
      target_digest: string;
      restored_database_id: string;
      retained_database_id: string;
      verification_json: string;
    }>();
  const activeProductionRelease = await database
    .prepare(
      `SELECT id, state, expected_head_sha, api_version_id, ingestion_version_id,
            failure_code, roll_forward_required
     FROM production_releases
     WHERE state IN ('requested','preflight','migrating','deploying','smoke_testing')
     LIMIT 1`,
    )
    .first<Record<string, unknown>>();
  const productionTargetDigest = await sha256Text(canonicalJson(productionTarget));
  const retention = retainedEvidence.results.map((row) => ({
    revision_id: row.revision_id,
    depth: row.depth,
    export_verified: row.export_verified === 1,
    recovery_verified: row.recovery_verified === 1,
  }));
  const smokeTargets = await productionReleaseSmokeTargets(
    database,
    retention.map((item) => item.revision_id),
  );
  return {
    contract: "card-keepr-administration-status@1",
    production_target: productionTarget,
    safe_state: {
      current_revision_id: catalogue.current_revision_id,
      recovery_health: operation.recovery_health,
      active_ingestion_run_id: operation.active_ingestion_run_id,
      active_production_release_id: operation.active_production_release_id,
      active_recovery_id: operation.active_recovery_id,
      mutation_safe:
        operation.recovery_health === "healthy" &&
        operation.active_ingestion_run_id === null &&
        !(
          operation.active_production_release_id !== null &&
          operation.active_production_release_expires_at !== null &&
          operation.active_production_release_expires_at > observedAt
        ),
    },
    active_production_release: activeProductionRelease,
    release_preflight: {
      // Bootstrap Mode (issue #141): the catalogue is provably empty, so the
      // guarded Production Release relaxes only the gates that presuppose
      // published data.
      bootstrap: catalogue.current_revision_id === SPINE_REVISION_ID && (revisionCount?.count ?? 0) === 0,
      schema_migration_level: schema?.migration_level ?? 0,
      production_target_digest: productionTargetDigest,
      recovery_bookmark: recoveryBackup?.d1_bookmark ?? null,
      recovery_backup_attempt_id: recoveryBackup?.idempotency_key ?? null,
      recovery_manifest_digest: recoveryBackup?.manifest_sha256 ?? null,
      retained_revision_evidence: retention,
      retention_ready:
        retention.length === 3 && retention.every((item) => item.export_verified && item.recovery_verified),
      smoke_targets: smokeTargets,
      replacement_handoff:
        replacement === null
          ? null
          : {
              recovery_id: replacement.id,
              target_revision_id: replacement.target_revision_id,
              target_digest: replacement.target_digest,
              replacement_database_id: replacement.restored_database_id,
              retained_database_id: replacement.retained_database_id,
              verified: replacement.verification_json !== null,
            },
    },
    active_ingestion_run: active === null ? null : publicRun(active, cleanupByRun.get(active.id) ?? null),
    source_freshness: freshness.results.map((row) => ({
      ...sourceFreshnessFromStorage(row),
      ingestion_run_id: row.ingestion_run_id,
    })),
    diagnostics: {
      catalogue_revision_count: revisionCount?.count ?? 0,
      catalogue_export_count: exportCount?.count ?? 0,
      catalogue_export_object_count: objectDiagnostics.objectCount,
      orphaned_catalogue_export_object_count: objectDiagnostics.orphanedObjectCount,
      pending_publication_cleanup_count: cleanupCount?.count ?? 0,
    },
    repairable_catalogue_revision_ids: repairableRevisions.results.map(({ revision_id }) => revision_id),
    recent_runs: recentRuns.results.map((run) => publicRun(run, cleanupByRun.get(run.id) ?? null)),
  };
}

export async function inspectCandidate(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, observedAt);
  await reconcileAbandonedPublication(database, catalogueExports, observedAt);
  assertOpaqueId(runId, "run_id");
  const row = await requiredRun(database, runId);
  const inspectableFailure =
    row.state === "failed" &&
    row.candidate_digest !== null &&
    (row.failure_code === "curated_revision_reconfirmation_required" ||
      (await database
        .prepare(
          `SELECT 1 AS present
           FROM reconciliation_contexts
           WHERE ingestion_run_id = ?`,
        )
        .bind(row.id)
        .first<{ present: number }>()) !== null);
  if (row.state !== "awaiting_approval" && !inspectableFailure) {
    throw new AdministrationProblem(
      409,
      "candidate_not_approvable",
      "The Ingestion Run does not have an inspectable reconciliation candidate.",
    );
  }
  const candidate = JSON.parse(
    await retainedPayload(database, row.id, "candidate", row.candidate_json),
  ) as CatalogueCandidate;
  const diff = await inspectCatalogueCandidate(database, {
    runId: row.id,
    expectedRevisionId: row.expected_current_revision_id,
    candidate,
    fallbackWarnings: parseWarnings(row.warnings_json),
  });
  const curated = await curatedRevisionInspectionForRun(database, row.id, candidate);
  return {
    run_id: row.id,
    candidate_digest: row.candidate_digest,
    expected_current_revision_id: row.expected_current_revision_id,
    candidate_created_at: row.candidate_created_at,
    approval_deadline: row.approval_deadline,
    progress: parseProgress(row.progress_json),
    ...(curated === null
      ? {}
      : {
          curated_revision_ids: curated.revision_ids,
          curated_revision_set_digest: curated.set_digest,
        }),
    diff: {
      ...diff,
      curated_effects: curated?.effects ?? [],
    },
  };
}

export async function productionReleaseSmokeTargets(
  database: D1Database,
  revisionIds: readonly string[],
): Promise<Record<string, unknown> | null> {
  if (revisionIds.length !== 3) return null;
  const revisions = [];
  for (const revisionId of revisionIds) {
    const [cards, printings] = await Promise.all([
      database
        .prepare(
          `SELECT query.card_id,query.sort_game,query.sort_identity_kind,
                query.sort_identity_value,query.sort_id,card.document_json
         FROM revision_card_query_documents AS query
         JOIN revision_cards AS card
           ON card.catalogue_revision_id=query.catalogue_revision_id
          AND card.card_id=query.card_id
         WHERE query.catalogue_revision_id=?
         ORDER BY sort_game,sort_identity_kind,sort_identity_value,sort_id LIMIT 2`,
        )
        .bind(revisionId)
        .all<{
          card_id: string;
          sort_game: string;
          sort_identity_kind: string;
          sort_identity_value: string;
          sort_id: string;
          document_json: string;
        }>(),
      database
        .prepare(
          `SELECT printing_id,card_id FROM revision_printings
         WHERE catalogue_revision_id=? ORDER BY card_id,printing_id LIMIT 2`,
        )
        .bind(revisionId)
        .all<{ printing_id: string; card_id: string }>(),
    ]);
    if (cards.results.length !== 2 || printings.results.length !== 2) return null;
    const firstCard = cards.results[0]!;
    const representativeCard = cards.results[1]!;
    const firstPrinting = printings.results[0]!;
    const representativePrinting = printings.results[1]!;
    const cardAfter = {
      game: firstCard.sort_game,
      identity_kind: firstCard.sort_identity_kind,
      identity_value: firstCard.sort_identity_value,
      id: firstCard.sort_id,
    };
    const searchQuery = releaseSmokeSearchQuery(representativeCard.document_json);
    if (searchQuery === null) return null;
    const ftsQuery = cardSearchFtsQuery(searchQuery, revisionId);
    if (ftsQuery === null) return null;
    const indexed = await database
      .prepare(
        `SELECT 1 AS present FROM revision_card_search_fts
       WHERE revision_card_search_fts MATCH ?
         AND catalogue_revision_id=? AND card_id=?
         AND instr(search_text,?)>0 LIMIT 1`,
      )
      .bind(ftsQuery, revisionId, representativeCard.card_id, searchQuery)
      .first<{ present: number }>();
    if (indexed?.present !== 1) return null;
    revisions.push({
      revision_id: revisionId,
      card_id: representativeCard.card_id,
      printing_id: representativePrinting.printing_id,
      search_query: searchQuery,
      card_cursor: encodeReleaseCursor({
        contract: "card-keepr-card-cursor@1",
        route: "/v1/cards",
        order: "game,official_identity.kind,official_identity.value,id",
        revision_id: revisionId,
        q: null,
        game: null,
        card_number: null,
        limit: 50,
        after: cardAfter,
      }),
      search_cursor: encodeReleaseCursor({
        contract: "card-keepr-card-cursor@1",
        route: "/v1/cards",
        order: "game,official_identity.kind,official_identity.value,id",
        revision_id: revisionId,
        q: searchQuery,
        game: null,
        card_number: null,
        limit: 50,
        after: cardAfter,
      }),
      printing_cursor: encodeReleaseCursor({
        route: "/v1/printings",
        ordering: "card-id,printing-id",
        revision: revisionId,
        filters: { card_id: null, game: null, rarity: null, product_id: null, release_region: null, limit: 50 },
        last: { card_id: firstPrinting.card_id, id: firstPrinting.printing_id },
      }),
    });
  }
  const [currentExtras, unavailable] = await Promise.all([
    database
      .prepare(
        `SELECT
       (SELECT image_id FROM revision_printing_images WHERE catalogue_revision_id=? ORDER BY image_id LIMIT 1) AS printing_image_id,
       (SELECT json_extract(card_ids_json,'$[0]') FROM revision_legality_rules WHERE catalogue_revision_id=? AND json_array_length(card_ids_json)>0 ORDER BY legality_rule_id LIMIT 1) AS legality_card_id,
       (SELECT format FROM revision_legality_rules WHERE catalogue_revision_id=? AND json_array_length(card_ids_json)>0 ORDER BY legality_rule_id LIMIT 1) AS legality_format,
       (SELECT region FROM revision_legality_rules WHERE catalogue_revision_id=? AND json_array_length(card_ids_json)>0 ORDER BY legality_rule_id LIMIT 1) AS legality_region`,
      )
      .bind(...Array(4).fill(revisionIds[0]))
      .first<Record<string, string | null>>(),
    database
      .prepare(
        `SELECT catalogue_revision_id FROM catalogue_query_revisions
       WHERE state='archived' ORDER BY catalogue_revision_id DESC LIMIT 1`,
      )
      .first<{ catalogue_revision_id: string }>(),
  ]);
  if (
    currentExtras === null ||
    unavailable === null ||
    Object.values(currentExtras).some((value) => typeof value !== "string")
  )
    return null;
  const staleAfter = (revisions[0] as { card_cursor: string }).card_cursor;
  const decoded = JSON.parse(
    new TextDecoder().decode(Uint8Array.from(atob(staleAfter), (character) => character.charCodeAt(0))),
  ) as Record<string, unknown>;
  return {
    revisions,
    ...currentExtras,
    stale_cursor: encodeReleaseCursor({ ...decoded, revision_id: unavailable.catalogue_revision_id }),
    stale_revision_id: unavailable.catalogue_revision_id,
  };
}

export function releaseSmokeSearchQuery(documentJson: string): string | null {
  try {
    const envelope = JSON.parse(documentJson) as Record<string, unknown>;
    const card = isRecord(envelope.data) ? envelope.data : envelope;
    if (
      !isRecord(card.official_identity) ||
      typeof card.official_identity.value !== "string" ||
      typeof card.name !== "string" ||
      (card.effective_rules_text !== null &&
        card.effective_rules_text !== undefined &&
        typeof card.effective_rules_text !== "string")
    )
      return null;
    const fields = JSON.parse(
      cardSearchText({
        official_identity: { value: card.official_identity.value },
        name: card.name,
        effective_rules_text: card.effective_rules_text as string | null | undefined,
      }),
    ) as string[];
    const field = fields.find((item) => [...item].length >= 3);
    return field === undefined ? null : [...field].slice(0, 64).join("");
  } catch {
    return null;
  }
}

function encodeReleaseCursor(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes));
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
  const currentRevision = await database
    .prepare(
      `SELECT content_digest
      FROM catalogue_revisions
      WHERE id = ?`,
    )
    .bind(catalogueState.current_revision_id)
    .first<{ content_digest: string }>();
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

function assertRulesClockFresh(
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

async function candidateWithCanonicalLegalityProvenance(
  database: D1Database,
  candidate: CatalogueCandidate,
): Promise<CatalogueCandidate> {
  const rules = candidate.legality_rules ?? [];
  if (rules.length === 0) return candidate;
  const canonical = new Map<string, CanonicalLegalityProvenance>();
  for (const chunk of byteBoundedJsonArrays(rules.map((rule) => rule.id))) {
    const rows = await database
      .prepare(
        `SELECT id, source_lineage, source_snapshot_id,
              source_observation_set_id, source_observation_id,
              source_observation_pointer, source_field_pointers_json
       FROM legality_rules
       WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .bind(chunk)
      .all<CanonicalLegalityProvenance>();
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

export async function rejectRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  request: RejectRunRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  assertOpaqueId(runId, "run_id");
  assertSha256(request.candidate_digest, "candidate_digest");
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({
    run_id: runId,
    candidate_digest: request.candidate_digest,
  });
  return idempotentAdministration(
    database,
    {
      key: request.idempotency_key,
      operation: "reject_ingestion_run",
      requestJson,
      observedAt,
    },
    async (claimOwner) => {
      await expireOverdueRuns(database, observedAt);
      await reconcileAbandonedPublication(database, catalogueExports, observedAt);
      return rejectRunAttempt(database, runId, request, requestJson, observedAt, claimOwner);
    },
  );
}

async function rejectRunAttempt(
  database: D1Database,
  runId: string,
  request: RejectRunRequest,
  requestJson: string,
  now: string,
  claimOwner: IdempotencyClaimOwner,
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, now);
  const run = await requiredRun(database, runId);
  if (run.state === "expired") {
    throw new AdministrationProblem(409, "candidate_expired", "The candidate approval deadline has passed.");
  }
  if (run.state !== "awaiting_approval") {
    throw new AdministrationProblem(409, "run_not_awaiting_approval", "The Ingestion Run is not awaiting approval.");
  }
  if (run.candidate_digest !== request.candidate_digest) {
    throw new AdministrationProblem(
      409,
      "candidate_digest_mismatch",
      "The candidate digest no longer matches the requested rejection.",
    );
  }
  const decision = {
    action: "rejected",
    rejected_at: now,
    candidate_digest: request.candidate_digest,
  };
  const rejectedProgress = terminalProgress(run, "rejected");
  const resultingRun = publicRun({
    ...run,
    state: "rejected",
    terminal_at: now,
    progress_json: JSON.stringify(rejectedProgress),
    approval_history_json: JSON.stringify([decision]),
  });
  try {
    await database.batch([
      database
        .prepare(
          `UPDATE ingestion_runs
          SET state = 'rejected',
              terminal_at = ?,
              progress_json = ?,
              approval_history_json = ?
          WHERE id = ? AND state = 'awaiting_approval'`,
        )
        .bind(now, JSON.stringify(rejectedProgress), JSON.stringify([decision]), run.id),
      releaseRunLockStatement(database, run.id),
      ...idempotencyCompletionStatements(database, {
        key: request.idempotency_key,
        operation: "reject_ingestion_run",
        requestJson,
        response: resultingRun,
        status: 200,
        createdAt: now,
        claimOwner,
      }),
    ]);
  } catch (error) {
    const concurrentReplay = await replayAfterConflict(
      database,
      request.idempotency_key,
      "reject_ingestion_run",
      requestJson,
      error,
    );
    if (concurrentReplay !== null) return concurrentReplay;
    if (errorMessage(error).includes("run_not_active")) {
      throw new AdministrationProblem(409, "run_not_active", "The active Ingestion Run identity no longer matches.");
    }
    throw error;
  }
  return resultingRun;
}

export { AdministrationProblem } from "./shared";

class PublicationPrefixOwnershipError extends Error {}

async function startPreparedRun(
  database: D1Database,
  input: {
    candidate: CatalogueCandidate;
    selectedGames: readonly SupportedGame[];
    idempotencyKey: string;
    operationalRequestId: string | null;
    idempotencyOperation: string;
    idempotencyRequestJson: string;
    linkedRunId: string | null;
    observedAt: string;
    claimOwner: IdempotencyClaimOwner;
  },
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, input.observedAt);
  const [catalogueState, operationState] = await Promise.all([
    currentCatalogueState(database),
    currentOperationState(database),
  ]);
  if (operationState.active_ingestion_run_id !== null) {
    throw new AdministrationProblem(409, "active_ingestion_run", "Another Ingestion Run is already active.");
  }
  if (operationState.recovery_health === "blocked") {
    throw new AdministrationProblem(409, "recovery_in_progress", "Recovery blocks new Ingestion Runs.");
  }
  await assertCuratedGamesUnblocked(database, input.selectedGames);

  const startedAt = input.observedAt;
  const approvalDeadline = new Date(Date.parse(startedAt) + sevenDaysInMilliseconds).toISOString();
  const runId = `run_${crypto.randomUUID()}`;
  const curated = await prepareCuratedRevisionRunStart(
    database,
    runId,
    input.selectedGames,
    input.candidate,
    startedAt,
  );
  const candidateJson = canonicalJson(curated.candidate);
  const candidateDigest = await sha256(new TextEncoder().encode(candidateJson));
  const curatedFailure = curated.failureCode !== null;
  const resultingRun = publicRun({
    id: runId,
    state: curatedFailure ? "failed" : "awaiting_approval",
    selected_games_json: JSON.stringify(input.selectedGames),
    started_at: startedAt,
    expected_current_revision_id: catalogueState.current_revision_id,
    linked_run_id: input.linkedRunId,
    idempotency_key: input.idempotencyKey,
    operational_request_id: input.operationalRequestId,
    candidate_digest: candidateDigest,
    candidate_catalogue_digest: candidateDigest,
    candidate_created_at: startedAt,
    approval_deadline: approvalDeadline,
    approval_json: null,
    published_revision_id: null,
    export_manifest_digest: null,
    terminal_at: curatedFailure ? startedAt : null,
    candidate_json: candidateJson,
    approval_idempotency_key: null,
    failure_code: curated.failureCode,
    progress_json: JSON.stringify(progressFor(curatedFailure ? "failed" : "awaiting_approval")),
    warnings_json: canonicalJson(curated.diagnostics),
    approval_history_json: "[]",
    publication_outcome: null,
    resulting_revision_id: null,
    freshness_checked_at: null,
    publication_revision_id: null,
    publication_started_at: null,
    publication_reconcile_after: null,
    publication_manifest_digest: null,
    publication_writer_token: null,
  });
  const curatedPinStatements = curated.statements;

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO ingestion_runs (
            id,
            state,
            selected_games_json,
            started_at,
            expected_current_revision_id,
            linked_run_id,
            idempotency_key,
            operational_request_id,
            candidate_digest,
            candidate_catalogue_digest,
            candidate_created_at,
            approval_deadline,
            approval_json,
            published_revision_id,
            export_manifest_digest,
            terminal_at,
            candidate_json,
            approval_idempotency_key,
            failure_code,
            progress_json,
            warnings_json,
            approval_history_json,
            publication_outcome,
            resulting_revision_id,
            freshness_checked_at
          ) VALUES (
            ?, 'planning', ?, ?, ?, ?, ?, ?,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL,
            NULL, ?, ?, '[]', NULL, NULL, NULL
          )`,
        )
        .bind(
          runId,
          JSON.stringify(input.selectedGames),
          startedAt,
          catalogueState.current_revision_id,
          input.linkedRunId,
          input.idempotencyKey,
          input.operationalRequestId,
          candidateJson,
          JSON.stringify(progressFor("planning")),
          canonicalJson(curated.diagnostics),
        ),
      ...curatedPinStatements,
      ...(curatedFailure
        ? [
            database
              .prepare(
                `UPDATE operation_state
           SET active_ingestion_run_id = ?
           WHERE singleton = 1
             AND active_ingestion_run_id IS NULL
             AND recovery_health <> 'blocked'`,
              )
              .bind(runId),
            database
              .prepare(
                `UPDATE ingestion_runs
           SET state = 'failed',
               candidate_digest = ?,
               candidate_catalogue_digest = ?,
               candidate_created_at = ?,
               approval_deadline = ?,
               terminal_at = ?,
               failure_code = ?,
               progress_json = ?
           WHERE id = ? AND state = 'planning'`,
              )
              .bind(
                candidateDigest,
                candidateDigest,
                startedAt,
                approvalDeadline,
                startedAt,
                curated.failureCode,
                JSON.stringify(progressFor("failed")),
                runId,
              ),
            releaseRunLockStatement(database, runId),
          ]
        : [
            database
              .prepare(
                `UPDATE operation_state
          SET active_ingestion_run_id = ?
          WHERE singleton = 1
            AND active_ingestion_run_id IS NULL
            AND recovery_health <> 'blocked'`,
              )
              .bind(runId),
            transitionStatement(database, runId, "planning", "collecting"),
            transitionStatement(database, runId, "collecting", "parsing"),
            transitionStatement(database, runId, "parsing", "reconciling"),
            database
              .prepare(
                `UPDATE ingestion_runs
          SET state = 'awaiting_approval',
              candidate_digest = ?,
              candidate_catalogue_digest = ?,
              candidate_created_at = ?,
              approval_deadline = ?,
              progress_json = ?
          WHERE id = ? AND state = 'reconciling'`,
              )
              .bind(
                candidateDigest,
                candidateDigest,
                startedAt,
                approvalDeadline,
                JSON.stringify(progressFor("awaiting_approval")),
                runId,
              ),
          ]),
      ...idempotencyCompletionStatements(database, {
        key: input.idempotencyKey,
        operation: input.idempotencyOperation,
        requestJson: input.idempotencyRequestJson,
        response: resultingRun,
        status: 201,
        createdAt: startedAt,
        claimOwner: input.claimOwner,
      }),
    ]);
  } catch (error) {
    const concurrentReplay = await replayAfterConflict(
      database,
      input.idempotencyKey,
      input.idempotencyOperation,
      input.idempotencyRequestJson,
      error,
    );
    if (concurrentReplay !== null) return concurrentReplay;
    if (errorMessage(error).includes("active_ingestion_run") || errorMessage(error).includes("run_not_active")) {
      throw new AdministrationProblem(409, "active_ingestion_run", "Another Ingestion Run is already active.");
    }
    if (errorMessage(error).includes("recovery_in_progress")) {
      throw new AdministrationProblem(409, "recovery_in_progress", "Recovery blocks new Ingestion Runs.");
    }
    if (errorMessage(error).includes("credential_execution_in_progress")) {
      throw new AdministrationProblem(
        409,
        "credential_execution_in_progress",
        "Credential execution blocks new Ingestion Runs.",
      );
    }
    throw error;
  }
  return resultingRun;
}

async function publishNoChange(
  database: D1Database,
  run: RunRow,
  request: ApproveRunRequest,
  requestJson: string,
  approval: Record<string, unknown>,
  now: string,
  claimOwner: IdempotencyClaimOwner,
  candidate: CatalogueCandidate,
): Promise<Record<string, unknown>> {
  const resultingRun = publicRun({
    ...run,
    state: "published",
    approval_json: JSON.stringify(approval),
    approval_idempotency_key: request.idempotency_key,
    approval_history_json: JSON.stringify([approval]),
    terminal_at: now,
    progress_json: JSON.stringify(progressFor("published")),
    publication_outcome: "no_change",
    resulting_revision_id: request.expected_current_revision_id,
    freshness_checked_at: now,
  });
  const reconciliation = await reconciliationPublication(database, run.id, request.expected_current_revision_id, now);
  const runFreshnessStatements = await freshnessStatementsForRun(
    database,
    parseSelectedGames(run.selected_games_json),
    run.id,
    candidate,
    now,
  );
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO ingestion_no_change_results (
            ingestion_run_id,
            catalogue_revision_id,
            candidate_digest,
            checked_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .bind(run.id, request.expected_current_revision_id, request.candidate_digest, now),
      database
        .prepare(
          `UPDATE ingestion_runs
          SET state = 'publishing',
              approval_json = ?,
              approval_idempotency_key = ?,
              approval_history_json = ?,
              progress_json = ?
          WHERE id = ? AND state = 'awaiting_approval'`,
        )
        .bind(
          JSON.stringify(approval),
          request.idempotency_key,
          JSON.stringify([approval]),
          JSON.stringify(progressFor("publishing")),
          run.id,
        ),
      ...(reconciliation?.statements ?? []),
      ...runFreshnessStatements,
      database
        .prepare(
          `UPDATE ingestion_runs
          SET state = 'published',
              terminal_at = ?,
              progress_json = ?,
              publication_outcome = 'no_change',
              resulting_revision_id = ?,
              freshness_checked_at = ?
          WHERE id = ? AND state = 'publishing'`,
        )
        .bind(now, JSON.stringify(progressFor("published")), request.expected_current_revision_id, now, run.id),
      releaseRunLockStatement(database, run.id),
      ...idempotencyCompletionStatements(database, {
        key: request.idempotency_key,
        operation: "approve_ingestion_run",
        requestJson,
        response: resultingRun,
        status: 200,
        createdAt: now,
        claimOwner,
      }),
    ]);
  } catch (error) {
    const concurrentReplay = await replayAfterConflict(
      database,
      request.idempotency_key,
      "approve_ingestion_run",
      requestJson,
      error,
    );
    if (concurrentReplay !== null) return concurrentReplay;
    await throwApprovalFailure(database, run, error, now);
  }
  return resultingRun;
}

function assertRunIsApprovable(run: RunRow, request: ApproveRunRequest): void {
  if (run.state === "expired") {
    throw new AdministrationProblem(409, "candidate_expired", "The candidate approval deadline has passed.");
  }
  if (run.state !== "awaiting_approval") {
    throw new AdministrationProblem(409, "run_not_awaiting_approval", "The Ingestion Run is not awaiting approval.");
  }
  if (run.candidate_digest !== request.candidate_digest) {
    throw new AdministrationProblem(
      409,
      "candidate_digest_mismatch",
      "The candidate digest no longer matches the requested approval.",
    );
  }
}

async function throwApprovalFailure(database: D1Database, run: RunRow, error: unknown, now: string): Promise<never> {
  const message = errorMessage(error);
  await expireOverdueRuns(database, now);
  const guardedRun = await requiredRun(database, run.id);
  if (guardedRun.state === "expired") {
    throw new AdministrationProblem(409, "candidate_expired", "The candidate approval deadline has passed.");
  }
  if (message.includes("run_not_active")) {
    throw new AdministrationProblem(409, "run_not_active", "The active Ingestion Run identity no longer matches.");
  }
  if (
    message.includes("publication_guard_failed") ||
    message.includes("approval_guard_failed") ||
    message.includes("no_change_guard_failed")
  ) {
    const [catalogue, operation] = await Promise.all([
      currentCatalogueState(database),
      currentOperationState(database),
    ]);
    if (catalogue.current_revision_id !== run.expected_current_revision_id) {
      throw new AdministrationProblem(
        409,
        "current_revision_mismatch",
        "The current Catalogue Revision no longer matches the requested approval.",
      );
    }
    if (operation.active_ingestion_run_id !== run.id) {
      throw new AdministrationProblem(409, "run_not_active", "The active Ingestion Run identity no longer matches.");
    }
    if (operation.recovery_health !== "healthy") {
      throw new AdministrationProblem(
        409,
        "recovery_not_verified",
        "Recovery is not healthy, so publication is blocked.",
      );
    }
    throw new AdministrationProblem(
      409,
      "publication_precondition_failed",
      "The publication guards changed before the approval could commit.",
    );
  }
  await failRun(database, run.id, now, "export_verification_failed");
  throw new AdministrationProblem(
    500,
    "export_verification_failed",
    "The Catalogue Export could not be verified, so no revision was published.",
  );
}

function catalogueCard(
  card: CatalogueCandidate["cards"][number],
  printingIds: readonly string[],
  revisionId: string,
  reconciledLifecycle?: Record<string, unknown>,
  evidenceResources: readonly PublicationEvidenceResource[] = [],
  effectiveRulesEvidence: readonly PublicationEvidenceResource[] = [],
) {
  const data = {
    type: "card",
    ...card,
    printing_ids: printingIds,
    source_lineages: [...new Set(evidenceResources.map(({ source }) => source))].sort(),
    lifecycle: reconciledLifecycle ?? lifecycle(revisionId),
    links: {
      self: `/v1/cards/${card.id}`,
    },
  };
  const included = [
    ...new Map([...evidenceResources, ...effectiveRulesEvidence].map((resource) => [resource.id, resource])).values(),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const effectiveRulesObservationIds = [...new Set(effectiveRulesEvidence.map(({ id }) => id))].sort();
  return {
    data,
    included,
    provenance:
      effectiveRulesObservationIds.length === 0
        ? {}
        : {
            "/data/effective_rules_text": effectiveRulesObservationIds,
          },
    disagreements: [],
  };
}

async function cataloguePrinting(
  printing: CatalogueCandidate["printings"][number],
  game: SupportedGame,
  revisionId: string,
  reconciledLifecycle?: Record<string, unknown>,
  relationshipEvidence: readonly Record<string, unknown>[] = [],
  locatorEvidence: Record<string, unknown> = {
    current: [],
    historical: [],
  },
  declaredContexts: readonly NonNullable<CatalogueCandidate["distribution_contexts"]>[number][] = [],
  declaredProducts: readonly NonNullable<CatalogueCandidate["products"]>[number][] = [],
  declaredRelationships: readonly NonNullable<CatalogueCandidate["product_relationships"]>[number][] = [],
  evidenceResources: readonly {
    type: "source_observation";
    id: string;
    captured_at: string;
    source: string;
  }[] = [],
  printingImages: readonly NonNullable<CatalogueCandidate["printing_images"]>[number][] = [],
) {
  const canonicalRelationshipEvidence = relationshipEvidence.filter(
    (relationship) => relationship.relationship_kind !== "source_bucket",
  );
  const contexts = await Promise.all(
    canonicalRelationshipEvidence
      .filter(
        (relationship) => relationship.current === true && relationship.relationship_kind === "distribution_context",
      )
      .map(async (relationship) => {
        const declared = declaredContexts.find(
          (context) => context.game === game && context.key === String(relationship.relationship_value),
        );
        return (
          declared ?? {
            id: await distributionContextExportId(
              game,
              String(relationship.source_lineage),
              String(relationship.relationship_value),
            ),
            kind: "other" as const,
            label: String(relationship.relationship_value),
            product_id: null,
            evidence_category: "explicit" as const,
          }
        );
      }),
  );
  const typed = typedPrintingProjections(printing.id, declaredProducts, declaredContexts, declaredRelationships);
  const projectedContexts = [
    ...new Map([...contexts, ...typed.distribution_contexts].map((context) => [context.id, context])).values(),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const data = {
    type: "printing",
    ...printing,
    printing_images: printingImages.map(publicPrintingImage),
    products: typed.products,
    distribution_contexts: projectedContexts,
    relationship_evidence: canonicalRelationshipEvidence,
    locator_evidence: locatorEvidence,
    source_lineages: [...new Set(evidenceResources.map(({ source }) => source))].sort(),
    lifecycle: reconciledLifecycle ?? lifecycle(revisionId),
    links: {
      self: `/v1/printings/${printing.id}`,
    },
  };
  const included = [...new Map(evidenceResources.map((resource) => [resource.id, resource])).values()].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
  const observationIds = included.map(({ id }) => id);
  return {
    data,
    included,
    provenance:
      observationIds.length === 0
        ? {}
        : {
            "/data/rarity": observationIds,
            "/data/printed_rules_text": observationIds,
            "/data/game_data": observationIds,
          },
    disagreements: [],
  };
}

function publicPrintingImage(image: NonNullable<CatalogueCandidate["printing_images"]>[number]) {
  return {
    type: "printing_image",
    id: image.id,
    printing_id: image.printing_id,
    role: image.role,
    media_type: image.media_type,
    width: image.width,
    height: image.height,
    content_sha256: image.content_sha256,
    links: {
      self: `/v1/printing-images/${encodeURIComponent(image.id)}`,
      content: `/v1/printing-images/${encodeURIComponent(image.id)}/content`,
    },
  };
}

function lifecycle(revisionId: string) {
  return {
    first_revision_id: revisionId,
    last_observed_revision_id: revisionId,
    withdrawn: false,
  };
}

async function reservePublication(
  database: D1Database,
  runId: string,
  approval: Record<string, unknown>,
  idempotencyKey: string,
  revisionId: string,
  manifestDigest: string,
  writerToken: string,
  startedAt: string,
): Promise<void> {
  const reconcileAfter = new Date(Date.parse(startedAt) + publicationLeaseMilliseconds).toISOString();
  const reserved = await database
    .prepare(
      `UPDATE ingestion_runs
      SET state = 'publishing',
          approval_json = ?,
          approval_idempotency_key = ?,
          approval_history_json = ?,
          progress_json = ?,
          publication_revision_id = ?,
          publication_started_at = ?,
          publication_reconcile_after = ?,
          publication_manifest_digest = ?,
          publication_writer_token = ?
      WHERE id = ? AND state = 'awaiting_approval'
      RETURNING id`,
    )
    .bind(
      JSON.stringify(approval),
      idempotencyKey,
      JSON.stringify([approval]),
      JSON.stringify(progressFor("publishing")),
      revisionId,
      startedAt,
      reconcileAfter,
      manifestDigest,
      writerToken,
      runId,
    )
    .first<{ id: string }>();
  if (reserved === null) {
    throw new AdministrationProblem(
      409,
      "publication_precondition_failed",
      "The Ingestion Run could not reserve publication.",
    );
  }
}

async function storeAndVerifyExport(
  database: D1Database,
  bucket: R2Bucket,
  runId: string,
  revisionId: string,
  writerToken: string,
  objects: readonly ExportObject[],
): Promise<void> {
  for (const object of objects) {
    await assertReservedPublicationOwnsUnpublishedPrefix(database, runId);
    await assertPublicationWriterActive(database, runId, revisionId, writerToken);
    const existing = await bucket.head(object.key);
    await assertReservedPublicationOwnsUnpublishedPrefix(database, runId);
    if (existing !== null) {
      if (!(await storedExportObjectMatches(bucket, object))) {
        throw new Error("Immutable Catalogue Export object changed");
      }
      continue;
    }
    const body = object.body();
    await Promise.all([
      bucket.put(object.key, body.readable, {
        sha256: object.sha256,
        httpMetadata: {
          contentType: object.contentType,
          ...(object.contentEncoding === undefined ? {} : { contentEncoding: object.contentEncoding }),
          cacheControl: "private, max-age=31536000, immutable",
        },
      }),
      body.completed,
    ]);
    if (!(await storedExportObjectMatches(bucket, object))) {
      throw new Error("Catalogue Export object verification failed");
    }
    await assertPublicationWriterActive(database, runId, revisionId, writerToken, bucket, object.key);
  }
}

async function storeAndVerifyPrintingImages(
  candidate: CatalogueCandidate,
  bucket: R2Bucket | undefined,
): Promise<void> {
  const images = candidate.printing_images ?? [];
  if (images.length === 0) return;
  if (bucket === undefined) {
    throw new Error("The Printing Image object binding is unavailable.");
  }
  for (const image of images) {
    const bytes = decodeBase64Bytes(image.content_base64);
    if (
      bytes.byteLength !== image.content_byte_length ||
      (await sha256(bytes)) !== image.content_sha256 ||
      image.object_key !== `printing-images/${image.content_sha256}`
    ) {
      throw new Error("Captured Printing Image bytes failed verification.");
    }
    const existing = await bucket.head(image.object_key);
    if (existing !== null) {
      await assertStoredPrintingImage(bucket, existing, image);
      continue;
    }
    const stored = await bucket.put(image.object_key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: image.content_sha256,
      httpMetadata: {
        contentType: image.media_type,
        cacheControl: "private, max-age=31536000, immutable",
      },
      customMetadata: { sha256: image.content_sha256 },
    });
    if (stored === null) {
      const concurrent = await bucket.head(image.object_key);
      if (concurrent === null) {
        throw new Error("Immutable Printing Image write conflict.");
      }
      await assertStoredPrintingImage(bucket, concurrent, image);
      continue;
    }
    await assertStoredPrintingImage(bucket, stored, image);
  }
}

function decodeBase64Bytes(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("Captured Printing Image bytes are not valid base64.");
  }
}

async function assertStoredPrintingImage(
  bucket: R2Bucket,
  object: R2Object,
  image: NonNullable<CatalogueCandidate["printing_images"]>[number],
): Promise<void> {
  if (object.size !== image.content_byte_length) {
    throw new Error("Immutable Printing Image object key collision.");
  }
  const storedChecksum = object.checksums.toJSON().sha256;
  if (storedChecksum !== undefined) {
    if (storedChecksum !== image.content_sha256) {
      throw new Error("Immutable Printing Image object key collision.");
    }
    return;
  }
  const body = await bucket.get(image.object_key);
  if (body === null) {
    throw new Error("Immutable Printing Image object disappeared.");
  }
  const digest = new crypto.DigestStream("SHA-256");
  await body.body.pipeTo(digest);
  if (digestHex(await digest.digest) !== image.content_sha256) {
    throw new Error("Immutable Printing Image object key collision.");
  }
}

function assertPublicationAggregateBudget(candidate: CatalogueCandidate): void {
  const encoder = new TextEncoder();
  const candidateBytes = encoder.encode(canonicalJson(candidate)).byteLength;
  if (candidateBytes > maximumPublicationCandidateBytes) {
    throw new AdministrationProblem(
      422,
      "publication_aggregate_too_large",
      "The Catalogue candidate exceeds the bounded publication aggregate.",
    );
  }
  let searchTermBytes = 2;
  let searchChunkBytes = 2;
  for (const card of candidate.cards) {
    assertPublicationEntityBudget(card, "Card", encoder);
    const document = cardSearchText(card);
    for (const term of cardSearchTerms(document)) {
      searchTermBytes +=
        (searchTermBytes === 2 ? 0 : 1) +
        encoder.encode(
          canonicalJson({
            card_id: card.id,
            term,
          }),
        ).byteLength;
    }
    for (const chunk of cardSearchChunks(document)) {
      searchChunkBytes +=
        (searchChunkBytes === 2 ? 0 : 1) +
        encoder.encode(
          canonicalJson({
            card_id: card.id,
            field_ordinal: chunk.field,
            chunk_ordinal: chunk.ordinal,
            search_text: chunk.text,
          }),
        ).byteLength;
    }
    if (searchTermBytes + searchChunkBytes > maximumPublicationSearchMaterializationBytes) {
      throw new AdministrationProblem(
        422,
        "publication_aggregate_too_large",
        "The Catalogue candidate exceeds the byte-bounded Card search publication aggregate.",
      );
    }
  }
  for (const printing of candidate.printings) {
    assertPublicationEntityBudget(printing, "Printing", encoder);
  }
  for (const erratum of candidate.errata ?? []) {
    assertPublicationEntityBudget(erratum, "Erratum", encoder);
  }
}

function assertPublicationEntityBudget(entity: unknown, description: string, encoder: TextEncoder): void {
  if (encoder.encode(canonicalJson(entity)).byteLength > maximumPublicationEntityBytes) {
    throw new AdministrationProblem(
      422,
      "publication_aggregate_too_large",
      `One ${description} exceeds the byte-bounded publication record budget.`,
    );
  }
}

function assertBuiltPublicationBudget(catalogueExport: BuiltCatalogueExport): void {
  let bytes = 0;
  for (const object of catalogueExport.objects) {
    bytes += object.byteLength;
    if (bytes > maximumPublicationExportBytes) {
      throw new AdministrationProblem(
        422,
        "publication_aggregate_too_large",
        "The Catalogue Export exceeds the bounded publication aggregate.",
      );
    }
  }
}

async function assertPublicationWriterActive(
  database: D1Database,
  runId: string,
  revisionId: string,
  writerToken: string,
  bucket?: R2Bucket,
  lateObjectKey?: string,
): Promise<void> {
  const reservation = await database
    .prepare(
      `SELECT id
      FROM ingestion_runs
      WHERE id = ?
        AND (
          state = 'publishing'
          OR (? = 1 AND state = 'published')
        )
        AND publication_revision_id = ?
        AND publication_writer_token = ?`,
    )
    .bind(runId, bucket === undefined ? 0 : 1, revisionId, writerToken)
    .first<{ id: string }>();
  if (reservation === null) {
    if (bucket !== undefined && lateObjectKey !== undefined) {
      await compensateLatePublicationWrite(database, bucket, runId, lateObjectKey);
    }
    throw new Error("publication_writer_fenced");
  }
}

function publicationWriterToken(revisionId: string): string {
  return `writer:${revisionId}`;
}

async function compensateLatePublicationWrite(
  database: D1Database,
  bucket: R2Bucket,
  runId: string,
  objectKey: string,
): Promise<void> {
  try {
    await bucket.delete(objectKey);
    if ((await bucket.get(objectKey)) === null) return;
  } catch {
    // Persisting cleanup ownership below is the fail-closed fallback.
  }
  const run = await requiredRun(database, runId);
  if (run.state !== "failed" || run.terminal_at === null) {
    throw new Error("The late publication write could not be attached to terminal cleanup.");
  }
  const failureAt = run.terminal_at;
  await database
    .prepare(
      `INSERT INTO ingestion_publication_cleanup (
        ingestion_run_id,
        state,
        object_keys_json,
        attempts,
        failure_code,
        last_attempt_at,
        completed_at,
        not_before,
        idempotency_key,
        request_json,
        claim_token,
        claim_version,
        claim_expires_at
      ) VALUES (
        ?, 'failed', json_array(?), 1,
        'late_publication_write', ?, NULL, ?,
        NULL, NULL, NULL, 1, NULL
      )
      ON CONFLICT (ingestion_run_id) DO UPDATE SET
        state = 'failed',
        object_keys_json = (
          SELECT json_group_array(object_key)
          FROM (
            SELECT value AS object_key
            FROM json_each(
              ingestion_publication_cleanup.object_keys_json
            )
            UNION
            SELECT excluded_key.object_key
            FROM (SELECT ? AS object_key) AS excluded_key
            ORDER BY object_key
          )
        ),
        attempts = MAX(ingestion_publication_cleanup.attempts, 1),
        failure_code = 'late_publication_write',
        last_attempt_at = ?,
        completed_at = NULL,
        idempotency_key = NULL,
        request_json = NULL,
        claim_token = NULL,
        claim_version =
          ingestion_publication_cleanup.claim_version + 1,
        claim_expires_at = NULL`,
    )
    .bind(runId, objectKey, failureAt, publicationCleanupNotBefore(run, failureAt), objectKey, failureAt)
    .run();
}

async function commitVerifiedPublication(
  database: D1Database,
  input: {
    run: RunRow;
    candidate: CatalogueCandidate;
    catalogueExport: BuiltCatalogueExport;
    reconciliation: ReconciliationPublicationPlan | null;
    requestJson: string;
    completedAt: string;
    claimOwner?: IdempotencyClaimOwner;
  },
): Promise<Record<string, unknown>> {
  const revisionId = requiredPublicationValue(input.run.publication_revision_id, "revision ID");
  const publishedAt = requiredPublicationValue(input.run.publication_started_at, "start time");
  const idempotencyKey = requiredPublicationValue(input.run.approval_idempotency_key, "idempotency key");
  const manifestDigest = requiredPublicationValue(input.run.publication_manifest_digest, "manifest digest");
  const publicationBackup = await publicationBackupReservation(revisionId);
  if (
    input.catalogueExport.manifest.manifest_sha256 !== manifestDigest ||
    input.catalogueExport.manifestKey !== `catalogue-exports/${revisionId}/manifest.json`
  ) {
    throw new Error("Reserved Catalogue Export identity changed");
  }
  const resultingRun = publicRun({
    ...input.run,
    state: "published",
    published_revision_id: revisionId,
    export_manifest_digest: manifestDigest,
    terminal_at: input.completedAt,
    progress_json: JSON.stringify(progressFor("published")),
    publication_outcome: "revision",
    resulting_revision_id: revisionId,
    freshness_checked_at: input.completedAt,
  });
  const runFreshnessStatements = await freshnessStatementsForRun(
    database,
    parseSelectedGames(input.run.selected_games_json),
    input.run.id,
    input.candidate,
    input.completedAt,
  );
  const cardDocuments = input.candidate.cards.map((card) => {
    const document = catalogueCard(
      card,
      input.candidate.printings.filter((printing) => printing.card_id === card.id).map((printing) => printing.id),
      revisionId,
      input.reconciliation?.cardLifecycles[card.id],
      input.reconciliation?.cardEvidence[card.id] ?? [],
      input.reconciliation?.cardEffectiveRulesEvidence[card.id] ?? [],
    );
    return {
      card,
      document,
      summary: {
        type: document.data.type,
        id: document.data.id,
        game: document.data.game,
        official_identity: document.data.official_identity,
        name: document.data.name,
        game_data: document.data.game_data,
        lifecycle: document.data.lifecycle,
        links: document.data.links,
      },
      searchText: cardSearchText(document.data),
    };
  });
  const printingDocuments = await Promise.all(
    input.candidate.printings.map(async (printing) => ({
      printing,
      document: await cataloguePrinting(
        printing,
        input.candidate.cards.find((card) => card.id === printing.card_id)!.game,
        revisionId,
        input.reconciliation?.printingLifecycles[printing.id],
        input.reconciliation?.relationshipEvidence[printing.id] ?? [],
        input.reconciliation?.locatorEvidence[printing.id] ?? {
          current: [],
          historical: [],
        },
        input.candidate.distribution_contexts ?? [],
        input.candidate.products ?? [],
        input.candidate.product_relationships ?? [],
        input.reconciliation?.printingEvidence[printing.id] ?? [],
        (input.candidate.printing_images ?? []).filter((image) => image.printing_id === printing.id),
      ),
    })),
  );
  const productReleaseStatements = productReleasePublicationStatements(database, input.candidate, revisionId, {
    products: input.reconciliation?.productLifecycles ?? {},
    releases:
      input.reconciliation?.releaseLifecycles ??
      Object.fromEntries(
        (input.candidate.products ?? []).flatMap((product) =>
          product.releases.map((release) => [
            release.id,
            {
              first_revision_id: revisionId,
              last_observed_revision_id: revisionId,
            },
          ]),
        ),
      ),
    relationships: input.reconciliation?.productRelationshipLifecycles ?? {},
  });
  const revisionCardStatements = byteBoundedJsonArrays(
    cardDocuments.map(({ card, document }) => ({
      card_id: card.id,
      document_json: JSON.stringify(document),
    })),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO revision_cards (
           catalogue_revision_id, card_id, document_json
         )
         SELECT ?, json_extract(value, '$.card_id'),
                json_extract(value, '$.document_json')
         FROM json_each(?)`,
      )
      .bind(revisionId, chunk),
  );
  const revisionCardQueryStatements = byteBoundedJsonArrays(
    cardDocuments.map(({ card, summary, searchText }) => ({
      card_id: card.id,
      summary_json: JSON.stringify(summary),
      search_text: searchText,
    })),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO revision_card_query_documents (
           catalogue_revision_id, card_id, summary_json, search_text
         )
         SELECT ?, json_extract(value, '$.card_id'),
                json_extract(value, '$.summary_json'),
                json_extract(value, '$.search_text')
         FROM json_each(?)`,
      )
      .bind(revisionId, chunk),
  );
  const revisionCardSearchStatements = byteBoundedJsonArrays(
    cardDocuments.flatMap(({ card, searchText }) =>
      cardSearchTerms(searchText).map((term) => ({
        card_id: card.id,
        term,
      })),
    ),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO revision_card_search_terms (
           catalogue_revision_id, card_id, term, sort_game,
           sort_identity_kind, sort_identity_value, sort_id
         )
         SELECT query.catalogue_revision_id, query.card_id,
                json_extract(term.value, '$.term'),
                query.sort_game, query.sort_identity_kind,
                query.sort_identity_value, query.sort_id
         FROM json_each(?) AS term
         JOIN revision_card_query_documents AS query
           ON query.catalogue_revision_id = ?
          AND query.card_id = json_extract(term.value, '$.card_id')`,
      )
      .bind(chunk, revisionId),
  );
  const revisionCardSearchChunkStatements = byteBoundedJsonArrays(
    cardDocuments.flatMap(({ card, searchText }) =>
      cardSearchChunks(searchText).map((chunk) => ({
        card_id: card.id,
        field_ordinal: chunk.field,
        chunk_ordinal: chunk.ordinal,
        search_text: chunk.text,
      })),
    ),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO revision_card_search_chunks (
           catalogue_revision_id, card_id, field_ordinal,
           chunk_ordinal, search_text
         )
         SELECT ?, json_extract(value, '$.card_id'),
                json_extract(value, '$.field_ordinal'),
                json_extract(value, '$.chunk_ordinal'),
                json_extract(value, '$.search_text')
         FROM json_each(?)`,
      )
      .bind(revisionId, chunk),
  );
  const revisionPrintingStatements = byteBoundedJsonArrays(
    printingDocuments.map(({ printing, document }) => ({
      printing_id: printing.id,
      card_id: printing.card_id,
      document_json: JSON.stringify(document),
    })),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO revision_printings (
           catalogue_revision_id, printing_id, card_id, document_json
         )
         SELECT ?, json_extract(value, '$.printing_id'),
                json_extract(value, '$.card_id'),
                json_extract(value, '$.document_json')
         FROM json_each(?)`,
      )
      .bind(revisionId, chunk),
  );
  const printingImageStatements = byteBoundedJsonArrays(
    (input.candidate.printing_images ?? []).map((image) => ({
      id: image.id,
      printing_id: image.printing_id,
      role: image.role,
      media_type: image.media_type,
      width: image.width,
      height: image.height,
      content_sha256: image.content_sha256,
      content_byte_length: image.content_byte_length,
      object_key: image.object_key,
    })),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO reconciled_printing_images (
           id, printing_id, role, media_type, width, height,
           content_sha256, content_byte_length, object_key
         )
         SELECT
           json_extract(value, '$.id'),
           json_extract(value, '$.printing_id'),
           json_extract(value, '$.role'),
           json_extract(value, '$.media_type'),
           json_extract(value, '$.width'),
           json_extract(value, '$.height'),
           json_extract(value, '$.content_sha256'),
           json_extract(value, '$.content_byte_length'),
           json_extract(value, '$.object_key')
         FROM json_each(?)
         WHERE true
         ON CONFLICT(id) DO UPDATE SET
           printing_id = excluded.printing_id,
           role = excluded.role,
           media_type = excluded.media_type,
           width = excluded.width,
           height = excluded.height,
           content_sha256 = excluded.content_sha256,
           content_byte_length = excluded.content_byte_length,
           object_key = excluded.object_key`,
      )
      .bind(chunk),
  );
  const revisionPrintingImageStatements = byteBoundedJsonArrays(
    (input.candidate.printing_images ?? []).map((image) => ({
      image_id: image.id,
      printing_id: image.printing_id,
    })),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO revision_printing_images (
           catalogue_revision_id, image_id, printing_id
         )
         SELECT ?,
           json_extract(value, '$.image_id'),
           json_extract(value, '$.printing_id')
         FROM json_each(?)`,
      )
      .bind(revisionId, chunk),
  );
  const commitStatements = [
    database
      .prepare(
        `INSERT INTO catalogue_revisions (
          id,
          ingestion_run_id,
          published_at,
          content_digest,
          expected_previous_revision_id,
          approved_candidate_digest
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        revisionId,
        input.run.id,
        publishedAt,
        requiredCandidateCatalogueDigest(input.run),
        input.run.expected_current_revision_id,
        input.run.candidate_digest,
      ),
    ...(input.reconciliation?.statements ?? []),
    ...legalityPublicationStatements(database, input.candidate, revisionId),
    ...revisionCardStatements,
    ...revisionCardQueryStatements,
    ...revisionCardSearchChunkStatements,
    ...revisionCardSearchStatements,
    database
      .prepare(
        `INSERT INTO catalogue_query_revisions (
           catalogue_revision_id, state, repaired_through_card_id
         ) VALUES (?, 'available', NULL)`,
      )
      .bind(revisionId),
    database
      .prepare(
        `WITH RECURSIVE retained(catalogue_revision_id, depth) AS (
         SELECT ?, 0
         UNION ALL
         SELECT revision.expected_previous_revision_id, retained.depth + 1
         FROM retained
         JOIN catalogue_revisions AS revision
           ON revision.id = retained.catalogue_revision_id
         WHERE retained.depth < 2
           AND revision.expected_previous_revision_id IS NOT NULL
       )
       UPDATE catalogue_query_revisions
       SET state = 'archived',
           repaired_through_card_id = NULL,
           repair_card_id = NULL,
           repair_search_offset = 0,
           repair_term_offset = 0
       WHERE catalogue_revision_id NOT IN (
         SELECT catalogue_revision_id
         FROM retained
       )`,
      )
      .bind(revisionId),
    database.prepare(
      `DELETE FROM revision_card_query_documents
       WHERE catalogue_revision_id IN (
         SELECT catalogue_revision_id
         FROM catalogue_query_revisions
         WHERE state = 'archived'
       )`,
    ),
    ...revisionPrintingStatements,
    ...printingImageStatements,
    ...revisionPrintingImageStatements,
    ...productReleaseStatements,
    database
      .prepare(
        `INSERT INTO catalogue_exports (
          catalogue_revision_id,
          manifest_key,
          manifest_digest,
          verified
        ) VALUES (?, ?, ?, 1)`,
      )
      .bind(revisionId, input.catalogueExport.manifestKey, manifestDigest),
    database
      .prepare(
        `UPDATE catalogue_state
        SET current_revision_id = ?, published_at = ?
        WHERE singleton = 1
          AND current_revision_id = ?`,
      )
      .bind(revisionId, publishedAt, input.run.expected_current_revision_id),
    ...runFreshnessStatements,
    database
      .prepare(
        `UPDATE ingestion_runs
        SET state = 'published',
            published_revision_id = ?,
            export_manifest_digest = ?,
            terminal_at = ?,
            progress_json = ?,
            publication_outcome = 'revision',
            resulting_revision_id = ?,
            freshness_checked_at = ?
        WHERE id = ? AND state = 'publishing'`,
      )
      .bind(
        revisionId,
        manifestDigest,
        input.completedAt,
        JSON.stringify(progressFor("published")),
        revisionId,
        input.completedAt,
        input.run.id,
      ),
    database
      .prepare(
        `INSERT INTO catalogue_backup_attempts (
         idempotency_key, request_json, owner_token, catalogue_revision_id,
         state, object_key, started_at, publication_ingestion_run_id
       ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(
        publicationBackup.idempotencyKey,
        publicationBackup.requestJson,
        publicationBackup.ownerToken,
        revisionId,
        publicationBackup.objectKey,
        input.completedAt,
        input.run.id,
      ),
    database.prepare(
      `UPDATE operation_state SET recovery_health = 'degraded'
       WHERE singleton = 1 AND recovery_health = 'healthy'`,
    ),
    releaseRunLockStatement(database, input.run.id),
    ...idempotencyCompletionStatements(database, {
      key: idempotencyKey,
      operation: "approve_ingestion_run",
      requestJson: input.requestJson,
      response: resultingRun,
      status: 200,
      createdAt: input.completedAt,
      claimOwner: input.claimOwner ?? null,
    }),
  ];
  await database.batch(guardedAtomicBatch(commitStatements));
  return resultingRun;
}

async function reconcileAbandonedPublication(
  database: D1Database,
  bucket: R2Bucket,
  observedAt: string,
): Promise<void> {
  const run = await database
    .prepare(
      `SELECT *
      FROM ingestion_runs
      WHERE state = 'publishing'
        AND publication_reconcile_after IS NOT NULL
        AND publication_reconcile_after <= ?
      ORDER BY publication_reconcile_after, id
      LIMIT 1`,
    )
    .bind(observedAt)
    .first<RunRow>();
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

async function reservedPublicationOwnsUnpublishedPrefix(database: D1Database, run: RunRow): Promise<boolean> {
  if (
    run.candidate_digest === null ||
    !isSha256Digest(run.candidate_digest) ||
    run.publication_revision_id === null ||
    (run.state !== "publishing" && run.state !== "failed")
  ) {
    return false;
  }
  const expectedRevisionId = await catalogueRevisionIdentity({
    runId: run.id,
    candidateDigest: run.candidate_digest,
    expectedCurrentRevisionId: run.expected_current_revision_id,
  });
  if (run.publication_revision_id !== expectedRevisionId) return false;
  const registered = await database
    .prepare(
      `SELECT
       EXISTS(
         SELECT 1 FROM catalogue_revisions WHERE id = ?
       ) AS revision_registered,
       EXISTS(
         SELECT 1 FROM catalogue_exports
         WHERE catalogue_revision_id = ?
       ) AS export_registered,
       EXISTS(
         SELECT 1 FROM ingestion_runs
         WHERE id <> ? AND publication_revision_id = ?
       ) AS other_run_reserved`,
    )
    .bind(expectedRevisionId, expectedRevisionId, run.id, expectedRevisionId)
    .first<{
      revision_registered: number;
      export_registered: number;
      other_run_reserved: number;
    }>();
  return (
    registered?.revision_registered === 0 && registered.export_registered === 0 && registered.other_run_reserved === 0
  );
}

async function assertReservedPublicationOwnsUnpublishedPrefix(database: D1Database, runId: string): Promise<void> {
  const run = await requiredRun(database, runId);
  if (!(await reservedPublicationOwnsUnpublishedPrefix(database, run))) {
    throw new PublicationPrefixOwnershipError(
      "The publication prefix is not exclusively owned by this unpublished run.",
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

function requiredCandidateCatalogueDigest(run: RunRow): string {
  if (run.candidate_catalogue_digest === null || !isSha256Digest(run.candidate_catalogue_digest)) {
    throw new Error("The candidate Catalogue Data digest is invalid.");
  }
  return run.candidate_catalogue_digest;
}

async function listCatalogueExportPrefix(bucket: R2Bucket, revisionId: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: `catalogue-exports/${revisionId}/`,
      ...(cursor === undefined ? {} : { cursor }),
    });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}

async function isExactVerifiedExport(
  bucket: R2Bucket,
  revisionId: string,
  catalogueExport: BuiltCatalogueExport,
): Promise<boolean> {
  const prefix = `catalogue-exports/${revisionId}/`;
  const actualKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix,
      ...(cursor === undefined ? {} : { cursor }),
    });
    actualKeys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  const expectedKeys = [...new Set(catalogueExport.objects.map((object) => object.key))].sort();
  actualKeys.sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    return false;
  }
  for (const object of catalogueExport.objects) {
    if (!(await storedExportObjectMatches(bucket, object))) {
      return false;
    }
  }
  return true;
}

async function storedExportObjectMatches(bucket: R2Bucket, expected: ExportObject): Promise<boolean> {
  const stored = await bucket.head(expected.key);
  if (stored === null || stored.size !== expected.byteLength) return false;
  const checksum = stored.checksums.toJSON().sha256;
  if (checksum !== undefined) return checksum === expected.sha256;
  const body = await bucket.get(expected.key);
  if (body === null) return false;
  const digest = new crypto.DigestStream("SHA-256");
  await body.body.pipeTo(digest);
  return digestHex(await digest.digest) === expected.sha256;
}

function digestHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function publicationFailureProblem(error: unknown): AdministrationProblem {
  if (error instanceof CatalogueExportLimitError) {
    return new AdministrationProblem(
      422,
      "catalogue_export_too_large",
      "The candidate exceeds the bounded Catalogue Export relationship or byte budget, so no revision was published.",
    );
  }
  if (errorMessage(error).includes("publication_guard_failed")) {
    return new AdministrationProblem(
      409,
      "publication_precondition_failed",
      "The publication guards changed after approval was reserved.",
    );
  }
  return new AdministrationProblem(
    500,
    "export_verification_failed",
    "The Catalogue Export could not be verified, so no revision was published.",
  );
}

async function failUnreservedPublication(
  database: D1Database,
  run: RunRow,
  request: ApproveRunRequest,
  requestJson: string,
  terminalAt: string,
  claimOwner: IdempotencyClaimOwner,
  problem: AdministrationProblem,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `UPDATE ingestion_runs
        SET state = 'failed',
            terminal_at = ?,
            failure_code = ?,
            progress_json = json_set(
              progress_json,
              '$.current_stage',
              'failed'
            )
        WHERE id = ? AND state = 'awaiting_approval'`,
      )
      .bind(terminalAt, problem.code, run.id),
    database
      .prepare(
        `UPDATE ingestion_evidence_plans
        SET failure_code = ?
        WHERE ingestion_run_id = ?`,
      )
      .bind(problem.code, run.id),
    releaseRunLockStatement(database, run.id),
    database
      .prepare(
        `INSERT INTO administration_idempotency (
          idempotency_key,
          operation,
          request_json,
          response_json,
          http_status,
          outcome,
          created_at,
          claim_owner_token,
          claim_version
        ) VALUES (
          ?, 'approve_ingestion_run', ?, ?, ?, 'problem', ?, ?, ?
        )`,
      )
      .bind(
        request.idempotency_key,
        requestJson,
        canonicalJson({
          code: problem.code,
          detail: problem.message,
        }),
        problem.status,
        terminalAt,
        claimOwner.ownerToken,
        claimOwner.version,
      ),
    administrationClaimDeleteStatement(
      database,
      {
        key: request.idempotency_key,
        operation: "approve_ingestion_run",
        requestJson,
      },
      claimOwner,
    ),
  ]);
}

async function failReservedPublication(
  database: D1Database,
  run: RunRow,
  objectKeys: readonly string[] | null,
  terminalAt: string,
  problem: AdministrationProblem,
): Promise<void> {
  const key = requiredPublicationValue(run.approval_idempotency_key, "idempotency key");
  if (run.candidate_digest === null || !isSha256Digest(run.candidate_digest)) {
    throw new Error("The reserved publication candidate digest is invalid.");
  }
  const requestJson = canonicalJson({
    run_id: run.id,
    candidate_digest: run.candidate_digest,
    expected_current_revision_id: run.expected_current_revision_id,
  });
  const claimOwner = await currentAdministrationClaimOwner(database, key, "approve_ingestion_run", requestJson);
  const failureStatements = [
    database
      .prepare(
        `UPDATE ingestion_runs
        SET state = 'failed',
            terminal_at = ?,
            failure_code = ?,
            progress_json = json_set(
              progress_json,
              '$.current_stage',
              'failed'
            )
        WHERE id = ? AND state = 'publishing'`,
      )
      .bind(terminalAt, problem.code, run.id),
    database
      .prepare(
        `UPDATE ingestion_evidence_plans
        SET failure_code = ?
        WHERE ingestion_run_id = ?`,
      )
      .bind(problem.code, run.id),
    releaseRunLockStatement(database, run.id),
    database
      .prepare(
        `INSERT INTO administration_idempotency (
          idempotency_key,
          operation,
          request_json,
          response_json,
          http_status,
          outcome,
          created_at,
          claim_owner_token,
          claim_version
        ) VALUES (
          ?, 'approve_ingestion_run', ?, ?, ?, 'problem', ?, ?, ?
        )`,
      )
      .bind(
        key,
        requestJson,
        canonicalJson({
          code: problem.code,
          detail: problem.message,
        }),
        problem.status,
        terminalAt,
        claimOwner?.ownerToken ?? null,
        claimOwner?.version ?? null,
      ),
    administrationClaimDeleteStatement(
      database,
      {
        key,
        operation: "approve_ingestion_run",
        requestJson,
      },
      claimOwner,
    ),
  ];
  if (objectKeys !== null) {
    failureStatements.push(
      database
        .prepare(
          `INSERT INTO ingestion_publication_cleanup (
            ingestion_run_id,
            state,
            object_keys_json,
            attempts,
            failure_code,
            last_attempt_at,
            completed_at,
            not_before,
            idempotency_key,
            request_json
          ) VALUES (?, 'pending', ?, 0, NULL, NULL, NULL, ?, NULL, NULL)
          ON CONFLICT (ingestion_run_id) DO NOTHING`,
        )
        .bind(run.id, canonicalJson([...new Set(objectKeys)].sort()), publicationCleanupNotBefore(run, terminalAt)),
    );
  }
  await database.batch(failureStatements);
}

async function attemptPublicationCleanup(
  database: D1Database,
  bucket: R2Bucket,
  runId: string,
  observedAt: string,
  idempotency?: {
    key: string;
    requestJson: string;
    claimOwner: IdempotencyClaimOwner;
  },
): Promise<Record<string, unknown> | null> {
  let cleanup = await database
    .prepare(
      `SELECT *
      FROM ingestion_publication_cleanup
      WHERE ingestion_run_id = ?`,
    )
    .bind(runId)
    .first<PublicationCleanupRow>();
  if (cleanup === null) {
    throw new AdministrationProblem(
      409,
      "publication_cleanup_not_required",
      "The Ingestion Run has no pending publication cleanup.",
    );
  }
  const run = await requiredRun(database, runId);
  if (!isIsoInstant(cleanup.not_before)) {
    throw new Error("The persisted publication cleanup fence is invalid.");
  }
  if (Date.parse(observedAt) < Date.parse(cleanup.not_before)) {
    throw new AdministrationProblem(
      409,
      "publication_cleanup_fenced",
      "Publication cleanup is fenced until the publication writer lease and quiescence window expire.",
      false,
    );
  }
  if (run.state !== "failed") {
    throw new AdministrationProblem(
      409,
      "publication_cleanup_not_terminal",
      "Publication cleanup is only available for a failed Ingestion Run.",
    );
  }
  if (cleanup.state === "completed") {
    if (
      idempotency !== undefined &&
      cleanup.idempotency_key === idempotency.key &&
      cleanup.request_json === idempotency.requestJson
    ) {
      const result = publicRun(run, cleanup);
      await database.batch(
        idempotencyCompletionStatements(database, {
          key: idempotency.key,
          operation: "retry_publication_cleanup",
          requestJson: idempotency.requestJson,
          response: result,
          status: 200,
          createdAt: cleanup.completed_at ?? observedAt,
          claimOwner: idempotency.claimOwner,
        }),
      );
      return result;
    }
    throw new AdministrationProblem(
      409,
      "publication_cleanup_not_required",
      "The abandoned Catalogue Export objects have already been removed.",
    );
  }
  if (cleanup.state === "cleaning") {
    const operation = activeCleanupOperation(cleanup, run, idempotency, observedAt);
    if (operation !== null) return operation;
  }
  const recordedKeys = parseCleanupKeys(cleanup.object_keys_json, run);
  const revisionId = requiredPublicationValue(run.publication_revision_id, "revision ID");
  if (!(await reservedPublicationOwnsUnpublishedPrefix(database, run))) {
    throw new AdministrationProblem(
      500,
      "publication_cleanup_failed",
      "The abandoned Catalogue Export prefix is no longer exclusively owned by the failed Ingestion Run.",
    );
  }
  const observedKeys = await listCatalogueExportPrefix(bucket, revisionId);
  const keys = [...new Set([...recordedKeys, ...observedKeys])].sort();
  const claimToken = `cleanup-claim:${crypto.randomUUID()}`;
  const claimExpiresAt = new Date(Date.parse(observedAt) + publicationLeaseMilliseconds).toISOString();
  const claimed = await database
    .prepare(
      `UPDATE ingestion_publication_cleanup
      SET state = 'cleaning',
          attempts = attempts + 1,
          failure_code = NULL,
          last_attempt_at = ?,
          object_keys_json = ?,
          idempotency_key = ?,
          request_json = ?,
          claim_token = ?,
          claim_version = claim_version + 1,
          claim_expires_at = ?
      WHERE ingestion_run_id = ?
        AND claim_version = ?
        AND (
          state IN ('pending', 'failed')
          OR (
            state = 'cleaning'
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at <= ?
          )
        )
      RETURNING *`,
    )
    .bind(
      observedAt,
      canonicalJson(keys),
      idempotency?.key ?? null,
      idempotency?.requestJson ?? null,
      claimToken,
      claimExpiresAt,
      runId,
      cleanup.claim_version,
      observedAt,
    )
    .first<PublicationCleanupRow>();
  if (claimed === null) {
    if (idempotency !== undefined) {
      const completed = await replayAdministration(
        database,
        idempotency.key,
        "retry_publication_cleanup",
        idempotency.requestJson,
      );
      if (completed !== null) return completed;
    }
    cleanup = await requiredPublicationCleanup(database, runId);
    const operation = activeCleanupOperation(cleanup, run, idempotency, observedAt);
    if (operation !== null) return operation;
    throw new AdministrationProblem(
      409,
      "publication_cleanup_claim_changed",
      "Publication cleanup ownership changed; retry the request.",
      false,
    );
  }
  try {
    const claimedRun = await requiredRun(database, runId);
    if (!(await reservedPublicationOwnsUnpublishedPrefix(database, claimedRun))) {
      throw new PublicationPrefixOwnershipError("The publication prefix ownership changed before cleanup.");
    }
    await deleteR2KeysInBatches(bucket, keys);
    if ((await listCatalogueExportPrefix(bucket, revisionId)).length > 0) {
      throw new Error("Catalogue Export cleanup verification failed");
    }
    const completedCleanup: PublicationCleanupRow = {
      ...claimed,
      state: "completed",
      failure_code: null,
      last_attempt_at: observedAt,
      completed_at: observedAt,
      claim_token: null,
      claim_version: claimed.claim_version + 1,
      claim_expires_at: null,
    };
    const result = publicRun(run, completedCleanup);
    const completedRow = await database
      .prepare(
        `UPDATE ingestion_publication_cleanup
        SET state = 'completed',
            failure_code = NULL,
            completed_at = ?,
            claim_token = NULL,
            claim_version = claim_version + 1,
            claim_expires_at = NULL
        WHERE ingestion_run_id = ?
          AND state = 'cleaning'
          AND claim_token = ?
          AND claim_version = ?
        RETURNING *`,
      )
      .bind(observedAt, runId, claimToken, claimed.claim_version)
      .first<PublicationCleanupRow>();
    if (completedRow === null) {
      if (idempotency !== undefined) {
        const replay = await replayAdministration(
          database,
          idempotency.key,
          "retry_publication_cleanup",
          idempotency.requestJson,
        );
        if (replay !== null) return replay;
      }
      const current = await requiredPublicationCleanup(database, runId);
      const operation = activeCleanupOperation(current, run, idempotency, observedAt);
      if (operation !== null) return operation;
      if (
        current.state === "completed" &&
        idempotency !== undefined &&
        current.idempotency_key === idempotency.key &&
        current.request_json === idempotency.requestJson
      ) {
        return cleanupCompletionInProgress(run, idempotency.key, observedAt);
      }
      throw new AdministrationProblem(
        409,
        "publication_cleanup_claim_changed",
        "Publication cleanup ownership changed; retry the request.",
        false,
      );
    }
    if (idempotency !== undefined) {
      await database.batch(
        idempotencyCompletionStatements(database, {
          key: idempotency.key,
          operation: "retry_publication_cleanup",
          requestJson: idempotency.requestJson,
          response: result,
          status: 200,
          createdAt: observedAt,
          claimOwner: idempotency.claimOwner,
        }),
      );
    }
    return result;
  } catch {
    if (idempotency !== undefined) {
      const replay = await replayAdministration(
        database,
        idempotency.key,
        "retry_publication_cleanup",
        idempotency.requestJson,
      );
      if (replay !== null) return replay;
    }
    await database
      .prepare(
        `UPDATE ingestion_publication_cleanup
        SET state = 'failed',
            failure_code = 'publication_cleanup_failed',
            claim_token = NULL,
            claim_version = claim_version + 1,
            claim_expires_at = NULL
        WHERE ingestion_run_id = ?
          AND state = 'cleaning'
          AND claim_token = ?
          AND claim_version = ?`,
      )
      .bind(runId, claimToken, claimed.claim_version)
      .run();
    throw new AdministrationProblem(
      500,
      "publication_cleanup_failed",
      "The abandoned Catalogue Export objects could not be removed.",
    );
  }
}

function cleanupCompletionInProgress(run: RunRow, idempotencyKey: string, observedAt: string): Record<string, unknown> {
  return {
    contract: "card-keepr-administration-operation@1",
    operation: "retry_publication_cleanup",
    status: "in_progress",
    run_id: run.id,
    idempotency_key: idempotencyKey,
    claimed_at: observedAt,
    links: {
      run: `/v1/ingestion-runs/${run.id}`,
      status: "/v1/status",
    },
  };
}

function activeCleanupOperation(
  cleanup: PublicationCleanupRow,
  run: RunRow,
  idempotency: { key: string; requestJson: string } | undefined,
  observedAt: string,
): Record<string, unknown> | null {
  if (
    cleanup.state !== "cleaning" ||
    cleanup.claim_token === null ||
    !isIsoInstant(cleanup.claim_expires_at) ||
    Date.parse(observedAt) >= Date.parse(cleanup.claim_expires_at)
  ) {
    return null;
  }
  if (idempotency !== undefined && cleanup.idempotency_key === idempotency.key) {
    if (cleanup.request_json !== idempotency.requestJson) {
      throw new AdministrationProblem(
        409,
        "idempotency_key_reused",
        "The idempotency key was already used for a different administration request.",
      );
    }
    return {
      contract: "card-keepr-administration-operation@1",
      operation: "retry_publication_cleanup",
      status: "in_progress",
      run_id: run.id,
      idempotency_key: idempotency.key,
      retry_after: cleanup.claim_expires_at,
      links: {
        run: `/v1/ingestion-runs/${run.id}`,
        status: "/v1/status",
      },
    };
  }
  throw new AdministrationProblem(
    409,
    "publication_cleanup_in_progress",
    "The abandoned Catalogue Export cleanup is already in progress.",
    cleanup.idempotency_key !== null,
  );
}

async function requiredPublicationCleanup(database: D1Database, runId: string): Promise<PublicationCleanupRow> {
  const cleanup = await publicationCleanup(database, runId);
  if (cleanup === null) {
    throw new Error("The publication cleanup claim disappeared.");
  }
  return cleanup;
}

async function deleteR2KeysInBatches(bucket: R2Bucket, keys: readonly string[]): Promise<void> {
  for (let index = 0; index < keys.length; index += 1_000) {
    await bucket.delete(keys.slice(index, index + 1_000));
  }
}

function requiredPublicationValue(value: string | null, description: string): string {
  if (value === null || value.length === 0) {
    throw new Error(`The reserved publication ${description} is invalid.`);
  }
  return value;
}

function publicationCleanupNotBefore(run: RunRow, terminalAt: string): string {
  const reconcileAt =
    run.publication_reconcile_after === null ? Date.parse(terminalAt) : Date.parse(run.publication_reconcile_after);
  return new Date(Math.max(Date.parse(terminalAt), reconcileAt) + publicationLeaseMilliseconds).toISOString();
}

async function validatedCatalogueCandidate(
  request: StartRunRequest,
): Promise<{ candidate: CatalogueCandidate; digest: string }> {
  return fixtureCandidate(request.fixture, request.selected_games).catch((error: unknown) => {
    if (error instanceof FixtureInputError) {
      throw new AdministrationProblem(422, error.code, error.message);
    }
    throw error;
  });
}

async function currentCatalogueState(database: D1Database): Promise<CatalogueStateRow> {
  const state = await database
    .prepare(
      `SELECT current_revision_id, published_at
      FROM catalogue_state
      WHERE singleton = 1`,
    )
    .first<CatalogueStateRow>();
  if (state === null) {
    throw new Error("Catalogue state is unavailable");
  }
  return state;
}

async function catalogueExportObjectDiagnostics(
  database: D1Database,
  bucket: R2Bucket,
): Promise<{
  objectCount: number;
  orphanedObjectCount: number;
}> {
  let objectCount = 0;
  let orphanedObjectCount = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: "catalogue-exports/",
      limit: 1_000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    objectCount += page.objects.length;
    const revisionIds = [
      ...new Set(
        page.objects.flatMap((object) => {
          const [, revisionId] = object.key.split("/", 3);
          return revisionId === undefined ? [] : [revisionId];
        }),
      ),
    ];
    const published = new Set<string>();
    for (let index = 0; index < revisionIds.length; index += 50) {
      const chunk = revisionIds.slice(index, index + 50);
      const placeholders = chunk.map(() => "?").join(", ");
      const matches = await database
        .prepare(
          `SELECT id
          FROM catalogue_revisions
          WHERE id IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<{ id: string }>();
      for (const match of matches.results) published.add(match.id);
    }
    orphanedObjectCount += page.objects.filter((object) => {
      const [, revisionId] = object.key.split("/", 3);
      return revisionId === undefined || !published.has(revisionId);
    }).length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return { objectCount, orphanedObjectCount };
}

async function publicationCleanupsForRuns(
  database: D1Database,
  runIds: readonly string[],
): Promise<Map<string, PublicationCleanupRow>> {
  const uniqueRunIds = [...new Set(runIds)].slice(0, 21);
  if (uniqueRunIds.length === 0) return new Map();
  const placeholders = uniqueRunIds.map(() => "?").join(", ");
  const cleanups = await database
    .prepare(
      `SELECT *
      FROM ingestion_publication_cleanup
      WHERE ingestion_run_id IN (${placeholders})`,
    )
    .bind(...uniqueRunIds)
    .all<PublicationCleanupRow>();
  return new Map(cleanups.results.map((cleanup) => [cleanup.ingestion_run_id, cleanup]));
}

async function currentOperationState(database: D1Database): Promise<OperationStateRow> {
  const state = await database
    .prepare(
      `SELECT active_ingestion_run_id,
              active_release_id AS active_production_release_id,
              active_release_expires_at AS active_production_release_expires_at,
              active_recovery_id, recovery_health
      FROM operation_state
      WHERE singleton = 1`,
    )
    .first<OperationStateRow>();
  if (state === null) {
    throw new Error("Operation state is unavailable");
  }
  return state;
}

async function requiredRun(database: D1Database, runId: string): Promise<RunRow> {
  const run = await database.prepare("SELECT * FROM ingestion_runs WHERE id = ?").bind(runId).first<RunRow>();
  if (run === null) {
    throw new AdministrationProblem(404, "ingestion_run_not_found", "The requested Ingestion Run does not exist.");
  }
  return run;
}

async function publicationCleanup(database: D1Database, runId: string): Promise<PublicationCleanupRow | null> {
  return database
    .prepare(
      `SELECT *
      FROM ingestion_publication_cleanup
      WHERE ingestion_run_id = ?`,
    )
    .bind(runId)
    .first<PublicationCleanupRow>();
}

async function replayAdministration(
  database: D1Database,
  key: string,
  operation: string,
  requestJson: string,
): Promise<Record<string, unknown> | null> {
  const prior = await database
    .prepare(
      `SELECT
        operation,
        request_json,
        response_json,
        http_status,
        outcome
      FROM administration_idempotency
      WHERE idempotency_key = ?`,
    )
    .bind(key)
    .first<IdempotencyRow>();
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
  database: D1Database,
  run: Record<string, unknown>,
  prior: IdempotencyRow,
  key: string,
  requestJson: string,
): Promise<void> {
  const request = parseJson(requestJson, "Administration idempotency request");
  const expectedStatus =
    prior.operation === "start_ingestion_run" || prior.operation === "retry_ingestion_run" ? 201 : 200;
  let correlated = false;
  if (isRecord(request)) {
    if (prior.operation === "start_ingestion_run") {
      correlated =
        hasOnlyKeys(request, ["fixture", "selected_games"]) &&
        request.fixture === "first-catalogue" &&
        isExactStringTuple(request.selected_games, ["one-piece"]) &&
        run.idempotency_key === key &&
        run.linked_run_id === null &&
        run.state === "awaiting_approval";
    } else if (prior.operation === "retry_ingestion_run") {
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

async function idempotentAdministration(
  database: D1Database,
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
        database
          .prepare(
            `INSERT INTO administration_idempotency (
              idempotency_key,
              operation,
              request_json,
              response_json,
              http_status,
              outcome,
              created_at,
              claim_owner_token,
              claim_version
            ) VALUES (?, ?, ?, ?, ?, 'problem', ?, ?, ?)`,
          )
          .bind(
            context.key,
            context.operation,
            context.requestJson,
            canonicalJson({
              code: error.code,
              detail: error.message,
            }),
            error.status,
            context.observedAt,
            owner.ownerToken,
            owner.version,
          ),
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
  return [
    "start_ingestion_run",
    "retry_ingestion_run",
    "approve_ingestion_run",
    "reject_ingestion_run",
    "retry_publication_cleanup",
  ].includes(operation);
}

function isAdministrationInProgress(value: Record<string, unknown>): boolean {
  return value.contract === "card-keepr-administration-operation@1" && value.status === "in_progress";
}

async function claimAdministration(
  database: D1Database,
  context: IdempotencyContext,
): Promise<{
  claim: IdempotencyClaimRow;
  owner: IdempotencyClaimOwner | null;
}> {
  const ownerToken = `administration-claim:${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.parse(context.observedAt) + publicationLeaseMilliseconds).toISOString();
  try {
    const inserted = await database
      .prepare(
        `INSERT INTO administration_idempotency_claims (
          idempotency_key,
          operation,
          request_json,
          claimed_at,
          owner_token,
          claim_version,
          claim_expires_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?)
        RETURNING operation, request_json, claimed_at,
          owner_token, claim_version, claim_expires_at`,
      )
      .bind(context.key, context.operation, context.requestJson, context.observedAt, ownerToken, expiresAt)
      .first<IdempotencyClaimRow>();
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
      const takenOver = await database
        .prepare(
          `UPDATE administration_idempotency_claims
          SET claimed_at = ?,
              owner_token = ?,
              claim_version = claim_version + 1,
              claim_expires_at = ?
          WHERE idempotency_key = ?
            AND operation = ?
            AND request_json = ?
            AND owner_token = ?
            AND claim_version = ?
            AND claim_expires_at = ?
          RETURNING operation, request_json, claimed_at,
            owner_token, claim_version, claim_expires_at`,
        )
        .bind(
          context.observedAt,
          ownerToken,
          expiresAt,
          context.key,
          context.operation,
          context.requestJson,
          prior.owner_token,
          prior.claim_version,
          prior.claim_expires_at,
        )
        .first<IdempotencyClaimRow>();
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

async function administrationClaim(database: D1Database, key: string): Promise<IdempotencyClaimRow | null> {
  return database
    .prepare(
      `SELECT
        operation,
        request_json,
        claimed_at,
        owner_token,
        claim_version,
        claim_expires_at
      FROM administration_idempotency_claims
      WHERE idempotency_key = ?`,
    )
    .bind(key)
    .first<IdempotencyClaimRow>();
}

async function currentAdministrationClaimOwner(
  database: D1Database,
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
  database: D1Database,
  context: IdempotencyContext,
  owner: IdempotencyClaimOwner,
): Promise<void> {
  await administrationClaimDeleteStatement(database, context, owner).run();
}

function administrationClaimDeleteStatement(
  database: D1Database,
  context: {
    key: string;
    operation: string;
    requestJson: string;
  },
  owner: IdempotencyClaimOwner | null,
): D1PreparedStatement {
  return database
    .prepare(
      `DELETE FROM administration_idempotency_claims
      WHERE idempotency_key = ?
        AND operation = ?
        AND request_json = ?
        AND (? IS NULL OR owner_token = ?)
        AND (? IS NULL OR claim_version = ?)`,
    )
    .bind(
      context.key,
      context.operation,
      context.requestJson,
      owner?.ownerToken ?? null,
      owner?.ownerToken ?? null,
      owner?.version ?? null,
      owner?.version ?? null,
    );
}

async function replayLegacyAdministration(
  database: D1Database,
  key: string,
  operation: string,
  requestJson: string,
): Promise<Record<string, unknown> | null> {
  const run = await database
    .prepare(
      `SELECT *
      FROM ingestion_runs
      WHERE idempotency_key = ?
        OR approval_idempotency_key = ?
      LIMIT 1`,
    )
    .bind(key, key)
    .first<RunRow>();
  if (run === null) return null;

  if (operation === "start_ingestion_run" && run.idempotency_key === key) {
    const candidate = parseCandidate(run);
    const legacyRequestJson = canonicalJson({
      fixture: firstCatalogueFixture,
      selected_games: candidate.selected_games,
    });
    if (legacyRequestJson === requestJson) return publicRun(run);
  }
  if (operation === "approve_ingestion_run" && run.approval_idempotency_key === key) {
    const legacyRequestJson = canonicalJson({
      run_id: run.id,
      candidate_digest: run.candidate_digest,
      expected_current_revision_id: run.expected_current_revision_id,
    });
    if (legacyRequestJson === requestJson && terminalRunStates.has(run.state)) {
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

function approvalInProgress(run: RunRow, request: ApproveRunRequest, requestJson: string): Record<string, unknown> {
  const reservedRequestJson = canonicalJson({
    run_id: run.id,
    candidate_digest: run.candidate_digest,
    expected_current_revision_id: run.expected_current_revision_id,
  });
  if (
    run.approval_idempotency_key !== request.idempotency_key ||
    run.candidate_digest !== request.candidate_digest ||
    run.expected_current_revision_id !== request.expected_current_revision_id ||
    reservedRequestJson !== requestJson
  ) {
    throw new AdministrationProblem(
      409,
      run.approval_idempotency_key === request.idempotency_key ? "idempotency_key_reused" : "publication_in_progress",
      run.approval_idempotency_key === request.idempotency_key
        ? "The idempotency key was already used for a different administration request."
        : "The Ingestion Run already has a publication in progress.",
    );
  }
  const approval = parseApproval(run.approval_json);
  if (
    approval.candidate_digest !== request.candidate_digest ||
    approval.expected_current_revision_id !== request.expected_current_revision_id
  ) {
    throw new Error("The reserved approval request is invalid.");
  }
  return {
    contract: "card-keepr-administration-operation@1",
    operation: "approve_ingestion_run",
    status: "in_progress",
    run_id: run.id,
    idempotency_key: request.idempotency_key,
    retry_after: run.publication_reconcile_after,
    links: {
      run: `/v1/ingestion-runs/${run.id}`,
      status: "/v1/status",
    },
  };
}

async function replayAfterConflict(
  database: D1Database,
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

function idempotencyCompletionStatements(
  database: D1Database,
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
    database
      .prepare(
        `INSERT INTO administration_idempotency (
        idempotency_key,
        operation,
        request_json,
        response_json,
        http_status,
        outcome,
        created_at,
        claim_owner_token,
        claim_version
      ) VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?)`,
      )
      .bind(
        input.key,
        input.operation,
        input.requestJson,
        canonicalJson(input.response),
        input.status,
        input.createdAt,
        input.claimOwner?.ownerToken ?? null,
        input.claimOwner?.version ?? null,
      ),
    administrationClaimDeleteStatement(database, input, input.claimOwner ?? null),
  ];
}

function transitionStatement(database: D1Database, runId: string, from: string, to: string): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE ingestion_runs
      SET state = ?, progress_json = ?
      WHERE id = ? AND state = ?`,
    )
    .bind(to, JSON.stringify(progressFor(to)), runId, from);
}

function releaseRunLockStatement(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE operation_state
      SET active_ingestion_run_id = NULL
      WHERE singleton = 1 AND active_ingestion_run_id = ?`,
    )
    .bind(runId);
}

async function freshnessStatementsForRun(
  database: D1Database,
  games: readonly string[],
  runId: string,
  candidate: CatalogueCandidate,
  checkedAt: string,
): Promise<D1PreparedStatement[]> {
  return freshnessStatements(
    database,
    await checkedFreshnessAreasForRun(database, games, runId, candidate, checkedAt),
    runId,
  );
}

async function checkedFreshnessAreasForRun(
  database: D1Database,
  games: readonly string[],
  runId: string,
  candidate: CatalogueCandidate,
  checkedAt: string,
): Promise<SourceFreshness[]> {
  const coverage = await freshnessCoverage(database, runId, games);
  return [
    ...checkedFreshnessAreas([...coverage.catalogue], candidate, checkedAt),
    ...[...coverage.errata].map((game) => ({
      game,
      area: "errata" as const,
      checked_at: checkedAt,
    })),
  ];
}

function freshnessStatements(
  database: D1Database,
  checks: readonly SourceFreshness[],
  runId: string,
): D1PreparedStatement[] {
  return checks.map((check) => {
    const scope = sourceFreshnessStorageScope(check);
    return database
      .prepare(
        `INSERT INTO source_freshness (
          game,
          area,
          source_lineage,
          region,
          checked_at,
          ingestion_run_id
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (game, area, source_lineage, region) DO UPDATE SET
          checked_at = excluded.checked_at,
          ingestion_run_id = excluded.ingestion_run_id`,
      )
      .bind(check.game, check.area, scope.sourceLineage, scope.region, check.checked_at, runId);
  });
}

function checkedFreshnessAreas(
  games: readonly string[],
  candidate: CatalogueCandidate,
  checkedAt = "",
): SourceFreshness[] {
  const capturedChecks = candidate.source_checks ?? [];
  const generalChecks = games.flatMap((game) => {
    const supported = game as SupportedGame;
    const cardObservedGames = candidate.card_observed_games ?? candidate.selected_games;
    const capturedAt = (area: "cards-and-printings" | "products-and-releases") =>
      capturedChecks.find((check) => check.game === supported && check.area === area)?.checked_at ?? checkedAt;
    return [
      ...(cardObservedGames.includes(supported)
        ? [
            {
              game: supported,
              area: "cards-and-printings" as const,
              checked_at: capturedAt("cards-and-printings"),
            },
          ]
        : []),
      ...(candidate.product_observed_games?.includes(supported)
        ? [
            {
              game: supported,
              area: "products-and-releases" as const,
              checked_at: capturedAt("products-and-releases"),
            },
          ]
        : []),
    ];
  });
  const selectedGames = new Set(games);
  return [
    ...generalChecks,
    ...capturedChecks.filter(
      (
        check,
      ): check is Extract<
        SourceFreshness,
        {
          area: "legality-rules";
        }
      > => check.area === "legality-rules" && selectedGames.has(check.game),
    ),
  ];
}

async function freshnessCoverage(
  database: D1Database,
  runId: string,
  games: readonly string[],
): Promise<
  Readonly<{
    catalogue: ReadonlySet<SupportedGame>;
    errata: ReadonlySet<SupportedGame>;
  }>
> {
  const observedAdapters = await database
    .prepare(
      `SELECT DISTINCT
         observation.adapter_version,
         observation.supported_game
       FROM source_observation_sets AS observation
       JOIN source_snapshots AS snapshot
         ON snapshot.id = observation.source_snapshot_id
       WHERE snapshot.ingestion_run_id = ?
       ORDER BY observation.supported_game, observation.adapter_version`,
    )
    .bind(runId)
    .all<{ adapter_version: string; supported_game: SupportedGame }>();
  const selectedGames = new Set(games as readonly SupportedGame[]);
  if (observedAdapters.results.length === 0) {
    return { catalogue: selectedGames, errata: new Set() };
  }
  const catalogue = new Set<SupportedGame>();
  const errata = new Set<SupportedGame>();
  for (const observed of observedAdapters.results) {
    if (!selectedGames.has(observed.supported_game)) continue;
    const areas = adapterReconciliationAreas(requiredSourceAdapter(observed.adapter_version));
    if (areas.includes("catalogue")) catalogue.add(observed.supported_game);
    if (areas.includes("errata")) errata.add(observed.supported_game);
  }
  return { catalogue, errata };
}

async function sourceFreshnessForExport(
  database: D1Database,
  catalogueGames: readonly SupportedGame[],
  refreshedChecks: readonly SourceFreshness[],
  publishedAt: string,
): Promise<SourceFreshness[]> {
  const prior = await database
    .prepare(
      `SELECT game, area, source_lineage, region, checked_at
       FROM source_freshness
       WHERE area IN (
         'cards-and-printings', 'products-and-releases',
         'legality-rules', 'errata'
       )
       ORDER BY game, area, source_lineage, region`,
    )
    .all<SourceFreshnessStorageRow>();
  const freshness = new Map<string, SourceFreshness>();
  for (const row of prior.results) {
    const check = sourceFreshnessFromStorage(row);
    if (catalogueGames.includes(check.game)) {
      freshness.set(sourceFreshnessKey(check), check);
    }
  }
  for (const check of refreshedChecks) {
    if (catalogueGames.includes(check.game)) {
      freshness.set(sourceFreshnessKey(check), {
        ...check,
        checked_at: check.checked_at.length === 0 ? publishedAt : check.checked_at,
      });
    }
  }
  return [...freshness.values()].sort(compareSourceFreshness);
}

async function expireOverdueRuns(database: D1Database, observedAt: string): Promise<void> {
  await database.batch([
    database
      .prepare(
        `UPDATE ingestion_runs
        SET state = 'expired',
            terminal_at = approval_deadline,
            progress_json = json_set(
              progress_json,
              '$.current_stage',
              'expired'
            )
        WHERE state = 'awaiting_approval'
          AND approval_deadline IS NOT NULL
          AND approval_deadline <= ?`,
      )
      .bind(observedAt),
    database.prepare(
      `UPDATE operation_state
      SET active_ingestion_run_id = NULL
      WHERE singleton = 1
        AND active_ingestion_run_id IS NOT NULL
        AND (
          active_ingestion_run_id IN (
            SELECT id
            FROM ingestion_runs
            WHERE state = 'expired'
          )
          OR NOT EXISTS (
            SELECT 1
            FROM ingestion_runs
            WHERE id = operation_state.active_ingestion_run_id
              AND state IN (
                'planning',
                'collecting',
                'paused',
                'parsing',
                'reconciling',
                'awaiting_approval',
                'publishing'
              )
          )
        )`,
    ),
  ]);
}

async function failRun(database: D1Database, runId: string, terminalAt: string, failureCode: string): Promise<void> {
  await database.batch([
    database
      .prepare(
        `UPDATE ingestion_runs
        SET state = 'failed',
            terminal_at = ?,
            failure_code = ?,
            progress_json = json_set(
              progress_json,
              '$.current_stage',
              'failed'
            )
        WHERE id = ?
          AND state IN (
            'planning',
            'collecting',
            'parsing',
            'reconciling',
            'awaiting_approval',
            'publishing'
          )`,
      )
      .bind(terminalAt, failureCode, runId),
    releaseRunLockStatement(database, runId),
  ]);
}

function parseCandidate(row: RunRow): CatalogueCandidate {
  const parsed: unknown = JSON.parse(row.candidate_json);
  if (isRecord(parsed) && parsed.chunked_reconciliation_payload === "candidate") {
    return {
      contract: catalogueCandidateContract,
      selected_games: parseSelectedGames(row.selected_games_json),
      cards: [],
      printings: [],
    };
  }
  if (
    isRecord(parsed) &&
    hasOnlyKeys(parsed, ["fixture", "selected_games", "cards", "printings"]) &&
    parsed.fixture === "first-catalogue"
  ) {
    const upgraded = {
      contract: catalogueCandidateContract,
      selected_games: parsed.selected_games,
      cards: parsed.cards,
      printings: parsed.printings,
      legality_rules: [],
    };
    if (isCatalogueCandidate(upgraded)) return upgraded;
  }
  if (!isCatalogueCandidate(parsed)) {
    throw new Error("The persisted Catalogue Candidate is invalid.");
  }
  return parsed;
}

function parseJson(value: string, description: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${description} is not valid JSON.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCatalogueCandidate(value: unknown): value is CatalogueCandidate {
  if (
    !isRecord(value) ||
    !hasRequiredAndAllowedKeys(
      value,
      ["contract", "selected_games", "cards", "printings"],
      [
        "contract",
        "selected_games",
        "cards",
        "printings",
        "printing_images",
        "products",
        "distribution_contexts",
        "product_relationships",
        "card_observed_games",
        "product_observed_games",
        "product_observed_lineages",
        "source_checks",
        "errata",
        "legality_rules",
      ],
    ) ||
    value.contract !== catalogueCandidateContract ||
    !Array.isArray(value.selected_games) ||
    value.selected_games.length === 0 ||
    !value.selected_games.every(isSupportedGame) ||
    !Array.isArray(value.cards) ||
    !Array.isArray(value.printings) ||
    (value.errata !== undefined && (!Array.isArray(value.errata) || !value.errata.every(isCatalogueErratum))) ||
    (value.legality_rules !== undefined && !Array.isArray(value.legality_rules))
  ) {
    return false;
  }
  const cards = value.cards;
  const cardIds = new Set<string>();
  for (const card of cards) {
    if (
      !isRecord(card) ||
      !hasRequiredAndAllowedKeys(
        card,
        ["id", "game", "official_identity", "name", "effective_rules_text", "game_data"],
        ["id", "game", "official_identity", "name", "effective_rules_text", "game_data", "curated_provenance"],
      ) ||
      typeof card.id !== "string" ||
      !isSupportedGame(card.game) ||
      typeof card.name !== "string" ||
      (card.effective_rules_text !== null && typeof card.effective_rules_text !== "string") ||
      !isRecord(card.official_identity) ||
      !hasOnlyKeys(card.official_identity, ["kind", "value"]) ||
      !validOfficialIdentity(card.official_identity, card.game) ||
      (card.curated_provenance !== undefined &&
        (!Array.isArray(card.curated_provenance) || !card.curated_provenance.every(isCuratedProvenance))) ||
      !isRecord(card.game_data) ||
      !hasOnlyKeys(card.game_data, ["profile", "attributes"]) ||
      card.game_data.profile !== `${card.game}@1` ||
      !isRecord(card.game_data.attributes)
    ) {
      return false;
    }
    cardIds.add(card.id);
  }
  const printingsValid = value.printings.every((printing) => {
    if (
      !isRecord(printing) ||
      !hasRequiredAndAllowedKeys(
        printing,
        ["id", "card_id", "rarity", "printed_rules_text", "game_data"],
        ["id", "card_id", "rarity", "printed_rules_text", "game_data", "curated_provenance"],
      ) ||
      typeof printing.id !== "string" ||
      typeof printing.card_id !== "string" ||
      !cardIds.has(printing.card_id) ||
      (printing.printed_rules_text !== null && typeof printing.printed_rules_text !== "string") ||
      (printing.curated_provenance !== undefined &&
        (!Array.isArray(printing.curated_provenance) || !printing.curated_provenance.every(isCuratedProvenance))) ||
      !isRecord(printing.rarity) ||
      !hasOnlyKeys(printing.rarity, ["normalized", "raw"]) ||
      (printing.rarity.normalized !== null && typeof printing.rarity.normalized !== "string") ||
      (printing.rarity.raw !== null && typeof printing.rarity.raw !== "string")
    ) {
      return false;
    }
    return (
      printing.game_data === null ||
      (isRecord(printing.game_data) &&
        hasOnlyKeys(printing.game_data, ["profile", "attributes"]) &&
        typeof printing.game_data.profile === "string" &&
        isRecord(printing.game_data.attributes))
    );
  });
  return (
    printingsValid &&
    (value.products === undefined || (Array.isArray(value.products) && value.products.every(isRecord))) &&
    (value.distribution_contexts === undefined ||
      (Array.isArray(value.distribution_contexts) && value.distribution_contexts.every(isRecord))) &&
    (value.product_relationships === undefined ||
      (Array.isArray(value.product_relationships) && value.product_relationships.every(isRecord))) &&
    (value.card_observed_games === undefined ||
      (Array.isArray(value.card_observed_games) && value.card_observed_games.every(isSupportedGame))) &&
    (value.product_observed_games === undefined ||
      (Array.isArray(value.product_observed_games) && value.product_observed_games.every(isSupportedGame))) &&
    (value.product_observed_lineages === undefined ||
      (Array.isArray(value.product_observed_lineages) &&
        value.product_observed_lineages.every((lineage) => typeof lineage === "string" && lineage.length > 0))) &&
    (value.source_checks === undefined ||
      (Array.isArray(value.source_checks) && value.source_checks.every(isCatalogueSourceCheck)))
  );
}

function isCatalogueErratum(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasRequiredAndAllowedKeys(
      value,
      ["id", "game", "target_type", "target_id", "effective_from", "official_wording", "corrected_value", "provenance"],
      [
        "id",
        "game",
        "target_type",
        "target_id",
        "effective_from",
        "official_wording",
        "corrected_value",
        "provenance",
        "curated_provenance",
      ],
    ) &&
    typeof value.id === "string" &&
    isSupportedGame(value.game) &&
    (value.target_type === "card" || value.target_type === "printing") &&
    typeof value.target_id === "string" &&
    (value.effective_from === null || typeof value.effective_from === "string") &&
    typeof value.official_wording === "string" &&
    (value.corrected_value === null || typeof value.corrected_value === "string") &&
    Array.isArray(value.provenance) &&
    value.provenance.every(
      (provenance) =>
        isRecord(provenance) &&
        hasOnlyKeys(provenance, ["source_lineage", "source_observation_id"]) &&
        typeof provenance.source_lineage === "string" &&
        typeof provenance.source_observation_id === "string",
    ) &&
    (value.curated_provenance === undefined ||
      (Array.isArray(value.curated_provenance) &&
        value.curated_provenance.length > 0 &&
        value.curated_provenance.every(isCuratedProvenance)))
  );
}

function isCuratedProvenance(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "curated_revision_id",
      "content_digest",
      "target",
      "rationale",
      "evidence",
      "author",
      "reviewed_source_value",
    ]) &&
    typeof value.curated_revision_id === "string" &&
    isOpaqueIdentity(value.curated_revision_id) &&
    typeof value.content_digest === "string" &&
    isSha256Digest(value.content_digest) &&
    isCuratedTarget(value.target) &&
    typeof value.rationale === "string" &&
    value.rationale.length > 0 &&
    Array.isArray(value.evidence) &&
    value.evidence.length > 0 &&
    value.evidence.every(isCuratedEvidence) &&
    typeof value.author === "string" &&
    value.author.length > 0 &&
    Object.hasOwn(value, "reviewed_source_value")
  );
}

function isCuratedTarget(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "field") {
    return (
      hasOnlyKeys(value, ["kind", "entity_type", "entity_id", "path"]) &&
      ["card", "printing", "product", "release", "distribution_context", "erratum", "legality_rule"].includes(
        String(value.entity_type),
      ) &&
      typeof value.entity_id === "string" &&
      isOpaqueIdentity(value.entity_id) &&
      typeof value.path === "string" &&
      value.path.startsWith("/")
    );
  }
  if (
    value.kind !== "relationship" ||
    !hasOnlyKeys(value, ["kind", "relationship_kind", "from", "to"]) ||
    !isRecord(value.from) ||
    !isRecord(value.to)
  )
    return false;
  if (
    !hasOnlyKeys(value.from, ["type", "id"]) ||
    !hasOnlyKeys(value.to, ["type", "id"]) ||
    typeof value.from.id !== "string" ||
    !isOpaqueIdentity(value.from.id) ||
    typeof value.to.id !== "string" ||
    !isOpaqueIdentity(value.to.id)
  ) {
    return false;
  }
  const expectedEndpoints: Readonly<Record<string, readonly [string, string]>> = {
    "printing-product": ["printing", "product"],
    "printing-distribution-context": ["printing", "distribution_context"],
    "distribution-context-product": ["distribution_context", "product"],
    "product-card": ["product", "card"],
  };
  const endpoints = expectedEndpoints[String(value.relationship_kind)];
  return endpoints !== undefined && value.from.type === endpoints[0] && value.to.type === endpoints[1];
}

function isCuratedEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "source_observation") {
    return hasOnlyKeys(value, ["kind", "id"]) && typeof value.id === "string" && isOpaqueIdentity(value.id);
  }
  return (
    value.kind === "owner_reference" &&
    hasOnlyKeys(value, ["kind", "uri", "content_digest"]) &&
    typeof value.uri === "string" &&
    isAbsoluteUri(value.uri) &&
    typeof value.content_digest === "string" &&
    isSha256Digest(value.content_digest)
  );
}

function isAbsoluteUri(value: string): boolean {
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}

function validOfficialIdentity(identity: Record<string, unknown>, game: SupportedGame): boolean {
  return (
    (identity.kind === "card_number" && typeof identity.value === "string" && identity.value.length > 0) ||
    (game === "one-piece" && identity.kind === "functional_designation" && identity.value === "DON!!")
  );
}

function isSupportedGame(value: unknown): value is SupportedGame {
  return value === "one-piece" || value === "fusion-world" || value === "digimon" || value === "gundam";
}

function isExactStringTuple(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])
  );
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function hasRequiredAndAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.includes(key));
}

function parseSelectedGames(value: string): readonly SupportedGame[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isSupportedGame)) {
    throw new Error("The persisted selected games are invalid.");
  }
  return parsed;
}

function parseProgress(value: string, expectedState?: string): Record<string, unknown> {
  return decodeProgress(parseJson(value, "Ingestion Run progress"), expectedState);
}

function decodeProgress(value: unknown, expectedState?: string): Record<string, unknown> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["completed_stages", "current_stage"]) ||
    !Array.isArray(value.completed_stages) ||
    value.completed_stages.some(
      (stage) => typeof stage !== "string" || !activeRunStages.some((knownStage) => knownStage === stage),
    ) ||
    value.completed_stages.length > activeRunStages.length ||
    value.completed_stages.some((stage, index) => stage !== activeRunStages[index]) ||
    typeof value.current_stage !== "string" ||
    !runStates.has(value.current_stage) ||
    (expectedState !== undefined && value.current_stage !== expectedState) ||
    !validCompletedStageCount(value.current_stage, value.completed_stages.length)
  ) {
    throw new Error("The persisted Ingestion Run progress is invalid.");
  }
  return {
    completed_stages: [...value.completed_stages],
    current_stage: value.current_stage,
  };
}

function parseWarnings(value: string): Record<string, unknown>[] {
  return decodeWarnings(parseJson(value, "Ingestion Run warnings"));
}

function decodeWarnings(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((warning) => !isWarningDocument(warning))) {
    throw new Error("The persisted Ingestion Run warnings are invalid.");
  }
  return value;
}

function validCompletedStageCount(state: string, completedCount: number): boolean {
  const activeIndex = activeRunStages.findIndex((knownStage) => knownStage === state);
  if (activeIndex >= 0) return completedCount === activeIndex;
  if (state === "paused") {
    return completedCount === activeRunStages.indexOf("collecting");
  }
  if (state === "published") {
    return completedCount === activeRunStages.length;
  }
  if (state === "rejected" || state === "expired") {
    return completedCount === activeRunStages.indexOf("awaiting_approval");
  }
  return state === "failed";
}

function isWarningDocument(value: unknown): value is Record<string, unknown> {
  const curatedConflict =
    isRecord(value) &&
    hasOnlyKeys(value, ["code", "detail", "curated_revision_id", "conflict_id", "conflict_digest"]) &&
    value.code === "curated_revision_reconfirmation_required" &&
    typeof value.curated_revision_id === "string" &&
    isOpaqueIdentity(value.curated_revision_id) &&
    typeof value.conflict_id === "string" &&
    isOpaqueIdentity(value.conflict_id) &&
    typeof value.conflict_digest === "string" &&
    isSha256Digest(value.conflict_digest);
  return (
    isRecord(value) &&
    (curatedConflict || hasOnlyKeys(value, ["code", "detail"]) || hasOnlyKeys(value, ["code", "detail", "severity"])) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.detail === "string" &&
    (!("severity" in value) ||
      (typeof value.severity === "string" && ["info", "warning", "error"].includes(value.severity)))
  );
}

function parseApproval(value: string | null): {
  action: "approved";
  approved_at: string;
  candidate_digest: string;
  expected_current_revision_id: string;
} {
  if (value === null) {
    throw new Error("The persisted Ingestion Run approval is missing.");
  }
  return decodeApproval(parseJson(value, "Ingestion Run approval"));
}

function decodeApproval(value: unknown): {
  action: "approved";
  approved_at: string;
  candidate_digest: string;
  expected_current_revision_id: string;
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["action", "approved_at", "candidate_digest", "expected_current_revision_id"]) ||
    value.action !== "approved" ||
    !isIsoInstant(value.approved_at) ||
    typeof value.candidate_digest !== "string" ||
    !isSha256Digest(value.candidate_digest) ||
    typeof value.expected_current_revision_id !== "string" ||
    !isOpaqueIdentity(value.expected_current_revision_id)
  ) {
    throw new Error("The persisted Ingestion Run approval is invalid.");
  }
  return {
    action: "approved",
    approved_at: value.approved_at,
    candidate_digest: value.candidate_digest,
    expected_current_revision_id: value.expected_current_revision_id,
  };
}

function parseApprovalHistory(value: string): Record<string, unknown>[] {
  return decodeApprovalHistory(parseJson(value, "Ingestion Run approval history"));
}

function decodeApprovalHistory(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 1 || value.some((decision) => !isApprovalDecision(decision))) {
    throw new Error("The persisted Ingestion Run approval history is invalid.");
  }
  return value;
}

function isApprovalDecision(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.candidate_digest !== "string") {
    return false;
  }
  if (value.action === "approved") {
    return (
      hasOnlyKeys(value, ["action", "approved_at", "candidate_digest", "expected_current_revision_id"]) &&
      isIsoInstant(value.approved_at) &&
      isSha256Digest(value.candidate_digest) &&
      typeof value.expected_current_revision_id === "string" &&
      isOpaqueIdentity(value.expected_current_revision_id)
    );
  }
  return (
    value.action === "rejected" &&
    hasOnlyKeys(value, ["action", "rejected_at", "candidate_digest"]) &&
    isIsoInstant(value.rejected_at) &&
    isSha256Digest(value.candidate_digest)
  );
}

function isIsoInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function parseCleanupKeys(value: string, run: RunRow): string[] {
  const revisionId = requiredPublicationValue(run.publication_revision_id, "revision ID");
  const prefix = `catalogue-exports/${revisionId}/`;
  return decodeCleanupKeySet(parseJson(value, "Publication cleanup object keys"), prefix);
}

function decodeCleanupKeySet(value: unknown, prefix: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((key) => typeof key !== "string" || key.length <= prefix.length || !key.startsWith(prefix)) ||
    new Set(value).size !== value.length ||
    value.some((key, index) => key !== [...value].sort()[index])
  ) {
    throw new Error("The persisted publication cleanup object keys are invalid.");
  }
  return value;
}

function publicRun(row: RunRow, cleanup: PublicationCleanupRow | null = null): Record<string, unknown> {
  const selectedGames = parseSelectedGames(row.selected_games_json);
  const progress = parseProgress(row.progress_json);
  const approval = row.approval_json === null ? null : parseApproval(row.approval_json);
  const approvalHistory = parseApprovalHistory(row.approval_history_json);
  if (
    row.candidate_digest !== null &&
    !selectedGames.every((game) => parseCandidate(row).selected_games.includes(game))
  ) {
    throw new Error("The persisted Ingestion Run document is inconsistent.");
  }
  const document = decodePublicRunDocument({
    id: row.id,
    state: row.state,
    selected_games: selectedGames,
    started_at: row.started_at,
    expected_current_revision_id: row.expected_current_revision_id,
    linked_run_id: row.linked_run_id,
    idempotency_key: row.idempotency_key,
    candidate_digest: row.candidate_digest,
    candidate_created_at: row.candidate_created_at,
    approval_deadline: row.approval_deadline,
    approval,
    approval_history: approvalHistory,
    progress,
    warnings: parseWarnings(row.warnings_json),
    failure_code: row.failure_code,
    publication_outcome: row.publication_outcome,
    published_revision_id: row.published_revision_id,
    resulting_revision_id: row.resulting_revision_id,
    ...(row.export_manifest_digest === null ? {} : { export_manifest_digest: row.export_manifest_digest }),
    freshness_checked_at: row.freshness_checked_at,
    terminal_at: row.terminal_at,
    publication_reservation: publicPublicationReservation(row),
    publication_cleanup: publicPublicationCleanup(cleanup),
  });
  return {
    ...document,
    operational_diagnostics: operationalDiagnostics({
      ...document,
      operational_request_id: row.operational_request_id,
    }),
  };
}

function publicPublicationReservation(row: RunRow): Record<string, unknown> | null {
  const values = [
    row.publication_revision_id,
    row.publication_started_at,
    row.publication_reconcile_after,
    row.publication_manifest_digest,
    row.publication_writer_token,
  ];
  return decodePublicationReservation(
    values.every((value) => value === null)
      ? null
      : {
          revision_id: row.publication_revision_id,
          started_at: row.publication_started_at,
          reconcile_after: row.publication_reconcile_after,
          manifest_digest: row.publication_manifest_digest,
          writer_token: row.publication_writer_token,
        },
  );
}

function publicPublicationCleanup(cleanup: PublicationCleanupRow | null): Record<string, unknown> | null {
  return decodePublicationCleanup(
    cleanup === null
      ? null
      : {
          state: cleanup.state,
          attempts: cleanup.attempts,
          failure_code: cleanup.failure_code,
          last_attempt_at: cleanup.last_attempt_at,
          completed_at: cleanup.completed_at,
          not_before: cleanup.not_before,
          generation: cleanup.claim_version,
        },
  );
}

function decodePublicRunDocument(value: unknown): Record<string, unknown> {
  const requiredKeys = [
    "id",
    "state",
    "selected_games",
    "started_at",
    "expected_current_revision_id",
    "linked_run_id",
    "idempotency_key",
    "candidate_digest",
    "candidate_created_at",
    "approval_deadline",
    "approval",
    "approval_history",
    "progress",
    "warnings",
    "failure_code",
    "publication_outcome",
    "published_revision_id",
    "resulting_revision_id",
    "freshness_checked_at",
    "terminal_at",
    "publication_reservation",
    "publication_cleanup",
  ];
  if (
    !isRecord(value) ||
    requiredKeys.some((key) => !(key in value)) ||
    Object.keys(value).some(
      (key) => !requiredKeys.includes(key) && key !== "export_manifest_digest" && key !== "operational_diagnostics",
    ) ||
    typeof value.id !== "string" ||
    !isOpaqueIdentity(value.id) ||
    typeof value.state !== "string" ||
    !runStates.has(value.state) ||
    !Array.isArray(value.selected_games) ||
    value.selected_games.length === 0 ||
    !value.selected_games.every(isSupportedGame) ||
    !isIsoInstant(value.started_at) ||
    typeof value.expected_current_revision_id !== "string" ||
    !isOpaqueIdentity(value.expected_current_revision_id) ||
    !isNullableOpaqueIdentity(value.linked_run_id) ||
    typeof value.idempotency_key !== "string" ||
    !isOpaqueIdentity(value.idempotency_key) ||
    !isNullableSha256(value.candidate_digest) ||
    !isNullableIsoInstant(value.candidate_created_at) ||
    !isNullableIsoInstant(value.approval_deadline) ||
    !isNullableString(value.failure_code) ||
    !isNullableOpaqueIdentity(value.published_revision_id) ||
    !isNullableOpaqueIdentity(value.resulting_revision_id) ||
    !isNullableIsoInstant(value.freshness_checked_at) ||
    !isNullableIsoInstant(value.terminal_at) ||
    !(
      value.publication_outcome === null ||
      value.publication_outcome === "revision" ||
      value.publication_outcome === "no_change"
    ) ||
    ("export_manifest_digest" in value &&
      (typeof value.export_manifest_digest !== "string" || !isSha256Digest(value.export_manifest_digest)))
  ) {
    throw new Error("The persisted administration success outcome is invalid.");
  }
  const progress = decodeProgress(value.progress, value.state);
  const warnings = decodeWarnings(value.warnings);
  const approval = value.approval === null ? null : decodeApproval(value.approval);
  const approvalHistory = decodeApprovalHistory(value.approval_history);
  const reservation = decodePublicationReservation(value.publication_reservation);
  const cleanup = decodePublicationCleanup(value.publication_cleanup);
  assertPublicRunCrossFieldInvariants(value, {
    progress,
    approval,
    approvalHistory,
    reservation,
    cleanup,
  });
  const operationalRequestId = retainedOperationalRequestId(value.operational_diagnostics);
  const { operational_diagnostics: _retainedOperationalDiagnostics, ...retainedValue } = value;
  const document = {
    ...retainedValue,
    progress,
    warnings,
    approval,
    approval_history: approvalHistory,
    publication_reservation: reservation,
    publication_cleanup: cleanup,
  };
  return {
    ...document,
    operational_diagnostics: operationalDiagnostics({
      ...document,
      operational_request_id: operationalRequestId,
    }),
  };
}

function retainedOperationalRequestId(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const references = (value as Record<string, unknown>).references;
  if (references === null || typeof references !== "object" || Array.isArray(references)) return null;
  const requestId = (references as Record<string, unknown>).request_id;
  return typeof requestId === "string" ? requestId : null;
}

function decodePublicationReservation(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["revision_id", "started_at", "reconcile_after", "manifest_digest", "writer_token"]) ||
    typeof value.revision_id !== "string" ||
    !isOpaqueIdentity(value.revision_id) ||
    !isIsoInstant(value.started_at) ||
    !isIsoInstant(value.reconcile_after) ||
    Date.parse(value.reconcile_after) < Date.parse(value.started_at) ||
    typeof value.manifest_digest !== "string" ||
    !isSha256Digest(value.manifest_digest) ||
    typeof value.writer_token !== "string" ||
    value.writer_token !== publicationWriterToken(value.revision_id)
  ) {
    throw new Error("The persisted publication reservation is invalid.");
  }
  return {
    revision_id: value.revision_id,
    started_at: value.started_at,
    reconcile_after: value.reconcile_after,
    manifest_digest: value.manifest_digest,
    writer_token: value.writer_token,
  };
}

function decodePublicationCleanup(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "state",
      "attempts",
      "failure_code",
      "last_attempt_at",
      "completed_at",
      "not_before",
      "generation",
    ]) ||
    typeof value.state !== "string" ||
    !["pending", "cleaning", "completed", "failed"].includes(value.state) ||
    typeof value.attempts !== "number" ||
    !Number.isInteger(value.attempts) ||
    value.attempts < 0 ||
    !isNullableString(value.failure_code) ||
    !isNullableIsoInstant(value.last_attempt_at) ||
    !isNullableIsoInstant(value.completed_at) ||
    !isIsoInstant(value.not_before) ||
    typeof value.generation !== "number" ||
    !Number.isInteger(value.generation) ||
    value.generation < 0 ||
    (value.state === "pending" &&
      (value.attempts !== 0 || value.last_attempt_at !== null || value.completed_at !== null)) ||
    (value.state === "cleaning" &&
      (value.attempts < 1 || value.last_attempt_at === null || value.completed_at !== null)) ||
    (value.state === "failed" &&
      (value.attempts < 1 ||
        value.failure_code === null ||
        value.last_attempt_at === null ||
        value.completed_at !== null)) ||
    (value.state === "completed" &&
      (value.attempts < 1 ||
        value.failure_code !== null ||
        value.last_attempt_at === null ||
        value.completed_at === null))
  ) {
    throw new Error("The persisted publication cleanup state is invalid.");
  }
  return {
    state: value.state,
    attempts: value.attempts,
    failure_code: value.failure_code,
    last_attempt_at: value.last_attempt_at,
    completed_at: value.completed_at,
    not_before: value.not_before,
    generation: value.generation,
  };
}

function assertPublicRunCrossFieldInvariants(
  value: Record<string, unknown>,
  decoded: {
    progress: Record<string, unknown>;
    approval: {
      action: "approved";
      approved_at: string;
      candidate_digest: string;
      expected_current_revision_id: string;
    } | null;
    approvalHistory: Record<string, unknown>[];
    reservation: Record<string, unknown> | null;
    cleanup: Record<string, unknown> | null;
  },
): void {
  const state = value.state;
  const terminal = typeof state === "string" && terminalRunStates.has(state);
  const completedStages = decoded.progress.completed_stages;
  const candidateRequired =
    state === "awaiting_approval" ||
    state === "publishing" ||
    state === "published" ||
    state === "rejected" ||
    state === "expired" ||
    (Array.isArray(completedStages) && completedStages.includes("reconciling"));
  if (
    (terminal && value.terminal_at === null) ||
    (!terminal && value.terminal_at !== null) ||
    (candidateRequired &&
      (typeof value.candidate_digest !== "string" ||
        typeof value.candidate_created_at !== "string" ||
        typeof value.approval_deadline !== "string" ||
        Date.parse(value.approval_deadline) - Date.parse(value.candidate_created_at) !== sevenDaysInMilliseconds)) ||
    (!candidateRequired &&
      (value.candidate_digest !== null || value.candidate_created_at !== null || value.approval_deadline !== null)) ||
    (decoded.approval !== null &&
      (decoded.approval.candidate_digest !== value.candidate_digest ||
        decoded.approval.expected_current_revision_id !== value.expected_current_revision_id ||
        typeof value.approval_deadline !== "string" ||
        Date.parse(decoded.approval.approved_at) >= Date.parse(value.approval_deadline) ||
        !["publishing", "published", "failed"].includes(String(state)) ||
        decoded.approvalHistory.length !== 1 ||
        canonicalJson(decoded.approvalHistory[0]) !== canonicalJson(decoded.approval))) ||
    (decoded.approval === null && decoded.approvalHistory.some((decision) => decision.action === "approved")) ||
    decoded.approvalHistory.some((decision) => decision.candidate_digest !== value.candidate_digest) ||
    (state === "rejected" &&
      (decoded.approvalHistory.length !== 1 || decoded.approvalHistory[0]?.action !== "rejected")) ||
    (state !== "rejected" && decoded.approvalHistory.some((decision) => decision.action === "rejected")) ||
    (state === "expired" && decoded.approvalHistory.length !== 0) ||
    (decoded.reservation !== null &&
      (decoded.approval === null ||
        !["publishing", "published", "failed"].includes(String(state)) ||
        decoded.reservation.started_at !== decoded.approval.approved_at ||
        typeof decoded.reservation.started_at !== "string" ||
        typeof decoded.reservation.reconcile_after !== "string" ||
        Date.parse(decoded.reservation.reconcile_after) - Date.parse(decoded.reservation.started_at) !==
          publicationLeaseMilliseconds)) ||
    (state === "publishing" && (decoded.approval === null || decoded.reservation === null)) ||
    (decoded.cleanup !== null &&
      (state !== "failed" ||
        decoded.reservation === null ||
        typeof decoded.cleanup.not_before !== "string" ||
        typeof decoded.reservation.reconcile_after !== "string" ||
        typeof value.terminal_at !== "string" ||
        Date.parse(decoded.cleanup.not_before) -
          Math.max(Date.parse(decoded.reservation.reconcile_after), Date.parse(value.terminal_at)) !==
          publicationLeaseMilliseconds)) ||
    (state === "failed" &&
      decoded.reservation !== null &&
      decoded.cleanup === null &&
      value.failure_code !== "publication_abandoned") ||
    (state === "failed" && (decoded.approval === null) !== (decoded.reservation === null)) ||
    (state === "failed" && (typeof value.failure_code !== "string" || value.failure_code.length === 0)) ||
    (state !== "failed" && value.failure_code !== null) ||
    !validPublicationOutcome(value, decoded)
  ) {
    throw new Error("The persisted Ingestion Run document is inconsistent.");
  }
}

function validPublicationOutcome(
  value: Record<string, unknown>,
  decoded: {
    approval: Record<string, unknown> | null;
    reservation: Record<string, unknown> | null;
  },
): boolean {
  if (value.state !== "published") {
    return (
      value.publication_outcome === null &&
      value.published_revision_id === null &&
      value.resulting_revision_id === null &&
      !("export_manifest_digest" in value) &&
      value.freshness_checked_at === null
    );
  }
  if (decoded.approval === null || value.terminal_at === null || value.freshness_checked_at === null) {
    return false;
  }
  if (value.publication_outcome === "no_change") {
    return (
      decoded.reservation === null &&
      value.published_revision_id === null &&
      value.resulting_revision_id === value.expected_current_revision_id &&
      !("export_manifest_digest" in value)
    );
  }
  return (
    value.publication_outcome === "revision" &&
    decoded.reservation !== null &&
    value.published_revision_id === decoded.reservation.revision_id &&
    value.resulting_revision_id === decoded.reservation.revision_id &&
    value.export_manifest_digest === decoded.reservation.manifest_digest
  );
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isNullableIsoInstant(value: unknown): boolean {
  return value === null || isIsoInstant(value);
}

function isNullableOpaqueIdentity(value: unknown): boolean {
  return value === null || (typeof value === "string" && isOpaqueIdentity(value));
}

function isNullableSha256(value: unknown): boolean {
  return value === null || (typeof value === "string" && isSha256Digest(value));
}

function isOpaqueIdentity(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isSha256Digest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function progressFor(state: string): Record<string, unknown> {
  const position = activeRunStages.findIndex((knownStage) => knownStage === state);
  if (position >= 0) {
    return {
      completed_stages: activeRunStages.slice(0, position),
      current_stage: state,
    };
  }
  return {
    completed_stages: [...activeRunStages],
    current_stage: state,
  };
}

function terminalProgress(run: RunRow, terminalState: "rejected" | "expired" | "failed"): Record<string, unknown> {
  const progress = parseProgress(run.progress_json);
  return {
    ...progress,
    current_stage: terminalState,
  };
}

function assertOpaqueId(value: string, field: string): void {
  if (!isOpaqueIdentity(value)) {
    throw new AdministrationProblem(422, "invalid_parameter", `${field} is not a valid opaque identity.`);
  }
}

function assertSha256(value: string, field: string): void {
  if (!isSha256Digest(value)) {
    throw new AdministrationProblem(422, "invalid_parameter", `${field} is not a lower-case SHA-256 digest.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
