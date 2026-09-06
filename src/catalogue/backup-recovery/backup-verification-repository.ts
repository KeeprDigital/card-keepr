import { cardCollectionPageQuery } from "../read";
import { type CatalogueStore, repositoryStatements, runCurrentColumns } from "../shared";

export type CatalogueVerificationQuery =
  | Readonly<{ kind: "evidence"; revisionId: string; expectedJson: string }>
  | Readonly<{ kind: "integrity" }>
  | Readonly<{ kind: "representative-card"; revisionId: string; representativeCardId: string; searchText: string }>;

// Local D1 bindings and the remote D1 API consume the same query definitions.
export function catalogueVerificationQuery(input: CatalogueVerificationQuery): {
  sql: string;
  params: readonly unknown[];
} {
  if (input.kind === "integrity") return { sql: "PRAGMA quick_check", params: [] };
  if (input.kind === "evidence")
    return { sql: verificationEvidenceSql(), params: [input.revisionId, input.expectedJson] };
  const page = cardCollectionPageQuery(
    input.revisionId,
    { q: input.searchText, game: null, cardNumber: null, productId: null, rarity: null, attributes: {}, limit: 100 },
    null,
    100,
  );
  return {
    sql: `WITH expected_card(value) AS (SELECT ?),
          api_page AS (${page.sql})
     SELECT api_page.* FROM api_page, expected_card
     WHERE expected_card.value IS NOT NULL`,
    params: [input.representativeCardId, ...page.bindings],
  };
}

export function catalogueVerificationStatement(
  database: CatalogueStore,
  input: CatalogueVerificationQuery,
): D1PreparedStatement {
  const query = catalogueVerificationQuery(input);
  const statement = repositoryStatements(database).prepare(query.sql);
  return query.params.length === 0 ? statement : statement.bind(...query.params);
}

function verificationEvidenceSql(): string {
  return `SELECT catalogue.current_revision_id,
      schema_state.migration_level AS schema_migration_level,
      search.state AS card_search_state,
      (SELECT count(*) FROM sqlite_schema WHERE type = 'table'
       AND name = 'revision_card_search_fts'
       AND lower(sql) LIKE '%create virtual table%') AS card_search_fts_tables,
      (SELECT count(*) FROM revision_card_search_chunks AS chunk
       LEFT JOIN revision_card_search_fts_rows AS mapped USING (
         catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
       ) WHERE chunk.catalogue_revision_id = catalogue.current_revision_id
         AND mapped.fts_rowid IS NULL) AS missing_fts_rows,
      (SELECT count(*) FROM revision_card_query_documents
       WHERE catalogue_revision_id = catalogue.current_revision_id
         AND json_valid(summary_json) = 0) AS invalid_api_documents,
      (SELECT count(*) FROM catalogue_curated_provenance AS provenance
       LEFT JOIN curated_revisions AS curated
         ON curated.id = provenance.curated_revision_id
       WHERE provenance.catalogue_revision_id = catalogue.current_revision_id
         AND (
           curated.id IS NULL
           OR provenance.content_digest <> curated.content_digest
           OR provenance.target_key <> curated.target_key
           OR json_valid(provenance.provenance_json) = 0
           OR json_extract(provenance.provenance_json, '$.author')
                IS NOT curated.author
           OR json_extract(provenance.provenance_json, '$.created_at')
                IS NOT curated.created_at
           OR json_type(provenance.provenance_json, '$.evidence') <> 'array'
           OR json_extract(provenance.provenance_json, '$.evidence')
                IS NOT json_extract(curated.proposal_json, '$.evidence')
           OR json_extract(provenance.provenance_json, '$.rationale')
                IS NOT json_extract(curated.proposal_json, '$.rationale')
         )) AS invalid_curated_provenance,
      (SELECT count(*) FROM catalogue_revisions AS revision
       JOIN ingestion_runs AS run ON run.id = revision.ingestion_run_id
       LEFT JOIN ingestion_run_current AS current ON current.ingestion_run_id = run.id
       LEFT JOIN ingestion_run_events AS latest ON latest.ingestion_run_id = run.id
         AND latest.sequence_number = current.last_event_sequence
       LEFT JOIN ingestion_run_events AS birth ON birth.ingestion_run_id = run.id AND birth.sequence_number = 1
       WHERE revision.id = catalogue.current_revision_id AND (
         current.ingestion_run_id IS NULL OR latest.event_id IS NULL
         OR latest.event_id IS NOT current.last_event_id
         OR latest.to_state IS NOT current.state
         OR latest.from_state IS NOT current.previous_state
         OR current.state <> 'published' OR current.published_revision_id IS NOT revision.id
         OR current.candidate_digest IS NOT revision.approved_candidate_digest
         OR json_extract(latest.payload_json, '$.current') IS NOT
           json_object(${runCurrentColumns.map((column) => `'${column}', current.${column}`).join(", ")})
         OR (SELECT COUNT(*) FROM ingestion_run_events WHERE ingestion_run_id = run.id) <> current.last_event_sequence
         OR (SELECT MAX(sequence_number) FROM ingestion_run_events WHERE ingestion_run_id = run.id) <> current.last_event_sequence
         OR birth.event_kind IS NOT 'created' OR birth.from_state IS NOT NULL
         OR json_extract(birth.payload_json, '$.selected_games') IS NOT (
           SELECT json_group_array(game) FROM (
             SELECT game FROM ingestion_run_selected_games WHERE ingestion_run_id = run.id ORDER BY ordinal
           )
         )
         OR run.approval_idempotency_key IS NOT (
           SELECT json_extract(payload_json, '$.approval_idempotency_key') FROM ingestion_run_events
           WHERE ingestion_run_id = run.id AND json_type(payload_json, '$.approval_idempotency_key') = 'text'
           ORDER BY sequence_number DESC LIMIT 1
         )
         OR EXISTS (
           SELECT 1 FROM ingestion_run_events AS event, json_each(event.payload_json, '$.payloads') AS payload
           WHERE event.ingestion_run_id = run.id AND (
             payload.key NOT IN ('candidate', 'diagnostics')
             OR json_extract(payload.value, '$.chunks') IS NOT (
               SELECT COUNT(*) FROM ingestion_run_event_payload_chunks AS chunk
               WHERE chunk.ingestion_run_id = run.id AND chunk.event_sequence = event.sequence_number
                 AND chunk.payload_kind = payload.key
             )
             OR json_extract(payload.value, '$.bytes') IS NOT (
               SELECT SUM(length(CAST(content AS BLOB))) FROM ingestion_run_event_payload_chunks AS chunk
               WHERE chunk.ingestion_run_id = run.id AND chunk.event_sequence = event.sequence_number
                 AND chunk.payload_kind = payload.key
             )
             OR (SELECT MIN(chunk_index) FROM ingestion_run_event_payload_chunks AS chunk
                 WHERE chunk.ingestion_run_id = run.id AND chunk.event_sequence = event.sequence_number
                   AND chunk.payload_kind = payload.key) IS NOT 0
             OR (SELECT MAX(chunk_index) FROM ingestion_run_event_payload_chunks AS chunk
                 WHERE chunk.ingestion_run_id = run.id AND chunk.event_sequence = event.sequence_number
                   AND chunk.payload_kind = payload.key) IS NOT json_extract(payload.value, '$.chunks') - 1
           )
         )
         OR (current.candidate_payload_event_sequence IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM ingestion_run_events WHERE ingestion_run_id = run.id
             AND sequence_number = current.candidate_payload_event_sequence
             AND json_type(payload_json, '$.payloads.candidate') = 'object'
         ))
         OR (current.diagnostics_event_sequence IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM ingestion_run_events WHERE ingestion_run_id = run.id
             AND sequence_number = current.diagnostics_event_sequence
             AND json_type(payload_json, '$.payloads.diagnostics') = 'object'
         ))
       )) AS invalid_audit_rows,
      (SELECT count(*) FROM revision_cards
       WHERE catalogue_revision_id = catalogue.current_revision_id) AS cards,
      (SELECT count(*) FROM revision_printings
       WHERE catalogue_revision_id = catalogue.current_revision_id) AS printings,
      (SELECT count(*) FROM revision_products
       WHERE catalogue_revision_id = catalogue.current_revision_id) AS products,
      (SELECT count(*) FROM revision_card_query_documents
       WHERE catalogue_revision_id = catalogue.current_revision_id) AS api_documents,
      (SELECT count(*) FROM revision_card_search_chunks
       WHERE catalogue_revision_id = catalogue.current_revision_id) AS search_chunks,
      (SELECT count(*) FROM catalogue_curated_provenance
       WHERE catalogue_revision_id = catalogue.current_revision_id)
        AS provenance,
      (SELECT count(*) FROM catalogue_revisions AS revision
       JOIN ingestion_runs AS run ON run.id = revision.ingestion_run_id
       WHERE revision.id = catalogue.current_revision_id) AS audit_rows,
      (SELECT card_id FROM revision_card_query_documents
       WHERE catalogue_revision_id = catalogue.current_revision_id
       ORDER BY sort_game, sort_identity_kind, sort_identity_value, sort_id
       LIMIT 1) AS representative_card_id,
      (SELECT printing_id FROM revision_printings
       WHERE catalogue_revision_id = catalogue.current_revision_id
       ORDER BY printing_id LIMIT 1) AS representative_printing_id,
      (SELECT product_id FROM revision_products
       WHERE catalogue_revision_id = catalogue.current_revision_id
       ORDER BY product_id LIMIT 1) AS representative_product_id,
      (SELECT document_json FROM revision_products
       WHERE catalogue_revision_id = catalogue.current_revision_id
       ORDER BY product_id LIMIT 1) AS representative_product_document_json,
      (SELECT sort_identity_value FROM revision_card_query_documents
       WHERE catalogue_revision_id = catalogue.current_revision_id
       ORDER BY sort_game, sort_identity_kind, sort_identity_value, sort_id
       LIMIT 1) AS representative_search_text,
      (SELECT curated_revision_id FROM catalogue_curated_provenance
       WHERE catalogue_revision_id = catalogue.current_revision_id
       ORDER BY curated_revision_id LIMIT 1)
        AS representative_curated_revision_id,
      (SELECT content_digest FROM catalogue_curated_provenance
       WHERE catalogue_revision_id = catalogue.current_revision_id
       ORDER BY curated_revision_id LIMIT 1)
        AS representative_curated_revision_digest,
      (SELECT ingestion_run_id FROM catalogue_revisions
       WHERE id = catalogue.current_revision_id) AS publication_ingestion_run_id
    FROM catalogue_state AS catalogue
    JOIN card_search_fts_state AS search ON search.singleton = 1
    JOIN catalogue_schema_state AS schema_state ON schema_state.singleton = 1
    WHERE catalogue.singleton = 1 AND catalogue.current_revision_id = ?
      AND ? IS NOT NULL`;
}
