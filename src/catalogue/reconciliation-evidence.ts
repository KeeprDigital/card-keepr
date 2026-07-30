import { sha256 } from "./serialization";
import { parseReconciliationObservation } from "./reconciliation-model";
import type { SupportedGame } from "./fixture";
import { requiredSourceAdapter } from "./source-adapters";

type PlannedRequestRow = {
  request_id: string;
  sequence_number: number;
  state: string;
  source_snapshot_id: string | null;
};

type EvidenceRow = {
  request_id: string;
  observation_set_id: string;
  source_snapshot_id: string;
  source_lineage: string;
  supported_game: string;
  game_profile_version: string;
  adapter_version: string;
  content_digest: string;
  content_byte_length: number;
  content_object_key: string;
  observation_count: number;
  plan_source_lineage: string;
  plan_supported_game: string;
  plan_game_profile_version: string;
  plan_adapter_version: string;
  plan_origin: string;
};

export async function retainedReconciliationObservation(
  database: D1Database,
  evidenceObjects: R2Bucket,
  runId: string,
) {
  const [requests, observations] = await Promise.all([
    database
      .prepare(
        `SELECT request_id, sequence_number, state, source_snapshot_id
         FROM source_requests
         WHERE ingestion_run_id = ?
         ORDER BY sequence_number, request_id`,
      )
      .bind(runId)
      .all<PlannedRequestRow>(),
    database
      .prepare(
        `SELECT
          snapshots.request_id,
          observations.id AS observation_set_id,
          observations.source_snapshot_id,
          observations.source_lineage,
          observations.supported_game,
          observations.game_profile_version,
          observations.adapter_version,
          observations.content_digest,
          observations.content_byte_length,
          observations.content_object_key,
          observations.observation_count,
          plan.source_lineage AS plan_source_lineage,
          plan.supported_game AS plan_supported_game,
          plan.game_profile_version AS plan_game_profile_version,
          plan.adapter_version AS plan_adapter_version,
          plan.plan_origin
         FROM source_observation_sets AS observations
         JOIN source_parse_operations AS parse
           ON parse.id = observations.parse_operation_id
         JOIN source_snapshots AS snapshots
           ON snapshots.id = observations.source_snapshot_id
         JOIN ingestion_evidence_plans AS plan
           ON plan.ingestion_run_id = snapshots.ingestion_run_id
         WHERE snapshots.ingestion_run_id = ?
           AND parse.intent = 'collection'
         ORDER BY snapshots.request_id, observations.id`,
      )
      .bind(runId)
      .all<EvidenceRow>(),
  ]);
  if (requests.results.length === 0) {
    throw new Error(
      "Reconciliation requires complete coverage of every planned Source Request.",
    );
  }
  const selectedSnapshots = new Map<string, PlannedRequestRow>();
  for (const request of requests.results) {
    if (request.state !== "observed" || request.source_snapshot_id === null) {
      throw new Error(
        `Planned Source Request ${request.request_id} has no observed Source Snapshot.`,
      );
    }
    if (selectedSnapshots.has(request.source_snapshot_id)) {
      throw new Error(
        "Planned Source Requests selected a duplicate Source Snapshot.",
      );
    }
    selectedSnapshots.set(request.source_snapshot_id, request);
  }
  for (const row of observations.results) {
    if (!selectedSnapshots.has(row.source_snapshot_id)) {
      throw new Error(
        `Unplanned Source Observation Set ${row.observation_set_id} cannot participate in reconciliation.`,
      );
    }
  }
  const rowsBySnapshot = new Map<string, EvidenceRow[]>();
  for (const row of observations.results) {
    rowsBySnapshot.set(row.source_snapshot_id, [
      ...(rowsBySnapshot.get(row.source_snapshot_id) ?? []),
      row,
    ]);
  }
  const orderedRows = requests.results.map((request) => {
    const rows = rowsBySnapshot.get(request.source_snapshot_id!) ?? [];
    if (rows.length !== 1) {
      throw new Error(
        `Planned Source Request ${request.request_id} requires exactly one collection Source Observation Set.`,
      );
    }
    return rows[0]!;
  });
  const first = orderedRows[0]!;
  if (
    orderedRows.some(
      (row) =>
        row.source_lineage !== first.source_lineage ||
        row.supported_game !== first.supported_game ||
        row.game_profile_version !== first.game_profile_version ||
        row.adapter_version !== first.adapter_version ||
        row.source_lineage !== row.plan_source_lineage ||
        row.supported_game !== row.plan_supported_game ||
        row.game_profile_version !== row.plan_game_profile_version ||
        row.adapter_version !== row.plan_adapter_version,
    )
  ) {
    throw new Error(
      "Retained Source Observation Set provenance is inconsistent with its Evidence Plan.",
    );
  }
  const documents = await Promise.all(
    orderedRows.map((row) =>
      retainedObservationDocument(evidenceObjects, row),
    ),
  );
  const observationIds = new Set<string>();
  const merged = documents.flatMap((document, index) => {
    const row = orderedRows[index]!;
    return document.observations
      .map((wrapped) => {
        if (!isRecord(wrapped) || typeof wrapped.id !== "string") {
          throw new Error("Retained Source Observation identity is invalid.");
        }
        if (observationIds.has(wrapped.id)) {
          throw new Error(
            `Duplicate Source Observation ${wrapped.id} spans planned requests.`,
          );
        }
        observationIds.add(wrapped.id);
        return {
          ...parseReconciliationObservation(wrapped.id, wrapped.value),
          sourceObservationSetId: row.observation_set_id,
          sourceSnapshotId: row.source_snapshot_id,
        };
      })
      .sort((left, right) =>
        left.sourceObservationId.localeCompare(right.sourceObservationId),
      );
  });
  return {
    observationSetId: first.observation_set_id,
    sourceSnapshotId: first.source_snapshot_id,
    sourceLineage: first.source_lineage,
    supportedGame: supportedGame(first.supported_game),
    structurallyComplete: true,
    observations: merged,
  };
}

async function retainedObservationDocument(
  evidenceObjects: R2Bucket,
  row: EvidenceRow,
): Promise<{ observations: unknown[] }> {
  const object = await evidenceObjects.get(row.content_object_key);
  if (object === null || object.size !== row.content_byte_length) {
    throw new Error("Retained Source Observation Set bytes are unavailable.");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256(bytes)) !== row.content_digest) {
    throw new Error("Retained Source Observation Set digest is invalid.");
  }
  const document: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const adapter = requiredSourceAdapter(row.adapter_version);
  if (
    !isRecord(document) ||
    document.contract !== "card-keepr-source-observations@1" ||
    document.id !== row.observation_set_id ||
    document.source_snapshot_id !== row.source_snapshot_id ||
    document.source_lineage !== row.source_lineage ||
    document.supported_game !== row.supported_game ||
    document.game_profile_version !== row.game_profile_version ||
    document.adapter_version !== row.adapter_version ||
    adapter.reconciliationCoverage !== "synthetic_fixture" ||
    adapter.origin !== "synthetic_fixture" ||
    row.plan_origin !== "synthetic_fixture" ||
    !isRecord(document.coverage_proof) ||
    document.coverage_proof.kind !== "synthetic_fixture" ||
    document.coverage_proof.adapter_version !== adapter.adapterVersion ||
    document.coverage_proof.parser_contract !== adapter.parserContract ||
    !validEvidenceSummary(
      document.evidence_summary,
      document.observations,
      row.observation_count,
    ) ||
    !Array.isArray(document.observations)
  ) {
    throw new Error("Retained Source Observation Set provenance is invalid.");
  }
  return { observations: document.observations };
}

function validEvidenceSummary(
  value: unknown,
  observations: unknown,
  observationCount: number,
): boolean {
  if (!isRecord(value) || !Array.isArray(observations)) return false;
  return (
    value.structurally_complete === true &&
    value.required_surfaces_complete === true &&
    value.partitions_complete === true &&
    observationCount === observations.length &&
    value.observation_count === observationCount &&
    value.declared_record_count === observationCount &&
    value.parsed_record_count === observationCount
  );
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
