import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { retainPartitionedRecord, restorePartitionedRecord } from "./reconciliation-text";
import {
  nextNormalizedCardErratumStatement,
  normalizedCardErrataExistStatement,
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
async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new ReconciliationNormalizationStorageError(cause);
  }
}

export async function hasNormalizedCardErrata(database: CatalogueStore, runId: string): Promise<boolean> {
  return (await storage(() => normalizedCardErrataExistStatement(database, runId).first())) !== null;
}

export async function claimObservationOrigin(
  database: CatalogueStore,
  runId: string,
  id: string,
  setId: string,
  ordinal: number,
) {
  type Origin = { observation_set_id: string; source_ordinal: number };
  const results = await storage(() =>
    database.batch<Origin>([
      retainObservationOriginStatement(database, runId, id, setId, ordinal),
      normalizedObservationExistsStatement(database, runId, id),
    ]),
  );
  const inserted = results[0]?.results[0];
  const origin = inserted ?? (await storage(() => observationOriginStatement(database, runId, id).first<Origin>()));
  if (origin?.observation_set_id !== setId || origin.source_ordinal !== ordinal)
    throw new Error(`Duplicate Source Observation ${id} spans planned requests.`);
  return (results[1]?.results.length ?? 0) > 0;
}

export async function retainNormalizedObservation(
  database: CatalogueStore,
  runId: string,
  id: string,
  record: unknown,
  cardErratumTarget: { game: string; officialIdentity: unknown } | null = null,
) {
  const envelope = await retainPartitionedRecord(database, runId, JSON.parse(JSON.stringify(record)));
  const content = canonicalJson(envelope);
  if (new TextEncoder().encode(content).byteLength > 524286)
    throw new Error("reconciliation_capacity_exceeded: one normalized observation exceeds 512 KiB.");
  const sha256 = await sha256Text(content);
  const targetDigest =
    cardErratumTarget === null
      ? null
      : await sha256Text(canonicalJson([cardErratumTarget.game, cardErratumTarget.officialIdentity]));
  type Retained = { content: string; sha256: string; card_erratum_target_digest: string | null };
  const inserted = await storage(() =>
    retainNormalizedObservationStatement(database, runId, id, content, sha256, targetDigest).first<Retained>(),
  );
  const retained =
    inserted ?? (await storage(() => normalizedObservationStatement(database, runId, id).first<Retained>()));
  if (
    retained?.content !== content ||
    retained.sha256 !== sha256 ||
    retained.card_erratum_target_digest !== targetDigest
  )
    throw new Error("Normalized observation replay changed its immutable content.");
}

/** Generated Source Observation IDs use lowercase ASCII digests and decimal suffixes; this preserves their existing lexical order. */
export async function* stagedNormalizedObservations<T>(database: CatalogueStore, runId: string): AsyncGenerator<T> {
  let after: string | null = null;
  for (;;) {
    const row: { observation_id: string; content: string; sha256: string } | null = await storage(() =>
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

export async function* normalizedCardErrata<T>(
  database: CatalogueStore,
  runId: string,
  game: string,
  officialIdentity: unknown,
): AsyncGenerator<T> {
  const digest = await sha256Text(canonicalJson([game, officialIdentity]));
  let after: string | null = null;
  let count = 0;
  let bytes = 0;
  for (;;) {
    const row: { observation_id: string; content: string; sha256: string } | null = await storage(() =>
      nextNormalizedCardErratumStatement(database, runId, digest, after).first<{
        observation_id: string;
        content: string;
        sha256: string;
      }>(),
    );
    if (!row) return;
    const envelope = JSON.parse(row.content);
    bytes +=
      new TextEncoder().encode(row.content).byteLength +
      envelope.text_parts.reduce((total: number, part: { byte_length: number }) => total + part.byte_length, 0);
    if (++count > 8 || bytes > 512000)
      throw new Error("reconciliation_capacity_exceeded: one Card has too many Erratum records.");
    if ((await sha256Text(row.content)) !== row.sha256)
      throw new Error("Normalized Erratum failed integrity verification.");
    yield (await restorePartitionedRecord(database, runId, envelope)) as T;
    after = row.observation_id;
  }
}
