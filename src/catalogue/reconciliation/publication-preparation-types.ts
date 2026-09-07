import type { StreamingSha256State } from "../shared";
export type PreparationState = {
  candidate_id: string;
  manifest_digest: string;
  generation: number;
  sequence: number;
  state: "preparing" | "verified" | "retry_paused" | "failed";
  phase: "images" | "exports" | "projections" | "composition";
  cursor_json: string;
  failures: number;
  failure_code: string | null;
  artifact_count: number;
  root_digest: string | null;
  created_at: string;
};
export type PreparationCursor = {
  partition: number;
  record: number;
  text: number;
  chunk: number;
  chain: string;
  search_offset?: number;
  search_ordinal?: number;
  text_hash?: StreamingSha256State;
  text_bytes?: number;
  level: number;
  after: number;
  node: number;
};
export type ArtifactReference = {
  ordinal: number;
  object_key: string;
  sha256: string;
  byte_length: number;
  kind?: string;
};
export type PublicationPreparationIntent = {
  manifest_digest: string;
  generation: number;
  sequence: number;
  idempotency_key: string;
  resume?: boolean;
};
export class PublicationIntegrityError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
