import { reconciliationCheckpoint } from "../../../src/catalogue/reconciliation/reconciliation-checkpoint";
import { expect, test } from "vitest";
import { catalogueStore, type CatalogueCard, type CataloguePrinting } from "../../../src/catalogue/shared";
import { ReconciliationCardState } from "../../../src/catalogue/reconciliation/reconciliation-card-state";
import { ReconciliationReducerIndex } from "../../../src/catalogue/reconciliation/reconciliation-reducer-state";
import { ReconciliationPlanState } from "../../../src/catalogue/reconciliation/reconciliation-plan-state";
import { ReconciliationRecordCollection } from "../../../src/catalogue/reconciliation/reconciliation-record-collection";
import { ReconciliationContinuation } from "../../../src/catalogue/reconciliation/reconciliation-continuation";
import { prepareDisappearanceWarnings } from "../../../src/catalogue/reconciliation/reconciliation-disappearance";
import { initializeReconciliationProgress } from "../../../src/catalogue/reconciliation/reconciliation-progress";
import { ReconciliationErrataState } from "../../../src/catalogue/reconciliation/reconciliation-errata-state";
import { collect, installReconciliationSuite, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

test.each([6, 0])(
  "scoped disappearance resumes with %i observed Printings and preserves outside-scope records",
  async (observed) => {
    const run = await collect("/reconciliation/product-release", "scoped-disappearance-cursors");
    const db = catalogueStore(testEnv.CATALOGUE_DB);
    await initializeReconciliationProgress(db, run.id, new Date().toISOString());
    const cards = new ReconciliationCardState(db, run.id, "scoped_test_cards");
    const printings = new ReconciliationReducerIndex<CataloguePrinting>(db, run.id, "scoped_test_printings");
    const plans = new ReconciliationPlanState(db, run.id);
    const card: CatalogueCard = {
      id: "scope-card",
      game: "one-piece",
      official_identity: { kind: "card_number", value: "P-001" },
      name: "Luffy",
      effective_rules_text: null,
      game_data: { profile: "one-piece@1", attributes: {} },
    };
    await cards.seed(card);
    await cards.seed({ ...card, id: "outside-card", official_identity: { kind: "card_number", value: "P-002" } });
    for (let index = 0; index < 9; index++) {
      const printing: CataloguePrinting = {
        id: `scope-printing-${index}`,
        card_id: index < 7 ? card.id : "outside-card",
        rarity: { normalized: null, raw: null },
        printed_rules_text: null,
        game_data: null,
        locator_evidence: [
          {
            source_lineage: "one-piece-en",
            locator: `locator-${index}`,
            variant_key: null,
            source_observation_id: `prior-${index}`,
          },
        ],
      };
      await printings.seed(printing.id, printing);
      if (index < observed)
        await plans.append({
          sourceObservationSetId: "set",
          sourceSnapshotId: "snapshot",
          sourceObservationId: `scope-observation-${index}`,
          sourceLineage: "one-piece-en",
          supportedGame: "one-piece",
          observationKind: "card_printing",
          cardId: card.id,
          printingId: printing.id,
          locator: `locator-${index}`,
          variantKey: null,
          compatibility: null,
          memberships: { products: [], distribution_contexts: [], source_buckets: [] },
          withdrawal: null,
          sourceCardFactsJson: null,
        });
    }
    let continuations = 0;
    const stages = new Set<string>();
    let warnings: ReconciliationRecordCollection<Record<string, unknown>>;
    for (;;) {
      warnings = new ReconciliationRecordCollection(db, run.id, "scoped_test_warnings");
      try {
        await prepareDisappearanceWarnings(
          db,
          run.id,
          {
            plans,
            cardScopes: {
              scopes: [
                {
                  sourceLineage: "one-piece-en",
                  supportedGame: "one-piece",
                  cardIdentities: [{ kind: "card_number", value: "P-001" }],
                },
              ],
              priorCards: cards,
              priorPrintings: printings,
            },
            hasPrintings: true,
            checkedLineages: [],
            errataLineages: [],
            priorErrata: new ReconciliationErrataState(db, run.id, "scoped_test_prior_errata"),
            observedErrata: new ReconciliationErrataState(db, run.id, "scoped_test_observed_errata"),
            gundamProvenance: new ReconciliationReducerIndex(db, run.id, "scoped_test_gundam"),
            printingCompatibility: new ReconciliationReducerIndex(db, run.id, "scoped_test_compatibility"),
          },
          warnings,
          true,
        );
        break;
      } catch (error) {
        if (!(error instanceof ReconciliationContinuation)) throw error;
        expect(error.checkpoint.phase).toBe("disappearance_warnings");
        const checkpoint = await reconciliationCheckpoint<{ stage: string }>(db, run.id, "disappearance_warnings");
        stages.add(checkpoint!.value.stage);
        expect(++continuations).toBeLessThan(50);
      }
    }
    expect(continuations).toBeGreaterThanOrEqual(9);
    const results = [];
    for await (const warning of warnings) results.push(warning);
    expect(stages).toEqual(
      new Set([
        "scoped_printings",
        "scoped_cards",
        "memberships",
        "relationships",
        "gundam_published",
        "gundam_local",
        "printings",
        "cards",
        "errata",
        "complete",
      ]),
    );
    expect(
      results
        .filter((warning) => warning.printing_id)
        .map((warning) => warning.printing_id)
        .sort(),
    ).toEqual(Array.from({ length: 7 - observed }, (_, index) => `scope-printing-${index + observed}`));
    expect(results.filter((warning) => warning.card_id).map((warning) => warning.card_id)).toEqual(
      observed ? [] : [card.id],
    );
    for (const warning of results)
      expect(warning).toMatchObject({ code: "record_not_observed", source_lineage: "one-piece-en" });
    expect(await printings.get("scope-printing-6")).toBeDefined();
    expect(await printings.get("scope-printing-8")).toBeDefined();
  },
);
