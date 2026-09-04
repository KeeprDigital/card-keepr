import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { cardSearchChunks, cardSearchFtsQuery, cardSearchText } from "../../../src/catalogue/read";
import { releaseSmokeSearchQuery } from "../../../src/catalogue/ingestion";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
});

test("Production Release search fixtures come from realistic revision-pinned Card index material", async () => {
  const revision = "catrev_release_fixture";
  const cardId = "opaque-card-row-2";
  const data = {
    type: "card",
    id: cardId,
    game: "one-piece",
    official_identity: { kind: "card_number", value: "OP99-002" },
    name: "Indexed Release Sentinel",
    effective_rules_text: "When attacking, draw one indexed card.",
    game_data: { profile: "one-piece@1", attributes: {} },
    lifecycle: { current: true },
    links: {},
  };
  const document = JSON.stringify({ data });
  const summary = JSON.stringify(data);
  const searchDocument = cardSearchText(data);
  await testEnv.CATALOGUE_DB.prepare("DROP TRIGGER guard_catalogue_publication").run();
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (id,state,selected_games_json,started_at,
       expected_current_revision_id,idempotency_key,candidate_digest,
       approval_deadline,candidate_json)
       VALUES ('run_release_fixture','awaiting_approval','[]',
       '2026-08-05T00:00:00.000Z','catrev_spine_000','run-release-fixture',?,
       '2099-01-01T00:00:00.000Z','{}')`,
    ).bind("a".repeat(64)),
    testEnv.CATALOGUE_DB.prepare(
      "UPDATE operation_state SET active_ingestion_run_id='run_release_fixture' WHERE singleton=1",
    ),
  ]);
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO catalogue_revisions (id,ingestion_run_id,published_at,
     content_digest,expected_previous_revision_id,approved_candidate_digest)
     VALUES (?,'run_release_fixture','2026-08-05T00:00:00.000Z',?,
     'catrev_spine_000',?)`,
  )
    .bind(revision, "b".repeat(64), "a".repeat(64))
    .run();
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare("INSERT INTO revision_cards VALUES (?,?,?)").bind(revision, cardId, document),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_card_query_documents
       (catalogue_revision_id,card_id,summary_json,search_text)
       VALUES (?,?,?,?)`,
    ).bind(revision, cardId, summary, searchDocument),
  ]);
  for (const chunk of cardSearchChunks(searchDocument)) {
    await testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_card_search_chunks
       (catalogue_revision_id,card_id,field_ordinal,chunk_ordinal,search_text)
       VALUES (?,?,?,?,?)`,
    )
      .bind(revision, cardId, chunk.field, chunk.ordinal, chunk.text)
      .run();
  }

  const query = releaseSmokeSearchQuery(document);
  expect(query).toBe("op99-002");
  expect(query).not.toBe(cardId);
  if (query === null) throw new Error("release search fixture missing");
  const fts = cardSearchFtsQuery(query, revision);
  const indexed = await testEnv.CATALOGUE_DB.prepare(
    `SELECT card_id FROM revision_card_search_fts
     WHERE revision_card_search_fts MATCH ?
       AND catalogue_revision_id=? AND instr(search_text,?)>0`,
  )
    .bind(fts, revision, query)
    .first<{ card_id: string }>();
  expect(indexed?.card_id).toBe(cardId);
});
