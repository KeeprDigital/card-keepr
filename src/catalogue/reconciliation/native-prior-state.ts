import { type CatalogueStore, type CatalogueCandidate } from "../shared";
import { predecessorGameCandidateStatement } from "./game-candidate-repository";
import { verifiedCandidatePartition } from "./game-candidate-inspection";
import { restorePartitionedRecord } from "./reconciliation-text";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import type { candidateAtRevision, PriorStatePositions } from "./reconciliation-prior-state";

type Cursor = {
  candidate: string;
  pass: number;
  partition: number;
  record: number;
  positions: PriorStatePositions;
  complete: boolean;
};
/** Seed a subsequent operation from its exact native game predecessor, one record per durable unit. */
export async function nativeCandidateAtRevision(
  db: CatalogueStore,
  revision: string,
  games: Parameters<typeof candidateAtRevision>[2],
  seed: Parameters<typeof candidateAtRevision>[3],
  continuation: Parameters<typeof candidateAtRevision>[4],
) {
  if (games.length !== 1) return undefined;
  const candidate = await predecessorGameCandidateStatement(db, revision, games[0]!).first<{
    id: string;
    preparation_id: string;
    partition_count: number;
  }>();
  if (!candidate || (candidate.id === candidate.preparation_id && !candidate.id.startsWith("candidate_")))
    return undefined;
  const retained = await reconciliationCheckpoint<Cursor>(db, continuation.runId, "prior_state");
  const cursor: Cursor = retained?.value ?? {
    candidate: candidate.id,
    pass: 0,
    partition: 0,
    record: 0,
    positions: continuation.capture(),
    complete: false,
  };
  if (cursor.candidate !== candidate.id) throw new Error("Native predecessor changed during continuation.");
  if (retained) continuation.restore(cursor.positions);
  let ordinal = (retained?.ordinal ?? -1) + 1;
  const save = async () => {
    cursor.positions = continuation.capture();
    await retainReconciliationCheckpoint(db, continuation.runId, "prior_state", ordinal, cursor);
    if (continuation.yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "prior_state", ordinal });
    ordinal++;
  };
  while (!cursor.complete) {
    if (cursor.partition === candidate.partition_count) {
      cursor.pass++;
      cursor.partition = 0;
      cursor.record = 0;
      if (cursor.pass === 2) cursor.complete = true;
      await save();
      continue;
    }
    const partition = await verifiedCandidatePartition(db, candidate.id, cursor.partition);
    const handler = (
      {
        cards: seed.card,
        printings: seed.printing,
        printing_images: seed.image,
        products: seed.product,
        distribution_contexts: seed.context,
        product_relationships: seed.relationship,
        errata: seed.erratum,
        identity_corrections: seed.correction,
      } as Record<string, (value: never) => Promise<void>>
    )[partition.kind];
    if (
      !handler ||
      (partition.kind === "cards") !== (cursor.pass === 0) ||
      cursor.record === partition.records.length
    ) {
      cursor.partition++;
      cursor.record = 0;
      await save();
      continue;
    }
    const value = await restorePartitionedRecord(
      db,
      candidate.preparation_id,
      partition.records[cursor.record]! as Parameters<typeof restorePartitionedRecord>[2],
    );
    await handler(value as never);
    cursor.record++;
    await save();
  }
  return {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: games,
    cards: [],
    printings: [],
    printing_images: [],
    products: [],
    distribution_contexts: [],
    product_relationships: [],
    errata: [],
    identity_corrections: [],
  } satisfies CatalogueCandidate;
}
