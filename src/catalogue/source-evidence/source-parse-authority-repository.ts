import { repositoryStatements, verifiedRunCurrentSql, type CatalogueStore } from "../shared";

export type SourceParseAuthority = {
  intent: "collection" | "reparse";
  workflowAttempt?: { parentId: string; instanceId: string };
};

/** Compose this guard in every bounded progress transaction, after external I/O. */
export function sourceParseAuthorityGuard(db: CatalogueStore, runId: string, authority: SourceParseAuthority) {
  return repositoryStatements(db)
    .prepare(
      `SELECT CASE WHEN ?2='reparse' OR EXISTS (
    SELECT 1 FROM ingestion_run_current AS current
    JOIN ingestion_evidence_plans AS plan ON plan.ingestion_run_id=current.ingestion_run_id
    WHERE current.ingestion_run_id=?1 AND current.state='collecting' AND ${verifiedRunCurrentSql}
      AND (?3 IS NULL OR (plan.parent_workflow_id=?3 AND EXISTS (
        SELECT 1 FROM ingestion_workflow_attempts AS attempt
        WHERE attempt.ingestion_run_id=?1 AND attempt.workflow_instance_id=?4
          AND NOT EXISTS (SELECT 1 FROM ingestion_workflow_attempts AS later
            WHERE later.ingestion_run_id=attempt.ingestion_run_id AND later.workflow_kind=attempt.workflow_kind
              AND later.base_workflow_id=attempt.base_workflow_id AND later.attempt_number>attempt.attempt_number)
      )))
    ) THEN 1 ELSE json_extract('{}','source_parse_authority_superseded') END`,
    )
    .bind(
      runId,
      authority.intent,
      authority.workflowAttempt?.parentId ?? null,
      authority.workflowAttempt?.instanceId ?? null,
    );
}
