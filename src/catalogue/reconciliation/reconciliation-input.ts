import { normalizedObservationPageStatement } from "./reconciliation-normalized-repository";
import { ReconciliationInputSequence } from "./reconciliation-input-sequence";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { boundedAsyncRecordArrays, boundedRecordArrays } from "./reconciliation-preparation";
import { retainPartitionedRecord, restorePartitionedRecord } from "./reconciliation-text";
import {
  insertReconciliationInputPartitionStatement,
  reconciliationInputManifestStatement,
  reconciliationInputPartitionStatement,
  sealReconciliationInputStatement,
  nextReconciliationInputKindStatement,
} from "./reconciliation-input-repository";

export class ReconciliationInputStorageError extends Error {
  constructor(cause: unknown) {
    super("Reconciliation input storage is temporarily unavailable.", { cause });
    this.name = "ReconciliationInputStorageError";
  }
}
async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new ReconciliationInputStorageError(cause);
  }
}

type PreparationCursor = {
  kindIndex: number;
  partitionCount: number;
  digest: string;
  afterObservationId: string;
  preparedObservations: number;
  afterMetadataRecord: string | null;
  completedMetadataScans: number;
  complete: boolean;
};

/** Reuse immutable normalized envelopes and retain the next exact preparation cursor. */
export async function retainVerifiedReconciliationInput(
  database: CatalogueStore,
  runId: string,
  input: Record<string, unknown>,
  yieldAtCheckpoint = false,
) {
  const checkpoint = await reconciliationCheckpoint<PreparationCursor>(database, runId, "input_preparation");
  let ordinal = checkpoint?.value.partitionCount ?? 0;
  let digest =
    checkpoint?.value.digest ??
    (await sha256Text(canonicalJson({ contract: "card-keepr-reconciliation-input@1", run_id: runId })));
  let checkpointOrdinal = (checkpoint?.ordinal ?? -1) + 1;
  let afterObservationId = checkpoint?.value.afterObservationId ?? "";
  let preparedObservations = checkpoint?.value.preparedObservations ?? 0;
  let afterMetadataRecord = checkpoint?.value.afterMetadataRecord ?? null;
  let completedMetadataScans = checkpoint?.value.completedMetadataScans ?? 0;
  const metadata = Object.fromEntries(Object.entries(input).filter(([, value]) => !recordSequence(value)));
  const groups: [string, Iterable<unknown> | AsyncIterable<unknown>][] = [
    ["$metadata", [{ values: metadata, array_keys: Object.keys(input).filter((key) => recordSequence(input[key])) }]],
  ];
  for (const [kind, value] of Object.entries(input)) if (recordSequence(value)) groups.push([kind, value]);
  const save = async (kindIndex: number, complete = false) => {
    const cursor: PreparationCursor = {
      kindIndex,
      partitionCount: ordinal,
      digest,
      afterObservationId,
      preparedObservations,
      afterMetadataRecord,
      completedMetadataScans,
      complete,
    };
    await retainReconciliationCheckpoint(database, runId, "input_preparation", checkpointOrdinal, cursor);
    if (yieldAtCheckpoint)
      throw new ReconciliationContinuation({ phase: "input_preparation", ordinal: checkpointOrdinal });
    checkpointOrdinal++;
  };
  const retain = async (kind: string, content: string) => {
    const sha256 = await sha256Text(content);
    await storage(() =>
      insertReconciliationInputPartitionStatement(database, runId, ordinal, kind, content, sha256).run(),
    );
    const retained = await storage(() =>
      reconciliationInputPartitionStatement(database, runId, ordinal).first<{
        kind: string;
        content: string;
        sha256: string;
      }>(),
    );
    if (retained?.kind !== kind || retained.content !== content || retained.sha256 !== sha256)
      throw new Error("Reconciliation input replay changed its immutable content.");
    digest = await sha256Text(canonicalJson({ previous: digest, ordinal, kind, sha256 }));
    ordinal++;
  };
  for (let kindIndex = checkpoint?.value.kindIndex ?? 0; kindIndex < groups.length; kindIndex++) {
    const [kind, records] = groups[kindIndex]!;
    if (kind === "observations") {
      for (;;) {
        const page = await storage(() =>
          normalizedObservationPageStatement(database, runId, afterObservationId).all<{
            observation_id: string;
            content: string;
            sha256: string;
          }>(),
        );
        if (!page.results.length) break;
        for (const row of page.results)
          if ((await sha256Text(row.content)) !== row.sha256)
            throw new Error("Normalized observation failed integrity verification.");
        await retain(kind, `[${page.results.map((row) => row.content).join(",")}]`);
        afterObservationId = page.results.at(-1)!.observation_id;
        preparedObservations += page.results.length;
        await save(kindIndex);
      }
    } else if (records instanceof ReconciliationInputSequence) {
      let scanned = 0;
      let pending: unknown[] = [];
      const flush = async () => {
        for (const content of boundedRecordArrays(pending)) await retain(kind, content);
        pending = [];
      };
      for await (const entry of records.scan(afterMetadataRecord)) {
        for (const record of entry.records)
          pending.push(await retainPartitionedRecord(database, runId, JSON.parse(JSON.stringify(record))));
        afterMetadataRecord = entry.cursor;
        completedMetadataScans++;
        if (++scanned === 8) {
          await flush();
          await save(kindIndex);
          scanned = 0;
        }
      }
      await flush();
      afterMetadataRecord = null;
    } else {
      const partitioned = async function* () {
        for await (const record of records)
          yield await retainPartitionedRecord(database, runId, JSON.parse(JSON.stringify(record)));
      };
      for await (const content of boundedAsyncRecordArrays(partitioned())) await retain(kind, content);
    }
    await save(kindIndex + 1);
  }
  await storage(() => sealReconciliationInputStatement(database, runId, digest, ordinal).run());
  await save(groups.length, true);
}

type InputMetadata = { values: Record<string, unknown>; array_keys: string[] };
type VerificationCursor = {
  manifestDigest: string;
  digest: string;
  nextPartition: number;
  nextRecord: number;
  metadata: InputMetadata | null;
  complete: boolean;
  verifiedObservations: number;
};

/** Verification returns after bounded groups and resumes against the exact immutable manifest. */
export async function readVerifiedReconciliationInput(
  database: CatalogueStore,
  runId: string,
  yieldAtCheckpoint = false,
): Promise<Record<string, unknown> | null> {
  const manifest = await storage(() =>
    reconciliationInputManifestStatement(database, runId).first<{ input_manifest_digest: string | null }>(),
  );
  if (!manifest?.input_manifest_digest) return null;
  const checkpoint = yieldAtCheckpoint
    ? await reconciliationCheckpoint<VerificationCursor>(database, runId, "input_verification")
    : null;
  if (checkpoint && checkpoint.value.manifestDigest !== manifest.input_manifest_digest)
    throw new Error("Retained reconciliation input manifest changed during verification.");
  let digest =
    checkpoint?.value.digest ??
    (await sha256Text(canonicalJson({ contract: "card-keepr-reconciliation-input@1", run_id: runId })));
  let metadata = checkpoint?.value.metadata ?? null;
  let verifiedObservations = checkpoint?.value.verifiedObservations ?? 0;
  let ordinal = checkpoint?.value.nextPartition ?? 0;
  const save = async (nextPartition: number, nextRecord: number, complete: boolean) => {
    const cursor: VerificationCursor = {
      manifestDigest: manifest.input_manifest_digest!,
      digest,
      nextPartition,
      nextRecord,
      metadata,
      complete,
      verifiedObservations,
    };
    const checkpointOrdinal = (checkpoint?.ordinal ?? -1) + 1;
    await retainReconciliationCheckpoint(database, runId, "input_verification", checkpointOrdinal, cursor);
    throw new ReconciliationContinuation({ phase: "input_verification", ordinal: checkpointOrdinal });
  };
  if (!checkpoint?.value.complete) {
    for (; ; ordinal++) {
      const partition = await storage(() =>
        reconciliationInputPartitionStatement(database, runId, ordinal).first<{
          kind: string;
          content: string;
          sha256: string;
        }>(),
      );
      if (!partition) break;
      if ((await sha256Text(partition.content)) !== partition.sha256)
        throw new Error("Retained reconciliation input partition failed integrity verification.");
      const records = JSON.parse(partition.content) as (Parameters<typeof restorePartitionedRecord>[2] | null)[];
      let processed = 0;
      let bytes = 0;
      const start = ordinal === checkpoint?.value.nextPartition ? checkpoint.value.nextRecord : 0;
      for (let index = start; index < records.length; index++) {
        const record = records[index]!;
        const size =
          new TextEncoder().encode(canonicalJson(record)).byteLength +
          record.text_parts.reduce((sum, part) => sum + part.byte_length, 0);
        if (yieldAtCheckpoint && processed > 0 && (processed === 8 || bytes + size > 512000))
          await save(ordinal, index, false);
        const restored = await restorePartitionedRecord(database, runId, record);
        if (partition.kind === "$metadata") metadata = restored as InputMetadata;
        if (partition.kind === "observations") verifiedObservations++;
        records[index] = null;
        processed++;
        bytes += size;
      }
      digest = await sha256Text(
        canonicalJson({ previous: digest, ordinal, kind: partition.kind, sha256: partition.sha256 }),
      );
      if (yieldAtCheckpoint) await save(ordinal + 1, 0, false);
    }
    if (digest !== manifest.input_manifest_digest)
      throw new Error("Retained reconciliation input manifest failed verification.");
    if (yieldAtCheckpoint) await save(ordinal, 0, true);
  }
  if (!metadata) throw new Error("Retained reconciliation input metadata is unavailable.");
  const result = { ...metadata.values };
  for (const kind of metadata.array_keys)
    result[kind] = { [Symbol.asyncIterator]: () => verifiedReconciliationRecords(database, runId, kind) };
  return result;
}

/** Re-open the immutable verified sequence without retaining the complete observation array. */
export async function* verifiedReconciliationRecords<T>(
  database: CatalogueStore,
  runId: string,
  kind: string,
): AsyncGenerator<T> {
  let after = -1;
  for (;;) {
    const partition = await storage(() =>
      nextReconciliationInputKindStatement(database, runId, kind, after).first<{
        ordinal: number;
        content: string;
        sha256: string;
      }>(),
    );
    if (!partition) return;
    if ((await sha256Text(partition.content)) !== partition.sha256)
      throw new Error("Retained observation partition failed integrity verification.");
    for (const record of JSON.parse(partition.content))
      yield (await restorePartitionedRecord(database, runId, record)) as T;
    after = partition.ordinal;
  }
}

function recordSequence(value: unknown): value is Iterable<unknown> | AsyncIterable<unknown> {
  return (
    Array.isArray(value) ||
    (value !== null &&
      typeof value === "object" &&
      typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function")
  );
}
