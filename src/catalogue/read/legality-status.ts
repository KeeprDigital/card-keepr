import { type PublicBase, publicUrl } from "../../http/public-base";
import { requiredLegalityRegionsForGame } from "../adapters";
import {
  evaluateLegalityRuleEffect,
  legalityRuleCardIds,
  parseStoredCatalogueCard,
  parseStoredLegalityRule,
  type StoredLegalityStatusCard,
  type StoredLegalityStatusRule,
  unresolvedTargetScope,
} from "../legality";
import { type CatalogueStore, isIsoCalendarDate, type LegalityRegion, maximumLegalityStatusRules } from "../shared";
import {
  canonicalEtag,
  collectionFilter,
  collectionPage,
  collectionParameters,
  collectionSelf,
  conditionalResponse,
  invalidParameter as invalidQueryParameter,
  pinRevision,
  ReadProblem,
  revisionHeaders,
} from "./collection-endpoint";
import type { ContextRow, RuleRow } from "./published-read-repository";
import { applicableLegalityRulesStatement, legalityCardStatement } from "./published-read-repository";

type StoredRule = {
  rule: StoredLegalityStatusRule;
  sourceRetrievedAt: string | null;
};

export async function contextualLegalityStatusResponse(
  request: Request,
  database: CatalogueStore,
  base: PublicBase,
): Promise<Response> {
  const url = new URL(request.url);
  const query = parseQuery(url);
  const revision = await pinRevision(database, null, url.pathname, base, { projection: false });
  const context = await legalityCardStatement(database, {
    cardId: query.cardId,
    revisionId: revision.id,
  }).first<ContextRow>();
  if (context === null) {
    throw new ReadProblem(404, "not_found", "The requested Card does not exist in the current Catalogue Revision.");
  }
  const card = parsedStoredDocument(() => parseStoredCatalogueCard(context.document_json));
  const supportedRegions = requiredLegalityRegionsForGame(card.game);
  if (query.region !== null && !supportedRegions.includes(query.region)) {
    throw new ReadProblem(
      422,
      "invalid_legality_region",
      card.game === "gundam"
        ? "Gundam Legality Status is available only for EN-ASIA and EN-US; EN-OCEANIA is not synthesized."
        : `${query.region} is not a Legality region for this Card's Supported Game.`,
    );
  }
  const regions = query.region === null ? supportedRegions : [query.region];
  const page = await collectionPage<RuleRow>(
    applicableLegalityRulesStatement(database, {
      revisionId: context.current_revision_id,
      cardId: query.cardId,
      regionsJson: JSON.stringify(regions),
      game: card.game,
      format: query.format,
      onDate: query.on,
      eventTier: query.eventTier,
      rowLimit: maximumLegalityStatusRules + 1,
    }),
    maximumLegalityStatusRules,
  );
  if (page.hasMore) {
    throw new ReadProblem(500, "internal_error", "The request could not be completed.");
  }
  const stored: StoredRule[] = page.rows.map((row) => ({
    rule: parsedStoredDocument(() => parseStoredLegalityRule(row.document_json)),
    sourceRetrievedAt: row.source_retrieved_at,
  }));
  const rules = stored.map(({ rule }) => rule);
  const data = regions.map((region) => deriveRegionStatus(card, rules, query, region));
  const self = publicUrl(
    base,
    collectionSelf(url.pathname, {
      card_id: query.cardId,
      on: query.on,
      format: query.format,
      event_tier: query.eventTier,
      region: query.region,
      include: query.includeEvidence ? "evidence" : null,
    }),
  );
  const document = {
    data,
    ...(query.includeEvidence ? legalityEvidenceSidecar(stored, query, regions) : {}),
    meta: {
      catalogue_revision_id: context.current_revision_id,
      published_at: context.published_at,
    },
    links: { self },
  };
  const etag = await canonicalEtag(document);
  const headers = revisionHeaders(revision.id, etag);
  const conditional = conditionalResponse(request, headers);
  return conditional ?? Response.json(document, { headers });
}

function parsedStoredDocument<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new ReadProblem(500, "internal_error", "The request could not be completed.");
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
  const unresolvedScope = applicable.filter((rule) => rule.unresolved_scope !== null);
  const evaluations = applicable.map((rule) => ({
    rule,
    outcome: evaluateLegalityRuleEffect(rule.effect, card.game_data.attributes, query.on),
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
  return rules
    .filter(
      (rule) =>
        rule.region === region &&
        (legalityRuleCardIds(rule).length === 0 ||
          legalityRuleCardIds(rule).includes(query.cardId) ||
          // An unresolved target scope names an open publisher predicate whose
          // membership beyond the enumerated Cards is unknown, so the rule is
          // an explicit uncertainty for every Card in its context.
          unresolvedTargetScope(rule.unresolved_scope)),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

function legalityEvidenceSidecar(
  stored: readonly StoredRule[],
  query: { cardId: string },
  regions: readonly LegalityRegion[],
): {
  included: Array<{
    type: "source_observation";
    id: string;
    captured_at: string;
    source: string;
  }>;
  provenance: Record<string, string[]>;
} {
  const rules = stored.map(({ rule }) => rule);
  const capturedAtByRule = new Map(stored.map(({ rule, sourceRetrievedAt }) => [rule.id, sourceRetrievedAt]));
  const applicableByRegion = regions.map((region) => applicableRules(rules, query, region));
  const applicable = applicableByRegion.flat();
  const evidenceById = new Map<
    string,
    {
      type: "source_observation";
      id: string;
      captured_at: string;
      source: string;
    }
  >();
  for (const rule of applicable) {
    const capturedAt = capturedAtByRule.get(rule.id) ?? null;
    if (capturedAt === null) {
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
    const observationIds = [...new Set(applicable.map((rule) => rule.source_observation_id))].sort();
    if (observationIds.length > 0) {
      provenance[`/data/${dataIndex}/status`] = observationIds;
      provenance[`/data/${dataIndex}/derivation`] = observationIds;
    }
    let definitiveIndex = 0;
    let unresolvedIndex = 0;
    for (const rule of applicable) {
      const field = rule.unresolved_scope === null ? "rule_ids" : "unresolved_scope_rule_ids";
      const fieldIndex = rule.unresolved_scope === null ? definitiveIndex++ : unresolvedIndex++;
      provenance[`/data/${dataIndex}/${field}/${fieldIndex}`] = [rule.source_observation_id];
    }
  }
  const included = [...evidenceById.values()].sort((left, right) => left.id.localeCompare(right.id));
  return { included, provenance };
}

function deriveStatus(
  evaluations: readonly {
    outcome: "legal" | "restricted" | "not_legal" | "indeterminate";
  }[],
) {
  const status = evaluations.some(({ outcome }) => outcome === "not_legal")
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
  const unresolvedCount = evaluations.filter(({ rule }) => rule.unresolved_scope !== null).length;
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
  collectionParameters(url, ["card_id", "on", "format", "event_tier", "region", "include"]);
  const cardId = requiredParameter(url, "card_id");
  if (cardId.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(cardId)) {
    throw invalidQueryParameter("card_id", "card_id must be an opaque identity of at most 200 characters.");
  }
  const on = requiredParameter(url, "on");
  const format = requiredParameter(url, "format");
  if (!isIsoCalendarDate(on)) {
    throw invalidQueryParameter("on", "on must be a valid ISO date.");
  }
  const eventTier = optionalParameter(url, "event_tier");
  const include = optionalParameter(url, "include");
  if (include !== null && include !== "evidence") {
    throw invalidQueryParameter("include", "include must be exactly evidence when supplied.");
  }
  const rawRegion = optionalParameter(url, "region");
  if (rawRegion !== null && rawRegion !== "EN-OCEANIA" && rawRegion !== "EN-ASIA" && rawRegion !== "EN-US") {
    throw invalidQueryParameter("region", "region must be EN-OCEANIA, EN-ASIA, or EN-US.");
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
    throw invalidQueryParameter(name, `${name} is required.`);
  }
  return value;
}

function optionalParameter(url: URL, name: string): string | null {
  const value = collectionFilter(url, name);
  if (value === null) return null;
  if (value.length === 0 || value !== value.trim()) {
    throw invalidQueryParameter(name, `${name} must be a non-empty string.`);
  }
  return value;
}
