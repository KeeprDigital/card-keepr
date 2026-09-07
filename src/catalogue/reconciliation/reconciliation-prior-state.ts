import { nativeCandidateAtRevision } from "./native-prior-state";
import type {
  CatalogueCandidate,
  CatalogueCard,
  CatalogueErratum,
  CataloguePrinting,
  CataloguePrintingImage,
  CatalogueProduct,
  CatalogueDistributionContext,
  ProductRelationship,
  CatalogueStore,
  SupportedGame,
  ObjectMemberCursor,
} from "../shared";
import { canonicalJson, retainedPayloadChunks, resumableObjectMembers } from "../shared";
import { stripCuratedRevisionEffects } from "../curated";
import type { ReconciliationCandidateState } from "./reconciliation-candidate-state";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { candidateAtRevisionStatement } from "./reconciliation-read-repository";

export type PriorStatePositions = {
  cards: number;
  priorCards: number;
  printings: number;
  priorPrintings: number;
  printingImages: number;
  priorProducts: ReconciliationCandidateState["positions"];
  priorErrata: number;
  currentErrata: number;
};
type PriorStateCursor = {
  revisionId: string;
  sourceRunId: string | null;
  pass: number;
  member: ObjectMemberCursor | null;
  values: Record<string, unknown>;
  positions: PriorStatePositions;
  seededCards: number;
  complete: boolean;
};

export async function candidateAtRevision(
  database: CatalogueStore,
  revisionId: string,
  selectedGames: readonly SupportedGame[],
  seed: {
    card: (card: CatalogueCard) => Promise<void>;
    printing: (printing: CataloguePrinting) => Promise<void>;
    image: (image: CataloguePrintingImage) => Promise<void>;
    product: (product: CatalogueProduct) => Promise<void>;
    context: (context: CatalogueDistributionContext) => Promise<void>;
    relationship: (relationship: ProductRelationship) => Promise<void>;
    erratum: (erratum: CatalogueErratum) => Promise<void>;
    correction: (correction: NonNullable<CatalogueCandidate["identity_corrections"]>[number]) => Promise<void>;
  },
  continuation: {
    runId: string;
    capture: () => PriorStatePositions;
    restore: (positions: PriorStatePositions) => void;
    yieldAtCheckpoint: boolean;
  },
): Promise<CatalogueCandidate | null> {
  const native = await nativeCandidateAtRevision(database, revisionId, selectedGames, seed, continuation);
  if (native !== undefined) return native;
  const row = await candidateAtRevisionStatement(database, revisionId).first<{
    ingestion_run_id: string;
    candidate_json: string;
  }>();
  const checkpoint = await reconciliationCheckpoint<PriorStateCursor>(database, continuation.runId, "prior_state");
  if (
    checkpoint &&
    (checkpoint.value.revisionId !== revisionId || checkpoint.value.sourceRunId !== (row?.ingestion_run_id ?? null))
  )
    throw new Error("Prior candidate provenance changed during continuation.");
  if (checkpoint) continuation.restore(checkpoint.value.positions);
  const values: Record<string, unknown> = checkpoint?.value.values ?? {};
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  const save = async (pass: number, member: ObjectMemberCursor | null, complete: boolean) => {
    const positions = continuation.capture();
    await retainReconciliationCheckpoint(database, continuation.runId, "prior_state", ordinal, {
      revisionId,
      sourceRunId: row?.ingestion_run_id ?? null,
      pass,
      member,
      values,
      positions,
      seededCards: positions.priorCards,
      complete,
    } satisfies PriorStateCursor);
    if (continuation.yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "prior_state", ordinal });
    ordinal++;
  };
  if (!checkpoint?.value.complete) {
    // Cards precede Printings even when a legacy payload orders its object members differently.
    for (let pass = checkpoint?.value.pass ?? 0; row && pass < 2; pass++) {
      let scanned = 0;
      let bytes = 0;
      const after = pass === checkpoint?.value.pass ? checkpoint.value.member : null;
      let previous = after;
      for await (const { member, cursor } of resumableObjectMembers(
        (chunkIndex) =>
          retainedPayloadChunks(database, row.ingestion_run_id, "candidate", row.candidate_json, chunkIndex),
        after,
      )) {
        const size = member.kind === "value" ? new TextEncoder().encode(canonicalJson(member.value)).byteLength : 0;
        if (scanned > 0 && bytes + size > 512000) {
          await save(pass, previous, false);
          scanned = 0;
          bytes = 0;
        }
        bytes += size;
        const cardsOnly = pass === 0;
        if ((member.key === "cards") === cardsOnly) {
          if (member.kind === "array") {
            Object.defineProperty(values, member.key, {
              value: [],
              writable: true,
              enumerable: true,
              configurable: true,
            });
          } else if (member.key === "cards" && member.array) {
            await seed.card(member.value as CatalogueCard);
          } else if (member.key === "printings" && member.array) {
            await seed.printing(member.value as CataloguePrinting);
          } else if (member.key === "printing_images" && member.array) {
            await seed.image(member.value as CataloguePrintingImage);
          } else if (member.key === "products" && member.array) {
            await seed.product(member.value as CatalogueProduct);
          } else if (member.key === "distribution_contexts" && member.array) {
            await seed.context(member.value as CatalogueDistributionContext);
          } else if (member.key === "product_relationships" && member.array) {
            await seed.relationship(member.value as ProductRelationship);
          } else if (member.key === "identity_corrections" && member.array) {
            await seed.correction(member.value as NonNullable<CatalogueCandidate["identity_corrections"]>[number]);
          } else if (member.key === "errata" && member.array) {
            await seed.erratum(member.value as CatalogueErratum);
          } else if (member.array) {
            (values[member.key] as unknown[]).push(member.value);
          } else {
            Object.defineProperty(values, member.key, {
              value: member.value,
              writable: true,
              enumerable: true,
              configurable: true,
            });
          }
        }
        previous = cursor;
        if (member.kind === "value" && member.array && (++scanned === 8 || bytes >= 512000)) {
          await save(pass, cursor, false);
          scanned = 0;
          bytes = 0;
        }
      }
      await save(pass + 1, null, false);
    }
    await save(2, null, true);
  }
  if (row === null) return null;
  const candidate = stripCuratedRevisionEffects(values as CatalogueCandidate, selectedGames);
  return candidate;
}
