import { correctionDecisionPinMetadata } from "./identity-correction-pins";
import { entityAdmissionPinMetadata } from "./entity-admission-pins";
import { retainPartitionedRecord } from "./reconciliation-text";
import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import type { CanonicalRecordSource } from "./reconciliation-canonical-digest";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { documentStorage } from "./reconciliation-document";
import {
  insertReconciliationPartitionStatement,
  reconciliationPartitionStatement,
  reconciliationOperationHeaderStatement,
} from "./reconciliation-progress-repository";

type Cursor = { kind: number; after: string; ordinal: number; digest: string; complete: boolean };

/** Each output receipt and its source cursor are retained before returning to the scheduler. */
export async function persistCandidatePartitions(
  database: CatalogueStore,
  runId: string,
  candidate: Record<string, unknown>,
  warnings: Iterable<unknown> | AsyncIterable<unknown> = [],
  yieldAtCheckpoint = false,
) {
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "candidate_partitions");
  const cursor: Cursor = checkpoint?.value ?? {
    kind: 0,
    after: "",
    ordinal: 0,
    digest: await initialManifestDigest(database, runId),
    complete: false,
  };
  if (cursor.complete) return { digest: cursor.digest, count: cursor.ordinal };
  let checkpointOrdinal = (checkpoint?.ordinal ?? -1) + 1;
  const save = async () => {
    await retainReconciliationCheckpoint(database, runId, "candidate_partitions", checkpointOrdinal, cursor);
    if (yieldAtCheckpoint)
      throw new ReconciliationContinuation({ phase: "candidate_partitions", ordinal: checkpointOrdinal });
    checkpointOrdinal++;
  };
  const collections = Object.entries({ ...candidate, warnings }).filter(
    ([, records]) =>
      Array.isArray(records) || (records !== null && typeof records === "object" && Symbol.asyncIterator in records),
  );
  while (cursor.kind < collections.length) {
    const [kind, records] = collections[cursor.kind]!;
    let parts: string[] = [],
      bytes = 2,
      workBytes = 0;
    const flush = async () => {
      if (!parts.length) return;
      const content = `[${parts.join(",")}]`;
      const sha256 = await sha256Text(content);
      await documentStorage(() =>
        insertReconciliationPartitionStatement(database, {
          runId,
          ordinal: cursor.ordinal,
          kind,
          content,
          sha256,
          bytes,
          records: parts.length,
        }).run(),
      );
      const retained = await documentStorage(() =>
        reconciliationPartitionStatement(database, runId, cursor.ordinal).first<{ kind: string; content: string }>(),
      );
      if (retained?.kind !== kind || retained.content !== content)
        throw new Error("Reconciliation partition replay differs from its immutable content.");
      cursor.digest = await sha256Text(
        canonicalJson({ previous: cursor.digest, ordinal: cursor.ordinal, kind, sha256, bytes, records: parts.length }),
      );
      cursor.ordinal++;
      parts = [];
      bytes = 2;
      workBytes = 0;
      await save();
    };
    for await (const entry of partitionRecords(records, cursor.after)) {
      const encoded = canonicalJson(await retainPartitionedRecord(database, runId, entry.value));
      const length = new TextEncoder().encode(encoded).byteLength;
      if (length + 2 > 524288)
        throw new Error("reconciliation_capacity_exceeded: one metadata record exceeds 512 KiB.");
      if (parts.length && bytes + length + 1 > 524288) await flush();
      bytes += length + (parts.length ? 1 : 0);
      workBytes += new TextEncoder().encode(canonicalJson(entry.value)).byteLength;
      parts.push(encoded);
      cursor.after = entry.key;
      if (parts.length === 4 || workBytes >= 512000) await flush();
    }
    await flush();
    cursor.kind++;
    cursor.after = "";
    await save();
  }
  cursor.complete = true;
  await save();
  return { digest: cursor.digest, count: cursor.ordinal };
}

async function* partitionRecords(records: unknown, after: string) {
  if (Array.isArray(records)) {
    for (let index = after ? Number(after) : 0; index < records.length; index++)
      yield { key: String(index + 1), value: records[index] };
  } else {
    if (!records || typeof records !== "object" || !("canonicalEntries" in records))
      throw new Error("Candidate partition preparation requires a resumable record source.");
    yield* (records as CanonicalRecordSource<unknown>).canonicalEntries(after);
  }
}

async function initialManifestDigest(database: CatalogueStore, runId: string): Promise<string> {
  const pins = await documentStorage(() =>
    reconciliationOperationHeaderStatement(database, runId).first<{
      definition_pins_json: string;
      input_manifest_digest: string;
      observation_cutoff: number;
      identity_decision_cutoff: number;
      authority_decision_cutoff: number;
      created_at: string;
      deadline: string;
    }>(),
  );
  if (!pins) throw new Error("Reconciliation pins are unavailable.");
  return sha256Text(
    canonicalJson({
      contract: "card-keepr-sealed-candidate-manifest@1",
      run_id: runId,
      definitions: pins.definition_pins_json,
      input_manifest: pins.input_manifest_digest,
      admissions: await entityAdmissionPinMetadata(database, runId),
      corrections: await correctionDecisionPinMetadata(database, runId),
      observations: pins.observation_cutoff,
      identities: pins.identity_decision_cutoff,
      authorities: pins.authority_decision_cutoff,
      created_at: pins.created_at,
      deadline: pins.deadline,
    }),
  );
}
