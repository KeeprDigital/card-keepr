import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, test } from "vitest";
import {
  pokemonOfficialProduct,
  pokemonOfficialGarchomp,
  pokemonOfficialErratum,
} from "../../src/catalogue/adapters/pokemon-official-source-adapter";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation";
import { pokemonCorrectedRulesText, pokemonCorrectedCard } from "../../src/catalogue/reconciliation/pokemon-errata";
import { AdapterParseFailure } from "../../src/catalogue/adapters/adapter-parse-failure";
import {
  deriveEffectiveRulesText,
  identifyRulesTextErrata,
} from "../../src/catalogue/reconciliation/errata-rules-text";

const fixture = new URL("../../acceptance/fixtures/real-sources/2026-09-14-pokemon/raw/", import.meta.url);

test("the official Card parser rejects changed or missing physical content instead of inventing an empty value", () => {
  const html = readFileSync(new URL("official-garchomp-card.html", fixture), "utf8");
  for (const changed of [
    html.replace("<h4>Weakness</h4>", "<h4>Weakness</h4><p>Fire ×2</p>"),
    html.replace("<h4>Resistance</h4>", "<h4>Unknown field</h4>"),
    html.replace('class="left label">Dragonblade', 'class="left label">Another Attack'),
  ])
    expect(() => pokemonOfficialGarchomp(new TextEncoder().encode(changed))).toThrow(AdapterParseFailure);
});

test("the selected official Product separately lists stamped and plain Snorlax without claiming unique coverage or a release region", () => {
  const product = pokemonOfficialProduct(readFileSync(new URL("official-snorlax-product.html", fixture)));
  expect(product.product_release_catalogue.products).toMatchObject([
    {
      name: "Pokémon TCG: Scarlet & Violet—151 Pokémon Center Elite Trainer Box",
      official_code: null,
      releases: [{ region: "unknown", date: { precision: "day", value: "2023-09-22" } }],
    },
  ]);
  expect(product.source_sidecar.promo_contents).toEqual([
    "1 full-art foil promo card featuring Snorlax with a Pokémon Center logo",
    "1 full-art foil promo card featuring Snorlax",
  ]);
  expect(product.product_release_catalogue.relationships).toEqual([]);
});

test("the attributed correction replays while stale, ambiguous and unrelated Garchomp content stays protected", async () => {
  const original = parseReconciliationObservation(
    "original",
    pokemonOfficialGarchomp(readFileSync(new URL("official-garchomp-card.html", fixture))),
  );
  const correction = parseReconciliationObservation(
    "correction",
    pokemonOfficialErratum(readFileSync(new URL("official-garchomp-erratum.html", fixture))),
  );
  if (
    original.kind !== "card_printing" ||
    original.observedCardAndPrinting.card === null ||
    correction.kind !== "official_erratum"
  )
    throw new Error("Expected retained real card and correction");
  const card = { ...original.observedCardAndPrinting.card, id: "card_retained_garchomp" };
  const value = pokemonCorrectedRulesText(card, correction, []);
  const errata = await identifyRulesTextErrata({
    game: "pokemon",
    cardId: card.id,
    printingId: null,
    sourceLineage: "pokemon-official-en",
    sourceObservationId: correction.sourceObservationId,
    errata: [
      {
        targetType: "card",
        effectiveFrom: correction.effectiveFrom,
        officialWording: correction.officialWording,
        correctedValue: value,
      },
    ],
  });
  const corrected = { ...card, effective_rules_text: value };
  expect(pokemonCorrectedRulesText(corrected, correction, errata)).toBe(value);
  const published = pokemonCorrectedCard(card, errata, "2026-09-14T00:00:00.000Z");
  expect(published.game_data.attributes.abilities).toEqual([
    { kind: "Ability", name: "Sonic Slip", text: correction.correctedRulesText },
  ]);
  expect(published.effective_rules_text).toBe(value);
  expect(published.game_data.attributes.attacks).toEqual(card.game_data.attributes.attacks);
  expect(card.game_data.attributes.abilities).toEqual([
    { kind: "Ability", name: "Sonic Slip", text: correction.observedPrintedRulesText },
  ]);
  expect(pokemonCorrectedCard(published, errata, "2026-09-14T00:00:00.000Z")).toEqual(published);
  expect(pokemonCorrectedCard(card, errata, "2022-02-08T00:00:00.000Z")).toEqual(card);
  for (const abilities of [[], [{ kind: "Ability", name: "Sonic Slip", text: "Unrelated content" }]])
    expect(() =>
      pokemonCorrectedCard(
        { ...card, game_data: { ...card.game_data, attributes: { ...card.game_data.attributes, abilities } } },
        errata,
        "2026-09-14T00:00:00.000Z",
      ),
    ).toThrow();
  expect(() => pokemonCorrectedRulesText(corrected, correction, [])).toThrow();
  for (const content of [
    "Unexpected aggregator wording",
    `${card.effective_rules_text}\nSonic Slip: ${correction.observedPrintedRulesText}`,
  ])
    expect(() => pokemonCorrectedRulesText({ ...card, effective_rules_text: content }, correction, errata)).toThrow();
  for (const official_identity of [
    { kind: "unknown" as const, value: null },
    { kind: "card_number" as const, value: "OTHER-SET-109/172" },
  ]) {
    const unrelated = { ...card, id: "card_other_garchomp", official_identity };
    expect(() => pokemonCorrectedRulesText(unrelated, correction, errata)).toThrow();
    expect(deriveEffectiveRulesText(unrelated, errata, "2026-09-14T00:00:00.000Z")).toBe(card.effective_rules_text);
  }
});

test("the real dated Garchomp correction keeps original wording and targets only its publisher set and number", () => {
  const erratum = pokemonOfficialErratum(readFileSync(new URL("official-garchomp-erratum.html", fixture)));
  const parsed = parseReconciliationObservation("real-garchomp-correction", erratum);
  expect(parsed).toMatchObject({
    kind: "official_erratum",
    game: "pokemon",
    publishedOn: "2022-02-09",
    effectiveFrom: "2022-02-09",
    target: { type: "card", officialIdentity: { kind: "card_number", value: "BRILLIANT-STARS-109/172" } },
    correctedRulesText:
      "When you play this Pokémon from your hand to evolve 1 of your Pokémon during your turn, you may prevent all damage from and effects of attacks from your opponent’s Pokémon done to this Pokémon until the end of your opponent’s next turn.",
    observedPrintedRulesText:
      "When you play this Pokémon from your hand to evolve 1 of your Pokémon during your turn, you may prevent all damage from and effects of attacks done to this Pokémon until the end of your opponent’s next turn.",
  });
  for (const identity of [
    { kind: "unknown", value: null },
    { kind: "card_number", value: "OTHER-SET-109/172" },
  ])
    expect(() =>
      parseReconciliationObservation("controlled-wrong-target", {
        ...erratum,
        target: { type: "card", official_identity: identity },
      }),
    ).toThrow();
});

test("the original official Garchomp page identifies one issued card and keeps its Sonic Slip wording", () => {
  const observation = pokemonOfficialGarchomp(readFileSync(new URL("official-garchomp-card.html", fixture)));
  expect(observation.card).toMatchObject({
    game: "pokemon",
    category: "gameplay",
    name: "Garchomp",
    official_identity: { kind: "card_number", value: "BRILLIANT-STARS-109/172" },
    game_data: {
      profile: "pokemon@1",
      attributes: { hp: 160, types: ["Dragon"], stage: "Stage2", evolves_from: "Gabite", retreat_cost: 1 },
    },
  });
  expect(observation.card.effective_rules_text).toContain(
    "prevent all damage from and effects of attacks done to this Pokémon",
  );
  expect(observation.card.effective_rules_text).toContain("Dragonblade: Discard the top 2 cards of your deck.");
  expect(observation.printing).toMatchObject({
    rarity: { raw: "Rare Holo" },
    game_data: { attributes: { collector_number: "109/172", finish: "holo" } },
  });
  expect(observation.source_sidecar.publisher_identity).toEqual({
    set: "Brilliant Stars",
    collector_number: "109/172",
    page_card_id: "swsh9/109",
  });
});

test("reconciliation replaces only the evidenced Sonic Slip paragraph and preserves Dragonblade", () => {
  const original = parseReconciliationObservation(
    "original",
    pokemonOfficialGarchomp(readFileSync(new URL("official-garchomp-card.html", fixture))),
  );
  const correction = parseReconciliationObservation(
    "correction",
    pokemonOfficialErratum(readFileSync(new URL("official-garchomp-erratum.html", fixture))),
  );
  if (
    original.kind !== "card_printing" ||
    original.observedCardAndPrinting.card === null ||
    correction.kind !== "official_erratum"
  )
    throw new Error("Expected retained real card and correction");
  const card = { ...original.observedCardAndPrinting.card, id: "card_retained_garchomp" };
  expect(pokemonCorrectedRulesText(card, correction, [])).toBe(
    `Sonic Slip: ${correction.correctedRulesText}\nDragonblade: Discard the top 2 cards of your deck.`,
  );
  expect(card.effective_rules_text).toContain(correction.observedPrintedRulesText);
  expect(original.observedCardAndPrinting.printing?.printed_rules_text).toBe(card.effective_rules_text);
});
