import * as ingestionQueries from "../../ingestion/test/query-helpers/ingestion";
import * as publishedCatalogueQueries from "../../ingestion/test/query-helpers/published-catalogue";
import * as cardSearchQueries from "../../ingestion/test/query-helpers/card-search";
import * as sourceEvidenceQueries from "../../ingestion/test/query-helpers/source-evidence";
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeEach } from "vitest";
import { cardSearchChunks, cardSearchText } from "../../../src/catalogue/read";

export const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
};

// The vitest pool mounts the API at the root of this local base (issue
// #123); every emitted link is absolute on it.
export const apiPublicBase = "http://127.0.0.1:8787";

export function installApiSuite(): void {
  beforeEach(async () => {
    await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
    await ingestionQueries.setOperationStateActiveIngestionRunIdForInstallApiSuite(testEnv.CATALOGUE_DB).run();
    await publishedCatalogueQueries
      .setCatalogueStateCurrentRevisionIdPublishedAtForInstallApiSuite(testEnv.CATALOGUE_DB)
      .run();
  });
}

export function apiHeaders(ip: string): Record<string, string> {
  return {
    authorization: "Bearer vitest-api-key",
    "cf-connecting-ip": ip,
  };
}

export type ApiCardFixture = Record<string, unknown> & {
  id: string;
  official_identity: { kind: string; value: string };
  name: string;
  effective_rules_text: unknown;
};

export function apiCard(input: {
  id: string;
  cardNumber: string;
  name: string;
  effectiveRulesText?: string;
}): ApiCardFixture {
  return {
    type: "card",
    id: input.id,
    game: "one-piece",
    official_identity: {
      kind: "card_number",
      value: input.cardNumber,
    },
    name: input.name,
    game_data: {
      profile: "one-piece@1",
      attributes: {
        card_type: "leader",
        colours: ["red"],
        cost: null,
        life: 5,
        battle_attributes: [],
        power: 5000,
        counter: null,
        traits: [],
        block_icons: [],
        effect_text: input.name,
        trigger_text: null,
      },
    },
    effective_rules_text: input.effectiveRulesText ?? input.name,
    printing_ids: [],
    source_lineages: ["one-piece-en"],
    lifecycle: {
      first_revision_id: "catrev_fixture",
      last_observed_revision_id: "catrev_fixture",
      withdrawn: false,
    },
    links: { self: `/v1/cards/${input.id}` },
  };
}

export async function seedApiRevision(input: {
  revisionId: string;
  runId: string;
  cards: readonly ApiCardFixture[];
}): Promise<void> {
  const digest = "b".repeat(64);
  const previousRevisionId = await publishedCatalogueQueries
    .readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB)
    .first<string>("current_revision_id");
  if (previousRevisionId === null) {
    throw new Error("The API test catalogue state is unavailable.");
  }
  await testEnv.CATALOGUE_DB.batch([
    ingestionQueries.insertIngestionRunsForSeedApiRevision(testEnv.CATALOGUE_DB).bind(
      input.runId,
      previousRevisionId,
      `${input.runId}-seed`,
      digest,
      JSON.stringify({
        candidate_digest: digest,
        expected_current_revision_id: previousRevisionId,
        approved_at: "2026-07-20T00:00:00.000Z",
      }),
    ),
    ingestionQueries
      .setOperationStateActiveIngestionRunIdForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(input.runId),
  ]);
  await ingestionQueries
    .insertCatalogueRevisionsForSeedApiRevision(testEnv.CATALOGUE_DB)
    .bind(input.revisionId, input.runId, digest, previousRevisionId, digest)
    .run();
  await testEnv.CATALOGUE_DB.batch([
    ...input.cards.flatMap((card) => [
      publishedCatalogueQueries
        .insertRevisionCardsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
          testEnv.CATALOGUE_DB,
        )
        .bind(input.revisionId, card.id, JSON.stringify(publishedCardEnvelope(card))),
      ...cardSearchStatements(input.revisionId, card),
    ]),
    publishedCatalogueQueries
      .insertCatalogueQueryRevisionsForSeedApiRevision(testEnv.CATALOGUE_DB)
      .bind(input.revisionId),
    publishedCatalogueQueries
      .setCatalogueStateCurrentRevisionIdPublishedAtForSeedApiRevision(testEnv.CATALOGUE_DB)
      .bind(input.revisionId),
    ingestionQueries
      .setIngestionRunsStatePublishedRevisionIdForSeedApiRevision(testEnv.CATALOGUE_DB)
      .bind(input.revisionId, input.revisionId, input.runId),
    ingestionQueries.setOperationStateActiveIngestionRunIdForSeedApiRevision(testEnv.CATALOGUE_DB).bind(input.runId),
  ]);
}

export function cardSearchStatements(revisionId: string, card: ApiCardFixture): D1PreparedStatement[] {
  return [
    publishedCatalogueQueries
      .insertRevisionCardQueryDocuments(testEnv.CATALOGUE_DB)
      .bind(revisionId, card.id, JSON.stringify(apiCardSummary(card)), apiCardSearchText(card)),
    ...cardSearchChunks(apiCardSearchText(card)).map((chunk) =>
      cardSearchQueries
        .insertRevisionCardSearchChunks(testEnv.CATALOGUE_DB)
        .bind(revisionId, card.id, chunk.field, chunk.ordinal, chunk.text),
    ),
  ];
}

export function legalitySourceStatements(input: {
  runId: string;
  key: string;
  game: string;
  profile: string;
  lineage: string;
  adapter: string;
  snapshotId: string;
  observationSetId: string;
}): D1PreparedStatement[] {
  const requestId = `request_${input.key}`;
  const fetchId = `fetch_${input.key}`;
  const parseId = `parse_${input.key}`;
  const fingerprint = "1".repeat(64);
  const requestUrl = `https://official-source.invalid/${input.key}`;
  const requestPlan = JSON.stringify({
    requests: [
      {
        id: requestId,
        method: "GET",
        url: requestUrl,
        headers: {},
        representation_fingerprint: fingerprint,
      },
    ],
  });
  return [
    sourceEvidenceQueries
      .insertIngestionEvidencePlans(testEnv.CATALOGUE_DB)
      .bind(input.runId, input.lineage, input.game, input.profile, input.adapter, requestPlan),
    sourceEvidenceQueries
      .insertSourceRequests(testEnv.CATALOGUE_DB)
      .bind(input.runId, requestId, requestUrl, fingerprint, input.snapshotId),
    sourceEvidenceQueries.insertSourceFetchAttempts(testEnv.CATALOGUE_DB).bind(fetchId, input.runId, requestId),
    sourceEvidenceQueries
      .insertSourceSnapshots(testEnv.CATALOGUE_DB)
      .bind(
        input.snapshotId,
        input.runId,
        requestId,
        fetchId,
        requestUrl,
        fingerprint,
        "2".repeat(64),
        `source-snapshots/${input.key}.json`,
        input.lineage,
        input.game,
        input.profile,
        input.adapter,
      ),
    sourceEvidenceQueries
      .insertSourceParseOperations(testEnv.CATALOGUE_DB)
      .bind(
        parseId,
        input.snapshotId,
        input.adapter,
        `parse-${input.key}`,
        input.observationSetId,
        `source-observations/${input.key}.json`,
        "3".repeat(64),
      ),
    sourceEvidenceQueries
      .insertSourceObservationSets(testEnv.CATALOGUE_DB)
      .bind(
        input.observationSetId,
        parseId,
        input.snapshotId,
        input.lineage,
        input.game,
        input.profile,
        input.adapter,
        "3".repeat(64),
        `source-observations/${input.key}.json`,
      ),
  ];
}

function apiCardSummary(card: ApiCardFixture) {
  return {
    type: card.type,
    id: card.id,
    game: card.game,
    official_identity: card.official_identity,
    name: card.name,
    game_data: card.game_data,
    lifecycle: card.lifecycle,
    links: card.links,
  };
}

function apiCardSearchText(card: ApiCardFixture): string {
  return cardSearchText({
    official_identity: card.official_identity,
    name: card.name,
    effective_rules_text:
      typeof card.effective_rules_text === "string" || card.effective_rules_text === null
        ? card.effective_rules_text
        : null,
  });
}

export function canonicalLegalityRuleStatements(
  revisionId: string,
  rules: readonly {
    id: string;
    official_id: string;
    game: string;
    region: string;
    format: string;
    event_tier: string | null;
    effective_from: string | null;
    effective_until: string | null;
    unresolved_scope?: {
      dimensions: readonly ("effective_interval" | "event_tier" | "target_scope")[];
    } | null;
    card_ids: readonly string[];
    official_wording: string;
    effect: unknown;
    source_lineage: string;
    source_snapshot_id: string;
    source_observation_set_id: string;
    source_observation_id: string;
    // The retrieval instant the publication projects onto the revision row
    // (migration 0004); defaults to the legalitySourceStatements snapshot.
    source_retrieved_at?: string;
  }[],
): D1PreparedStatement[] {
  return rules.map((rule, index) => {
    const pointer = `/observations/0/value/legality_rules/${index}`;
    const cardIds = canonicalLegalityCardIds(rule);
    const unresolvedScope = rule.unresolved_scope ?? null;
    return sourceEvidenceQueries
      .insertLegalityRules(testEnv.CATALOGUE_DB)
      .bind(
        rule.id,
        rule.official_id,
        rule.game,
        rule.region,
        rule.format,
        rule.event_tier,
        rule.effective_from,
        rule.effective_until,
        JSON.stringify(unresolvedScope),
        rule.official_wording,
        JSON.stringify(rule.effect),
        JSON.stringify(cardIds),
        JSON.stringify(rule.card_ids),
        rule.source_lineage,
        rule.source_snapshot_id,
        rule.source_observation_set_id,
        rule.source_observation_id,
        pointer,
        JSON.stringify(legalityRuleFieldPointers(pointer)),
        revisionId,
        revisionId,
      );
  });
}

export function revisionLegalityRuleStatements(
  revisionId: string,
  rules: Parameters<typeof canonicalLegalityRuleStatements>[1],
): D1PreparedStatement[] {
  return rules.map(({ source_retrieved_at: sourceRetrievedAt, ...rule }, index) => {
    const pointer = `/observations/0/value/legality_rules/${index}`;
    const unresolvedScope = rule.unresolved_scope ?? null;
    const document = {
      ...rule,
      unresolved_scope: unresolvedScope,
      source_observation_pointer: pointer,
      source_field_pointers: legalityRuleFieldPointers(pointer),
      first_revision_id: revisionId,
      last_observed_revision_id: revisionId,
      current: true,
      last_missing_revision_id: null,
    };
    return sourceEvidenceQueries
      .insertRevisionLegalityRules(testEnv.CATALOGUE_DB)
      .bind(
        revisionId,
        rule.id,
        rule.game,
        rule.region,
        rule.format,
        rule.event_tier,
        rule.effective_from,
        rule.effective_until,
        JSON.stringify(unresolvedScope),
        JSON.stringify(canonicalLegalityCardIds(rule)),
        sourceRetrievedAt ?? "2026-07-30T00:00:01.000Z",
        JSON.stringify(document),
      );
  });
}

function canonicalLegalityCardIds(rule: Parameters<typeof canonicalLegalityRuleStatements>[1][number]): string[] {
  const effect = rule.effect as { type?: unknown; with_card_ids?: unknown };
  const companionIds =
    effect.type === "prohibited_combination" && Array.isArray(effect.with_card_ids)
      ? effect.with_card_ids.filter((value): value is string => typeof value === "string")
      : [];
  return [...new Set([...rule.card_ids, ...companionIds])].sort();
}

export function publishedCardEnvelope(data: Record<string, unknown>) {
  return { data, included: [], provenance: {}, disagreements: [] };
}

export function legalityRuleFieldPointers(pointer: string) {
  return {
    official_wording: `${pointer}/official_wording`,
    effective_from: `${pointer}/effective_from`,
    effective_until: `${pointer}/effective_until`,
    unresolved_scope: `${pointer}/unresolved_scope`,
    region: `${pointer}/region`,
    format: `${pointer}/format`,
    event_tier: `${pointer}/event_tier`,
    card_numbers: `${pointer}/card_numbers`,
    effect: `${pointer}/effect`,
  };
}
