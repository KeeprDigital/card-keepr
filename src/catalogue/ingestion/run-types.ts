import type { SourceFreshnessStorageRow } from "../read";

export const sevenDaysInMilliseconds = 7 * 24 * 60 * 60 * 1_000;

export const publicationLeaseMilliseconds = 5 * 60 * 1_000;

export const maximumPublicationCandidateBytes = 16 * 1024 * 1024;

export const maximumPublicationEntityBytes = 384 * 1024;

export const maximumPublicationSearchMaterializationBytes = 24 * 1024 * 1024;

export const maximumPublicationExportBytes = 32 * 1024 * 1024;

export type RunRow = {
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

export type CatalogueStateRow = {
  current_revision_id: string;
  published_at: string;
};

export type OperationStateRow = {
  active_ingestion_run_id: string | null;
  active_production_release_id: string | null;
  active_production_release_expires_at: string | null;
  active_recovery_id: string | null;
  recovery_health: string;
};

export type IdempotencyRow = {
  operation: string;
  request_json: string;
  response_json: string;
  http_status: number;
  outcome: "success" | "problem";
};

export type FreshnessRow = SourceFreshnessStorageRow & {
  ingestion_run_id: string;
};

export type PublicationCleanupRow = {
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

export type IdempotencyContext = {
  key: string;
  operation: string;
  requestJson: string;
  observedAt: string;
};

export type IdempotencyClaimRow = {
  operation: string;
  request_json: string;
  claimed_at: string;
  owner_token: string;
  claim_version: number;
  claim_expires_at: string;
};

export type IdempotencyClaimOwner = {
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
