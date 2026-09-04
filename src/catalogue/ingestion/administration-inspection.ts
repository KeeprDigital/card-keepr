import { curatedRevisionInspectionForRun } from "../curated";
import { cardSearchFtsQuery, cardSearchText, sourceFreshnessFromStorage } from "../read";
import { AdministrationProblem, type CatalogueCandidate, canonicalJson, retainedPayload, sha256Text } from "../shared";
import { inspectCatalogueCandidate } from "./candidate-inspection";
import { repairableCatalogueRevisionWindow } from "./catalogue-revision-retention";
import { SPINE_REVISION_ID } from "./production-release";

import { reconcileAbandonedPublication } from "./publication-lifecycle";
import { parseProgress, parseWarnings, publicRun } from "./run-document-codec";
import { currentCatalogueState, currentOperationState, expireOverdueRuns, requiredRun } from "./run-storage";
import type { FreshnessRow, PublicationCleanupRow, RunRow } from "./run-types";
import { assertOpaqueId, isRecord } from "./run-values";

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
