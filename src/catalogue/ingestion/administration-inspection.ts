import { outstandingBackupDispatches } from "../backup-recovery";
import { curatedRevisionInspectionForRun } from "../curated";
import { cardSearchFtsQuery, cardSearchText, compositionSmokeTargets, sourceFreshnessFromStorage } from "../read";
import {
  AdministrationProblem,
  type CatalogueCandidate,
  type CatalogueStore,
  canonicalJson,
  retainedPayload,
  sha256Text,
} from "../shared";
import {
  activeProductionReleaseStatement,
  administrationSourceFreshnessStatement,
  archivedQueryRevisionStatement,
  catalogueExportCountStatement,
  catalogueRevisionCountStatement,
  catalogueSchemaLevelStatement,
  currentRevisionVerifiedBackupStatement,
  pendingPublicationCleanupCountStatement,
  pendingReplacementRecoveryStatement,
  publicationCleanupsForRunIdsStatement,
  recentIngestionRunsStatement,
  registeredRevisionIdsStatement,
  retainedRevisionInspectionStatement,
  runHasReconciliationContextStatement,
  smokeTargetCardsStatement,
  smokeTargetExtrasStatement,
  smokeTargetPrintingsStatement,
  smokeTargetSearchMatchStatement,
} from "./administration-inspection-repository";
import { freshBaselineHandoffStatement, latestFreshBaselineCorrectionStatement } from "./fresh-baseline-repository";
import { inspectCatalogueCandidate } from "./candidate-inspection";
import { repairableCatalogueRevisionWindow } from "./catalogue-revision-retention";
import { SPINE_REVISION_ID } from "./production-release";

import { reconcileAbandonedPublication } from "./publication-lifecycle";
import { parseProgress, parseWarnings, publicRun } from "./run-document-codec";
import { currentCatalogueState, currentOperationState, expireOverdueRuns, requiredRun } from "./run-storage";
import type { FreshnessRow, PublicationCleanupRow, RunRow } from "./run-types";
import { assertOpaqueId, isRecord } from "./run-values";

export async function administrationStatus(
  database: CatalogueStore,
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
  reconcile = true,
): Promise<Record<string, unknown>> {
  const handoff = await freshBaselineHandoffStatement(database).first<{
    release_id: string;
    role: string;
    phase: number;
    dispatch_digest: string;
    request_json: string;
    evidence_json: string;
  }>();
  const handoffBlocked =
    handoff !== null &&
    ((handoff.role === "source" && handoff.phase !== 7) || (handoff.role === "destination" && handoff.phase !== 6));
  if (reconcile && !handoffBlocked) {
    await expireOverdueRuns(database, observedAt);
    await reconcileAbandonedPublication(database, catalogueExports, observedAt);
  }
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
    administrationSourceFreshnessStatement(database).all<FreshnessRow>(),
    recentIngestionRunsStatement(database).all<RunRow>(),
    catalogueRevisionCountStatement(database).first<{ count: number }>(),
    catalogueExportCountStatement(database).first<{ count: number }>(),
    pendingPublicationCleanupCountStatement(database).first<{ count: number }>(),
    catalogueExportObjectDiagnostics(database, catalogueExports),
    repairableCatalogueRevisionWindow(database),
  ]);
  const active =
    operation.active_ingestion_run_id === null ? null : await requiredRun(database, operation.active_ingestion_run_id);
  const cleanupByRun = await publicationCleanupsForRuns(database, [
    ...recentRuns.results.map((run) => run.id),
    ...(active === null ? [] : [active.id]),
  ]);
  const schema = await catalogueSchemaLevelStatement(database).first<{ migration_level: number }>();
  const recoveryBackup = await currentRevisionVerifiedBackupStatement(database, catalogue.current_revision_id).first<{
    idempotency_key: string;
    d1_bookmark: string;
    manifest_sha256: string;
  }>();
  const retainedEvidence = await retainedRevisionInspectionStatement(database).all<{
    revision_id: string;
    depth: number;
    export_verified: number;
    recovery_verified: number;
  }>();
  const replacement = await pendingReplacementRecoveryStatement(database).first<{
    id: string;
    target_revision_id: string;
    target_digest: string;
    restored_database_id: string;
    retained_database_id: string;
    verification_json: string;
  }>();
  const correction =
    handoff === null
      ? null
      : await latestFreshBaselineCorrectionStatement(database, handoff.dispatch_digest).first<{
          request_json: string;
          evidence_json: string;
          state: number;
          generation: number;
          correction_digest: string;
        }>();
  const activeProductionRelease = await activeProductionReleaseStatement(database).first<Record<string, unknown>>();
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
        !handoffBlocked &&
        operation.recovery_health === "healthy" &&
        operation.active_ingestion_run_id === null &&
        !(
          operation.active_production_release_id !== null &&
          operation.active_production_release_expires_at !== null &&
          operation.active_production_release_expires_at > observedAt
        ),
    },
    fresh_baseline_handoff:
      handoff === null
        ? null
        : {
            ...handoff,
            request: JSON.parse(handoff.request_json),
            evidence: JSON.parse(handoff.evidence_json),
            mutation_blocked: handoffBlocked,
            correction:
              correction === null
                ? null
                : {
                    ...correction,
                    request: JSON.parse(correction.request_json),
                    evidence: JSON.parse(correction.evidence_json),
                  },
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
      backup_dispatches: await outstandingBackupDispatches(database),
    },
    repairable_catalogue_revision_ids: repairableRevisions.results.map(({ revision_id }) => revision_id),
    recent_runs: recentRuns.results.map((run) => publicRun(run, cleanupByRun.get(run.id) ?? null)),
  };
}

export async function inspectCandidate(
  database: CatalogueStore,
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
      (await runHasReconciliationContextStatement(database, row.id).first<{ present: number }>()) !== null);
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
  database: CatalogueStore,
  revisionIds: readonly string[],
): Promise<Record<string, unknown> | null> {
  if (revisionIds.length !== 3) return null;
  const revisions = [];
  let nativeImageId: string | undefined;
  for (const revisionId of revisionIds) {
    const native = await compositionSmokeTargets(database, revisionId, releaseSmokeSearchQuery);
    if (native === null) return null;
    if (native !== undefined) {
      if (revisionId === revisionIds[0]) nativeImageId = native.printing_image_id;
      const { printing_image_id: _imageId, ...target } = native;
      revisions.push(target);
      continue;
    }
    const [cards, printings] = await Promise.all([
      smokeTargetCardsStatement(database, revisionId).all<{
        card_id: string;
        sort_game: string;
        sort_identity_kind: string;
        sort_identity_value: string;
        sort_id: string;
        document_json: string;
      }>(),
      smokeTargetPrintingsStatement(database, revisionId).all<{ printing_id: string; card_id: string }>(),
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
    const indexed = await smokeTargetSearchMatchStatement(database, {
      ftsQuery: ftsQuery,
      revisionId: revisionId,
      cardId: representativeCard.card_id,
      searchQuery: searchQuery,
    }).first<{ present: number }>();
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
    nativeImageId === undefined
      ? smokeTargetExtrasStatement(database, revisionIds[0]!).first<Record<string, string | null>>()
      : Promise.resolve({ printing_image_id: nativeImageId }),
    archivedQueryRevisionStatement(database).first<{ catalogue_revision_id: string }>(),
  ]);
  if (
    currentExtras === null ||
    unavailable === null ||
    Object.values(currentExtras).some((value) => typeof value !== "string")
  )
    return null;
  const staleAfter = (revisions[0] as { card_cursor: string }).card_cursor;
  const decoded = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(staleAfter.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
        character.charCodeAt(0),
      ),
    ),
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
      (card.official_identity.value !== null && typeof card.official_identity.value !== "string") ||
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

async function catalogueExportObjectDiagnostics(
  database: CatalogueStore,
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

      const matches = await registeredRevisionIdsStatement(database, chunk).all<{ id: string }>();
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
  database: CatalogueStore,
  runIds: readonly string[],
): Promise<Map<string, PublicationCleanupRow>> {
  const uniqueRunIds = [...new Set(runIds)].slice(0, 21);
  if (uniqueRunIds.length === 0) return new Map();

  const cleanups = await publicationCleanupsForRunIdsStatement(database, uniqueRunIds).all<PublicationCleanupRow>();
  return new Map(cleanups.results.map((cleanup) => [cleanup.ingestion_run_id, cleanup]));
}
