import { type CatalogueStore, repositoryStatements } from "../shared";

export function cataloguePublicationGuardStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN changes() = 0 OR EXISTS (
    SELECT 1 FROM catalogue_revisions AS revision
    JOIN ingestion_run_current AS run ON run.ingestion_run_id = revision.ingestion_run_id
    JOIN ingestion_runs AS identity ON identity.id = run.ingestion_run_id
    JOIN operation_state AS operation ON operation.singleton = 1
    JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
    WHERE revision.id = ? AND run.state = 'publishing'
      AND run.candidate_digest = revision.approved_candidate_digest
      AND identity.expected_current_revision_id = revision.expected_previous_revision_id
      AND run.approved_candidate_digest = revision.approved_candidate_digest
      AND run.approved_expected_revision_id = revision.expected_previous_revision_id
      AND operation.active_ingestion_run_id = run.ingestion_run_id AND operation.recovery_health = 'healthy'
      AND catalogue.current_revision_id = revision.expected_previous_revision_id
  ) THEN 1 ELSE json_extract('{}', 'publication_guard_failed') END`)
    .bind(revisionId);
}

export function noChangeResultGuardStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN changes() = 0 OR EXISTS (
    SELECT 1 FROM ingestion_no_change_results AS result
    JOIN ingestion_run_current AS run ON run.ingestion_run_id = result.ingestion_run_id
    JOIN ingestion_runs AS identity ON identity.id = run.ingestion_run_id
    JOIN operation_state AS operation ON operation.singleton = 1
    JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
    JOIN catalogue_revisions AS revision ON revision.id = catalogue.current_revision_id
    WHERE result.ingestion_run_id = ? AND run.state = 'awaiting_approval'
      AND run.candidate_digest = result.candidate_digest
      AND identity.expected_current_revision_id = result.catalogue_revision_id
      AND operation.active_ingestion_run_id = run.ingestion_run_id AND operation.recovery_health = 'healthy'
      AND catalogue.current_revision_id = result.catalogue_revision_id
      AND revision.content_digest = run.candidate_catalogue_digest AND result.checked_at < run.approval_deadline
  ) THEN 1 ELSE json_extract('{}', 'no_change_guard_failed') END`)
    .bind(runId);
}

export function projectedPrintingImagesGuardStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; imagesJson: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN changes() = 0 OR NOT EXISTS (
    SELECT 1 FROM revision_printing_images AS image
    WHERE catalogue_revision_id = ? AND image_id IN (SELECT json_extract(value, '$.image_id') FROM json_each(?))
      AND (media_type IS NULL OR content_sha256 IS NULL OR content_byte_length IS NULL OR object_key IS NULL)
  ) THEN 1 ELSE json_extract('{}', 'revision_printing_image_content_missing') END`)
    .bind(input.revisionId, input.imagesJson);
}
