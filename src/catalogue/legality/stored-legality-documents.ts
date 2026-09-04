import {
  type CatalogueCard,
  type SupportedGame,
  canonicalProfileAttributes,
  validateMembershipPredicate,
  type ProfileWarning,
  isIsoCalendarDate,
  canonicalJson,
  compareUtf8,
} from "../shared";
import { type LegalityRegion, type LegalityRule, regionForLineage } from "./legality-rule";
import { parseStoredLegalityRuleEffect } from "./legality-effect-policy";
import { registeredLegalitySourceScope } from "../adapters";

const games = new Set<SupportedGame>(["one-piece", "fusion-world", "digimon", "gundam"]);
const regions = new Set<LegalityRegion>(["EN-OCEANIA", "EN-ASIA", "EN-US"]);

export type StoredLegalityStatusCard = Pick<CatalogueCard, "id" | "game" | "game_data">;

export type StoredLegalityStatusRule = LegalityRule;

export function parseStoredCatalogueCard(json: string): StoredLegalityStatusCard {
  const root = parsedRecord(json, "stored Card document");
  assertExactFields(root, ["data", "included", "provenance", "disagreements"], "stored Card envelope");
  requiredRecordArray(root.included, "stored Card included resources");
  requiredProvenance(root.provenance, "stored Card provenance");
  requiredRecordArray(root.disagreements, "stored Card disagreements");
  const data = requiredRecord(root.data, "stored Card data");
  assertExactFields(
    data,
    [
      "type",
      "id",
      "game",
      "official_identity",
      "name",
      "effective_rules_text",
      "game_data",
      "printing_ids",
      "source_lineages",
      "lifecycle",
      "links",
    ],
    "stored Card data",
  );
  if (data.type !== "card") {
    throw new Error("Stored Card type is invalid.");
  }
  const id = requiredText(data.id, "stored Card id");
  const game = requiredGame(data.game, "stored Card game");
  const identity = requiredRecord(data.official_identity, "stored Card official identity");
  assertExactFields(identity, ["kind", "value"], "stored Card identity");
  if (identity.kind === "card_number") {
    requiredText(identity.value, "stored Card number");
  } else if (game !== "one-piece" || identity.kind !== "functional_designation" || identity.value !== "DON!!") {
    throw new Error("Stored Card official identity is invalid.");
  }
  const gameData = requiredRecord(data.game_data, "stored Card game data");
  assertOnlyFields(gameData, ["profile", "attributes"], "stored Card game data");
  const profile = requiredText(gameData.profile, "stored Card profile");
  if (profile !== `${game}@1`) {
    throw new Error("Stored Card profile conflicts with its Supported Game.");
  }
  const rawAttributes = requiredRecord(gameData.attributes, "stored Card profile attributes");
  const warnings: ProfileWarning[] = [];
  const attributes = canonicalProfileAttributes("stored-card-document", profile, "card", rawAttributes, warnings);
  if (warnings.length > 0 || canonicalJson(attributes) !== canonicalJson(rawAttributes)) {
    throw new Error("Stored Card profile attributes are not canonical.");
  }
  requiredText(data.name, "stored Card name");
  nullableText(data.effective_rules_text, "stored Card Effective Rules Text");
  requiredUniqueStrings(data.printing_ids, "stored Card Printing ids", true);
  const sourceLineages = requiredUniqueStrings(data.source_lineages, "stored Card Source Lineages", true);
  if (sourceLineages.some((lineage) => registeredLegalitySourceScope(lineage).game !== game)) {
    throw new Error("Stored Card Source Lineage conflicts with its Supported Game.");
  }
  requiredLifecycle(data.lifecycle, "stored Card lifecycle");
  const links = requiredRecord(data.links, "stored Card links");
  assertExactFields(links, ["self"], "stored Card links");
  if (requiredText(links.self, "stored Card self link") !== `/v1/cards/${id}`) {
    throw new Error("Stored Card self link conflicts with its identity.");
  }
  return {
    id,
    game,
    game_data: {
      profile: profile as CatalogueCard["game_data"]["profile"],
      attributes,
    },
  };
}

export function parseStoredLegalityRule(json: string): StoredLegalityStatusRule {
  const rule = parsedRecord(json, "stored Legality Rule document");
  assertOnlyFields(
    rule,
    [
      "id",
      "official_id",
      "game",
      "region",
      "format",
      "event_tier",
      "effective_from",
      "effective_until",
      "card_ids",
      "official_wording",
      "unresolved_scope",
      "effect",
      "source_lineage",
      "source_snapshot_id",
      "source_observation_set_id",
      "source_observation_id",
      "source_observation_pointer",
      "source_field_pointers",
      "first_revision_id",
      "last_observed_revision_id",
      "current",
      "last_missing_revision_id",
    ],
    "stored Legality Rule",
  );
  const game = requiredGame(rule.game, "stored Legality Rule game");
  const region = requiredRegion(rule.region, "stored Legality Rule region");
  const sourceLineage = requiredText(rule.source_lineage, "stored Legality Rule Source Lineage");
  if (regionForLineage(sourceLineage) !== region) {
    throw new Error("Stored Legality Rule region conflicts with its Source Lineage.");
  }
  if (registeredLegalitySourceScope(sourceLineage).game !== game) {
    throw new Error("Stored Legality Rule game conflicts with its Source Lineage.");
  }
  const effectiveFrom =
    rule.effective_from === null ? null : requiredDate(rule.effective_from, "stored Legality Rule effective_from");
  const effectiveUntil = nullableDate(rule.effective_until, "stored Legality Rule effective_until");
  if (effectiveFrom !== null && effectiveUntil !== null && effectiveUntil <= effectiveFrom) {
    throw new Error("Stored Legality Rule effective interval is invalid.");
  }
  const cardIds = requiredUniqueStrings(rule.card_ids, "stored Legality Rule Card ids", true);
  if (canonicalJson(cardIds) !== canonicalJson([...cardIds].sort(compareUtf8))) {
    throw new Error("Stored Legality Rule Card ids are not canonical.");
  }
  const sourceFieldPointers = requiredRecord(rule.source_field_pointers, "stored Legality Rule source field pointers");
  const pointerFields = [
    "official_wording",
    "effective_from",
    "effective_until",
    "region",
    "unresolved_scope",
    "format",
    "event_tier",
    "card_numbers",
    "effect",
  ];
  assertExactFields(sourceFieldPointers, pointerFields, "stored Legality Rule source field pointers");
  const sourceObservationPointer = requiredJsonPointer(
    rule.source_observation_pointer,
    "stored Legality Rule Source Observation pointer",
  );
  for (const field of pointerFields) {
    const pointer = requiredJsonPointer(sourceFieldPointers[field], `stored Legality Rule ${field} pointer`);
    if (pointer !== `${sourceObservationPointer}/${field}`) {
      throw new Error(`Stored Legality Rule ${field} pointer conflicts with its observation pointer.`);
    }
  }
  const current = requiredBoolean(rule.current, "stored Legality Rule current");
  const lastMissingRevisionId = nullableText(
    rule.last_missing_revision_id,
    "stored Legality Rule last missing revision id",
  );
  if (!current && lastMissingRevisionId === null) {
    throw new Error("Stored Legality Rule missing lifecycle omits its last missing revision.");
  }
  const effect = parseStoredLegalityRuleEffect(rule.effect);
  const unresolvedScope = requiredUnresolvedScope(rule.unresolved_scope);
  if (
    (effectiveFrom === null &&
      (unresolvedScope === null || !unresolvedScope.dimensions.includes("effective_interval"))) ||
    (unresolvedScope !== null &&
      (effect.type !== "unresolved" ||
        cardIds.length === 0 ||
        (unresolvedScope.dimensions.includes("effective_interval")
          ? effectiveFrom !== null || effectiveUntil !== null
          : effectiveFrom === null) ||
        (unresolvedScope.dimensions.includes("event_tier") && rule.event_tier !== null)))
  ) {
    throw new Error("Stored Legality Rule unresolved scope is invalid.");
  }
  if (effect.type === "prohibited_combination") {
    if (cardIds.length === 0 || effect.with_card_ids.length === 0) {
      throw new Error("Stored prohibited-combination Legality Rule requires direct and companion Cards.");
    }
    if (effect.with_card_ids.some((cardId) => cardIds.includes(cardId))) {
      throw new Error("Stored prohibited-combination Legality Rule operands overlap.");
    }
  }
  if (effect.type === "membership") {
    validateMembershipPredicate(`${game}@1`, effect.attribute, effect.includes_any);
  }
  return {
    id: requiredText(rule.id, "stored Legality Rule id"),
    official_id: requiredText(rule.official_id, "stored Legality Rule official id"),
    game,
    region,
    format: requiredText(rule.format, "stored Legality Rule format"),
    event_tier: nullableText(rule.event_tier, "stored Legality Rule event tier"),
    effective_from: effectiveFrom,
    effective_until: effectiveUntil,
    unresolved_scope: unresolvedScope,
    card_ids: cardIds,
    official_wording: requiredText(rule.official_wording, "stored Legality Rule wording"),
    effect,
    source_lineage: sourceLineage,
    source_snapshot_id: requiredText(rule.source_snapshot_id, "stored Legality Rule Source Snapshot id"),
    source_observation_set_id: requiredText(
      rule.source_observation_set_id,
      "stored Legality Rule Source Observation Set id",
    ),
    source_observation_id: requiredText(rule.source_observation_id, "stored Legality Rule Source Observation id"),
    source_observation_pointer: sourceObservationPointer,
    source_field_pointers: sourceFieldPointers as StoredLegalityStatusRule["source_field_pointers"],
    first_revision_id: requiredText(rule.first_revision_id, "stored Legality Rule first revision id"),
    last_observed_revision_id: requiredText(
      rule.last_observed_revision_id,
      "stored Legality Rule last observed revision id",
    ),
    current,
    last_missing_revision_id: lastMissingRevisionId,
  };
}

function requiredUnresolvedScope(value: unknown): LegalityRule["unresolved_scope"] {
  if (value === null) return null;
  const scope = requiredRecord(value, "stored Legality Rule unresolved scope");
  assertExactFields(scope, ["dimensions"], "stored Legality Rule unresolved scope");
  const dimensions = requiredUniqueStrings(scope.dimensions, "stored Legality Rule unresolved scope dimensions", false);
  if (
    dimensions.some(
      (dimension) => dimension !== "effective_interval" && dimension !== "event_tier" && dimension !== "target_scope",
    ) ||
    canonicalJson(dimensions) !== canonicalJson([...dimensions].sort())
  ) {
    throw new Error("Stored Legality Rule unresolved scope is not canonical.");
  }
  return {
    dimensions: dimensions as ("effective_interval" | "event_tier" | "target_scope")[],
  };
}

function parsedRecord(json: string, name: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`${name} is not valid JSON.`);
  }
  return requiredRecord(value, name);
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredRecordArray(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value.map((item) => requiredRecord(item, name));
}

function requiredProvenance(value: unknown, name: string): void {
  const provenance = requiredRecord(value, name);
  for (const [pointer, ids] of Object.entries(provenance)) {
    requiredJsonPointer(pointer, `${name} pointer`);
    requiredUniqueStrings(ids, `${name} observation ids`, false);
  }
}

function requiredLifecycle(value: unknown, name: string): void {
  const lifecycle = requiredRecord(value, name);
  assertOnlyFields(lifecycle, ["first_revision_id", "last_observed_revision_id", "withdrawn", "withdrawal"], name);
  requiredText(lifecycle.first_revision_id, `${name} first revision id`);
  requiredText(lifecycle.last_observed_revision_id, `${name} last observed revision id`);
  const withdrawn = requiredBoolean(lifecycle.withdrawn, `${name} withdrawn`);
  if (withdrawn) {
    const withdrawal = requiredRecord(lifecycle.withdrawal, `${name} withdrawal`);
    assertExactFields(withdrawal, ["revision_id", "evidence"], `${name} withdrawal`);
    requiredText(withdrawal.revision_id, `${name} withdrawal revision id`);
    requiredRecord(withdrawal.evidence, `${name} withdrawal evidence`);
  } else if (lifecycle.withdrawal !== null && lifecycle.withdrawal !== undefined) {
    throw new Error(`${name} cannot retain withdrawal evidence while current.`);
  }
}

function requiredGame(value: unknown, name: string): SupportedGame {
  if (typeof value !== "string" || !games.has(value as SupportedGame)) {
    throw new Error(`${name} is unsupported.`);
  }
  return value as SupportedGame;
}

function requiredRegion(value: unknown, name: string): LegalityRegion {
  if (typeof value !== "string" || !regions.has(value as LegalityRegion)) {
    throw new Error(`${name} is unsupported.`);
  }
  return value as LegalityRegion;
}

function requiredDate(value: unknown, name: string): string {
  const date = requiredText(value, name);
  if (!isIsoCalendarDate(date)) throw new Error(`${name} must be an exact ISO date.`);
  return date;
}

function nullableDate(value: unknown, name: string): string | null {
  return value === null ? null : requiredDate(value, name);
}

function requiredUniqueStrings(value: unknown, name: string, emptyAllowed: boolean): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  const values = value.map((item) => requiredText(item, name));
  if (!emptyAllowed && values.length === 0) throw new Error(`${name} must not be empty.`);
  if (new Set(values).size !== values.length) throw new Error(`${name} must not contain duplicates.`);
  return values;
}

function requiredJsonPointer(value: unknown, name: string): string {
  const pointer = requiredText(value, name);
  if (!pointer.startsWith("/")) throw new Error(`${name} must be a JSON Pointer.`);
  return pointer;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${name} must be non-empty text.`);
  }
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  return value === null ? null : requiredText(value, name);
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean.`);
  return value;
}

function assertOnlyFields(record: Record<string, unknown>, fields: readonly string[], name: string): void {
  const allowed = new Set(fields);
  const unexpected = Object.keys(record).find((field) => !allowed.has(field));
  if (unexpected !== undefined) throw new Error(`${name} has unexpected field ${unexpected}.`);
}

function assertExactFields(record: Record<string, unknown>, fields: readonly string[], name: string): void {
  assertOnlyFields(record, fields, name);
  const missing = fields.find((field) => !(field in record));
  if (missing !== undefined) throw new Error(`${name} omits required field ${missing}.`);
}
