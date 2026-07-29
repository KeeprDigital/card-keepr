import { sha256 } from "./serialization";
import { parseReconciliationObservation } from "./reconciliation-model";
import type { SupportedGame } from "./fixture";

type EvidenceRow = {
  observation_set_id: string;
  source_snapshot_id: string;
  source_lineage: string;
  supported_game: string;
  game_profile_version: string;
  adapter_version: string;
  content_digest: string;
  content_byte_length: number;
  content_object_key: string;
};

export async function retainedReconciliationObservation(
  database: D1Database,
  evidenceObjects: R2Bucket,
  runId: string,
) {
  const rows = await database
    .prepare(
      `SELECT
        observations.id AS observation_set_id,
        observations.source_snapshot_id,
        observations.source_lineage,
        observations.supported_game,
        observations.game_profile_version,
        observations.adapter_version,
        observations.content_digest,
        observations.content_byte_length,
        observations.content_object_key
      FROM source_observation_sets AS observations
      JOIN source_snapshots AS snapshots
        ON snapshots.id = observations.source_snapshot_id
      JOIN ingestion_evidence_plans AS plan
        ON plan.ingestion_run_id = snapshots.ingestion_run_id
      WHERE snapshots.ingestion_run_id = ?
        AND observations.source_lineage = plan.source_lineage
        AND observations.supported_game = plan.supported_game
        AND observations.game_profile_version = plan.game_profile_version
        AND observations.adapter_version = plan.adapter_version
      ORDER BY observations.id`,
    )
    .bind(runId)
    .all<EvidenceRow>();
  if (rows.results.length !== 1) {
    throw new Error(
      "Reconciliation requires exactly one provenance-validated Source Observation Set.",
    );
  }
  const row = rows.results[0]!;
  const object = await evidenceObjects.get(row.content_object_key);
  if (object === null || object.size !== row.content_byte_length) {
    throw new Error("Retained Source Observation Set bytes are unavailable.");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256(bytes)) !== row.content_digest) {
    throw new Error("Retained Source Observation Set digest is invalid.");
  }
  const document: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (
    !isRecord(document) ||
    document.contract !== "card-keepr-source-observations@1" ||
    document.id !== row.observation_set_id ||
    document.source_snapshot_id !== row.source_snapshot_id ||
    document.source_lineage !== row.source_lineage ||
    document.supported_game !== row.supported_game ||
    document.game_profile_version !== row.game_profile_version ||
    document.adapter_version !== row.adapter_version ||
    !Array.isArray(document.observations) ||
    document.observations.length === 0
  ) {
    throw new Error("Retained Source Observation Set provenance is invalid.");
  }
  return {
    observationSetId: row.observation_set_id,
    sourceSnapshotId: row.source_snapshot_id,
    sourceLineage: row.source_lineage,
    supportedGame: supportedGame(row.supported_game),
    observations: document.observations.map((wrapped) => {
      if (!isRecord(wrapped) || typeof wrapped.id !== "string") {
        throw new Error("Retained Source Observation identity is invalid.");
      }
      return parseReconciliationObservation(wrapped.id, wrapped.value);
    }),
  };
}

function supportedGame(value: string): SupportedGame {
  if (
    value !== "one-piece" &&
    value !== "fusion-world" &&
    value !== "digimon" &&
    value !== "gundam"
  ) {
    throw new Error("Retained Source Observation Set game is unsupported.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
