// Retained-evidence row and policy shapes shared by the Source Snapshot
// repository and the owner's collection inspection. This module is a leaf:
// it declares types only and imports nothing, so `collection-inspection`
// can read these shapes without importing the repository that in turn
// calls the inspection. `source-evidence-repository` re-exports them.

export type SnapshotRow = {
  id: string;
  ingestion_run_id: string;
  request_id: string;
  fetch_attempt_id: string;
  request_method: string;
  request_url: string;
  request_headers_json: string;
  representation_fingerprint: string;
  response_vary_json: string;
  retrieved_at: string;
  http_status: number;
  response_headers_json: string;
  media_type: string | null;
  content_digest: string;
  content_byte_length: number;
  content_object_key: string;
  source_lineage: string;
  supported_game: string;
  game_profile_version: string;
  adapter_version: string;
  reused_source_snapshot_id: string | null;
};

export type ObservationSetRow = {
  id: string;
  source_snapshot_id: string;
  source_lineage: string;
  supported_game: string;
  game_profile_version: string;
  adapter_version: string;
  parsed_at: string;
  content_digest: string;
  content_byte_length: number;
  content_object_key: string;
  observation_count: number;
};

// The effective capacity policy of one Ingestion Run: the newest capacity
// extension when the owner has extended it, otherwise the Source Adapter
// Version's registered capacity. Both remain constrained by the global
// emergency ceiling.
export type RunCapacityPolicy = Readonly<{
  request_capacity: number;
  capacity_generation: number;
}>;

export type CurrentPause = Readonly<{
  reason: string;
  paused_at: string;
  document: Record<string, unknown>;
}>;
