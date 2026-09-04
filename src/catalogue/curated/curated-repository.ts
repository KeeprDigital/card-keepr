import type { SupportedGame } from "../shared";

export type CuratedRevisionRow = {
  id: string;
  game: SupportedGame;
  target_key: string;
  proposal_json: string;
  content_digest: string;
  schema_binding_json: string;
  author: string;
  created_at: string;
  status: string;
  event_version: number;
  reviewed_source_digest: string;
};

export function curatedRevisionStatement(database: D1Database, revisionId: string): D1PreparedStatement {
  return database.prepare("SELECT * FROM curated_revisions WHERE id = ?").bind(revisionId);
}

export type CuratedLifecycleMutationInput = {
  revisionId: string;
  expectedEventVersion: number;
  status: "active" | "reconfirmation_required" | "superseded" | "retired";
  eventVersion: number;
  kind: "reaffirmed" | "retired";
  eventJson: string;
  observedAt: string;
  idempotencyKey: string;
  requestDigest: string;
  responseJson: string;
};

export function curatedLifecycleMutationStatements(
  database: D1Database,
  input: CuratedLifecycleMutationInput,
): D1PreparedStatement[] {
  return [
    database
      .prepare(
        "UPDATE curated_revisions SET status = ?, event_version = ? WHERE id = ? AND event_version = ? AND status IN ('active', 'reconfirmation_required')",
      )
      .bind(input.status, input.eventVersion, input.revisionId, input.expectedEventVersion),
    database
      .prepare(
        `INSERT INTO curated_revision_events (revision_id, event_version, kind, event_json, created_at, author)
         VALUES (?, ?, ?, ?, ?, 'owner')`,
      )
      .bind(input.revisionId, input.eventVersion, input.kind, input.eventJson, input.observedAt),
    database
      .prepare(
        `INSERT INTO curated_revision_idempotency (idempotency_key, request_digest, response_json, response_status, created_at)
         VALUES (?, ?, ?, 200, ?)`,
      )
      .bind(input.idempotencyKey, input.requestDigest, input.responseJson, input.observedAt),
  ];
}
