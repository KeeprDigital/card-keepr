export type PlannedRequestRow = {
  request_id: string;
  sequence_number: number;
  method: string;
  url: string;
  request_headers_json: string;
  representation_fingerprint: string;
  request_role: "surface" | "listing" | "detail" | "product_detail" | "image";
  discovered_from_request_id: string | null;
  state: string;
  source_snapshot_id: string | null;
  failure_code: string | null;
};

export type EvidenceRow = {
  request_id: string;
  observation_set_id: string;
  source_snapshot_id: string;
  retrieved_at: string;
  source_lineage: string;
  supported_game: string;
  game_profile_version: string;
  adapter_version: string;
  content_digest: string;
  snapshot_content_digest: string;
  content_byte_length: number;
  content_object_key: string;
  observation_count: number;
  plan_origin: string;
  snapshot_request_method: string;
  snapshot_request_url: string;
  snapshot_request_headers_json: string;
  snapshot_representation_fingerprint: string;
};

export type EvidenceSelection = { request: PlannedRequestRow; row: EvidenceRow | null };

export type PrintingImageSnapshotRow = {
  request_url: string;
  media_type: string | null;
  content_digest: string;
  content_byte_length: number;
  content_object_key: string;
};

export type CollectionPlanRow = {
  source_lineage: string;
  discovery_observation_set_id: string;
  contract: string;
  content_digest: string;
};

export type EvidencePlanRow = {
  request_plan_json: string;
};

export type DiscoveryRequestPlanRow = {
  ingestion_run_id: string;
  request_id: string;
  sequence_number: number;
  parent_request_id: string;
  method: "GET";
  url: string;
  request_headers_json: string;
  representation_fingerprint: string;
  request_role: Exclude<PlannedRequestRow["request_role"], "surface">;
};
