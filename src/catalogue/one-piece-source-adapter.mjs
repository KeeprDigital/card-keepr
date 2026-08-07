const colourOrder = [
  "red",
  "green",
  "blue",
  "purple",
  "black",
  "yellow",
  "white",
  "colourless",
];

const cardTypes = new Map([
  ["leader", "leader"],
  ["character", "character"],
  ["event", "event"],
  ["stage", "stage"],
]);

const illustrationTypes = new Map([
  ["comic", "comic"],
  ["animation", "animation"],
  ["original", "original"],
  ["other", "other"],
]);

const rarities = new Map([
  ["l", "leader"],
  ["c", "common"],
  ["uc", "uncommon"],
  ["r", "rare"],
  ["sr", "super-rare"],
  ["sec", "secret-rare"],
  ["p", "promo"],
  ["sp", "special"],
  // The live Card List prints the special rarity as "SP CARD"
  // (verified 2026-08-07 on the OP-16 series listing).
  ["sp card", "special"],
  ["tr", "treasure-rare"],
]);

export function normalizeOnePieceCardPage(value) {
  const cardType = controlledValue(
    value.Category,
    cardTypes,
    "One Piece Category",
  );
  const colours = uniqueValues(value.Color, "One Piece Color")
    .map((colour) => normalizedToken(colour))
    .map((colour) => {
      if (!colourOrder.includes(colour)) {
        throw new Error(`One Piece Color has unrecognized value ${colour}.`);
      }
      return colour;
    })
    .sort((left, right) =>
      colourOrder.indexOf(left) - colourOrder.indexOf(right)
    );
  if (colours.length === 0) {
    throw new Error("One Piece Color is required.");
  }
  const printing = optionalRecord(value.printing, "One Piece Printing");
  if (printing?.normalized_rarity !== undefined) {
    throw new Error(
      "One Piece raw Printing fields cannot supply normalized rarity.",
    );
  }
  const rawIllustrationTypes = optionalRecord(
    printing?.attributes,
    "One Piece Printing attributes",
  )?.illustration_types;
  const normalizedIllustrationTypes = rawIllustrationTypes === undefined
    ? []
    : uniqueValues(
        rawIllustrationTypes,
        "One Piece illustration filter membership",
      ).map((item) => illustrationTypes.get(normalizedToken(item)))
      .filter((item) => item !== undefined)
      .sort();
  const cost = nonNegativeIntegerOrNull(value.Cost, "One Piece Cost");
  const life = nonNegativeIntegerOrNull(value.Life, "One Piece Life");
  assertOnePieceTypeNullability(cardType, cost, life);
  return {
    normalizedRarity: printing === null
      ? null
      : normalizedOnePieceRarity(printing.rarity),
    attributes: {
      card_type: cardType,
      colours,
      cost,
      life,
      battle_attributes: uniqueValues(
        value.Attribute,
        "One Piece Attribute",
      ).map(normalizedToken).sort(),
      power: nonNegativeIntegerOrNull(value.Power, "One Piece Power"),
      counter: nonNegativeIntegerOrNull(value.Counter, "One Piece Counter"),
      traits: uniqueValues(value.Type, "One Piece Type")
        .map(normalizedText).sort(),
      block_icons: uniqueValues(
        value["Block icon"],
        "One Piece Block icon",
      ).map(normalizedText).sort(),
      effect_text: nullableText(value.Effect, "One Piece Effect"),
      trigger_text: nullableText(value.Trigger, "One Piece Trigger"),
    },
    printingAttributes: normalizedIllustrationTypes.length === 0
      ? undefined
      : { illustration_types: normalizedIllustrationTypes },
  };
}

export function onePieceDonCardObservation(value) {
  const card = requiredRecord(value, "One Piece DON!! rules Card evidence");
  const fields = ["functional_designation", "name", "Category", "Effect"];
  const undeclared = Object.keys(card).filter((field) =>
    !fields.includes(field)
  );
  if (undeclared.length > 0) {
    throw new Error(
      `One Piece DON!! Card contains undeclared fields: ${undeclared.sort().join(", ")}.`,
    );
  }
  if (
    normalizedText(card.functional_designation) !== "DON!!" ||
    normalizedToken(card.Category) !== "don!! card"
  ) {
    throw new Error(
      "One Piece DON!! rules must use the exact functional designation.",
    );
  }
  const name = normalizedText(card.name);
  const effect = nullableText(card.Effect, "One Piece DON!! rules text");
  if (name.length === 0 || effect === null) {
    throw new Error("One Piece DON!! rules are incomplete.");
  }
  return {
    completeness: {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 1,
      parsed_record_count: 1,
    },
    card: {
      game: "one-piece",
      official_identity: {
        kind: "functional_designation",
        value: "DON!!",
      },
      name,
      effective_rules_text: effect,
      game_data: {
        profile: "one-piece@1",
        attributes: {
          card_type: "don",
          colours: [],
          cost: null,
          life: null,
          battle_attributes: [],
          power: null,
          counter: null,
          traits: [],
          block_icons: [],
          effect_text: effect,
          trigger_text: null,
        },
      },
    },
    memberships: {
      products: [],
      distribution_contexts: [],
      source_buckets: ["don-rules"],
    },
    product_release_catalogue: {
      products: [],
      distribution_contexts: [],
      relationships: [],
    },
    source_sidecar: {
      raw: { don_card: card },
      consumed_fields: [
        "don_card.Category",
        "don_card.Effect",
        "don_card.functional_designation",
        "don_card.name",
      ],
      unmapped_optional_fields: [],
    },
  };
}

export function normalizedOnePieceRarity(value) {
  const raw = nullableText(value, "One Piece Printing rarity");
  if (raw === null) return null;
  const normalized = rarities.get(normalizedToken(raw));
  if (normalized === undefined) {
    throw new Error(`One Piece rarity has unrecognized value ${raw}.`);
  }
  return normalized;
}

function assertOnePieceTypeNullability(cardType, cost, life) {
  if (cardType === "leader" && cost !== null) {
    throw new Error("One Piece Leader cost must be null.");
  }
  if (cardType !== "leader" && life !== null) {
    throw new Error(`One Piece ${cardType} life must be null.`);
  }
  if (cardType !== "leader" && cost === null) {
    throw new Error(`One Piece ${cardType} cost must be non-null.`);
  }
  if (cardType === "leader" && life === null) {
    throw new Error("One Piece Leader life must be non-null.");
  }
}

export function onePieceRecordingMemberships(value) {
  if (!Array.isArray(value)) {
    throw new Error("One Piece Recording partitions are invalid.");
  }
  const memberships = new Map();
  for (const item of value) {
    const partition = requiredRecord(item, "One Piece Recording partition");
    const recording = normalizedText(partition.bucket);
    if (!Array.isArray(partition.entries)) {
      throw new Error("One Piece Recording partition identity is invalid.");
    }
    if (!/^\d+$/u.test(recording)) continue;
    for (const entryValue of partition.entries) {
      const entry = requiredRecord(entryValue, "One Piece Recording entry");
      const locator = normalizedText(entry.detail);
      if (locator.length === 0) {
        throw new Error("One Piece Recording entry locator is invalid.");
      }
      const recordings = memberships.get(locator) ?? new Set();
      recordings.add(`recording:${recording}`);
      memberships.set(locator, recordings);
    }
  }
  return new Map(
    [...memberships].map(([locator, recordings]) => [
      locator,
      [...recordings].sort(),
    ]),
  );
}

function controlledValue(
  value,
  vocabulary,
  name,
) {
  const raw = normalizedText(value);
  const normalized = vocabulary.get(normalizedToken(raw));
  if (normalized === undefined) {
    throw new Error(`${name} has unrecognized value ${raw}.`);
  }
  return normalized;
}

function uniqueValues(value, name) {
  const values = Array.isArray(value) ? value : value === null ? [] : [value];
  const normalized = values.map((item) => {
    const text = normalizedText(item);
    if (text.length === 0) throw new Error(`${name} contains an empty value.`);
    return text;
  });
  return [...new Set(normalized)];
}

function nonNegativeIntegerOrNull(value, name) {
  if (value === null || value === undefined || value === "" || value === "-") {
    return null;
  }
  const normalized = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${name} is not a non-negative integer.`);
  }
  return normalized;
}

function nullableText(value, name) {
  if (value === null || value === undefined || value === "" || value === "-") {
    return null;
  }
  if (typeof value !== "string") throw new Error(`${name} is invalid.`);
  const text = normalizedText(value);
  return text.length === 0 ? null : text;
}

function normalizedToken(value) {
  return normalizedText(value).toLocaleLowerCase();
}

function normalizedText(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").replaceAll(/\s+/gu, " ").trim();
}

function requiredRecord(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function optionalRecord(
  value,
  name,
) {
  if (value === undefined || value === null) return null;
  return requiredRecord(value, name);
}
