import type { CatalogueCandidate, CataloguePrinting, CatalogueStore, SupportedGame } from "../shared";
import { verifiedCandidatePartition } from "./game-candidate-inspection";
import { nativePredecessorGameCandidateStatement } from "./game-candidate-repository";
import { nativePriorPrintingIdentity } from "./native-printing-locators";
import type { PriorStateContinuation, PriorStatePositions, PriorStateSeed } from "./prior-state-types";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { restorePartitionedRecord } from "./reconciliation-text";

type Cursor = {
  candidate: string;
  pass: number;
  partition: number;
  record: number;
  locator?: number;
  positions: PriorStatePositions;
  complete: boolean;
};
/** Seed a subsequent operation from its exact native game predecessor, one record per durable unit. */
export async function nativeCandidateAtRevision(
  db: CatalogueStore,
  revision: string,
  games: readonly SupportedGame[],
  seed: PriorStateSeed,
  continuation: PriorStateContinuation,
) {
  if (games.length !== 1) return undefined;
  const candidate = await nativePredecessorGameCandidateStatement(db, revision, games[0]!).first<{
    id: string;
    preparation_id: string;
    partition_count: number;
  }>();
  if (!candidate) return undefined;
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
    if (partition.kind === "printings") {
      const printing = value as CataloguePrinting;
      const identity = await nativePriorPrintingIdentity(db, candidate.preparation_id, printing);
      if (cursor.locator === undefined) {
        await seed.printing(printing, identity);
        if (identity?.locators.length) {
          cursor.locator = 0;
          await save();
          continue;
        }
      } else {
        if (!identity || cursor.locator >= identity.locators.length)
          throw new Error("Native prior locator continuation changed its retained identity.");
        await seed.printingLocator({ ...identity, locators: [identity.locators[cursor.locator]!] });
        cursor.locator++;
        if (cursor.locator < identity.locators.length) {
          await save();
          continue;
        }
        delete cursor.locator;
      }
    } else await handler(value as never);
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
