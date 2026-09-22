import { type CatalogueStore, repositoryStatements } from "../shared";

// Proposed identities the run already admitted: a replayed batch keeps them.
export function admittedDiscoveryRequestsStatement(database: CatalogueStore, runId: string, requestIdsJson: string) {
  return repositoryStatements(database)
    .prepare(
      `SELECT request_id FROM source_discovery_request_plans
       WHERE ingestion_run_id = ? AND request_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(runId, requestIdsJson);
}

const admittedRoleCountSql = `(SELECT COUNT(*) FROM source_discovery_request_plans
  WHERE ingestion_run_id = ?1 AND request_role = ?2 AND request_id LIKE ?3)`;

// Discovered requests of one role the lineage already holds in this run.
export function admittedDiscoveryRoleCountStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; role: string; lineagePattern: string }>,
) {
  return repositoryStatements(database)
    .prepare(`SELECT ${admittedRoleCountSql} AS count`)
    .bind(input.runId, input.role, input.lineagePattern);
}

// Aborts the admission batch (invalid JSON) when a concurrent batch already
// filled the selection's maximum; evaluated after this batch's inserts.
export function discoverySelectionMaximumGuardStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; role: string; lineagePattern: string; maximum: number }>,
) {
  return repositoryStatements(database)
    .prepare(
      `SELECT CASE WHEN ${admittedRoleCountSql} > ?4
       THEN json('source_discovery_selection_exceeded') ELSE 1 END`,
    )
    .bind(input.runId, input.role, input.lineagePattern, input.maximum);
}

export function insertDiscoveryDeferralStatement(
  database: CatalogueStore,
  input: Readonly<{
    runId: string;
    parentRequestId: string;
    deferralKey: string;
    sourceLineage: string;
    role: string;
    deferredCount: number;
    groupCountsJson: string;
    recordedAt: string;
  }>,
) {
  return repositoryStatements(database)
    .prepare(
      `INSERT OR IGNORE INTO source_discovery_deferrals (
         ingestion_run_id, parent_request_id, deferral_key, source_lineage,
         request_role, deferred_count, group_counts_json, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.runId,
      input.parentRequestId,
      input.deferralKey,
      input.sourceLineage,
      input.role,
      input.deferredCount,
      input.groupCountsJson,
      input.recordedAt,
    );
}
