import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { tcgdexPokemonSourceAdapterRegistration } from "../../src/catalogue/adapters/tcgdex-pokemon-source-adapter";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation";
import { AdapterParseFailure } from "../../src/catalogue/adapters/adapter-parse-failure";

const fixture = new URL("../../acceptance/fixtures/real-sources/2026-09-14-pokemon/raw/", import.meta.url);

test("retained TCGdex Snorlax treatments stay distinct and its shared catalogue image does not depict the stamp", () => {
  const observations = tcgdexPokemonSourceAdapterRegistration.parseBytes(
    readFileSync(new URL("tcgdex-snorlax-svp-051.body", fixture)),
    { url: "https://api.tcgdex.net/v2/en/cards/svp-051", mediaType: "application/json" },
  );
  expect(observations).toHaveLength(2);
  const [plain, stamped] = observations;
  expect(plain!.card).toMatchObject({
    name: "Snorlax",
    category: "gameplay",
    official_identity: { kind: "unknown", value: null },
    game_data: { profile: "pokemon@1", attributes: { card_type: "pokemon", hp: 150, stage: "Basic" } },
  });
  expect(plain!.printing.game_data.attributes).toMatchObject({ collector_number: "051", stamps: [], finish: "holo" });
  expect(stamped!.printing.game_data.attributes).toMatchObject({
    collector_number: "051",
    stamps: ["pokemon-center"],
    finish: "holo",
  });
  expect(plain!.identity_evidence.variant_key).not.toBe(stamped!.identity_evidence.variant_key);
  expect(stamped!.appearance_evidence.images).toEqual([]);
  expect(stamped!.printing.printed_rules_text).toBeNull();
  expect(plain!.appearance_evidence.images).toMatchObject([
    { role: "front", source_url: "https://assets.tcgdex.net/en/sv/svp/051/high.png" },
  ]);
});

test("the exact physical scope rejects Pocket, error bodies, repository envelopes and unrelated image paths", () => {
  const source = JSON.parse(readFileSync(new URL("tcgdex-snorlax-svp-051.body", fixture), "utf8"));
  const context = { url: "https://api.tcgdex.net/v2/en/cards/svp-051", mediaType: "application/json" };
  for (const name of ["snorlax-svp-051.json", "source-snorlax-svp-051.json"])
    expect(() =>
      tcgdexPokemonSourceAdapterRegistration.parseBytes(readFileSync(new URL(name, fixture)), context),
    ).toThrow(AdapterParseFailure);
  expect(() => tcgdexPokemonSourceAdapterRegistration.parseBytes(new Uint8Array([255]), context)).toThrow(
    AdapterParseFailure,
  );
  const pocket = { ...source, id: "A1-001", set: { id: "A1", series: { id: "tcgp" } }, localId: "001" };
  expect(() =>
    tcgdexPokemonSourceAdapterRegistration.parseBytes(new TextEncoder().encode(JSON.stringify(pocket)), {
      ...context,
      url: "https://api.tcgdex.net/v2/en/cards/A1-001",
    }),
  ).toThrow(AdapterParseFailure);
  const otherImage = { ...source, image: "https://assets.tcgdex.net/en/base/base1/4" };
  expect(() =>
    tcgdexPokemonSourceAdapterRegistration.parseBytes(new TextEncoder().encode(JSON.stringify(otherImage)), context),
  ).toThrow(AdapterParseFailure);
});

test("the Pokémon Game Profile represents playable full-art Snorlax without inventing printed content or regional facts", () => {
  const observations = tcgdexPokemonSourceAdapterRegistration.parseBytes(
    readFileSync(new URL("tcgdex-snorlax-svp-051.body", fixture)),
    { url: "https://api.tcgdex.net/v2/en/cards/svp-051", mediaType: "application/json" },
  );
  const result = parseReconciliationObservation("retained-snorlax-plain", observations[0]);
  if (result.kind !== "card_printing") throw new Error("Expected Card and Printing evidence");
  expect(result.observedCardAndPrinting.card).toMatchObject({
    category: "gameplay",
    gameplay_applicability: "applicable",
    related_cards: [],
    game_data: {
      attributes: {
        abilities: [
          {
            kind: "Ability",
            name: "Voraciousness",
            text: "Once during your turn, you may put up to 2 Leftovers cards from your discard pile into your hand.",
          },
        ],
        attacks: [
          {
            name: "Thudding Press",
            damage: "130",
            cost: ["Colorless", "Colorless", "Colorless"],
            text: "This Pokémon also does 30 damage to itself.",
          },
        ],
      },
    },
  });
  expect(result.observedCardAndPrinting.printing).toMatchObject({
    printed_rules_text: null,
    game_data: { attributes: { reverse_face: null } },
  });
  expect(result.noveltyProofComplete).toBe(false);
});

test("the real duplicate marketplace IDs do not merge first-edition and unstamped shadowless Charizard", () => {
  const observations = tcgdexPokemonSourceAdapterRegistration.parseBytes(
    readFileSync(new URL("tcgdex-charizard-base1-4.body", fixture)),
    { url: "https://api.tcgdex.net/v2/en/cards/base1-4", mediaType: "application/json" },
  );
  expect(observations.map((o) => o.printing.game_data.attributes)).toMatchObject([
    { finish: "holo", edition: "unlimited", stamps: [] },
    { finish: "holo", edition: "shadowless", stamps: ["1st-edition"] },
    { finish: "holo", edition: "shadowless", stamps: [] },
    { finish: "holo", edition: "1999-2000-copyright", stamps: [] },
  ]);
  const raw = JSON.parse(observations[0]!.source_sidecar.source_record_json);
  expect(raw.variants_detailed[1].thirdParty).toEqual({ tcgplayer: 106999, cardmarket: 660224 });
  expect(raw.variants_detailed[2].thirdParty).toEqual(raw.variants_detailed[1].thirdParty);
  expect(new Set(observations.map((o) => o.identity_evidence.locator)).size).toBe(4);
  // The actual shared scan has a visible 1st Edition stamp and shadowless frame.
  expect(observations.map((o) => o.appearance_evidence.images.length)).toEqual([0, 1, 0, 0]);
});

test("unknown TCGdex fields remain attributable warnings rather than silently changing the Pokémon profile", () => {
  const source = JSON.parse(readFileSync(new URL("tcgdex-snorlax-svp-051.body", fixture), "utf8"));
  source.new_source_field = { experimental: 0.5 }; // Controlled forward-vocabulary change.
  const [observation] = tcgdexPokemonSourceAdapterRegistration.parseBytes(
    new TextEncoder().encode(JSON.stringify(source)),
    { url: "https://api.tcgdex.net/v2/en/cards/svp-051", mediaType: "application/json" },
  );
  const parsed = parseReconciliationObservation("controlled-unknown-field", observation);
  if (parsed.kind !== "card_printing") throw new Error("Expected Card evidence");
  expect(parsed.sourceWarnings).toContainEqual(
    expect.objectContaining({
      code: "unknown_source_field",
      path: "tcgdex_card.new_source_field",
      raw_value: '{"experimental":0.5}',
    }),
  );
});
