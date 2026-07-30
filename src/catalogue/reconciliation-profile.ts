import type { SupportedGame } from "./catalogue-candidate";
import { canonicalJson } from "./serialization";

export type ProfileWarning = Readonly<{
  code: "unknown_source_vocabulary" | "unknown_source_field";
  source_observation_id: string;
  profile: string;
  path: string;
  raw_value: string;
  detail: string;
}>;

type Schema =
  | { kind: "string"; nullable?: boolean; minimumLength?: number }
  | { kind: "integer"; nullable?: boolean; minimum?: number }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }
  | {
      kind: "array";
      items: Schema;
      unique?: boolean;
      minimumItems?: number;
      maximumItems?: number;
    }
  | {
      kind: "object";
      required: readonly string[];
      properties: Readonly<Record<string, Schema>>;
    };

type ProfileContract = Readonly<{
  game: SupportedGame;
  card: Extract<Schema, { kind: "object" }>;
  printing: Extract<Schema, { kind: "object" }>;
  validateCard: (value: Record<string, unknown>) => void;
}>;

const colours = array(
  enumeration([
    "red",
    "green",
    "blue",
    "purple",
    "black",
    "yellow",
    "white",
    "colourless",
  ]),
  true,
);
const strings = array(string(), true);
const nullableInteger = integer(true);
const nullableText = string(true);
const typedText = object(["kind", "text"], {
  kind: enumeration(["ordinary", "front", "back"]),
  text: string(),
});
const digimonText = object(["kind", "text"], {
  kind: enumeration([
    "effect",
    "inherited_effect",
    "security_effect",
    "rule",
    "special_digivolution_condition",
    "dual_effect",
    "dual_rule",
    "link_condition",
    "link_effect",
  ]),
  text: string(),
});

const profileContracts: Readonly<Record<string, ProfileContract>> = {
  "one-piece@1": {
    game: "one-piece",
    card: object(
      [
        "card_type",
        "colours",
        "cost",
        "life",
        "battle_attributes",
        "power",
        "counter",
        "traits",
        "block_icons",
        "effect_text",
        "trigger_text",
      ],
      {
        card_type: enumeration([
          "leader",
          "character",
          "event",
          "stage",
          "don",
        ]),
        colours,
        cost: nullableInteger,
        life: nullableInteger,
        battle_attributes: strings,
        power: nullableInteger,
        counter: nullableInteger,
        traits: strings,
        block_icons: strings,
        effect_text: nullableText,
        trigger_text: nullableText,
      },
    ),
    printing: object([], {
      illustration_types: array(
        enumeration(["comic", "animation", "original", "other"]),
        true,
      ),
    }),
    validateCard(value) {
      if (
        value.card_type === "leader" &&
        !isNonNegativeInteger(value.life)
      ) {
        throw new Error("A One Piece Leader requires non-negative life.");
      }
      if (
        ["character", "event", "stage"].includes(String(value.card_type)) &&
        !isNonNegativeInteger(value.cost)
      ) {
        throw new Error(
          "A One Piece Character, Event, or Stage requires non-negative cost.",
        );
      }
      if (
        value.card_type === "don" &&
        (!Array.isArray(value.colours) ||
          value.colours.length !== 0 ||
          value.cost !== null ||
          value.life !== null ||
          value.power !== null ||
          value.counter !== null)
      ) {
        throw new Error("The One Piece DON!! profile shape is invalid.");
      }
    },
  },
  "fusion-world@1": {
    game: "fusion-world",
    card: object(
      [
        "card_type",
        "colours",
        "cost",
        "specified_cost",
        "power",
        "combo_power",
        "traits",
        "skills",
      ],
      {
        card_type: enumeration([
          "leader",
          "battle",
          "extra",
          "energy_marker",
        ]),
        colours,
        cost: nullableInteger,
        specified_cost: array(
          object(["colour", "count"], {
            colour: enumeration(["red", "blue", "green", "yellow", "black"]),
            count: integer(false, 1),
          }),
        ),
        power: nullableInteger,
        combo_power: nullableInteger,
        traits: strings,
        skills: array(typedText),
        leader_faces: array(
          object(["role", "name", "traits", "skills"], {
            role: enumeration(["front", "back"]),
            name: string(false, 1),
            power: nullableInteger,
            traits: strings,
            skills: string(),
          }),
          false,
          2,
          2,
        ),
      },
    ),
    printing: object([], {}),
    validateCard(value) {
      if (value.card_type !== "leader") return;
      if (!Array.isArray(value.leader_faces)) {
        throw new Error("A Fusion World Leader requires two canonical faces.");
      }
      const roles = value.leader_faces.map((face) =>
        isRecord(face) ? face.role : null,
      );
      if (
        roles.length !== 2 ||
        new Set(roles).size !== 2 ||
        !roles.includes("front") ||
        !roles.includes("back")
      ) {
        throw new Error(
          "A Fusion World Leader requires one front and one back face.",
        );
      }
    },
  },
  "digimon@1": {
    game: "digimon",
    card: object(
      [
        "card_type",
        "colours",
        "level",
        "play_cost",
        "use_cost",
        "dp",
        "form",
        "attribute",
        "traits",
        "digivolution_requirements",
        "text_sections",
      ],
      {
        card_type: enumeration([
          "digi_egg",
          "digimon",
          "tamer",
          "option",
          "digimon_option",
        ]),
        colours,
        level: nullableInteger,
        play_cost: nullableInteger,
        use_cost: nullableInteger,
        dp: nullableInteger,
        form: nullableText,
        attribute: nullableText,
        traits: strings,
        digivolution_requirements: array(
          object(["cost"], {
            index: integer(false, 1),
            from_level: nullableInteger,
            colours,
            cost: integer(false),
            raw_condition: nullableText,
          }),
        ),
        text_sections: array(digimonText),
        dual_colours: colours,
        dual_cost: nullableInteger,
        link_dp: nullableInteger,
      },
    ),
    printing: object(["alternative_art"], {
      alternative_art: { kind: "boolean" },
    }),
    validateCard() {},
  },
  "gundam@1": {
    game: "gundam",
    card: object(
      [
        "card_type",
        "colours",
        "level",
        "cost",
        "block_icon",
        "effect_text",
        "zone",
        "traits",
        "link_condition",
        "ap",
        "hp",
        "series_titles",
      ],
      {
        card_type: enumeration([
          "unit",
          "pilot",
          "command",
          "base",
          "resource",
          "ex_base",
          "ex_resource",
          "unit_token",
        ]),
        colours,
        level: nullableInteger,
        cost: nullableInteger,
        block_icon: nullableText,
        effect_text: nullableText,
        zone: nullableText,
        traits: strings,
        link_condition: nullableText,
        ap: nullableInteger,
        hp: nullableInteger,
        series_titles: strings,
      },
    ),
    printing: object(["alternate_art"], {
      alternate_art: { kind: "boolean" },
    }),
    validateCard() {},
  },
};

export function requiredProfileContract(profile: string): ProfileContract {
  const contract = profileContracts[profile];
  if (contract === undefined) {
    throw new Error("Retained Card evidence has an unsupported profile binding.");
  }
  return contract;
}

export function exportedGameProfileSchema(profile: string) {
  const contract = requiredProfileContract(profile);
  return {
    type: "object",
    additionalProperties: false,
    required: ["card", "printing"],
    properties: {
      card: exportedSchema(contract.card),
      printing: exportedSchema(contract.printing),
    },
  };
}

export function validateMembershipPredicate(
  profile: string,
  attribute: string,
  includesAny: readonly string[],
): void {
  const schema = requiredProfileContract(profile).card.properties[attribute];
  if (schema === undefined) {
    throw new Error(
      `Legality Rule membership attribute ${attribute} is not defined by ${profile}.`,
    );
  }
  const vocabulary = membershipVocabulary(schema);
  if (vocabulary === undefined) {
    throw new Error(
      `Legality Rule membership attribute ${attribute} cannot be represented by ${profile}.`,
    );
  }
  if (vocabulary === null) return;
  const invalid = includesAny.find(
    (value) => !vocabulary.includes(value),
  );
  if (invalid !== undefined) {
    throw new Error(
      `Legality Rule membership value ${invalid} is not defined for ${profile} attribute ${attribute}.`,
    );
  }
}

function membershipVocabulary(
  schema: Schema,
): readonly string[] | null | undefined {
  if (schema.kind === "string") return null;
  if (schema.kind === "enum") return schema.values;
  if (schema.kind === "array") {
    return membershipVocabulary(schema.items);
  }
  return undefined;
}

function exportedSchema(schema: Schema): Record<string, unknown> {
  if (schema.kind === "string") {
    return {
      type: schema.nullable ? ["string", "null"] : "string",
      ...(schema.minimumLength === undefined
        ? {}
        : { minLength: schema.minimumLength }),
    };
  }
  if (schema.kind === "integer") {
    return {
      type: schema.nullable ? ["integer", "null"] : "integer",
      minimum: schema.minimum ?? 0,
    };
  }
  if (schema.kind === "boolean") return { type: "boolean" };
  if (schema.kind === "enum") return { enum: schema.values };
  if (schema.kind === "array") {
    return {
      type: "array",
      items: exportedSchema(schema.items),
      ...(schema.unique ? { uniqueItems: true } : {}),
      ...(schema.minimumItems === undefined
        ? {}
        : { minItems: schema.minimumItems }),
      ...(schema.maximumItems === undefined
        ? {}
        : { maxItems: schema.maximumItems }),
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: schema.required,
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([field, child]) => [
        field,
        exportedSchema(child),
      ]),
    ),
  };
}

export function canonicalProfileAttributes(
  sourceObservationId: string,
  profile: string,
  entity: "card" | "printing",
  raw: Record<string, unknown>,
  warnings: ProfileWarning[],
): Record<string, unknown> {
  const contract = requiredProfileContract(profile);
  const schema = entity === "card" ? contract.card : contract.printing;
  const canonical = sanitize(
    raw,
    schema,
    entity,
    sourceObservationId,
    profile,
    warnings,
  );
  if (!isRecord(canonical)) {
    throw new Error(`Retained ${profile} ${entity} evidence is invalid.`);
  }
  if (entity === "card") contract.validateCard(canonical);
  return canonical;
}

function sanitize(
  value: unknown,
  schema: Schema,
  path: string,
  sourceObservationId: string,
  profile: string,
  warnings: ProfileWarning[],
): unknown {
  if (schema.kind === "string") {
    if (value === null && schema.nullable) return null;
    if (
      typeof value !== "string" ||
      value.length < (schema.minimumLength ?? 0)
    ) {
      throw invalid(path);
    }
    return value;
  }
  if (schema.kind === "integer") {
    if (value === null && schema.nullable) return null;
    if (
      !Number.isInteger(value) ||
      Number(value) < (schema.minimum ?? 0)
    ) {
      throw invalid(path);
    }
    return value;
  }
  if (schema.kind === "boolean") {
    if (typeof value !== "boolean") throw invalid(path);
    return value;
  }
  if (schema.kind === "enum") {
    if (typeof value === "string" && schema.values.includes(value)) {
      return value;
    }
    warnings.push(sourceVocabularyWarning(
      sourceObservationId,
      profile,
      path,
      value,
    ));
    return undefined;
  }
  if (schema.kind === "array") {
    if (!Array.isArray(value)) throw invalid(path);
    const result = value.flatMap((item, index) => {
      const canonical = sanitize(
        item,
        schema.items,
        schema.items.kind === "enum" ? path : `${path}[${index}]`,
        sourceObservationId,
        profile,
        warnings,
      );
      return canonical === undefined ? [] : [canonical];
    });
    const canonical = schema.unique
      ? [
          ...new Map(
            result.map((item) => [canonicalJson(item), item]),
          ).values(),
        ].sort((left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right)),
        )
      : result;
    if (
      canonical.length < (schema.minimumItems ?? 0) ||
      canonical.length > (schema.maximumItems ?? Number.MAX_SAFE_INTEGER)
    ) {
      throw invalid(path);
    }
    return canonical;
  }
  if (!isRecord(value)) throw invalid(path);
  const result: Record<string, unknown> = {};
  for (const [field, raw] of Object.entries(value)) {
    const child = schema.properties[field];
    const childPath = `${path}.${field}`;
    if (child === undefined) {
      warnings.push(sourceFieldWarning(
        sourceObservationId,
        profile,
        childPath,
        raw,
      ));
      continue;
    }
    const canonical = sanitize(
      raw,
      child,
      childPath,
      sourceObservationId,
      profile,
      warnings,
    );
    if (canonical !== undefined) result[field] = canonical;
  }
  const missing = schema.required.filter((field) => !(field in result));
  if (missing.length > 0) {
    throw new Error(
      `Retained ${profile} evidence at ${path} is incomplete: ${missing.join(", ")}.`,
    );
  }
  return result;
}

function object(
  required: readonly string[],
  properties: Readonly<Record<string, Schema>>,
): Extract<Schema, { kind: "object" }> {
  return { kind: "object", required, properties };
}

function array(
  items: Schema,
  unique = false,
  minimumItems?: number,
  maximumItems?: number,
): Extract<Schema, { kind: "array" }> {
  return { kind: "array", items, unique, minimumItems, maximumItems };
}

function string(
  nullable = false,
  minimumLength = 0,
): Extract<Schema, { kind: "string" }> {
  return { kind: "string", nullable, minimumLength };
}

function integer(
  nullable = false,
  minimum = 0,
): Extract<Schema, { kind: "integer" }> {
  return { kind: "integer", nullable, minimum };
}

function enumeration(
  values: readonly string[],
): Extract<Schema, { kind: "enum" }> {
  return { kind: "enum", values };
}

function invalid(path: string): Error {
  return new Error(`Retained profile value at ${path} is invalid.`);
}

export function sourceFieldWarning(
  sourceObservationId: string,
  profile: string,
  path: string,
  raw: unknown,
): ProfileWarning {
  return {
    code: "unknown_source_field",
    source_observation_id: sourceObservationId,
    profile,
    path,
    raw_value: rawSourceValue(raw),
    detail:
      "The unknown Official Source field remains retained Source Observation evidence and was not added to the Game Profile.",
  };
}

export function sourceVocabularyWarning(
  sourceObservationId: string,
  profile: string,
  path: string,
  raw: unknown,
): ProfileWarning {
  return {
    code: "unknown_source_vocabulary",
    source_observation_id: sourceObservationId,
    profile,
    path,
    raw_value: rawSourceValue(raw),
    detail:
      "The unknown controlled value remains retained Source Observation evidence and was not added to the Game Profile.",
  };
}

export function rawSourceValue(value: unknown): string {
  return typeof value === "string" ? value : canonicalJson(value);
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
