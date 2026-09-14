import { beforeEach, expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import { nativeCuratedTarget } from "../../../src/catalogue/curated/curated-native-target";
import {
  reconciliationCheckpoint,
  retainReconciliationCheckpoint,
} from "../../../src/catalogue/reconciliation/reconciliation-checkpoint";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import { collect, installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";

installReconciliationSuite({ directPreparation: true });

const allGames = ["one-piece", "digimon", "fusion-world", "gundam", "riftbound", "magic", "pokemon"];
let fixture: { preparation: string; revision: string; product: Record<string, unknown> };
beforeEach(async () => {
  const run = await collect("/reconciliation/inspection-product", "native-target-source");
  const candidate = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "native-target-candidate");
  const preparation = requiredString(candidate, "id");
  const records = await nativeCandidateRecords(preparation, ["products"]);
  expect(records.products).toHaveLength(1);
  const publication = await approveNativeCandidate(candidate, "native-target-publish");
  fixture = {
    preparation,
    revision: requiredString(publication.document, "resulting_revision_id"),
    product: records.products![0]!,
  };
});

test.each([
  { label: "all seven registered games", games: allGames, valid: true },
  { label: "duplicate game", games: [...allGames.slice(0, -1), "one-piece"], valid: false },
  { label: "unknown game", games: [...allGames.slice(0, -1), "unknown-game"], valid: false },
])("a native Curated Product target verifies $label", async ({ games, valid }) => {
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  const official = await reconciliationCheckpoint<Record<string, unknown>>(
    database,
    fixture.preparation,
    "official_errata",
  );
  expect(official).not.toBeNull();
  // Retain a bounded completed multi-game checkpoint at the actual native reader's
  // storage boundary; all original published Product and text partitions stay real.
  for (const game of allGames) {
    const phase = `product_reduction:${game}`;
    if (!(await reconciliationCheckpoint(database, fixture.preparation, phase)))
      await retainReconciliationCheckpoint(database, fixture.preparation, phase, 0, { stage: "complete", result: {} });
  }
  await retainReconciliationCheckpoint(database, fixture.preparation, "official_errata", official!.ordinal + 1, {
    ...official!.value,
    productGames: games,
  });
  const target = nativeCuratedTarget(database, fixture.revision, "one-piece", "product", String(fixture.product.id));
  if (valid) await expect(target).resolves.toMatchObject({ id: fixture.product.id, name: fixture.product.name });
  else await expect(target).rejects.toMatchObject({ code: "curated_revision_target_unavailable" });
});
