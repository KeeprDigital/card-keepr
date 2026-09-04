import { type CatalogueStore, repositoryStatements } from "../shared";
// Named prepared statements; callers retain execution and atomic batch composition.

export function administrationSourceFreshnessStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT game, area, source_lineage, region, checked_at,
                  ingestion_run_id
          FROM source_freshness
          ORDER BY game, area, source_lineage, region`);
}

export function recentIngestionRunsStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT * FROM ingestion_runs
          ORDER BY started_at DESC, id DESC
          LIMIT 20`);
}

export function catalogueRevisionCountStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare("SELECT COUNT(*) AS count FROM catalogue_revisions");
}

export function catalogueExportCountStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare("SELECT COUNT(*) AS count FROM catalogue_exports");
}

export function pendingPublicationCleanupCountStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT COUNT(*) AS count
          FROM ingestion_publication_cleanup
          WHERE state IN ('pending', 'failed')`);
}

export function catalogueSchemaLevelStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(
    "SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1",
  );
}

export function currentRevisionVerifiedBackupStatement(
  database: CatalogueStore,
  revisionId: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT idempotency_key, d1_bookmark, manifest_sha256
     FROM catalogue_backup_attempts
     WHERE state = 'verified' AND catalogue_revision_id = ?
       AND d1_bookmark IS NOT NULL AND manifest_sha256 IS NOT NULL
     ORDER BY completed_at DESC LIMIT 1`)
    .bind(revisionId);
}

export function retainedRevisionInspectionStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`WITH RECURSIVE retained(revision_id, depth) AS (
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
     ORDER BY retained.depth`);
}

export function pendingReplacementRecoveryStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(
    database,
  ).prepare(`SELECT id, target_revision_id, target_digest, restored_database_id, retained_database_id, verification_json
     FROM catalogue_recovery_operations
     WHERE state = 'awaiting_acceptance' AND method = 'replacement_database'
     ORDER BY started_at DESC LIMIT 1`);
}

export function activeProductionReleaseStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(
    database,
  ).prepare(`SELECT id, state, expected_head_sha, api_version_id, ingestion_version_id,
            failure_code, roll_forward_required
     FROM production_releases
     WHERE state IN ('requested','preflight','migrating','deploying','smoke_testing')
     LIMIT 1`);
}

export function runHasReconciliationContextStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT 1 AS present
           FROM reconciliation_contexts
           WHERE ingestion_run_id = ?`)
    .bind(runId);
}

export function smokeTargetCardsStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT query.card_id,query.sort_game,query.sort_identity_kind,
                query.sort_identity_value,query.sort_id,card.document_json
         FROM revision_card_query_documents AS query
         JOIN revision_cards AS card
           ON card.catalogue_revision_id=query.catalogue_revision_id
          AND card.card_id=query.card_id
         WHERE query.catalogue_revision_id=?
         ORDER BY sort_game,sort_identity_kind,sort_identity_value,sort_id LIMIT 2`)
    .bind(revisionId);
}

export function smokeTargetPrintingsStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT printing_id,card_id FROM revision_printings
         WHERE catalogue_revision_id=? ORDER BY card_id,printing_id LIMIT 2`)
    .bind(revisionId);
}

export function smokeTargetSearchMatchStatement(
  database: CatalogueStore,
  input: Readonly<{ ftsQuery: string; revisionId: string; cardId: string; searchQuery: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT 1 AS present FROM revision_card_search_fts
       WHERE revision_card_search_fts MATCH ?
         AND catalogue_revision_id=? AND card_id=?
         AND instr(search_text,?)>0 LIMIT 1`)
    .bind(input.ftsQuery, input.revisionId, input.cardId, input.searchQuery);
}

export function archivedQueryRevisionStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT catalogue_revision_id FROM catalogue_query_revisions
       WHERE state='archived' ORDER BY catalogue_revision_id DESC LIMIT 1`);
}

export function smokeTargetExtrasStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT
       (SELECT image_id FROM revision_printing_images WHERE catalogue_revision_id=? ORDER BY image_id LIMIT 1) AS printing_image_id,
       (SELECT json_extract(card_ids_json,'$[0]') FROM revision_legality_rules WHERE catalogue_revision_id=? AND json_array_length(card_ids_json)>0 ORDER BY legality_rule_id LIMIT 1) AS legality_card_id,
       (SELECT format FROM revision_legality_rules WHERE catalogue_revision_id=? AND json_array_length(card_ids_json)>0 ORDER BY legality_rule_id LIMIT 1) AS legality_format,
       (SELECT region FROM revision_legality_rules WHERE catalogue_revision_id=? AND json_array_length(card_ids_json)>0 ORDER BY legality_rule_id LIMIT 1) AS legality_region`)
    .bind(revisionId, revisionId, revisionId, revisionId);
}

export function registeredRevisionIdsStatement(database: CatalogueStore, ids: readonly string[]): D1PreparedStatement {
  const placeholders = ids.map(() => "?").join(", ");
  return repositoryStatements(database)
    .prepare(`SELECT id
          FROM catalogue_revisions
          WHERE id IN (${placeholders})`)
    .bind(...ids);
}

export function publicationCleanupsForRunIdsStatement(
  database: CatalogueStore,
  ids: readonly string[],
): D1PreparedStatement {
  const placeholders = ids.map(() => "?").join(", ");
  return repositoryStatements(database)
    .prepare(`SELECT *
      FROM ingestion_publication_cleanup
      WHERE ingestion_run_id IN (${placeholders})`)
    .bind(...ids);
}
