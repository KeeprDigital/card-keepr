import { AdapterParseFailure } from "./adapter-parse-failure";

/** Card content is independent of set membership, design identity and Printing qualification. */
export function tcgdexCardContent(card: Readonly<Record<string, unknown>>): {
  attributes: Record<string, unknown>;
  effectiveRulesText: string | null;
  inapplicableSourceFields: { path: string; value: string }[];
  physicalContentEvidence?: { sourceUrl: string; contentSha256: string; field: string }[];
} {
  if (card.category === "Pokemon") return pokemonContent(card);
  if (card.category === "Energy") return energyContent(card);
  if (card.category !== "Trainer")
    throw new AdapterParseFailure("TCGdex Card category has no qualified content mapping.");
  const effect = text(card.effect);
  // The inspected first-edition front explicitly prints TRAINER and 10 HP.
  // This qualifies that printed field only; its conditional in-play rules do
  // not turn the catalogue Card into a Pokémon or assign another treatment.
  const fossilHp =
    card.id === "base3-62" &&
    card.name === "Mysterious Fossil" &&
    card.hp === 10 &&
    card.localId === "62" &&
    record(card.set).id === "base3" &&
    card.image === "https://assets.tcgdex.net/en/base/base3/62";
  const inapplicableSourceFields: { path: string; value: string }[] = [];
  for (const field of [
    "hp",
    "types",
    "stage",
    "evolveFrom",
    "abilities",
    "attacks",
    "weaknesses",
    "resistances",
    "retreat",
  ]) {
    const value = card[field];
    if (value === undefined) continue;
    if (field === "hp" && fossilHp) continue;
    if (field === "retreat" && value === 0)
      inapplicableSourceFields.push({ path: `tcgdex_card.${field}`, value: JSON.stringify(value) });
    else
      throw new AdapterParseFailure(
        "TCGdex Trainer contains additional gameplay evidence requiring profile qualification.",
      );
  }
  return {
    attributes: {
      card_type: "trainer",
      hp: fossilHp ? 10 : null,
      types: [],
      stage: null,
      evolves_from: null,
      abilities: [],
      attacks: [],
      weaknesses: [],
      resistances: [],
      retreat_cost: null,
      regulation_mark: optionalText(card.regulationMark),
      trainer_type: optionalText(card.trainerType),
      effect_text: effect,
    },
    effectiveRulesText: effect,
    inapplicableSourceFields,
    ...(fossilHp
      ? {
          physicalContentEvidence: [
            {
              sourceUrl: "https://assets.tcgdex.net/en/base/base3/62/high.png",
              contentSha256: "82021f7db6451e04db5382fa3034126a31eeb2b0596d7157ac6036afde750bd8",
              field: "hp",
            },
          ],
        }
      : {}),
  };
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.length)
    throw new AdapterParseFailure("TCGdex required content text is absent or invalid.");
  return value;
}
function optionalText(value: unknown) {
  return value === undefined ? null : text(value);
}

function energyContent(card: Readonly<Record<string, unknown>>) {
  const kind =
    card.energyType === "Special"
      ? "special"
      : card.energyType === "Basic" || (card.energyType === "Normal" && card.stage === "Basic")
        ? "basic"
        : "unknown";
  const effect = optionalText(card.effect);
  for (const field of ["hp", "types", "evolveFrom", "abilities", "attacks", "weaknesses", "resistances", "retreat"])
    if (card[field] !== undefined)
      throw new AdapterParseFailure(
        "TCGdex Energy contains additional gameplay evidence requiring profile qualification.",
      );
  if (card.stage !== undefined && !(kind === "basic" && card.stage === "Basic"))
    throw new AdapterParseFailure("TCGdex Energy stage requires profile qualification.");
  const proof = basicFireProofs[String(card.id)];
  const set = card.set as { id?: unknown } | undefined;
  const hasFireProof =
    proof !== undefined &&
    kind === "basic" &&
    card.name === "Fire Energy" &&
    set?.id === proof.setId &&
    card.localId === proof.localId &&
    card.image === proof.image &&
    effect === null;
  const doubleColorless =
    kind === "special" && effect === "Provides {C}{C} energy.\nDoesn't count as a basic Energy card.";
  return {
    attributes: {
      card_type: "energy",
      hp: null,
      types: [],
      stage: null,
      evolves_from: null,
      abilities: [],
      attacks: [],
      weaknesses: [],
      resistances: [],
      retreat_cost: null,
      regulation_mark: optionalText(card.regulationMark),
      energy_kind: kind,
      effect_text: effect,
      provided_energy: hasFireProof
        ? { state: "fixed", units: ["Fire"] }
        : doubleColorless
          ? { state: "fixed", units: ["Colorless", "Colorless"] }
          : { state: "unknown", units: [] },
    },
    effectiveRulesText: effect,
    inapplicableSourceFields: [],
    physicalContentEvidence: hasFireProof
      ? [{ sourceUrl: `${proof.image}/high.png`, contentSha256: proof.sha256, field: "provided_energy" }]
      : [],
  };
}

// These exact inspected fronts establish Fire provision. A shared name is not
// sufficient for any other record, or for cross-reprint identity qualification.
const basicFireProofs: Readonly<Record<string, { setId: string; localId: string; image: string; sha256: string }>> = {
  "base1-98": {
    setId: "base1",
    localId: "98",
    image: "https://assets.tcgdex.net/en/base/base1/98",
    sha256: "b37b463cd43a7f6eeac0c9619f2e950d50b8984bf4436f134c48ff8167460830",
  },
  "base4-126": {
    setId: "base4",
    localId: "126",
    image: "https://assets.tcgdex.net/en/base/base4/126",
    sha256: "b71878ddd2b261c752465e233f43a004d3722a13126dccbbcc1a907d499433ec",
  },
};

function pokemonContent(card: Readonly<Record<string, unknown>>) {
  const attributes = {
    card_type: "pokemon",
    hp: integer(card.hp),
    types: list(card.types).map(text),
    stage: optionalText(card.stage),
    evolves_from: optionalText(card.evolveFrom),
    abilities: optionalList(card.abilities).map((entry) => {
      const ability = record(entry);
      return { kind: optionalText(ability.type), name: text(ability.name), text: text(ability.effect) };
    }),
    attacks: optionalList(card.attacks).map((entry) => {
      const attack = record(entry);
      return {
        name: text(attack.name),
        cost: list(attack.cost).map(text),
        damage:
          attack.damage === undefined
            ? null
            : typeof attack.damage === "number"
              ? String(integer(attack.damage))
              : text(attack.damage),
        text: optionalText(attack.effect),
      };
    }),
    weaknesses: relations(card.weaknesses),
    resistances: relations(card.resistances),
    retreat_cost: card.retreat === undefined ? null : integer(card.retreat),
    regulation_mark: optionalText(card.regulationMark),
  };
  return {
    attributes,
    effectiveRulesText:
      [
        ...attributes.abilities.map((ability) => `${ability.name}: ${ability.text}`),
        ...attributes.attacks.map((attack) => `${attack.name}${attack.text === null ? "" : `: ${attack.text}`}`),
      ].join("\n") || null,
    inapplicableSourceFields: [],
  };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new AdapterParseFailure("TCGdex required object is missing.");
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new AdapterParseFailure("TCGdex required array is missing.");
  return value;
}

function optionalList(value: unknown) {
  return value === undefined ? [] : list(value);
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new AdapterParseFailure("TCGdex required integer is invalid.");
  return value;
}

function relations(value: unknown) {
  return optionalList(value).map((entry) => {
    const relation = record(entry);
    return { type: text(relation.type), value: text(relation.value) };
  });
}
