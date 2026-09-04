import { type CatalogueStore, canonicalJson, repositoryStatements } from "../shared";

export type { ObservationSetRow, SnapshotRow } from "./source-evidence-repository-types";

export type AttemptOutcome =
  | "success"
  | "cache_revalidated"
  | "redirect"
  | "http_failure"
  | "network_failure"
  | "body_failure"
  | "storage_failure"
  | "content_rejected";

export type AttemptInput = {
  id: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  requestedAt: string;
  completedAt: string;
  outcome: AttemptOutcome;
  status: number | null;
  headers: Record<string, string>;
  retryAfterMs: number | null;
  diagnostic: string | null;
};

export function attemptStatement(database: CatalogueStore, attempt: AttemptInput): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `INSERT OR IGNORE INTO source_fetch_attempts (
        id, ingestion_run_id, request_id, attempt_number, requested_at,
        completed_at, outcome, http_status, response_headers_json,
        retry_after_ms, diagnostic
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      attempt.id,
      attempt.runId,
      attempt.requestId,
      attempt.attemptNumber,
      attempt.requestedAt,
      attempt.completedAt,
      attempt.outcome,
      attempt.status,
      canonicalJson(attempt.headers),
      attempt.retryAfterMs,
      attempt.diagnostic,
    );
}

export function sourceSnapshotStatement(database: CatalogueStore, snapshotId: string): D1PreparedStatement {
  return repositoryStatements(database).prepare("SELECT * FROM source_snapshots WHERE id = ?").bind(snapshotId);
}

export function sourceObservationSetStatement(database: CatalogueStore, observationSetId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT * FROM source_observation_sets WHERE id = ?")
    .bind(observationSetId);
}
