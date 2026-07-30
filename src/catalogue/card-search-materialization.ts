import {
  cardSearchTerms,
  cardSearchText,
} from "./card-search";

type SearchableCard = {
  official_identity: { value: string };
  name: string;
  effective_rules_text?: string | null;
};

type PendingRevision = {
  catalogue_revision_id: string;
  repaired_through_card_id: string | null;
};

type RevisionCardRow = {
  card_id: string;
  document_json: string;
};

export type CardSearchRepairResult = {
  contract: "card-keepr-card-search-repair@1";
  complete: boolean;
  processed_cards: number;
  revisions_available: number;
};

export async function repairCardSearchMaterialization(
  database: D1Database,
  options: { limit?: number } = {},
): Promise<CardSearchRepairResult> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Card search repair limit must be from 1 to 100.");
  }
  const revision = await database.prepare(
    `SELECT query.catalogue_revision_id,
            query.repaired_through_card_id
     FROM catalogue_query_revisions AS query
     WHERE query.state = 'pending'
     ORDER BY query.catalogue_revision_id
     LIMIT 1`,
  ).first<PendingRevision>();
  if (revision === null) return repairResult(database, 0);

  const rows = await database.prepare(
    `SELECT card_id, document_json
     FROM revision_cards
     WHERE catalogue_revision_id = ?
       AND (? IS NULL OR card_id > ?)
     ORDER BY card_id
     LIMIT ?`,
  )
    .bind(
      revision.catalogue_revision_id,
      revision.repaired_through_card_id,
      revision.repaired_through_card_id,
      limit + 1,
    )
    .all<RevisionCardRow>();
  const page = rows.results.slice(0, limit);
  const revisionComplete = rows.results.length <= limit;
  const repairs = page.map((row) => {
    const searchText = cardSearchText(
      JSON.parse(row.document_json) as SearchableCard,
    );
    return {
      card_id: row.card_id,
      search_text: searchText,
      terms: cardSearchTerms(searchText),
    };
  });
  const repairJson = JSON.stringify(
    repairs.map(({ card_id, search_text }) => ({
      card_id,
      search_text,
    })),
  );
  const termJson = JSON.stringify(
    repairs.flatMap((repair) =>
      repair.terms.map((term) => ({
        card_id: repair.card_id,
        term,
      }))
    ),
  );
  const statements: D1PreparedStatement[] = page.length === 0
    ? []
    : [
      database.prepare(
        `WITH repairs AS (
           SELECT
             CAST(json_extract(value, '$.card_id') AS TEXT) AS card_id,
             CAST(json_extract(value, '$.search_text') AS TEXT)
               AS search_text
           FROM json_each(?)
         )
         UPDATE revision_cards
         SET search_text = (
           SELECT repair.search_text
           FROM repairs AS repair
           WHERE repair.card_id = revision_cards.card_id
         )
         WHERE catalogue_revision_id = ?
           AND card_id IN (SELECT card_id FROM repairs)`,
      ).bind(repairJson, revision.catalogue_revision_id),
      database.prepare(
        `DELETE FROM revision_card_search_terms
         WHERE catalogue_revision_id = ?
           AND card_id IN (
             SELECT CAST(json_extract(value, '$.card_id') AS TEXT)
             FROM json_each(?)
           )`,
      ).bind(revision.catalogue_revision_id, repairJson),
      database.prepare(
        `INSERT INTO revision_card_search_terms (
           catalogue_revision_id, card_id, term
         )
         SELECT ?,
                CAST(json_extract(value, '$.card_id') AS TEXT),
                CAST(json_extract(value, '$.term') AS TEXT)
         FROM json_each(?)`,
      ).bind(revision.catalogue_revision_id, termJson),
    ];
  statements.push(
    revisionComplete
      ? database.prepare(
        `UPDATE catalogue_query_revisions
         SET state = 'available',
             repaired_through_card_id = NULL
         WHERE catalogue_revision_id = ? AND state = 'pending'`,
      ).bind(revision.catalogue_revision_id)
      : database.prepare(
        `UPDATE catalogue_query_revisions
         SET repaired_through_card_id = ?
         WHERE catalogue_revision_id = ? AND state = 'pending'`,
      ).bind(
        page.at(-1)!.card_id,
        revision.catalogue_revision_id,
      ),
  );
  await database.batch(statements);
  return repairResult(database, page.length);
}

async function repairResult(
  database: D1Database,
  processedCards: number,
): Promise<CardSearchRepairResult> {
  const counts = await database.prepare(
    `SELECT
       sum(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
       sum(CASE WHEN state = 'available' THEN 1 ELSE 0 END) AS available
     FROM catalogue_query_revisions`,
  ).first<{ pending: number | null; available: number | null }>();
  return {
    contract: "card-keepr-card-search-repair@1",
    complete: (counts?.pending ?? 0) === 0,
    processed_cards: processedCards,
    revisions_available: counts?.available ?? 0,
  };
}
