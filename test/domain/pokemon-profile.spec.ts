import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { profileWire } from "../../src/catalogue/read/http-contract";
import { expect, test } from "vitest";
import {
  canonicalProfileAttributes,
  exportedGameProfileSchema,
  requiredProfileContract,
} from "../../src/catalogue/shared/reconciliation-profile";

const trainer = {
  card_type: "trainer",
  hp: null,
  types: [],
  stage: null,
  evolves_from: null,
  abilities: [],
  attacks: [],
  weaknesses: [],
  resistances: [],
  retreat_cost: null,
  regulation_mark: "D",
  trainer_type: "Supporter",
  effect_text: "Discard your hand and draw 7 cards.",
};

test("the Pokémon profile preserves a Trainer subtype and standalone effect without fictitious attacks", () => {
  const warnings: Parameters<typeof canonicalProfileAttributes>[4] = [];
  const parsed = canonicalProfileAttributes("retained-swsh9-147", "pokemon@1", "card", trainer, warnings);
  expect(parsed).toEqual(trainer);
  expect(warnings).toEqual([]);
});

test("Trainer applicability rejects creature-only facts and requires explicit effect/subtype evidence states", () => {
  for (const attributes of [
    { ...trainer, stage: "Basic" },
    { ...trainer, retreat_cost: 0 },
    { ...trainer, types: ["Fire"] },
    { ...trainer, attacks: [{ name: "Invented", cost: [], damage: null, text: trainer.effect_text }] },
    Object.fromEntries(Object.entries(trainer).filter(([key]) => key !== "trainer_type")),
    Object.fromEntries(Object.entries(trainer).filter(([key]) => key !== "effect_text")),
  ])
    expect(() => canonicalProfileAttributes("trainer-applicability", "pokemon@1", "card", attributes, [])).toThrow();
  expect(
    canonicalProfileAttributes(
      "historical-subtype-unknown",
      "pokemon@1",
      "card",
      { ...trainer, trainer_type: null },
      [],
    ),
  ).toMatchObject({ trainer_type: null, effect_text: "Discard your hand and draw 7 cards." });
});

test("Energy preserves kind, explicit resource provision and full effect without Pokémon stage or types", () => {
  const { trainer_type: _subtype, ...base } = trainer;
  const basic = {
    ...base,
    card_type: "energy",
    regulation_mark: null,
    energy_kind: "basic",
    effect_text: null,
    provided_energy: { state: "fixed", units: ["Fire"] },
  };
  const special = {
    ...base,
    card_type: "energy",
    regulation_mark: null,
    energy_kind: "special",
    effect_text: "Provides {C}{C} energy.\nDoesn't count as a basic Energy card.",
    provided_energy: { state: "fixed", units: ["Colorless", "Colorless"] },
  };
  for (const attributes of [basic, special]) {
    const warnings: Parameters<typeof canonicalProfileAttributes>[4] = [];
    expect(canonicalProfileAttributes("retained-energy", "pokemon@1", "card", attributes, warnings)).toEqual(
      attributes,
    );
    expect(warnings).toEqual([]);
  }
  const unknownProvision = {
    ...special,
    effect_text: "Provides Energy only under the printed condition.",
    provided_energy: { state: "unknown", units: [] },
  };
  expect(
    canonicalProfileAttributes("controlled-conditional-energy", "pokemon@1", "card", unknownProvision, []),
  ).toHaveProperty("provided_energy", { state: "unknown", units: [] });
});

test("Pokemon and Trainer data cannot carry an Energy provision, and unknown Energy cannot assert fixed units", () => {
  const energy = {
    ...trainer,
    card_type: "energy",
    energy_kind: "special",
    provided_energy: { state: "unknown", units: ["Fire"] },
  };
  for (const attributes of [
    energy,
    { ...trainer, provided_energy: { state: "fixed", units: ["Fire"] } },
    { ...trainer, energy_kind: "basic" },
    { ...trainer, card_type: "pokemon" },
  ])
    expect(() => canonicalProfileAttributes("inapplicable-fields", "pokemon@1", "card", attributes, [])).toThrow();
});

test("published and exported Pokémon schemas enforce the same Trainer and Energy applicability", () => {
  const validate = new Ajv2020({ strict: false }).compile(exportedGameProfileSchema("pokemon@1"));
  const wire = profileWire(requiredProfileContract("pokemon@1").card);
  const httpAjv = new Ajv2020({ strict: false });
  addFormats(httpAjv);
  httpAjv.addSchema(JSON.parse(readFileSync("contracts/read-openapi.json", "utf8")), "catalogue-read");
  const validateHttp = httpAjv.getSchema("catalogue-read#/components/schemas/CardCollection")!;
  const response = (attributes: unknown) => ({
    data: [
      {
        type: "card",
        id: "card_trainer",
        game: "pokemon",
        category: "gameplay",
        gameplay_applicability: "applicable",
        official_identity: { kind: "unknown", value: null },
        name: "Retained Pokémon card",
        related_cards: [],
        game_data: { profile: "pokemon@1", attributes },
        lifecycle: { first_revision_id: "catrev_1", last_observed_revision_id: "catrev_1", withdrawn: false },
        links: { self: "https://catalogue.invalid/v1/cards/card_trainer" },
      },
    ],
    meta: { catalogue_revision_id: "catrev_1", published_at: "2026-09-15T00:00:00.000Z" },
    page: { limit: 1, next_cursor: null },
    links: { self: "https://catalogue.invalid/v1/cards" },
  });
  const printing = {
    set_code: "swsh9",
    collector_number: "147",
    finish: "holo",
    edition: null,
    size: "standard",
    stamps: [],
    artists: ["Sanosuke Sakuma"],
    reverse_face: null,
  };
  const exported = (card: unknown) => ({ category: "gameplay", gameplay_applicability: "applicable", card, printing });
  expect(validate(exported(trainer))).toBe(true);
  expect(wire.safeParse(trainer).success).toBe(true);
  expect(validateHttp(response(trainer))).toBe(true);
  // Printed HP also exists on Trainers such as the retained Mysterious Fossil.
  // Source qualification owns whether a particular record proves that value.
  const printedHpTrainer = { ...trainer, trainer_type: null, hp: 10 };
  expect(canonicalProfileAttributes("printed-trainer-hp", "pokemon@1", "card", printedHpTrainer, [])).toEqual(
    printedHpTrainer,
  );
  expect(validate(exported(printedHpTrainer))).toBe(true);
  expect(wire.safeParse(printedHpTrainer).success).toBe(true);
  expect(validateHttp(response(printedHpTrainer))).toBe(true);
  const { trainer_type: _subtype, ...energyBase } = trainer;
  const unknownEnergy = {
    ...energyBase,
    card_type: "energy",
    energy_kind: "special",
    provided_energy: { state: "unknown", units: [] },
  };
  for (const card of [unknownEnergy, { ...unknownEnergy, provided_energy: { state: "fixed", units: ["Fire"] } }]) {
    expect(validate(exported(card))).toBe(true);
    expect(wire.safeParse(card).success).toBe(true);
    expect(validateHttp(response(card))).toBe(true);
  }
  for (const card of [
    { ...trainer, hp: -10 },
    { ...trainer, retreat_cost: 0 },
    { ...trainer, energy_kind: "special" },
    Object.fromEntries(Object.entries(trainer).filter(([key]) => key !== "effect_text")),
    ...[trainer, unknownEnergy].flatMap((attributes) => [
      { ...attributes, types: ["Fire"] },
      { ...attributes, abilities: [{ name: "Invented", text: "Unestablished ability" }] },
      { ...attributes, attacks: [{ name: "Invented", cost: [], damage: null, text: "Unestablished attack" }] },
      { ...attributes, weaknesses: [{ type: "Fire", value: "x2" }] },
      { ...attributes, resistances: [{ type: "Fire", value: "-20" }] },
    ]),
    { ...unknownEnergy, provided_energy: { state: "unknown", units: ["Fire"] } },
    { ...unknownEnergy, provided_energy: { state: "fixed", units: [] } },
  ]) {
    expect(validate(exported(card))).toBe(false);
    expect(wire.safeParse(card).success).toBe(false);
    expect(validateHttp(response(card))).toBe(false);
  }
});
