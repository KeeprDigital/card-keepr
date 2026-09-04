import {
  type PrintingQueryFact,
  printingQueryProjectionStatements,
} from "../../../src/catalogue/ingestion/printing-query-materialization";

export async function seedPrintingQueryFixture(database: D1Database): Promise<void> {
  await database.batch([
    database
      .prepare(`INSERT INTO ingestion_runs (
      id, state, selected_games_json, started_at, expected_current_revision_id, idempotency_key,
      candidate_digest, candidate_created_at, approval_deadline, approval_json, candidate_json
    ) VALUES ('run_products', 'publishing', '["one-piece"]', '2026-01-01T00:00:00.000Z',
      'catrev_spine_000', 'printing-query-fixture', ?, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', ?, '{}')`)
      .bind(
        "a".repeat(64),
        JSON.stringify({
          candidate_digest: "a".repeat(64),
          expected_current_revision_id: "catrev_spine_000",
          approved_at: "2026-01-01T00:00:00.000Z",
        }),
      ),
    database.prepare("UPDATE operation_state SET active_ingestion_run_id = 'run_products' WHERE singleton = 1"),
    database
      .prepare(
        `INSERT INTO catalogue_revisions VALUES ('catrev_products', 'run_products', '2026-01-01T00:00:00.000Z', ?, 'catrev_spine_000', ?)`,
      )
      .bind("a".repeat(64), "a".repeat(64)),
    database.prepare(
      `INSERT INTO catalogue_query_revisions(catalogue_revision_id,state) VALUES ('catrev_products','available')`,
    ),
    database
      .prepare(`INSERT INTO revision_cards VALUES ('catrev_products','card_st15_event', ?)`)
      .bind(JSON.stringify({ id: "card_st15_event", game: "one-piece" })),
    database
      .prepare(`INSERT INTO revision_printings VALUES ('catrev_products','printing_st15_event','card_st15_event', ?)`)
      .bind(
        JSON.stringify({
          id: "printing_st15_event",
          card_id: "card_st15_event",
          rarity: { normalized: "leader", raw: "L" },
        }),
      ),
    database.prepare(
      `INSERT INTO revision_products VALUES ('catrev_products','product_st15','one-piece','ST-15','Starter','starter','["EN-OCEANIA"]','{}')`,
    ),
    database.prepare("UPDATE catalogue_state SET current_revision_id='catrev_products' WHERE singleton=1"),
  ]);
}

export async function seedPrintingQueryProjection(database: D1Database): Promise<void> {
  const rows = await database
    .prepare(`
    SELECT printing.printing_id, printing.card_id,
           coalesce(json_extract(card.document_json, '$.data.game'), json_extract(card.document_json, '$.game')) AS supported_game,
           coalesce(json_extract(printing.document_json, '$.data.rarity.normalized'), json_extract(printing.document_json, '$.rarity.normalized')) AS normalized_rarity
    FROM revision_printings AS printing JOIN revision_cards AS card
      ON card.catalogue_revision_id = printing.catalogue_revision_id AND card.card_id = printing.card_id
    WHERE printing.catalogue_revision_id = 'catrev_products'
  `)
    .all<PrintingQueryFact>();
  await database.batch([
    database.prepare("DELETE FROM revision_printing_query WHERE catalogue_revision_id = 'catrev_products'"),
    ...printingQueryProjectionStatements(database, "catrev_products", rows.results),
  ]);
}
