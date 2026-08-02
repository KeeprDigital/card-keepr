import type { LegalityRegion } from "./legality-rule";
import {
  evaluateLegalityRuleEffect,
  legalityRuleCardIds,
} from "./legality-rule";
import { canonicalJson, sha256Text } from "./serialization";
import { ifNoneMatchMatches } from "../http/conditional-request";
import { isIsoCalendarDate } from "./calendar-date.mjs";
import { requiredLegalityRegionsForGame } from "./official-source-scope";
import { maximumLegalityStatusRules } from "./export-limits";
import {
  parseStoredCatalogueCard,
  parseStoredLegalityRule,
  type StoredLegalityStatusCard,
  type StoredLegalityStatusRule,
} from "./stored-legality-documents";

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
    readonly status: 400 | 404 | 422 | 500,
    readonly code:
      | "invalid_parameter"
      | "not_found"
      | "invalid_legality_region"
      | "internal_error",
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
  const card = parsedStoredDocument(() =>
    parseStoredCatalogueCard(context.document_json)
  );
  const supportedRegions = requiredLegalityRegionsForGame(card.game);
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
  const regions = query.region === null
    ? supportedRegions
    : [query.region];
  const rows = await database
    .prepare(
      `WITH applicable AS (
         SELECT legality_rule_id
         FROM revision_legality_rule_applicability
         WHERE catalogue_revision_id = ?
           AND applicability_kind = 'card'
           AND card_id = ?
         UNION ALL
         SELECT legality_rule_id
         FROM revision_legality_rule_applicability
         WHERE catalogue_revision_id = ?
           AND applicability_kind = 'all_cards'
           AND card_id = ''
       )
       SELECT rule.document_json
       FROM applicable
       JOIN revision_legality_rules AS rule
         ON rule.catalogue_revision_id = ?
        AND rule.legality_rule_id = applicable.legality_rule_id
       WHERE rule.region IN (SELECT value FROM json_each(?))
         AND rule.supported_game = ?
         AND rule.format = ?
         AND (
           (
             rule.effective_from <= ?
             AND (rule.effective_until IS NULL OR ? < rule.effective_until)
           )
           OR EXISTS (
             SELECT 1
             FROM json_each(rule.unresolved_scope_json, '$.dimensions')
             WHERE value = 'effective_interval'
           )
         )
         AND (
           rule.event_tier IS NULL OR rule.event_tier = ?
           OR EXISTS (
             SELECT 1
             FROM json_each(rule.unresolved_scope_json, '$.dimensions')
             WHERE value = 'event_tier'
           )
         )
       ORDER BY rule.region, rule.legality_rule_id
       LIMIT ?`,
    )
    .bind(
      context.current_revision_id,
      query.cardId,
      context.current_revision_id,
      context.current_revision_id,
      JSON.stringify(regions),
      card.game,
      query.format,
      query.on,
      query.on,
      query.eventTier,
      maximumLegalityStatusRules + 1,
    )
    .all<RuleRow>();
  if (rows.results.length > maximumLegalityStatusRules) {
    throw new LegalityStatusProblem(
      500,
      "internal_error",
      "The request could not be completed.",
    );
  }
  const rules = rows.results.map((row) =>
    parsedStoredDocument(() => parseStoredLegalityRule(row.document_json))
  );
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

function parsedStoredDocument<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new LegalityStatusProblem(
      500,
      "internal_error",
      "The request could not be completed.",
    );
  }
}

function deriveRegionStatus(
  card: StoredLegalityStatusCard,
  rules: readonly StoredLegalityStatusRule[],
  query: {
    cardId: string;
    on: string;
    format: string;
    eventTier: string | null;
  },
  region: LegalityRegion,
) {
  const applicable = applicableRules(rules, query, region);
  const effective = applicable.filter((rule) => rule.unresolved_scope === null);
  const unresolvedScope = applicable.filter(
    (rule) => rule.unresolved_scope !== null,
  );
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
    rule_ids: effective.map((rule) => rule.id),
    unresolved_scope_rule_ids: unresolvedScope.map((rule) => rule.id),
    derivation: derivation(status, evaluations),
  };
}

function applicableRules(
  rules: readonly StoredLegalityStatusRule[],
  query: { cardId: string },
  region: LegalityRegion,
): StoredLegalityStatusRule[] {
  return rules.filter(
    (rule) =>
      rule.region === region &&
      (legalityRuleCardIds(rule).length === 0 ||
        legalityRuleCardIds(rule).includes(query.cardId)),
  ).sort((left, right) => left.id.localeCompare(right.id));
}

async function legalityEvidenceSidecar(
  database: D1Database,
  rules: readonly StoredLegalityStatusRule[],
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
    let definitiveIndex = 0;
    let unresolvedIndex = 0;
    for (const rule of applicable) {
      const field = rule.unresolved_scope === null
        ? "rule_ids"
        : "unresolved_scope_rule_ids";
      const fieldIndex = rule.unresolved_scope === null
        ? definitiveIndex++
        : unresolvedIndex++;
      provenance[`/data/${dataIndex}/${field}/${fieldIndex}`] = [
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
    rule: StoredLegalityStatusRule;
    outcome: "legal" | "restricted" | "not_legal" | "indeterminate";
  }[],
): string {
  if (evaluations.length === 0) {
    return "Indeterminate because no effective published Legality Rule establishes this Card's status for the requested context.";
  }
  const audit = evaluations
    .map(
      ({ rule, outcome }) =>
        `${rule.id} (${rule.effect.type}${rule.unresolved_scope === null ? "" : ", unresolved scope"}) evaluated ${outcome}: ${rule.official_wording}`,
    )
    .join(" ");
  const unresolvedCount = evaluations.filter(
    ({ rule }) => rule.unresolved_scope !== null,
  ).length;
  const effectiveCount = evaluations.length - unresolvedCount;
  return `Derived ${status} from ${effectiveCount} effective rule${effectiveCount === 1 ? "" : "s"} and ${unresolvedCount} contextual scope uncertaint${unresolvedCount === 1 ? "y" : "ies"}. ${audit}`;
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
