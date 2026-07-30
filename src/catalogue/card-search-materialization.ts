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
  repair_card_id: string | null;
  repair_search_offset: number;
  repair_term_offset: number;
};

type RevisionCardRow = {
  document_json: string;
};

export type CardSearchRepairResult = {
  contract: "card-keepr-card-search-repair@1";
  complete: boolean;
  processed_cards: number;
  revisions_available: number;
  maximum_bound_parameter_bytes: number;
};

const defaultMaximumBoundParameterBytes = 32 * 1024;
const maximumTermsPerInvocation = 25;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

export async function repairCardSearchMaterialization(
  database: D1Database,
  options: {
    limit?: number;
    maximumBoundParameterBytes?: number;
  } = {},
): Promise<CardSearchRepairResult> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Card search repair limit must be from 1 to 100.");
  }
  const maximumBoundParameterBytes =
    options.maximumBoundParameterBytes ?? defaultMaximumBoundParameterBytes;
  if (
    !Number.isInteger(maximumBoundParameterBytes) ||
    maximumBoundParameterBytes < 1_024 ||
    maximumBoundParameterBytes > 64 * 1_024
  ) {
    throw new Error(
      "Card search repair parameter bytes must be from 1024 to 65536.",
    );
  }

  const revision = await pendingRevision(database);
  if (revision === null) {
    const missing = await database.prepare(
      `SELECT revision.id AS catalogue_revision_id
       FROM catalogue_revisions AS revision
       WHERE EXISTS (
         SELECT 1 FROM revision_cards AS card
         WHERE card.catalogue_revision_id = revision.id
       )
         AND NOT EXISTS (
           SELECT 1 FROM catalogue_query_revisions AS query
           WHERE query.catalogue_revision_id = revision.id
         )
       ORDER BY revision.id
       LIMIT 1`,
    ).first<{ catalogue_revision_id: string }>();
    if (missing === null) return repairResult(database, 0, 0);
    await database.prepare(
      `INSERT INTO catalogue_query_revisions (
         catalogue_revision_id, state, repaired_through_card_id,
         repair_card_id, repair_search_offset, repair_term_offset
       ) VALUES (?, 'pending', NULL, NULL, 0, 0)`,
    ).bind(missing.catalogue_revision_id).run();
    return repairResult(
      database,
      0,
      boundBytes(missing.catalogue_revision_id),
    );
  }

  if (revision.repair_card_id === null) {
    const next = await database.prepare(
      `SELECT card_id
       FROM revision_cards
       WHERE catalogue_revision_id = ?
         AND (? IS NULL OR card_id > ?)
       ORDER BY card_id
       LIMIT 1`,
    )
      .bind(
        revision.catalogue_revision_id,
        revision.repaired_through_card_id,
        revision.repaired_through_card_id,
      )
      .first<{ card_id: string }>();
    if (next === null) {
      await database.prepare(
        `UPDATE catalogue_query_revisions
         SET state = 'available',
             repaired_through_card_id = NULL,
             repair_card_id = NULL,
             repair_search_offset = 0,
             repair_term_offset = 0
         WHERE catalogue_revision_id = ? AND state = 'pending'`,
      ).bind(revision.catalogue_revision_id).run();
      return repairResult(
        database,
        0,
        boundBytes(revision.catalogue_revision_id),
      );
    }
    await database.batch([
      database.prepare(
        `INSERT OR IGNORE INTO revision_card_query_documents (
           catalogue_revision_id, card_id, summary_json, search_text
         )
         SELECT catalogue_revision_id, card_id,
                json_object(
                  'type', json_extract(document_json, '$.type'),
                  'id', json_extract(document_json, '$.id'),
                  'game', json_extract(document_json, '$.game'),
                  'official_identity',
                    json_extract(document_json, '$.official_identity'),
                  'name', json_extract(document_json, '$.name'),
                  'game_data', json_extract(document_json, '$.game_data'),
                  'lifecycle', json_extract(document_json, '$.lifecycle'),
                  'links', json_extract(document_json, '$.links')
                ),
                ''
         FROM revision_cards
         WHERE catalogue_revision_id = ? AND card_id = ?`,
      ).bind(revision.catalogue_revision_id, next.card_id),
      database.prepare(
        `UPDATE catalogue_query_revisions
         SET repair_card_id = ?,
             repair_search_offset = 0,
             repair_term_offset = 0
         WHERE catalogue_revision_id = ?
           AND state = 'pending'
           AND repair_card_id IS NULL`,
      ).bind(next.card_id, revision.catalogue_revision_id),
    ]);
    return repairResult(
      database,
      0,
      Math.max(
        boundBytes(revision.catalogue_revision_id, next.card_id),
        boundBytes(next.card_id, revision.catalogue_revision_id),
      ),
    );
  }

  const row = await database.prepare(
    `SELECT document_json
     FROM revision_cards
     WHERE catalogue_revision_id = ? AND card_id = ?`,
  )
    .bind(revision.catalogue_revision_id, revision.repair_card_id)
    .first<RevisionCardRow>();
  if (row === null) {
    throw new Error("The Card search repair source Card is unavailable.");
  }
  const searchText = cardSearchText(
    JSON.parse(row.document_json) as SearchableCard,
  );
  const searchBytes = encoder.encode(searchText);
  if (revision.repair_search_offset < searchBytes.byteLength) {
    const fixedBytes = boundBytes(
      revision.catalogue_revision_id,
      revision.repair_card_id,
    );
    const chunk = utf8Chunk(
      searchBytes,
      revision.repair_search_offset,
      maximumBoundParameterBytes - fixedBytes,
    );
    const nextOffset = revision.repair_search_offset +
      encoder.encode(chunk).byteLength;
    const measured = Math.max(
      boundBytes(
        chunk,
        revision.catalogue_revision_id,
        revision.repair_card_id,
      ),
      boundBytes(
        nextOffset,
        revision.catalogue_revision_id,
        revision.repair_card_id,
      ),
    );
    if (measured > maximumBoundParameterBytes) {
      throw new Error("The Card search repair parameter bound was exceeded.");
    }
    await database.batch([
      database.prepare(
        `UPDATE revision_card_query_documents
         SET search_text = search_text || ?
         WHERE catalogue_revision_id = ? AND card_id = ?`,
      ).bind(chunk, revision.catalogue_revision_id, revision.repair_card_id),
      database.prepare(
        `UPDATE catalogue_query_revisions
         SET repair_search_offset = ?
         WHERE catalogue_revision_id = ?
           AND state = 'pending'
           AND repair_card_id = ?`,
      ).bind(
        nextOffset,
        revision.catalogue_revision_id,
        revision.repair_card_id,
      ),
    ]);
    return repairResult(database, 0, measured);
  }

  const terms = cardSearchTerms(searchText);
  if (revision.repair_term_offset < terms.length) {
    const selectedTerms = terms.slice(
      revision.repair_term_offset,
      revision.repair_term_offset + maximumTermsPerInvocation,
    );
    const statements = selectedTerms.map((term) => {
      const measured = boundBytes(
        term,
        revision.catalogue_revision_id,
        revision.repair_card_id!,
      );
      if (measured > maximumBoundParameterBytes) {
        throw new Error("The Card search repair parameter bound was exceeded.");
      }
      return database.prepare(
        `INSERT OR IGNORE INTO revision_card_search_terms (
           catalogue_revision_id, card_id, term, sort_game,
           sort_identity_kind, sort_identity_value, sort_id
         )
         SELECT catalogue_revision_id, card_id, ?,
                sort_game, sort_identity_kind, sort_identity_value, sort_id
         FROM revision_card_query_documents
         WHERE catalogue_revision_id = ? AND card_id = ?`,
      ).bind(term, revision.catalogue_revision_id, revision.repair_card_id);
    });
    const nextOffset = revision.repair_term_offset + selectedTerms.length;
    statements.push(
      database.prepare(
        `UPDATE catalogue_query_revisions
         SET repair_term_offset = ?
         WHERE catalogue_revision_id = ?
           AND state = 'pending'
           AND repair_card_id = ?`,
      ).bind(
        nextOffset,
        revision.catalogue_revision_id,
        revision.repair_card_id,
      ),
    );
    await database.batch(statements);
    return repairResult(
      database,
      0,
      Math.max(
        ...selectedTerms.map((term) =>
          boundBytes(
            term,
            revision.catalogue_revision_id,
            revision.repair_card_id!,
          )
        ),
        boundBytes(
          nextOffset,
          revision.catalogue_revision_id,
          revision.repair_card_id,
        ),
      ),
    );
  }

  await database.prepare(
    `UPDATE catalogue_query_revisions
     SET repaired_through_card_id = repair_card_id,
         repair_card_id = NULL,
         repair_search_offset = 0,
         repair_term_offset = 0
     WHERE catalogue_revision_id = ?
       AND state = 'pending'
       AND repair_card_id = ?`,
  ).bind(revision.catalogue_revision_id, revision.repair_card_id).run();
  return repairResult(
    database,
    1,
    boundBytes(revision.catalogue_revision_id, revision.repair_card_id),
  );
}

async function pendingRevision(
  database: D1Database,
): Promise<PendingRevision | null> {
  return database.prepare(
    `SELECT catalogue_revision_id, repaired_through_card_id,
            repair_card_id, repair_search_offset, repair_term_offset
     FROM catalogue_query_revisions
     WHERE state = 'pending'
     ORDER BY catalogue_revision_id
     LIMIT 1`,
  ).first<PendingRevision>();
}

async function repairResult(
  database: D1Database,
  processedCards: number,
  maximumBoundParameterBytes: number,
): Promise<CardSearchRepairResult> {
  const counts = await database.prepare(
    `SELECT
       sum(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
       sum(CASE WHEN state = 'available' THEN 1 ELSE 0 END) AS available,
       EXISTS (
         SELECT 1
         FROM catalogue_revisions AS revision
         WHERE EXISTS (
           SELECT 1 FROM revision_cards AS card
           WHERE card.catalogue_revision_id = revision.id
         )
           AND NOT EXISTS (
             SELECT 1 FROM catalogue_query_revisions AS query
             WHERE query.catalogue_revision_id = revision.id
           )
       ) AS missing
     FROM catalogue_query_revisions`,
  ).first<{
    pending: number | null;
    available: number | null;
    missing: number;
  }>();
  return {
    contract: "card-keepr-card-search-repair@1",
    complete:
      (counts?.pending ?? 0) === 0 &&
      (counts?.missing ?? 0) === 0,
    processed_cards: processedCards,
    revisions_available: counts?.available ?? 0,
    maximum_bound_parameter_bytes: maximumBoundParameterBytes,
  };
}

function boundBytes(...values: readonly (string | number)[]): number {
  return values.reduce<number>(
    (total, value) => total + encoder.encode(String(value)).byteLength,
    0,
  );
}

function utf8Chunk(
  bytes: Uint8Array,
  offset: number,
  maximumBytes: number,
): string {
  if (maximumBytes < 1) {
    throw new Error("The Card search repair parameter bound is too small.");
  }
  let end = Math.min(bytes.byteLength, offset + maximumBytes);
  while (end > offset) {
    try {
      return decoder.decode(bytes.slice(offset, end));
    } catch {
      end -= 1;
    }
  }
  throw new Error("The Card search repair could not make bounded progress.");
}
