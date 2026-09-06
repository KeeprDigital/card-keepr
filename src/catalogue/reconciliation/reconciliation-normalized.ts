import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { retainPartitionedRecord, restorePartitionedRecord } from "./reconciliation-text";
import {
  retainObservationOriginStatement,
  observationOriginStatement,
  normalizedObservationExistsStatement,
  retainNormalizedObservationStatement,
  normalizedObservationStatement,
  nextNormalizedObservationStatement,
} from "./reconciliation-normalized-repository";

export class ReconciliationNormalizationStorageError extends Error {
  constructor(cause: unknown) {
    super("Reconciliation normalization storage is temporarily unavailable.", { cause });
    this.name = "ReconciliationNormalizationStorageError";
  }
}
async function storage<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (cause) {
    throw new ReconciliationNormalizationStorageError(cause);
  }
}

export async function claimObservationOrigin(
  database: CatalogueStore,
  runId: string,
  id: string,
  setId: string,
  ordinal: number,
) {
  await storage(retainObservationOriginStatement(database, runId, id, setId, ordinal).run());
  const origin = await storage(
    observationOriginStatement(database, runId, id).first<{ observation_set_id: string; source_ordinal: number }>(),
  );
  if (origin?.observation_set_id !== setId || origin.source_ordinal !== ordinal)
    throw new Error(`Duplicate Source Observation ${id} spans planned requests.`);
}

export async function hasNormalizedObservation(database: CatalogueStore, runId: string, id: string) {
  return (await storage(normalizedObservationExistsStatement(database, runId, id).first())) !== null;
}

export async function retainNormalizedObservation(
  database: CatalogueStore,
  runId: string,
  id: string,
  record: unknown,
) {
  const envelope = await retainPartitionedRecord(database, runId, JSON.parse(JSON.stringify(record)));
  const content = canonicalJson(envelope);
  if (new TextEncoder().encode(content).byteLength > 524286)
    throw new Error("reconciliation_capacity_exceeded: one normalized observation exceeds 512 KiB.");
  const sha256 = await sha256Text(content);
  await storage(retainNormalizedObservationStatement(database, runId, id, content, sha256).run());
  const retained = await storage(
    normalizedObservationStatement(database, runId, id).first<{ content: string; sha256: string }>(),
  );
  if (retained?.content !== content || retained.sha256 !== sha256)
    throw new Error("Normalized observation replay changed its immutable content.");
}

/** Generated Source Observation IDs use lowercase ASCII digests and decimal suffixes; this preserves their existing lexical order. */
export async function* stagedNormalizedObservations<T>(database: CatalogueStore, runId: string): AsyncGenerator<T> {
  let after: string | null = null;
  for (;;) {
    const row: { observation_id: string; content: string; sha256: string } | null = await storage(
      nextNormalizedObservationStatement(database, runId, after).first<{
        observation_id: string;
        content: string;
        sha256: string;
      }>(),
    );
    if (!row) return;
    if ((await sha256Text(row.content)) !== row.sha256)
      throw new Error("Normalized observation failed integrity verification.");
    yield (await restorePartitionedRecord(database, runId, JSON.parse(row.content))) as T;
    after = row.observation_id;
  }
}
