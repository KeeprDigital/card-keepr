import type {
  LegalityRegion,
  LegalityRule,
  LegalityRuleEffect,
} from "./legality-rule";
import { legalityRuleCardIds } from "./legality-rule";
import { canonicalJson, sha256Text } from "./serialization";

type CatalogueCard = {
  id: string;
  game: "one-piece" | "fusion-world" | "digimon" | "gundam";
  game_data: { attributes: Record<string, unknown> };
};

type ContextRow = {
  current_revision_id: string;
  published_at: string;
  document_json: string;
};

type RuleRow = {
  document_json: string;
};

export class LegalityStatusProblem extends Error {
  constructor(
    readonly status: 400 | 404 | 422,
    readonly code:
      | "invalid_parameter"
      | "not_found"
      | "invalid_legality_region",
    message: string,
  ) {
    super(message);
  }
}

export async function contextualLegalityStatusResponse(
  request: Request,
  database: D1Database,
): Promise<Response> {
  const url = new URL(request.url);
  const query = parseQuery(url);
  const context = await database
    .prepare(
      `SELECT catalogue.current_revision_id, catalogue.published_at,
              card.document_json
       FROM catalogue_state AS catalogue
       JOIN revision_cards AS card
         ON card.catalogue_revision_id = catalogue.current_revision_id
       WHERE catalogue.singleton = 1 AND card.card_id = ?`,
    )
    .bind(query.cardId)
    .first<ContextRow>();
  if (context === null) {
    throw new LegalityStatusProblem(
      404,
      "not_found",
      "The requested Card does not exist in the current Catalogue Revision.",
    );
  }
  const card = catalogueCardData(
    JSON.parse(context.document_json) as unknown,
  );
  const supportedRegions = regionsFor(card.game);
  if (
    query.region !== null &&
    !supportedRegions.includes(query.region)
  ) {
    throw new LegalityStatusProblem(
      422,
      "invalid_legality_region",
      card.game === "gundam"
        ? "Gundam Legality Status is available only for EN-ASIA and EN-US; EN-OCEANIA is not synthesized."
        : `${query.region} is not a Legality region for this Card's Supported Game.`,
    );
  }
  const rows = await database
    .prepare(
      `SELECT rule.document_json
       FROM revision_legality_rules AS rule
       WHERE rule.catalogue_revision_id = ?
         AND rule.supported_game = ?
         AND rule.format = ?
         AND rule.effective_from <= ?
         AND (rule.effective_until IS NULL OR ? < rule.effective_until)
         AND (rule.event_tier IS NULL OR rule.event_tier = ?)
       ORDER BY rule.region, rule.legality_rule_id`,
    )
    .bind(
      context.current_revision_id,
      card.game,
      query.format,
      query.on,
      query.on,
      query.eventTier,
    )
    .all<RuleRow>();
  const rules = rows.results.map(
    (row) => JSON.parse(row.document_json) as LegalityRule,
  );
  const regions =
    query.region === null
      ? supportedRegions
      : [query.region];
  const data = regions.map((region) =>
    deriveRegionStatus(card, rules, query, region),
  );
  const self = `${url.pathname}${url.search}`;
  const document = {
    data,
    meta: {
      catalogue_revision_id: context.current_revision_id,
      published_at: context.published_at,
    },
    links: { self },
  };
  const etag = `"${await sha256Text(canonicalJson(document))}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        "x-catalogue-revision": context.current_revision_id,
        "cache-control": "private, max-age=0, must-revalidate",
      },
    });
  }
  return Response.json(document, {
    headers: {
      etag,
      "x-catalogue-revision": context.current_revision_id,
      "cache-control": "private, max-age=0, must-revalidate",
    },
  });
}

function catalogueCardData(value: unknown): CatalogueCard {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).data !== null &&
    typeof (value as Record<string, unknown>).data === "object" &&
    !Array.isArray((value as Record<string, unknown>).data)
  ) {
    return (value as { data: CatalogueCard }).data;
  }
  return value as CatalogueCard;
}

function deriveRegionStatus(
  card: CatalogueCard,
  rules: readonly LegalityRule[],
  query: {
    cardId: string;
    on: string;
    format: string;
    eventTier: string | null;
  },
  region: LegalityRegion,
) {
  const applicable = rules.filter(
    (rule) =>
      rule.region === region &&
      (legalityRuleCardIds(rule).length === 0 ||
        legalityRuleCardIds(rule).includes(query.cardId)),
  );
  const evaluations = applicable.map((rule) => ({
    rule,
    outcome: evaluate(rule.effect, card, query.on),
  }));
  const status =
    evaluations.some(({ outcome }) => outcome === "not_legal")
      ? "not_legal"
      : evaluations.some(({ outcome }) => outcome === "indeterminate")
        ? "indeterminate"
        : evaluations.some(({ outcome }) => outcome === "restricted")
          ? "restricted"
          : evaluations.some(({ outcome }) => outcome === "legal")
            ? "legal"
            : "indeterminate";
  const ruleIds = applicable.map((rule) => rule.id).sort();
  return {
    card_id: query.cardId,
    on: query.on,
    format: query.format,
    event_tier: query.eventTier,
    region,
    status,
    rule_ids: ruleIds,
    derivation: derivation(status, evaluations),
  };
}

function evaluate(
  effect: LegalityRuleEffect,
  card: CatalogueCard,
  on: string,
): "legal" | "restricted" | "not_legal" | "indeterminate" {
  switch (effect.type) {
    case "eligible":
      return "legal";
    case "ban":
      return "not_legal";
    case "copy_limit":
    case "prohibited_combination":
      return "restricted";
    case "release_timing":
      return on >= effect.legal_from ? "legal" : "not_legal";
    case "unresolved":
      return "indeterminate";
    case "membership": {
      const value = card.game_data.attributes[effect.attribute];
      if (value === null || value === undefined) {
        return "indeterminate";
      }
      const values = Array.isArray(value) ? value : [value];
      return values.some(
        (candidate) =>
          typeof candidate === "string" &&
          effect.includes_any.some(
            (member) =>
              member.toUpperCase() === candidate.toUpperCase(),
          ),
      )
        ? "legal"
        : "not_legal";
    }
    case "rotation": {
      const attributes = card.game_data.attributes;
      const rawBlocks =
        attributes.block_icons !== undefined
          ? attributes.block_icons
          : attributes.block_icon;
      if (rawBlocks === null || rawBlocks === undefined) {
        return "indeterminate";
      }
      const blocks = Array.isArray(rawBlocks) ? rawBlocks : [rawBlocks];
      return blocks.some(
        (block) =>
          typeof block === "string" &&
          effect.eligible_blocks.some(
            (eligible) =>
              eligible.toUpperCase() === block.toUpperCase(),
          ),
      )
        ? "legal"
        : "not_legal";
    }
  }
}

function derivation(
  status: "legal" | "restricted" | "not_legal" | "indeterminate",
  evaluations: readonly {
    rule: LegalityRule;
    outcome: "legal" | "restricted" | "not_legal" | "indeterminate";
  }[],
): string {
  if (evaluations.length === 0) {
    return "Indeterminate because no effective published Legality Rule establishes this Card's status for the requested context.";
  }
  const audit = evaluations
    .map(
      ({ rule, outcome }) =>
        `${rule.id} (${rule.effect.type}) evaluated ${outcome}: ${rule.official_wording}`,
    )
    .join(" ");
  return `Derived ${status} from ${evaluations.length} effective rule${evaluations.length === 1 ? "" : "s"}. ${audit}`;
}

function parseQuery(url: URL): {
  cardId: string;
  on: string;
  format: string;
  eventTier: string | null;
  region: LegalityRegion | null;
} {
  const allowed = new Set([
    "card_id",
    "on",
    "format",
    "event_tier",
    "region",
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new LegalityStatusProblem(
        400,
        "invalid_parameter",
        "The Legality Status query contains an unknown or duplicate parameter.",
      );
    }
  }
  const cardId = requiredParameter(url, "card_id");
  if (
    cardId.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(cardId)
  ) {
    throw new LegalityStatusProblem(
      400,
      "invalid_parameter",
      "card_id must be an opaque identity of at most 200 characters.",
    );
  }
  const on = requiredParameter(url, "on");
  const format = requiredParameter(url, "format");
  if (!validDate(on)) {
    throw new LegalityStatusProblem(
      400,
      "invalid_parameter",
      "on must be a valid ISO date.",
    );
  }
  const eventTier = optionalParameter(url, "event_tier");
  const rawRegion = optionalParameter(url, "region");
  if (
    rawRegion !== null &&
    rawRegion !== "EN-OCEANIA" &&
    rawRegion !== "EN-ASIA" &&
    rawRegion !== "EN-US"
  ) {
    throw new LegalityStatusProblem(
      400,
      "invalid_parameter",
      "region must be EN-OCEANIA, EN-ASIA, or EN-US.",
    );
  }
  return {
    cardId,
    on,
    format,
    eventTier,
    region: rawRegion,
  };
}

function requiredParameter(url: URL, name: string): string {
  const value = optionalParameter(url, name);
  if (value === null) {
    throw new LegalityStatusProblem(
      400,
      "invalid_parameter",
      `${name} is required.`,
    );
  }
  return value;
}

function optionalParameter(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  if (value === null) return null;
  if (value.length === 0 || value !== value.trim()) {
    throw new LegalityStatusProblem(
      400,
      "invalid_parameter",
      `${name} must be a non-empty string.`,
    );
  }
  return value;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

function regionsFor(game: CatalogueCard["game"]): readonly LegalityRegion[] {
  return game === "gundam"
    ? ["EN-ASIA", "EN-US"]
    : ["EN-OCEANIA"];
}
