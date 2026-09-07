import { ReconciliationRecordLog } from "./reconciliation-record-log";
import {
  type CatalogueCard,
  type CataloguePrinting,
  type CataloguePrintingImage,
  type CatalogueStore,
  type SupportedGame,
  canonicalJson,
} from "../shared";
import { deriveEffectiveRulesText, ErratumRulesTextError } from "./errata-rules-text";
import { ReconciliationCandidateState } from "./reconciliation-candidate-state";
import type { ReconciliationCardState } from "./reconciliation-card-state";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import type { ReconciliationErrataState } from "./reconciliation-errata-state";
import type { ReconciliationPlanState } from "./reconciliation-plan-state";
import type { ReconciliationRecordSink } from "./reconciliation-record-collection";
import type { ReconciliationReducerIndex } from "./reconciliation-reducer-state";

type Cursor = {
  stage: "cards" | "printings" | "printing_images" | "errata" | "complete";
  after: string;
  cards: number;
  observedCards: number;
  observedPrintings: number;
  cardLog: number;
  printingLog: number;
  positions: ReconciliationCandidateState["positions"];
  diagnostics: { position: number; count: number };
};

/** Assemble official facts without replaying the completed entity prefix after a retry. */
export async function prepareOfficialCandidate(
  database: CatalogueStore,
  runId: string,
  base: ReconciliationCandidateState,
  sources: {
    cards: ReconciliationCardState;
    printings: ReconciliationReducerIndex<CataloguePrinting>;
    images: ReconciliationReducerIndex<CataloguePrintingImage>;
    errata: ReconciliationErrataState;
    plans: ReconciliationPlanState;
    games: ReadonlySet<SupportedGame>;
    observedCard: (id: string) => Promise<boolean>;
    observedPrinting: (id: string) => Promise<boolean>;
  },
  diagnostics: ReconciliationRecordSink<{
    code: "canonical_card_conflict";
    source_observation_id: string | null;
    locator: string | null;
    matched_printing_ids: string[];
    detail: string;
  }> & {
    readonly cursor: { position: number; count: number };
    resumeAt(cursor: { position: number; count: number }): void;
  },
  observedAt: string,
  yieldAtCheckpoint: boolean,
) {
  const draft = new ReconciliationCandidateState(database, runId, "before_curated", base);
  const cardIds = new ReconciliationRecordLog<string>(database, runId, "observed_card_ids");
  const printingIds = new ReconciliationRecordLog<string>(database, runId, "observed_printing_ids");
  const assembled = {
    draft,
    observedCards: { [Symbol.asyncIterator]: () => cardIds.records() },
    observedPrintings: { [Symbol.asyncIterator]: () => printingIds.records() },
  };
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "official_assembly");
  let stage: Cursor["stage"] = checkpoint?.value.stage ?? "cards";
  let after = checkpoint?.value.after ?? "";
  let cards = checkpoint?.value.cards ?? 0;
  let observedCards = checkpoint?.value.observedCards ?? 0;
  let observedPrintings = checkpoint?.value.observedPrintings ?? 0;
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  if (checkpoint) {
    draft.resumeAt(checkpoint.value.positions);
    diagnostics.resumeAt(checkpoint.value.diagnostics);
    cardIds.resumeAt(checkpoint.value.cardLog);
    printingIds.resumeAt(checkpoint.value.printingLog);
    if (stage === "complete") return assembled;
  }
  const save = async () => {
    const cardLog = await cardIds.checkpoint();
    const printingLog = await printingIds.checkpoint();
    await retainReconciliationCheckpoint(database, runId, "official_assembly", ordinal, {
      stage,
      after,
      cards,
      observedCards,
      observedPrintings,
      cardLog,
      printingLog,
      positions: draft.positions,
      diagnostics: diagnostics.cursor,
    } satisfies Cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "official_assembly", ordinal });
    ordinal++;
  };
  if (!checkpoint) await save();
  let records = 0;
  let bytes = 0;
  const consume = async <T extends { id: string }>(values: AsyncIterable<T>, action: (value: T) => Promise<void>) => {
    for await (const value of values) {
      const size = new TextEncoder().encode(canonicalJson(value)).byteLength;
      if (records > 0 && (records >= 8 || bytes + size > 512000)) {
        await save();
        records = 0;
        bytes = 0;
      }
      await action(value);
      after = value.id;
      records++;
      bytes += size;
    }
  };
  const finish = async (next: Cursor["stage"]) => {
    stage = next;
    after = "";
    await save();
    records = 0;
    bytes = 0;
  };
  if (stage === "cards") {
    await consume(sources.cards.entityValues(after), async (card) => {
      const errata = await sources.errata.forCard(card.game, card.id);
      let resolved = card;
      if (sources.games.has(card.game)) {
        try {
          resolved = { ...card, effective_rules_text: deriveEffectiveRulesText(card, errata, observedAt) };
        } catch (error) {
          const plans = await sources.plans.forCard(card.id);
          await diagnostics.push({
            code: "canonical_card_conflict",
            source_observation_id: plans[0]?.sourceObservationId ?? null,
            locator: plans[0]?.locator ?? null,
            matched_printing_ids: plans.flatMap((plan) => (plan.printingId === null ? [] : [plan.printingId])),
            detail:
              error instanceof ErratumRulesTextError
                ? error.message
                : "The Card has an unresolved Effective Rules Text conflict.",
          });
        }
      }
      await draft.set("cards", omitUndefinedValues(resolved) as CatalogueCard);
      if (await sources.observedCard(card.id)) {
        await cardIds.append(card.id);
        observedCards++;
      }
      cards++;
    });
    await finish("printings");
  }
  if (stage === "printings") {
    await consume(sources.printings.entityValues(after), async (printing) => {
      await draft.set("printings", omitUndefinedValues(printing) as CataloguePrinting);
      if (await sources.observedPrinting(printing.id)) {
        await printingIds.append(printing.id);
        observedPrintings++;
      }
    });
    await finish("printing_images");
  }
  if (stage === "printing_images") {
    await consume(sources.images.entityValues(after), async (image) => {
      await draft.set("printing_images", omitUndefinedValues(image) as CataloguePrintingImage);
    });
    await finish("errata");
  }
  if (stage === "errata") {
    await consume(sources.errata.values(after), async (erratum) => {
      await draft.set("errata", erratum);
    });
    await finish("complete");
  }
  return assembled;
}

export function omitUndefinedValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUndefinedValues);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, omitUndefinedValues(item)]),
    );
  }
  return value;
}
