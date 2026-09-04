import { applyD1Migrations } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { apiCard, apiHeaders, cardSearchStatements, seedApiRevision, testEnv } from "./api-fixtures";

test("Card attribute migration backfills typed values and nested array leaves for retained revisions", async () => {
  await applyD1Migrations(
    testEnv.CATALOGUE_DB,
    testEnv.TEST_MIGRATIONS.filter(({ name }) => Number.parseInt(name, 10) < 8),
  );
  const card = apiCard({ id: "card_digimon", cardNumber: "BT01-001", name: "Agumon" });
  card.game = "digimon";
  card.game_data = {
    profile: "digimon@1",
    attributes: {
      card_type: "digimon",
      colours: ["red"],
      level: 3,
      play_cost: 3,
      use_cost: null,
      dp: 2000,
      form: "Rookie",
      attribute: "Vaccine",
      traits: ["Reptile"],
      text_sections: [],
      digivolution_requirements: [{ cost: 0, from_level: 2, colours: ["red"], raw_condition: null }],
    },
  };
  await seedApiRevision({ revisionId: "catrev_attribute_backfill", runId: "run_attribute_backfill", cards: [card] });
  // Retained pre-envelope shape is also accepted by the one-time backfill.
  const bare = { ...card, id: "card_bare", official_identity: { kind: "card_number", value: "BT01-002" } };
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      "INSERT INTO revision_cards VALUES ('catrev_attribute_backfill', 'card_bare', ?)",
    ).bind(JSON.stringify(bare)),
    ...cardSearchStatements("catrev_attribute_backfill", bare),
  ]);
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  for (const attribute of [
    "level=3",
    "colours=red",
    "digivolution_requirements.cost=0",
    "digivolution_requirements.colours=red",
    "use_cost=null",
  ]) {
    const response = await exports.default.fetch(
      new Request(`https://card-keepr.invalid/v1/cards?game=digimon&attribute.${attribute}`, {
        headers: apiHeaders("203.0.113.80"),
      }),
    );
    expect(response.status, attribute).toBe(200);
    const body = await response.json<{ data: { id: string }[] }>();
    expect(body.data.map(({ id }) => id)).toEqual(["card_digimon", "card_bare"]);
  }
});
