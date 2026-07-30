import {
  cardSearchChunks,
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

const defaultMaximumBoundParameterBytes = 64 * 1024;
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
    targetRevisionId?: string;
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
    maximumBoundParameterBytes !== defaultMaximumBoundParameterBytes
  ) {
    throw new Error(
      "Card search repair parameter bytes must be exactly 65536.",
    );
  }

  const targetRevisionId = options.targetRevisionId;
  const revision = await pendingRevision(database, targetRevisionId);
  if (revision === null) {
    const missing = await database.prepare(
      `SELECT revision.id AS catalogue_revision_id
       FROM catalogue_revisions AS revision
       WHERE NOT EXISTS (
           SELECT 1 FROM catalogue_query_revisions AS query
           WHERE query.catalogue_revision_id = revision.id
         )
         AND (? IS NULL OR revision.id = ?)
       ORDER BY revision.id
       LIMIT 1`,
    )
      .bind(targetRevisionId ?? null, targetRevisionId ?? null)
      .first<{ catalogue_revision_id: string }>();
    if (missing === null) {
      return repairResult(database, 0, 0, targetRevisionId);
    }
    await database.prepare(
      `INSERT INTO catalogue_query_revisions (
         catalogue_revision_id, state, repaired_through_card_id,
         repair_card_id, repair_search_offset, repair_term_offset
       ) VALUES (?, 'pending', NULL, NULL, 0, 0)
       ON CONFLICT(catalogue_revision_id) DO NOTHING`,
    ).bind(missing.catalogue_revision_id).run();
    return repairResult(
      database,
      0,
      boundBytes(missing.catalogue_revision_id),
      targetRevisionId,
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
        targetRevisionId,
      );
    }
    const claimed = await database.batch([
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
    assertCasBatch(claimed, [0, 1]);
    return repairResult(
      database,
      0,
      Math.max(
        boundBytes(revision.catalogue_revision_id, next.card_id),
        boundBytes(next.card_id, revision.catalogue_revision_id),
      ),
      targetRevisionId,
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
    const appended = await database.batch([
      database.prepare(
        `UPDATE revision_card_query_documents
         SET search_text = search_text || ?
         WHERE catalogue_revision_id = ? AND card_id = ?
           AND length(CAST(search_text AS BLOB)) = ?`,
      ).bind(
        chunk,
        revision.catalogue_revision_id,
        revision.repair_card_id,
        revision.repair_search_offset,
      ),
      database.prepare(
        `UPDATE catalogue_query_revisions
         SET repair_search_offset = ?
         WHERE catalogue_revision_id = ?
           AND state = 'pending'
           AND repair_card_id = ?
           AND repair_search_offset = ?
           AND EXISTS (
             SELECT 1
             FROM revision_card_query_documents AS document
             WHERE document.catalogue_revision_id =
                     catalogue_query_revisions.catalogue_revision_id
               AND document.card_id =
                     catalogue_query_revisions.repair_card_id
               AND length(CAST(document.search_text AS BLOB)) = ?
           )`,
      ).bind(
        nextOffset,
        revision.catalogue_revision_id,
        revision.repair_card_id,
        revision.repair_search_offset,
        nextOffset,
      ),
    ]);
    assertCasPair(appended);
    return repairResult(database, 0, measured, targetRevisionId);
  }

  const entries = [
    ...cardSearchChunks(searchText).map((chunk) => ({
      kind: "chunk" as const,
      chunk,
    })),
    ...cardSearchTerms(searchText).map((term) => ({
      kind: "term" as const,
      term,
    })),
  ];
  if (revision.repair_term_offset < entries.length) {
    const selectedEntries = entries.slice(
      revision.repair_term_offset,
      revision.repair_term_offset + maximumTermsPerInvocation,
    );
    const statements = selectedEntries.map((entry) => {
      const measured = boundBytes(
        entry.kind === "term" ? entry.term : entry.chunk.text,
        revision.catalogue_revision_id,
        revision.repair_card_id!,
      );
      if (measured > maximumBoundParameterBytes) {
        throw new Error("The Card search repair parameter bound was exceeded.");
      }
      return entry.kind === "term"
        ? database.prepare(
          `INSERT OR IGNORE INTO revision_card_search_terms (
             catalogue_revision_id, card_id, term, sort_game,
             sort_identity_kind, sort_identity_value, sort_id
           )
           SELECT catalogue_revision_id, card_id, ?,
                  sort_game, sort_identity_kind, sort_identity_value, sort_id
           FROM revision_card_query_documents
           WHERE catalogue_revision_id = ? AND card_id = ?`,
        ).bind(
          entry.term,
          revision.catalogue_revision_id,
          revision.repair_card_id,
        )
        : database.prepare(
          `INSERT OR IGNORE INTO revision_card_search_chunks (
             catalogue_revision_id, card_id, field_ordinal,
             chunk_ordinal, search_text
           ) VALUES (?, ?, ?, ?, ?)`,
        ).bind(
          revision.catalogue_revision_id,
          revision.repair_card_id,
          entry.chunk.field,
          entry.chunk.ordinal,
          entry.chunk.text,
        );
    });
    const nextOffset = revision.repair_term_offset + selectedEntries.length;
    statements.push(
      database.prepare(
        `UPDATE catalogue_query_revisions
         SET repair_term_offset = ?
         WHERE catalogue_revision_id = ?
           AND state = 'pending'
           AND repair_card_id = ?
           AND repair_term_offset = ?`,
      ).bind(
        nextOffset,
        revision.catalogue_revision_id,
        revision.repair_card_id,
        revision.repair_term_offset,
      ),
    );
    const inserted = await database.batch(statements);
    const offsetResult = inserted.at(-1);
    if (
      offsetResult === undefined ||
      (offsetResult.meta.changes !== 0 && offsetResult.meta.changes !== 1)
    ) {
      throw new Error("The Card search repair term offset CAS is invalid.");
    }
    return repairResult(
      database,
      0,
      Math.max(
        ...selectedEntries.map((entry) =>
          boundBytes(
            entry.kind === "term" ? entry.term : entry.chunk.text,
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
      targetRevisionId,
    );
  }

  const completedCard = await database.prepare(
    `UPDATE catalogue_query_revisions
     SET repaired_through_card_id = repair_card_id,
         repair_card_id = NULL,
         repair_search_offset = 0,
         repair_term_offset = 0
     WHERE catalogue_revision_id = ?
       AND state = 'pending'
       AND repair_card_id = ?
       AND repair_search_offset = ?
       AND repair_term_offset = ?`,
  ).bind(
    revision.catalogue_revision_id,
    revision.repair_card_id,
    searchBytes.byteLength,
    entries.length,
  ).run();
  if (
    completedCard.meta.changes !== 0 &&
    completedCard.meta.changes !== 1
  ) {
    throw new Error("The Card search repair completion CAS is invalid.");
  }
  return repairResult(
    database,
    completedCard.meta.changes,
    boundBytes(revision.catalogue_revision_id, revision.repair_card_id),
    targetRevisionId,
  );
}

async function pendingRevision(
  database: D1Database,
  targetRevisionId?: string,
): Promise<PendingRevision | null> {
  return database.prepare(
    `SELECT catalogue_revision_id, repaired_through_card_id,
            repair_card_id, repair_search_offset, repair_term_offset
     FROM catalogue_query_revisions
     WHERE state = 'pending'
       AND (? IS NULL OR catalogue_revision_id = ?)
     ORDER BY catalogue_revision_id
     LIMIT 1`,
  )
    .bind(targetRevisionId ?? null, targetRevisionId ?? null)
    .first<PendingRevision>();
}

async function repairResult(
  database: D1Database,
  processedCards: number,
  maximumBoundParameterBytes: number,
  targetRevisionId?: string,
): Promise<CardSearchRepairResult> {
  const counts = await database.prepare(
    `SELECT
       sum(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
       sum(CASE WHEN state = 'available' THEN 1 ELSE 0 END) AS available,
       EXISTS (
         SELECT 1
         FROM catalogue_revisions AS revision
         WHERE NOT EXISTS (
             SELECT 1 FROM catalogue_query_revisions AS query
             WHERE query.catalogue_revision_id = revision.id
           )
           AND (? IS NULL OR revision.id = ?)
       ) AS missing
     FROM catalogue_query_revisions
     WHERE (? IS NULL OR catalogue_revision_id = ?)`,
  )
    .bind(
      targetRevisionId ?? null,
      targetRevisionId ?? null,
      targetRevisionId ?? null,
      targetRevisionId ?? null,
    )
    .first<{
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

function assertCasPair(results: readonly D1Result<unknown>[]): void {
  if (results.length !== 2) {
    throw new Error("The Card search repair CAS result is invalid.");
  }
  const changes = results.map((result) => result.meta.changes);
  if (
    (changes[0] !== 0 && changes[0] !== 1) ||
    (changes[1] !== 0 && changes[1] !== 1) ||
    changes[0] !== changes[1]
  ) {
    throw new Error("The Card search repair offset CAS was not atomic.");
  }
}

function assertCasBatch(
  results: readonly D1Result<unknown>[],
  allowedChanges: readonly number[],
): void {
  if (
    results.some((result) => !allowedChanges.includes(result.meta.changes))
  ) {
    throw new Error("The Card search repair claim CAS is invalid.");
  }
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
