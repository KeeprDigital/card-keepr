import { type CatalogueStore, repositoryStatements } from "../shared";

/** Owner writes recheck mutable authority inside the caller's transaction. */
export function curatedOwnerMutationGuardStatement(
  database: CatalogueStore,
  input: Readonly<{ evidenceJson: string; evidenceKind: "schema" | "event" }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE
    WHEN COALESCE(json_extract(?, CASE ? WHEN 'schema' THEN '$.catalogue_revision_id' ELSE '$.expected_current_revision_id' END), '')
      <> (SELECT current_revision_id FROM catalogue_state WHERE singleton = 1)
      THEN json_extract('{}', 'curated_revision_current_revision_mismatch')
    WHEN EXISTS (SELECT 1 FROM operation_state WHERE singleton = 1
      AND (active_ingestion_run_id IS NOT NULL OR recovery_health = 'blocked'))
      THEN json_extract('{}', 'curated_revision_operation_not_idle')
    WHEN EXISTS (SELECT 1 FROM operation_state WHERE singleton = 1
      AND active_production_release_id IS NOT NULL
      AND active_production_release_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      THEN json_extract('{}', 'curated_revision_release_not_idle')
    ELSE 1 END`)
    .bind(input.evidenceJson, input.evidenceKind);
}

export function curatedTargetAvailabilityGuardStatement(
  database: CatalogueStore,
  input: Readonly<{ targetKey: string; effectiveFrom: string | null; effectiveTo: string | null }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM curated_revisions AS existing
    WHERE existing.status IN ('active', 'reconfirmation_required') AND existing.target_key = ?
      AND (existing.effective_to IS NULL OR ? IS NULL OR ? < existing.effective_to)
      AND (? IS NULL OR existing.effective_from IS NULL OR existing.effective_from < ?)
  ) THEN json_extract('{}', 'curated_revision_target_conflict') ELSE 1 END`)
    .bind(input.targetKey, input.effectiveFrom, input.effectiveFrom, input.effectiveTo, input.effectiveTo);
}

export function curatedRunPinSetGuardStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; idsJson: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN ? <> COALESCE((
    SELECT json_group_array(id) FROM (
      SELECT revision.id FROM curated_revisions AS revision JOIN ingestion_runs AS run ON run.id = ?
      WHERE revision.status = 'active'
        AND revision.game IN (SELECT game FROM ingestion_run_selected_games WHERE ingestion_run_id = run.id)
        AND (revision.effective_from IS NULL OR revision.effective_from <= substr(run.started_at, 1, 10))
        AND (revision.effective_to IS NULL OR substr(run.started_at, 1, 10) < revision.effective_to)
      ORDER BY revision.id
    )
  ), '[]') THEN json_extract('{}', 'curated_revision_pin_set_changed') ELSE 1 END`)
    .bind(input.idsJson, input.runId);
}

/** Follows a successful INSERT so selected games come from the persisted run. */
export function curatedRunStartGuardStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN changes() > 0 AND EXISTS (
    SELECT 1 FROM curated_revisions AS revision WHERE revision.status = 'reconfirmation_required'
      AND revision.game IN (SELECT game FROM ingestion_run_selected_games WHERE ingestion_run_id = ?)
  ) THEN json_extract('{}', 'curated_revision_reconfirmation_required') ELSE 1 END`)
    .bind(runId);
}
