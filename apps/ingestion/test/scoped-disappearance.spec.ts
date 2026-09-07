import { expect, test } from "vitest";
import { catalogueStore, type CatalogueCard, type CataloguePrinting } from "../../../src/catalogue/shared";
import { ReconciliationCardState } from "../../../src/catalogue/reconciliation/reconciliation-card-state";
import { ReconciliationReducerIndex } from "../../../src/catalogue/reconciliation/reconciliation-reducer-state";
import { ReconciliationPlanState } from "../../../src/catalogue/reconciliation/reconciliation-plan-state";
import { ReconciliationRecordCollection } from "../../../src/catalogue/reconciliation/reconciliation-record-collection";
import { ReconciliationContinuation } from "../../../src/catalogue/reconciliation/reconciliation-continuation";
import { prepareScopedDisappearanceWarnings } from "../../../src/catalogue/reconciliation/scoped-disappearance";
import { collect, reconcile, installReconciliationSuite, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

test("scoped disappearance resumes through outside-scope records and reports only the missing seventh Printing", async () => {
  const run = await collect("/reconciliation/product-release", "scoped-disappearance-cursors");
  await reconcile(run.id);
  const db = catalogueStore(testEnv.CATALOGUE_DB);
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
    if (index < 6)
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
  let warnings: ReconciliationRecordCollection<Record<string, unknown>>;
  for (;;) {
    warnings = new ReconciliationRecordCollection(db, run.id, "scoped_test_warnings");
    try {
      await prepareScopedDisappearanceWarnings(
        db,
        run.id,
        [
          {
            sourceLineage: "one-piece-en",
            supportedGame: "one-piece",
            cardIdentities: [{ kind: "card_number", value: "P-001" }],
          },
        ],
        cards,
        printings,
        plans,
        warnings,
        true,
      );
      break;
    } catch (error) {
      if (!(error instanceof ReconciliationContinuation)) throw error;
      expect(++continuations).toBeLessThan(20);
    }
  }
  expect(continuations).toBeGreaterThanOrEqual(9);
  const results = [];
  for await (const warning of warnings) results.push(warning);
  expect(results).toEqual([
    expect.objectContaining({
      code: "record_not_observed",
      printing_id: "scope-printing-6",
      source_lineage: "one-piece-en",
    }),
  ]);
  expect(await printings.get("scope-printing-6")).toBeDefined();
  expect(await printings.get("scope-printing-8")).toBeDefined();
});
