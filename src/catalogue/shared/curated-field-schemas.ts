import { registeredGameProfileSchemas } from "./reconciliation-profile";
import { canonicalJson } from "./serialization";
type JsonSchema = Readonly<Record<string, unknown>>;

const nullableTextSchema = {
  oneOf: [{ type: "string" }, { type: "null" }],
} as const;
const nullableNonEmptyTextSchema = {
  oneOf: [{ type: "string", minLength: 1 }, { type: "null" }],
} as const;
const nullableDateSchema = {
  oneOf: [{ type: "string", format: "date" }, { type: "null" }],
} as const;
export const sharedCuratableFieldSchemas: Readonly<Record<string, JsonSchema>> = {
  "card:/name": { type: "string", minLength: 1 },
  "card:/effective_rules_text": nullableTextSchema,
  "printing:/rarity": {
    type: "object",
    additionalProperties: false,
    required: ["normalized", "raw"],
    properties: { normalized: nullableTextSchema, raw: nullableTextSchema },
  },
  "printing:/rarity/normalized": nullableTextSchema,
  "printing:/rarity/raw": nullableTextSchema,
  "printing:/printed_rules_text": nullableTextSchema,
  "product:/official_code": nullableNonEmptyTextSchema,
  "product:/name": nullableNonEmptyTextSchema,
  "release:/date": {
    type: "object",
    additionalProperties: false,
    required: ["precision", "value"],
    properties: {
      precision: {
        enum: ["day", "month", "quarter", "season", "year", "unknown", null],
      },
      value: nullableNonEmptyTextSchema,
    },
  },
  "release:/date/precision": {
    enum: ["day", "month", "quarter", "season", "year", "unknown", null],
  },
  "release:/date/value": nullableNonEmptyTextSchema,
  "release:/status": { enum: ["announced", "released", null] },
  "distribution_context:/kind": { enum: ["product", "tournament_pack", "winner_prize", "promotion", "other"] },
  "distribution_context:/label": { type: "string", minLength: 1 },
  "erratum:/effective_from": nullableDateSchema,
  "erratum:/official_wording": { type: "string", minLength: 1 },
  "erratum:/corrected_value": nullableNonEmptyTextSchema,
};

// One schema registry feeds both generated Worker code and request-time selection.
const schemas = new Map<string, JsonSchema>();
function retain(schema: JsonSchema) {
  schemas.set(canonicalJson(schema), schema);
  const properties = schema.properties;
  if (properties && typeof properties === "object") {
    for (const value of Object.values(properties)) retain(value as JsonSchema);
  }
}
for (const schema of Object.values(sharedCuratableFieldSchemas)) retain(schema);
for (const profile of registeredGameProfileSchemas()) {
  retain(profile.properties.card);
  retain(profile.properties.printing);
}
const orderedSchemas = [...schemas.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
const selectors = new Map(orderedSchemas.map(([schema], index) => [schema, index]));
export function curatedFieldSchemaSelector(schema: JsonSchema): number | undefined {
  return selectors.get(canonicalJson(schema));
}
export const curatedFieldDocumentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "value"],
  properties: { schema: { enum: orderedSchemas.map((_, index) => index) }, value: {} },
  allOf: orderedSchemas.map(([, schema], index) => ({
    if: { properties: { schema: { const: index } }, required: ["schema"] },
    // This is the JSON Schema conditional keyword, not a Promise.
    then: { properties: { value: schema } },
  })),
};
