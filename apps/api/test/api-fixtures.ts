import { catalogueStore } from "../../../src/catalogue/shared";
import * as ingestionQueries from "../../ingestion/test/query-helpers/ingestion";
import * as publishedCatalogueQueries from "../../ingestion/test/query-helpers/published-catalogue";
import * as cardSearchQueries from "../../ingestion/test/query-helpers/card-search";
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
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
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
  const cardStatements = input.cards.flatMap((card) => [
    publishedCatalogueQueries
      .insertRevisionCardsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(input.revisionId, card.id, JSON.stringify(publishedCardEnvelope(card))),
    ...cardSearchStatements(input.revisionId, card),
  ]);
  for (let offset = 0; offset < cardStatements.length; offset += 400) {
    await catalogueStore(testEnv.CATALOGUE_DB).batch(cardStatements.slice(offset, offset + 400));
  }
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
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
    cardSearchQueries.indexFixtureCardSearchRows(testEnv.CATALOGUE_DB).bind(revisionId, card.id),
    cardSearchQueries.indexFixtureCardSearchContents(testEnv.CATALOGUE_DB).bind(revisionId, card.id),
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

export function publishedCardEnvelope(data: Record<string, unknown>) {
  return { data, included: [], provenance: {}, disagreements: [] };
}
