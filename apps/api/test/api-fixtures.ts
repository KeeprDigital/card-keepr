import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeEach } from "vitest";
import { cardSearchChunks, cardSearchTerms, cardSearchText } from "../../../src/catalogue/read";

export const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
};

// The vitest pool mounts the API at the root of this local base (issue
// #123); every emitted link is absolute on it.
export const apiPublicBase = "http://127.0.0.1:8787";

export function installApiSuite(): void {
  beforeEach(async () => {
    await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
    await testEnv.CATALOGUE_DB.prepare(
      `UPDATE operation_state SET active_ingestion_run_id = NULL
       WHERE singleton = 1`,
    ).run();
    await testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_state
       SET current_revision_id = 'catrev_spine_000',
           published_at = '1970-01-01T00:00:00.000Z'
       WHERE singleton = 1`,
    ).run();
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
  const previousRevisionId = await testEnv.CATALOGUE_DB.prepare(
    `SELECT current_revision_id
     FROM catalogue_state WHERE singleton = 1`,
  ).first<string>("current_revision_id");
  if (previousRevisionId === null) {
    throw new Error("The API test catalogue state is unavailable.");
  }
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_digest, candidate_created_at, approval_deadline,
         approval_json, published_revision_id, export_manifest_digest,
         terminal_at, candidate_json, approval_idempotency_key
       ) VALUES (
         ?, 'publishing', '["one-piece"]',
         '2026-07-20T00:00:00.000Z', ?, NULL, ?, ?,
         '2026-07-20T00:00:00.000Z',
         '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
       )`,
    ).bind(
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
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE operation_state
       SET active_ingestion_run_id = ?
       WHERE singleton = 1`,
    ).bind(input.runId),
  ]);
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO catalogue_revisions (
       id, ingestion_run_id, published_at, content_digest,
       expected_previous_revision_id, approved_candidate_digest
     ) VALUES (?, ?, '2026-07-20T00:00:00.000Z', ?, ?, ?)`,
  )
    .bind(input.revisionId, input.runId, digest, previousRevisionId, digest)
    .run();
  await testEnv.CATALOGUE_DB.batch([
    ...input.cards.flatMap((card) => [
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO revision_cards (
           catalogue_revision_id, card_id, document_json
         ) VALUES (?, ?, ?)`,
      ).bind(input.revisionId, card.id, JSON.stringify(publishedCardEnvelope(card))),
      ...cardSearchStatements(input.revisionId, card),
    ]),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO catalogue_query_revisions (
         catalogue_revision_id, state, repaired_through_card_id
       ) VALUES (?, 'available', NULL)`,
    ).bind(input.revisionId),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_state
       SET current_revision_id = ?,
           published_at = '2026-07-20T00:00:00.000Z'
       WHERE singleton = 1`,
    ).bind(input.revisionId),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE ingestion_runs
       SET state = 'published',
           published_revision_id = ?,
           resulting_revision_id = ?,
           publication_outcome = 'revision',
           terminal_at = '2026-07-20T00:00:00.000Z'
       WHERE id = ?`,
    ).bind(input.revisionId, input.revisionId, input.runId),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE operation_state
       SET active_ingestion_run_id = NULL
       WHERE active_ingestion_run_id = ?`,
    ).bind(input.runId),
  ]);
}

export function cardSearchStatements(revisionId: string, card: ApiCardFixture): D1PreparedStatement[] {
  return [
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_card_query_documents (
         catalogue_revision_id, card_id, summary_json, search_text
       ) VALUES (?, ?, ?, ?)`,
    ).bind(revisionId, card.id, JSON.stringify(apiCardSummary(card)), apiCardSearchText(card)),
    ...cardSearchTerms(apiCardSearchText(card)).map((term) =>
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO revision_card_search_terms (
           catalogue_revision_id, card_id, term, sort_game,
           sort_identity_kind, sort_identity_value, sort_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(revisionId, card.id, term, card.game, card.official_identity.kind, card.official_identity.value, card.id),
    ),
    ...cardSearchChunks(apiCardSearchText(card)).map((chunk) =>
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO revision_card_search_chunks (
           catalogue_revision_id, card_id, field_ordinal,
           chunk_ordinal, search_text
         ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(revisionId, card.id, chunk.field, chunk.ordinal, chunk.text),
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
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_evidence_plans (
        ingestion_run_id, source_lineage, supported_game,
        game_profile_version, adapter_version, request_plan_json,
        plan_origin
      ) VALUES (?, ?, ?, ?, ?, ?, 'synthetic_fixture')`,
    ).bind(input.runId, input.lineage, input.game, input.profile, input.adapter, requestPlan),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
        ingestion_run_id, request_id, sequence_number, method, url,
        request_headers_json, representation_fingerprint, state,
        source_snapshot_id
      ) VALUES (?, ?, 0, 'GET', ?, '{}', ?, 'observed', ?)`,
    ).bind(input.runId, requestId, requestUrl, fingerprint, input.snapshotId),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_fetch_attempts (
        id, ingestion_run_id, request_id, attempt_number,
        requested_at, completed_at, outcome, http_status,
        response_headers_json, retry_after_ms, diagnostic
      ) VALUES (?, ?, ?, 1, '2026-07-30T00:00:00.000Z',
        '2026-07-30T00:00:01.000Z', 'success', 200, '{}', NULL, NULL)`,
    ).bind(fetchId, input.runId, requestId),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_snapshots (
        id, ingestion_run_id, request_id, fetch_attempt_id,
        request_method, request_url, request_headers_json,
        representation_fingerprint, response_vary_json, retrieved_at,
        http_status, response_headers_json, media_type, content_digest,
        content_byte_length, content_object_key, source_lineage,
        supported_game, game_profile_version, adapter_version,
        reused_source_snapshot_id
      ) VALUES (?, ?, ?, ?, 'GET', ?, '{}', ?, '[]',
        '2026-07-30T00:00:01.000Z', 200, '{}', 'application/json', ?, 2,
        ?, ?, ?, ?, ?, NULL)`,
    ).bind(
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
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_parse_operations (
        id, source_snapshot_id, adapter_version, intent,
        idempotency_key, observation_set_id, content_object_key,
        parsed_at, state, content_digest, content_byte_length,
        observation_count
      ) VALUES (?, ?, ?, 'collection', ?, ?, ?,
        '2026-07-30T00:00:02.000Z', 'finalized', ?, 2, 1)`,
    ).bind(
      parseId,
      input.snapshotId,
      input.adapter,
      `parse-${input.key}`,
      input.observationSetId,
      `source-observations/${input.key}.json`,
      "3".repeat(64),
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_observation_sets (
        id, parse_operation_id, source_snapshot_id, source_lineage,
        supported_game, game_profile_version, adapter_version, parsed_at,
        content_digest, content_byte_length, content_object_key,
        observation_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-07-30T00:00:02.000Z',
        ?, 2, ?, 1)`,
    ).bind(
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
  }[],
): D1PreparedStatement[] {
  return rules.map((rule, index) => {
    const pointer = `/observations/0/value/legality_rules/${index}`;
    const cardIds = canonicalLegalityCardIds(rule);
    const unresolvedScope = rule.unresolved_scope ?? null;
    return testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO legality_rules (
        id, official_id, supported_game, region, format, event_tier,
        effective_from, effective_until, unresolved_scope_json, official_wording,
        effect_json, card_ids_json, direct_card_ids_json, source_lineage,
        source_snapshot_id, source_observation_set_id,
        source_observation_id, source_observation_pointer,
        source_field_pointers_json, first_revision_id,
        last_observed_revision_id, current, last_missing_revision_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, 1, NULL)`,
    ).bind(
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
  return rules.map((rule, index) => {
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
    return testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_legality_rules (
        catalogue_revision_id, legality_rule_id, supported_game,
        region, format, event_tier, effective_from, effective_until,
        unresolved_scope_json, card_ids_json, document_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
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
