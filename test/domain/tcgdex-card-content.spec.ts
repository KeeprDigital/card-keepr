import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { tcgdexCardContent } from "../../src/catalogue/adapters/tcgdex-card-content";
import { canonicalProfileAttributes } from "../../src/catalogue/shared/reconciliation-profile";

const fixture = new URL("../../acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/raw/", import.meta.url);
const card = (id: string) => JSON.parse(readFileSync(new URL(`card-${id}.body`, fixture), "utf8"));

test("retained Professor's Research maps a Supporter effect with explicit non-creature applicability", () => {
  const content = tcgdexCardContent(card("swsh9-147"));
  const warnings: Parameters<typeof canonicalProfileAttributes>[4] = [];
  const attributes = canonicalProfileAttributes(
    "retained-professor",
    "pokemon@1",
    "card",
    content.attributes,
    warnings,
  );
  expect(attributes).toMatchObject({
    card_type: "trainer",
    trainer_type: "Supporter",
    hp: null,
    types: [],
    stage: null,
    attacks: [],
    retreat_cost: null,
    effect_text: "Discard your hand and draw 7 cards.",
    regulation_mark: "D",
  });
  expect(content.effectiveRulesText).toBe("Discard your hand and draw 7 cards.");
  expect(warnings).toEqual([]);
});

test("historical subtype absence and inapplicable source retreat remain explicit without becoming Card facts", () => {
  const historical = tcgdexCardContent(card("base1-94"));
  expect(historical.attributes.trainer_type).toBeNull();
  expect(historical.effectiveRulesText).toBe("Remove up to 2 damage counters from 1 of your Pokémon.");
  const kit = tcgdexCardContent(card("tk-ex-latia-8"));
  expect(kit.attributes).toMatchObject({ trainer_type: "Item", retreat_cost: null });
  expect(kit.inapplicableSourceFields).toContainEqual({ path: "tcgdex_card.retreat", value: "0" });
});

test("additional Trainer gameplay evidence must be qualified instead of being discarded into a sidecar", () => {
  for (const changes of [{ hp: 60 }, { retreat: 1 }, { attacks: [{ name: "Extra attack" }] }])
    expect(() => tcgdexCardContent({ ...card("swsh9-147"), ...changes })).toThrow(/qualification/u);
});

test("the retained Mysterious Fossil keeps printed Trainer HP and its conditional gameplay wording", () => {
  const source = card("base3-62");
  const content = tcgdexCardContent(source);
  expect(content.attributes).toMatchObject({
    card_type: "trainer",
    trainer_type: null,
    hp: 10,
    types: [],
    stage: null,
    abilities: [],
    attacks: [],
    retreat_cost: null,
    effect_text: source.effect,
  });
  expect(content.effectiveRulesText).toBe(source.effect);
  expect(content.inapplicableSourceFields).toEqual([]);
  expect(content.physicalContentEvidence).toContainEqual({
    sourceUrl: "https://assets.tcgdex.net/en/base/base3/62/high.png",
    contentSha256: "82021f7db6451e04db5382fa3034126a31eeb2b0596d7157ac6036afde750bd8",
    field: "hp",
  });
  expect(canonicalProfileAttributes(source.id, "pokemon@1", "card", content.attributes, [])).toEqual(
    content.attributes,
  );
  for (const changes of [
    { id: "unqualified-fossil" },
    { hp: 20 },
    { image: "https://assets.tcgdex.net/en/base/base3/61" },
  ])
    expect(() => tcgdexCardContent({ ...source, ...changes })).toThrow(/qualification/u);
});

test("the retained Basic Energy pair and Special Energy preserve evidenced provision without creature attributes", () => {
  for (const id of ["base1-98", "base4-126"]) {
    const content = tcgdexCardContent(card(id));
    expect(content.attributes).toMatchObject({
      card_type: "energy",
      energy_kind: "basic",
      provided_energy: { state: "fixed", units: ["Fire"] },
      effect_text: null,
      stage: null,
      types: [],
      retreat_cost: null,
    });
    expect(content.effectiveRulesText).toBeNull();
    expect(canonicalProfileAttributes(id, "pokemon@1", "card", content.attributes, [])).toEqual(content.attributes);
  }
  const special = tcgdexCardContent(card("base1-96"));
  expect(special.attributes).toMatchObject({
    energy_kind: "special",
    provided_energy: { state: "fixed", units: ["Colorless", "Colorless"] },
    effect_text: "Provides {C}{C} energy.\nDoesn't count as a basic Energy card.",
  });
  expect(special.effectiveRulesText).toBe("Provides {C}{C} energy.\nDoesn't count as a basic Energy card.");
});

test("conditional Energy wording and unfamiliar physical provision are retained without an unconditional claim", () => {
  const conditional = tcgdexCardContent({
    ...card("base1-96"),
    effect: "Provides {C}{C} energy only while this Pokémon is asleep.",
  });
  expect(conditional.attributes.provided_energy).toEqual({ state: "unknown", units: [] });
  expect(conditional.effectiveRulesText).toBe("Provides {C}{C} energy only while this Pokémon is asleep.");
  const anotherFire = tcgdexCardContent({ ...card("base1-98"), id: "different-source-record" });
  expect(anotherFire.attributes.provided_energy).toEqual({ state: "unknown", units: [] });
  expect(() => tcgdexCardContent({ ...card("base1-96"), hp: 60 })).toThrow(/qualification/u);
});

test("the existing pilot Pokemon content keeps the exact previously qualified attributes and complete rules", () => {
  const pilot = new URL("../../acceptance/fixtures/real-sources/2026-09-14-pokemon/raw/", import.meta.url);
  // Fixed outputs from actual merged 88b526, before the content mapper extraction.
  // There is no automatic golden replacement path.
  for (const [filename, expectedDigest] of [
    ["tcgdex-snorlax-svp-051.body", "d751e47efe36b5b22b24ce8accebfbc7d8717d184f10fa6cf937195bf5cf8586"],
    ["tcgdex-charizard-base1-4.body", "f57cd78f3f317d461c0e2feef01abeef7c1e5f0cce2887cc70b908b824ee845b"],
  ]) {
    const { attributes, effectiveRulesText, inapplicableSourceFields } = tcgdexCardContent(
      JSON.parse(readFileSync(new URL(filename!, pilot), "utf8")),
    );
    expect(createHash("sha256").update(JSON.stringify({ attributes, effectiveRulesText })).digest("hex")).toBe(
      expectedDigest,
    );
    expect(inapplicableSourceFields).toEqual([]);
  }
});
