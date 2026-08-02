import type { CatalogueCard, SupportedGame } from "./catalogue-candidate";
import type {
  LegalityRegion,
  LegalityRule,
  LegalityRuleEffect,
} from "./legality-rule";
import { regionForLineage } from "./legality-rule";
import { isIsoCalendarDate } from "./calendar-date.mjs";
import { canonicalJson, compareUtf8 } from "./serialization";

const games = new Set<SupportedGame>([
  "one-piece",
  "fusion-world",
  "digimon",
  "gundam",
]);
const regions = new Set<LegalityRegion>([
  "EN-OCEANIA",
  "EN-ASIA",
  "EN-US",
]);

export type StoredLegalityStatusCard = Pick<
  CatalogueCard,
  "id" | "game" | "game_data"
>;

export type StoredLegalityStatusRule = Omit<
  LegalityRule,
  "source_field_pointers"
> & {
  source_field_pointers: Partial<LegalityRule["source_field_pointers"]> &
    Pick<LegalityRule["source_field_pointers"], "official_wording">;
};

export function parseStoredCatalogueCard(
  json: string,
): StoredLegalityStatusCard {
  const root = parsedRecord(json, "stored Card document");
  const envelope = root.data === undefined ? null : root;
  if (envelope !== null) {
    assertOnlyFields(
      envelope,
      ["data", "included", "provenance", "disagreements"],
      "stored Card envelope",
    );
    requiredRecordArray(envelope.included, "stored Card included resources");
    requiredProvenance(envelope.provenance, "stored Card provenance");
    requiredRecordArray(envelope.disagreements, "stored Card disagreements");
  }
  const data = requiredRecord(envelope?.data ?? root, "stored Card data");
  assertOnlyFields(
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
  if (data.type !== undefined && data.type !== "card") {
    throw new Error("Stored Card type is invalid.");
  }
  const id = requiredText(data.id, "stored Card id");
  const game = requiredGame(data.game, "stored Card game");
  if (data.official_identity !== undefined) {
    const identity = requiredRecord(
      data.official_identity,
      "stored Card official identity",
    );
    assertOnlyFields(identity, ["kind", "value"], "stored Card identity");
    if (identity.kind === "card_number") {
      requiredText(identity.value, "stored Card number");
    } else if (
      game !== "one-piece" ||
      identity.kind !== "functional_designation" ||
      identity.value !== "DON!!"
    ) {
      throw new Error("Stored Card official identity is invalid.");
    }
  }
  const gameData = requiredRecord(data.game_data, "stored Card game data");
  assertOnlyFields(gameData, ["profile", "attributes"], "stored Card game data");
  const profile = requiredText(gameData.profile, "stored Card profile");
  if (profile !== `${game}@1`) {
    throw new Error("Stored Card profile conflicts with its Supported Game.");
  }
  const attributes = requiredRecord(
    gameData.attributes,
    "stored Card profile attributes",
  );
  if (data.name !== undefined) requiredText(data.name, "stored Card name");
  if (data.effective_rules_text !== undefined) {
    nullableText(
      data.effective_rules_text,
      "stored Card Effective Rules Text",
    );
  }
  if (data.printing_ids !== undefined) {
    requiredUniqueStrings(data.printing_ids, "stored Card Printing ids", true);
  }
  if (data.source_lineages !== undefined) {
    requiredUniqueStrings(data.source_lineages, "stored Card Source Lineages", true);
  }
  if (data.lifecycle !== undefined) requiredLifecycle(data.lifecycle, "stored Card lifecycle");
  if (data.links !== undefined) {
    const links = requiredRecord(data.links, "stored Card links");
    assertOnlyFields(links, ["self"], "stored Card links");
    if (requiredText(links.self, "stored Card self link") !== `/v1/cards/${id}`) {
      throw new Error("Stored Card self link conflicts with its identity.");
    }
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

export function parseStoredLegalityRule(
  json: string,
): StoredLegalityStatusRule {
  const rule = parsedRecord(json, "stored Legality Rule document");
  assertOnlyFields(
    rule,
    [
      "id", "official_id", "game", "region", "format", "event_tier",
      "effective_from", "effective_until", "card_ids", "official_wording",
      "effect", "source_lineage", "source_snapshot_id",
      "source_observation_set_id", "source_observation_id",
      "source_observation_pointer", "source_field_pointers",
      "first_revision_id", "last_observed_revision_id", "current",
      "last_missing_revision_id",
    ],
    "stored Legality Rule",
  );
  const game = requiredGame(rule.game, "stored Legality Rule game");
  const region = requiredRegion(rule.region, "stored Legality Rule region");
  const sourceLineage = requiredText(
    rule.source_lineage,
    "stored Legality Rule Source Lineage",
  );
  if (regionForLineage(sourceLineage) !== region) {
    throw new Error("Stored Legality Rule region conflicts with its Source Lineage.");
  }
  const effectiveFrom = requiredDate(
    rule.effective_from,
    "stored Legality Rule effective_from",
  );
  const effectiveUntil = nullableDate(
    rule.effective_until,
    "stored Legality Rule effective_until",
  );
  if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) {
    throw new Error("Stored Legality Rule effective interval is invalid.");
  }
  const cardIds = requiredUniqueStrings(
    rule.card_ids,
    "stored Legality Rule Card ids",
    true,
  );
  if (canonicalJson(cardIds) !== canonicalJson([...cardIds].sort(compareUtf8))) {
    throw new Error("Stored Legality Rule Card ids are not canonical.");
  }
  const sourceFieldPointers = requiredRecord(
    rule.source_field_pointers,
    "stored Legality Rule source field pointers",
  );
  const pointerFields = [
    "official_wording", "effective_from", "effective_until", "region",
    "format", "event_tier", "card_numbers", "effect",
  ];
  assertOnlyFields(
    sourceFieldPointers,
    pointerFields,
    "stored Legality Rule source field pointers",
  );
  if (!("official_wording" in sourceFieldPointers)) {
    throw new Error(
      "Stored Legality Rule source field pointers omit official wording.",
    );
  }
  for (const field of Object.keys(sourceFieldPointers)) {
    requiredJsonPointer(
      sourceFieldPointers[field],
      `stored Legality Rule ${field} pointer`,
    );
  }
  const current = requiredBoolean(rule.current, "stored Legality Rule current");
  const lastMissingRevisionId = nullableText(
    rule.last_missing_revision_id,
    "stored Legality Rule last missing revision id",
  );
  return {
    id: requiredText(rule.id, "stored Legality Rule id"),
    official_id: requiredText(rule.official_id, "stored Legality Rule official id"),
    game,
    region,
    format: requiredText(rule.format, "stored Legality Rule format"),
    event_tier: nullableText(rule.event_tier, "stored Legality Rule event tier"),
    effective_from: effectiveFrom,
    effective_until: effectiveUntil,
    card_ids: cardIds,
    official_wording: requiredText(
      rule.official_wording,
      "stored Legality Rule wording",
    ),
    effect: requiredCanonicalEffect(rule.effect),
    source_lineage: sourceLineage,
    source_snapshot_id: requiredText(
      rule.source_snapshot_id,
      "stored Legality Rule Source Snapshot id",
    ),
    source_observation_set_id: requiredText(
      rule.source_observation_set_id,
      "stored Legality Rule Source Observation Set id",
    ),
    source_observation_id: requiredText(
      rule.source_observation_id,
      "stored Legality Rule Source Observation id",
    ),
    source_observation_pointer: requiredJsonPointer(
      rule.source_observation_pointer,
      "stored Legality Rule Source Observation pointer",
    ),
    source_field_pointers:
      sourceFieldPointers as StoredLegalityStatusRule["source_field_pointers"],
    first_revision_id: requiredText(
      rule.first_revision_id,
      "stored Legality Rule first revision id",
    ),
    last_observed_revision_id: requiredText(
      rule.last_observed_revision_id,
      "stored Legality Rule last observed revision id",
    ),
    current,
    last_missing_revision_id: lastMissingRevisionId,
  };
}

function requiredCanonicalEffect(value: unknown): LegalityRuleEffect {
  const effect = requiredRecord(value, "stored Legality Rule effect");
  const type = requiredText(effect.type, "stored Legality Rule effect type");
  switch (type) {
    case "eligible":
    case "ban":
      assertOnlyFields(effect, ["type"], "stored Legality Rule effect");
      return { type };
    case "copy_limit": {
      assertOnlyFields(effect, ["type", "maximum_copies"], "stored Legality Rule effect");
      const maximum = effect.maximum_copies;
      if (!Number.isInteger(maximum) || Number(maximum) < 1) {
        throw new Error("Stored Legality Rule copy limit is invalid.");
      }
      return { type, maximum_copies: Number(maximum) };
    }
    case "prohibited_combination":
      assertOnlyFields(effect, ["type", "with_card_ids"], "stored Legality Rule effect");
      return {
        type,
        with_card_ids: requiredUniqueStrings(
          effect.with_card_ids,
          "stored Legality Rule companion Card ids",
          false,
        ),
      };
    case "membership":
      assertOnlyFields(effect, ["type", "attribute", "includes_any"], "stored Legality Rule effect");
      return {
        type,
        attribute: requiredText(effect.attribute, "stored Legality Rule membership attribute"),
        includes_any: requiredUniqueStrings(
          effect.includes_any,
          "stored Legality Rule membership values",
          false,
        ),
      };
    case "rotation":
      assertOnlyFields(effect, ["type", "eligible_blocks"], "stored Legality Rule effect");
      return {
        type,
        eligible_blocks: requiredUniqueStrings(
          effect.eligible_blocks,
          "stored Legality Rule eligible blocks",
          false,
        ),
      };
    case "release_timing":
      assertOnlyFields(effect, ["type", "legal_from"], "stored Legality Rule effect");
      return {
        type,
        legal_from: requiredDate(
          effect.legal_from,
          "stored Legality Rule legal_from",
        ),
      };
    case "unresolved":
      assertOnlyFields(effect, ["type", "reason"], "stored Legality Rule effect");
      return {
        type,
        reason: requiredText(effect.reason, "stored Legality Rule unresolved reason"),
      };
    default:
      throw new Error("Stored Legality Rule effect is unsupported.");
  }
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
  assertOnlyFields(
    lifecycle,
    ["first_revision_id", "last_observed_revision_id", "withdrawn", "withdrawal"],
    name,
  );
  requiredText(lifecycle.first_revision_id, `${name} first revision id`);
  requiredText(lifecycle.last_observed_revision_id, `${name} last observed revision id`);
  requiredBoolean(lifecycle.withdrawn, `${name} withdrawn`);
  if (lifecycle.withdrawal !== null && lifecycle.withdrawal !== undefined) {
    requiredRecord(lifecycle.withdrawal, `${name} withdrawal`);
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

function requiredUniqueStrings(
  value: unknown,
  name: string,
  emptyAllowed: boolean,
): string[] {
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

function assertOnlyFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  name: string,
): void {
  const allowed = new Set(fields);
  const unexpected = Object.keys(record).find((field) => !allowed.has(field));
  if (unexpected !== undefined) throw new Error(`${name} has unexpected field ${unexpected}.`);
}
