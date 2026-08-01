import type {
  LegalityRegion,
  LegalityRule,
} from "./legality-rule";
import {
  evaluateLegalityRuleEffect,
  legalityRuleCardIds,
} from "./legality-rule";
import { canonicalJson, sha256Text } from "./serialization";
import { ifNoneMatchMatches } from "../http/conditional-request";
import { isIsoCalendarDate } from "./calendar-date.mjs";

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

type SnapshotEvidenceRow = {
  id: string;
  retrieved_at: string;
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
    ...(query.includeEvidence
      ? await legalityEvidenceSidecar(database, rules, query, regions)
      : {}),
    meta: {
      catalogue_revision_id: context.current_revision_id,
      published_at: context.published_at,
    },
    links: { self },
  };
  const etag = `"${await sha256Text(canonicalJson(document))}"`;
  if (ifNoneMatchMatches(request, etag)) {
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
  const applicable = applicableRules(rules, query, region);
  const evaluations = applicable.map((rule) => ({
    rule,
    outcome: evaluateLegalityRuleEffect(
      rule.effect,
      card.game_data.attributes,
      query.on,
    ),
  }));
  const status = deriveStatus(evaluations);
  return {
    card_id: query.cardId,
    on: query.on,
    format: query.format,
    event_tier: query.eventTier,
    region,
    status,
    rule_ids: applicable.map((rule) => rule.id),
    derivation: derivation(status, evaluations),
  };
}

function applicableRules(
  rules: readonly LegalityRule[],
  query: { cardId: string },
  region: LegalityRegion,
): LegalityRule[] {
  return rules.filter(
    (rule) =>
      rule.region === region &&
      (legalityRuleCardIds(rule).length === 0 ||
        legalityRuleCardIds(rule).includes(query.cardId)),
  ).sort((left, right) => left.id.localeCompare(right.id));
}

async function legalityEvidenceSidecar(
  database: D1Database,
  rules: readonly LegalityRule[],
  query: { cardId: string },
  regions: readonly LegalityRegion[],
): Promise<{
  included: Array<{
    type: "source_observation";
    id: string;
    captured_at: string;
    source: string;
  }>;
  provenance: Record<string, string[]>;
}> {
  const applicableByRegion = regions.map((region) =>
    applicableRules(rules, query, region)
  );
  const applicable = applicableByRegion.flat();
  const snapshotIds = [...new Set(
    applicable.map((rule) => rule.source_snapshot_id),
  )].sort();
  const snapshots = snapshotIds.length === 0
    ? []
    : (await database.prepare(
      `SELECT id, retrieved_at
       FROM source_snapshots
       WHERE id IN (SELECT value FROM json_each(?))
       ORDER BY id`,
    ).bind(JSON.stringify(snapshotIds)).all<SnapshotEvidenceRow>()).results;
  const capturedAtBySnapshot = new Map(
    snapshots.map((snapshot) => [snapshot.id, snapshot.retrieved_at]),
  );
  const evidenceById = new Map<string, {
    type: "source_observation";
    id: string;
    captured_at: string;
    source: string;
  }>();
  for (const rule of applicable) {
    const capturedAt = capturedAtBySnapshot.get(rule.source_snapshot_id);
    if (capturedAt === undefined) {
      throw new Error("Legality Status Source Observation evidence disappeared.");
    }
    evidenceById.set(rule.source_observation_id, {
      type: "source_observation",
      id: rule.source_observation_id,
      captured_at: capturedAt,
      source: rule.source_lineage,
    });
  }
  const provenance: Record<string, string[]> = {};
  for (const [dataIndex, applicable] of applicableByRegion.entries()) {
    const observationIds = [...new Set(
      applicable.map((rule) => rule.source_observation_id),
    )].sort();
    if (observationIds.length > 0) {
      provenance[`/data/${dataIndex}/status`] = observationIds;
      provenance[`/data/${dataIndex}/derivation`] = observationIds;
    }
    for (const [ruleIndex, rule] of applicable.entries()) {
      provenance[`/data/${dataIndex}/rule_ids/${ruleIndex}`] = [
        rule.source_observation_id,
      ];
    }
  }
  const included = [...evidenceById.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  return { included, provenance };
}

function deriveStatus(
  evaluations: readonly {
    outcome: "legal" | "restricted" | "not_legal" | "indeterminate";
  }[],
) {
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
  return status;
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
  includeEvidence: boolean;
} {
  const allowed = new Set([
    "card_id",
    "on",
    "format",
    "event_tier",
    "region",
    "include",
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
  if (!isIsoCalendarDate(on)) {
    throw new LegalityStatusProblem(
      400,
      "invalid_parameter",
      "on must be a valid ISO date.",
    );
  }
  const eventTier = optionalParameter(url, "event_tier");
  const include = optionalParameter(url, "include");
  if (include !== null && include !== "evidence") {
    throw new LegalityStatusProblem(
      400,
      "invalid_parameter",
      "include must be exactly evidence when supplied.",
    );
  }
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
    includeEvidence: include === "evidence",
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

function regionsFor(game: CatalogueCard["game"]): readonly LegalityRegion[] {
  return game === "gundam"
    ? ["EN-ASIA", "EN-US"]
    : ["EN-OCEANIA"];
}
