import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { boundedAsyncRecordArrays } from "./reconciliation-preparation";
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
async function storage<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (cause) {
    throw new ReconciliationInputStorageError(cause);
  }
}

/** Inputs become reusable only after all verification and partition writes complete. */
export async function retainVerifiedReconciliationInput(
  database: CatalogueStore,
  runId: string,
  input: Record<string, unknown>,
) {
  let ordinal = 0;
  let digest = await sha256Text(canonicalJson({ contract: "card-keepr-reconciliation-input@1", run_id: runId }));
  const metadata = Object.fromEntries(Object.entries(input).filter(([, value]) => !recordSequence(value)));
  const groups: [string, Iterable<unknown> | AsyncIterable<unknown>][] = [
    ["$metadata", [{ values: metadata, array_keys: Object.keys(input).filter((key) => recordSequence(input[key])) }]],
  ];
  for (const [kind, value] of Object.entries(input)) if (recordSequence(value)) groups.push([kind, value]);
  for (const [kind, records] of groups) {
    const partitioned = async function* () {
      for await (const record of records)
        yield await retainPartitionedRecord(database, runId, JSON.parse(JSON.stringify(record)));
    };
    for await (const content of boundedAsyncRecordArrays(partitioned())) {
      const sha256 = await sha256Text(content);
      await storage(insertReconciliationInputPartitionStatement(database, runId, ordinal, kind, content, sha256).run());
      const retained = await storage(
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
    }
  }
  await storage(sealReconciliationInputStatement(database, runId, digest, ordinal).run());
}

/** Verify the manifest without rebuilding any retained record collection. */
export async function readVerifiedReconciliationInput(
  database: CatalogueStore,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const manifest = await storage(
    reconciliationInputManifestStatement(database, runId).first<{ input_manifest_digest: string | null }>(),
  );
  if (!manifest?.input_manifest_digest) return null;
  let digest = await sha256Text(canonicalJson({ contract: "card-keepr-reconciliation-input@1", run_id: runId }));
  const result: Record<string, unknown> = {};
  for (let ordinal = 0; ; ordinal++) {
    const partition = await storage(
      reconciliationInputPartitionStatement(database, runId, ordinal).first<{
        kind: string;
        content: string;
        sha256: string;
      }>(),
    );
    if (!partition) break;
    if ((await sha256Text(partition.content)) !== partition.sha256)
      throw new Error("Retained reconciliation input partition failed integrity verification.");
    for (const record of JSON.parse(partition.content)) {
      // Verify every retained text reference before exposing the stream, retaining only one restored record.
      const restored = await restorePartitionedRecord(database, runId, record);
      if (partition.kind !== "$metadata") continue;
      const metadata = restored as { values: Record<string, unknown>; array_keys: string[] };
      Object.assign(result, metadata.values);
      for (const kind of metadata.array_keys)
        result[kind] = {
          [Symbol.asyncIterator]: () => verifiedReconciliationRecords(database, runId, kind),
        };
    }
    digest = await sha256Text(
      canonicalJson({ previous: digest, ordinal, kind: partition.kind, sha256: partition.sha256 }),
    );
  }
  if (digest !== manifest.input_manifest_digest)
    throw new Error("Retained reconciliation input manifest failed verification.");
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
    const partition = await storage(
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
