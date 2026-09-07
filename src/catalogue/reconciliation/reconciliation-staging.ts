import { type CatalogueStore, canonicalJson, chunkedPayloadMarker } from "../shared";
import type { CanonicalRecordSource } from "./reconciliation-canonical-digest";
import type { ObservationPlan } from "./reconciliation-plan-state";
import { prepareCandidateBatch } from "./reconciliation-preparation";
import { prepareCandidatePayload } from "./reconciliation-payload-preparation";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import {
  candidatePlansStatement,
  createReconciliationContextStatement,
  evidencePartitionsStatement,
} from "./reconciliation-state-repository";

export type EvidencePartitionInput = {
  sequenceNumber: number;
  requestId: string;
  observationSetId: string;
  sourceSnapshotId: string;
  sourceLineage: string;
  supportedGame: string;
  gameProfileVersion: string;
  adapterVersion: string;
};
type Cursor = {
  stage: "context" | "evidence" | "candidate" | "digest" | "plans" | "complete";
  after: string;
  ordinal: number;
};

/** Stage bounded effects with exact receipts before the candidate's final visibility change. */
export async function stageCandidatePreparation(
  database: CatalogueStore,
  input: {
    runId: string;
    candidate: Record<string, unknown>;
    digestPayload: Record<string, unknown>;
    plans: AsyncIterable<ObservationPlan>;
    partitions: AsyncIterable<EvidencePartitionInput>;
    yieldAtCheckpoint?: boolean;
  },
): Promise<number> {
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, input.runId, "candidate_staging");
  const cursor: Cursor = checkpoint?.value ?? { stage: "context", after: "", ordinal: 0 };
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  const save = async () => {
    await retainReconciliationCheckpoint(database, input.runId, "candidate_staging", ordinal, cursor);
    if (input.yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "candidate_staging", ordinal });
    ordinal++;
  };
  if (cursor.stage === "context") {
    const marker = chunkedPayloadMarker("digest");
    await prepareCandidateBatch(database, input.runId, cursor.ordinal++, "context", marker, () => [
      createReconciliationContextStatement(database, { runId: input.runId, digestPayload: marker }),
    ]);
    cursor.stage = "evidence";
    await save();
  }
  const stageRecords = async <T>(
    source: AsyncIterable<T>,
    project: (value: T) => unknown,
    statement: (content: string) => D1PreparedStatement,
  ) => {
    if (!("canonicalEntries" in source)) throw new Error("Candidate staging requires a resumable record source.");
    let records: string[] = [],
      bytes = 2;
    const flush = async () => {
      if (!records.length) return;
      const content = `[${records.join(",")}]`;
      await prepareCandidateBatch(database, input.runId, cursor.ordinal++, cursor.stage, content, () => [
        statement(content),
      ]);
      records = [];
      bytes = 2;
      await save();
    };
    for await (const entry of (source as CanonicalRecordSource<T>).canonicalEntries(cursor.after)) {
      const content = canonicalJson(project(entry.value));
      const length = new TextEncoder().encode(content).byteLength;
      if (length + 2 > 524288)
        throw new Error("reconciliation_capacity_exceeded: one preparation record exceeds 512 KiB.");
      if (records.length && bytes + length + 1 > 524288) await flush();
      bytes += length + (records.length ? 1 : 0);
      records.push(content);
      cursor.after = entry.key;
      if (records.length === 4) await flush();
    }
    await flush();
    cursor.after = "";
  };
  if (cursor.stage === "evidence") {
    await stageRecords(input.partitions, evidencePartitionRow, (content) =>
      evidencePartitionsStatement(database, { runId: input.runId, partitionsJson: content }),
    );
    cursor.stage = "candidate";
    await save();
  }
  for (const kind of ["candidate", "digest"] as const) {
    if (cursor.stage !== kind) continue;
    cursor.ordinal += await prepareCandidatePayload(
      database,
      input.runId,
      kind,
      kind === "candidate" ? input.candidate : input.digestPayload,
      cursor.ordinal,
      input.yieldAtCheckpoint ?? false,
    );
    cursor.stage = kind === "candidate" ? "digest" : "plans";
    await save();
  }
  if (cursor.stage === "plans") {
    await stageRecords(input.plans, candidatePlanRow, (content) =>
      candidatePlansStatement(database, {
        runId: input.runId,
        plansJson: content,
        warningsJson: canonicalJson({ reconciliation_warning_partitions: true }),
      }),
    );
    cursor.stage = "complete";
    await save();
  }
  return cursor.ordinal;
}

function candidatePlanRow(plan: ObservationPlan) {
  return {
    observation_set_id: plan.sourceObservationSetId,
    snapshot_id: plan.sourceSnapshotId,
    observation_id: plan.sourceObservationId,
    source_lineage: plan.sourceLineage,
    observation_kind: plan.observationKind,
    card_id: plan.cardId,
    printing_id: plan.printingId,
    locator: plan.locator,
    variant_key: plan.variantKey,
    compatibility_json: plan.compatibility === null ? null : canonicalJson(plan.compatibility),
    memberships_json: canonicalJson(plan.memberships),
    withdrawal_json: plan.withdrawal === null ? null : canonicalJson(plan.withdrawal),
    source_card_facts_json: plan.sourceCardFactsJson,
  };
}
function evidencePartitionRow(partition: EvidencePartitionInput) {
  return {
    sequence_number: partition.sequenceNumber,
    request_id: partition.requestId,
    observation_set_id: partition.observationSetId,
    snapshot_id: partition.sourceSnapshotId,
    source_lineage: partition.sourceLineage,
    supported_game: partition.supportedGame,
    profile_version: partition.gameProfileVersion,
    adapter_version: partition.adapterVersion,
  };
}
