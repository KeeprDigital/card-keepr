// Dedicated test queries. Tests retain binding, execution, and atomic batch composition.

export function setRevisionCardsDocumentJson(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `UPDATE revision_cards SET document_json = json_object('data', json(document_json)) WHERE catalogue_revision_id = 'catrev_products'`,
  );
}

export function insertRevisionPrintings(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_printings
      SELECT catalogue_revision_id, 'printing_enveloped', card_id, json_object('data', json_set(document_json, '$.id', 'printing_enveloped'))
      FROM revision_printings WHERE printing_id = 'printing_st15_event'`);
}

export function insertRevisionProducts(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_products
      SELECT catalogue_revision_id, 'product_empty', supported_game, NULL, 'No regions', '', '[]', '{}'
      FROM revision_products WHERE product_id = 'product_st15'`);
}

export function insertRevisionProductsForPrintingProjectionBackfillsRetainedBareEnvelopedDocumentsCurrentProduct(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_products
      SELECT catalogue_revision_id, 'product_shared', supported_game, NULL, 'Shared', '', '["EN-US","EN-EU"]', '{}'
      FROM revision_products WHERE product_id = 'product_st15'`);
}

export function insertRevisionProductRelationships(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_product_relationships VALUES ('catrev_products', ?, ?)`);
}

export function insertRevisionCards(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_cards(catalogue_revision_id, card_id, document_json)
      SELECT catalogue_revision_id, 'card_zz_bulk', json_set(document_json, '$.id', 'card_zz_bulk', '$.game', 'digimon')
      FROM revision_cards WHERE catalogue_revision_id = 'catrev_products' AND card_id = 'card_st15_event'`);
}

export function insertRevisionPrintingsForPrintingFiltersSeekPublicationIndexesWithoutScanningThousandsUnrelated(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_printings(catalogue_revision_id, printing_id, card_id, document_json)
      WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM entries WHERE n < 6000)
      SELECT 'catrev_products', printf('printing_bulk_%05d', n), 'card_zz_bulk',
             json_set(printing.document_json, '$.id', printf('printing_bulk_%05d', n), '$.card_id', 'card_zz_bulk', '$.rarity.normalized', 'common')
      FROM entries CROSS JOIN revision_printings AS printing
      WHERE printing.catalogue_revision_id = 'catrev_products' AND printing.printing_id = 'printing_st15_event'`);
}

export function insertRevisionProductsForPrintingFiltersSeekPublicationIndexesWithoutScanningThousandsUnrelated(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_products(catalogue_revision_id, product_id, supported_game, official_code, name, search_text, release_regions_json, document_json)
      SELECT catalogue_revision_id, 'product_bulk', 'digimon', 'BULK', 'Bulk', 'bulk', '["EN-US"]', document_json
      FROM revision_products WHERE catalogue_revision_id = 'catrev_products' AND product_id = 'product_st15'`);
}

export function insertRevisionProductRelationshipsForPrintingFiltersSeekPublicationIndexesWithoutScanningThousandsUnrelated(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_product_relationships(catalogue_revision_id, relationship_id, document_json)
      SELECT catalogue_revision_id, 'relationship_' || printing_id,
        json_object('kind', 'printing-product', 'from', json_object('id', printing_id),
          'to', json_object('id', CASE WHEN printing_id = 'printing_st15_event' THEN 'product_st15' ELSE 'product_bulk' END),
          'lifecycle', json_object('current', json('true')))
      FROM revision_printings WHERE catalogue_revision_id = 'catrev_products'`);
}

export function insertRevisionPrintingsForSeedCards(database: D1Database): D1PreparedStatement {
  return database.prepare("INSERT INTO revision_printings VALUES (?, ?, ?, ?)");
}

export function insertRevisionProductsForSeedCards(database: D1Database): D1PreparedStatement {
  return database.prepare(
    "INSERT INTO revision_products VALUES (?, 'product_deck', 'one-piece', 'ST-01', 'Deck', 'deck', '[]', '{}')",
  );
}

export function insertRevisionProductRelationshipsForSeedCards(database: D1Database): D1PreparedStatement {
  return database.prepare("INSERT INTO revision_product_relationships VALUES (?, ?, ?)");
}

export function insertRevisionCardsForCardAttributeMigrationBackfillsTypedValuesNestedArrayLeaves(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare("INSERT INTO revision_cards VALUES ('catrev_attribute_backfill', 'card_bare', ?)");
}

export function insertCatalogueRevisions(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `INSERT INTO catalogue_revisions(id,ingestion_run_id,published_at,content_digest,expected_previous_revision_id,approved_candidate_digest) VALUES ('catrev_products', 'run_products', '2026-01-01T00:00:00.000Z', ?, 'catrev_spine_000', ?)`,
  );
}

export function insertCatalogueQueryRevisions(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `INSERT INTO catalogue_query_revisions(catalogue_revision_id,state) VALUES ('catrev_products','available')`,
  );
}

export function insertRevisionCardsForSeedPrintingQueryFixture(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_cards VALUES ('catrev_products','card_st15_event', ?)`);
}

export function insertRevisionPrintingsForSeedPrintingQueryFixture(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `INSERT INTO revision_printings VALUES ('catrev_products','printing_st15_event','card_st15_event', ?)`,
  );
}

export function insertRevisionProductsForSeedPrintingQueryFixture(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `INSERT INTO revision_products VALUES ('catrev_products','product_st15','one-piece','ST-15','Starter','starter','["EN-OCEANIA"]','{}')`,
  );
}

export function setCatalogueStateCurrentRevisionId(database: D1Database): D1PreparedStatement {
  return database.prepare("UPDATE catalogue_state SET current_revision_id='catrev_products' WHERE singleton=1");
}

export function readRevisionPrintingsSupportedGameNormalizedRarity(database: D1Database): D1PreparedStatement {
  return database.prepare(`
    SELECT printing.printing_id, printing.card_id,
           coalesce(json_extract(card.document_json, '$.data.game'), json_extract(card.document_json, '$.game')) AS supported_game,
           coalesce(json_extract(printing.document_json, '$.data.rarity.normalized'), json_extract(printing.document_json, '$.rarity.normalized')) AS normalized_rarity
    FROM revision_printings AS printing JOIN revision_cards AS card
      ON card.catalogue_revision_id = printing.catalogue_revision_id AND card.card_id = printing.card_id
    WHERE printing.catalogue_revision_id = 'catrev_products'
  `);
}

export function deleteRevisionPrintingQuery(database: D1Database): D1PreparedStatement {
  return database.prepare("DELETE FROM revision_printing_query WHERE catalogue_revision_id = 'catrev_products'");
}

export function setCatalogueQueryRevisionsState(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_query_revisions
     SET state = 'pending'
     WHERE catalogue_revision_id = 'catrev_pending_query_projection'`);
}

export function setCatalogueQueryRevisionsStateForSuppliedCursorUnavailableCurrentRevisionReturnsCursorRestartProblem(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_query_revisions
     SET state = 'pending'
     WHERE catalogue_revision_id = 'catrev_current_cursor_unavailable'`);
}

export function insertRevisionCardsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_cards (
          catalogue_revision_id, card_id, document_json
        ) VALUES (?, ?, ?)`);
}

export function setCatalogueStateCurrentRevisionIdPublishedAt(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_state SET current_revision_id = ?, published_at = ?
       WHERE singleton = 1`);
}

export function setRevisionCardsDocumentJsonForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE revision_cards SET document_json = ?
       WHERE catalogue_revision_id = ? AND card_id = ?`);
}

export function readCatalogueStateCurrentRevisionId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT current_revision_id
     FROM catalogue_state WHERE singleton = 1`);
}

export function insertRevisionPrintingsForPublicPrintingResponseValidatesFullDistributionContextObjects(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_printings (
        catalogue_revision_id, printing_id, card_id, document_json
      ) VALUES (?, ?, ?, ?)`);
}

export function setCatalogueStateCurrentRevisionIdPublishedAtForPublicPrintingResponseValidatesFullDistributionContextObjects(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_state
       SET current_revision_id = 'catrev_api_context',
           published_at = '2026-01-01T00:00:00.000Z'
       WHERE singleton = 1`);
}

export function insertCatalogueQueryRevisionsForAuthenticatedCardPrintingReadsExposeEffectivePrintedRulesText(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_query_revisions (
         catalogue_revision_id, state, repaired_through_card_id
       ) VALUES ('catrev_errata_read', 'available', NULL)`);
}

export function setCatalogueStateCurrentRevisionIdPublishedAtForAuthenticatedCardPrintingReadsExposeEffectivePrintedRulesText(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_state
       SET current_revision_id = 'catrev_errata_read',
           published_at = '2026-07-01T00:00:00.000Z'
       WHERE singleton = 1`);
}

export function readSqliteSchemaName(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT name FROM sqlite_schema
     WHERE type = 'table'
       AND name LIKE 'revision_card%'
       AND lower(sql) LIKE '%create virtual table%'`);
}

export function deleteRevisionCardQueryDocuments(database: D1Database): D1PreparedStatement {
  return database.prepare(`DELETE FROM revision_card_query_documents
     WHERE catalogue_revision_id = 'catrev_cursor_old'`);
}

export function setCatalogueRevisionsPublishedAt(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_revisions SET published_at = ? WHERE id = ?`);
}

export function setCatalogueStatePublishedAt(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_state SET published_at = ?
     WHERE singleton = 1 AND current_revision_id = ?`);
}

export function setCatalogueQueryRevisionsStateForCollectionContract(database: D1Database): D1PreparedStatement {
  return database.prepare("UPDATE catalogue_query_revisions SET state = 'pending' WHERE catalogue_revision_id = ?");
}

export function setCatalogueStateCurrentRevisionIdPublishedAtForInstallApiSuite(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_state
       SET current_revision_id = 'catrev_spine_000',
           published_at = '1970-01-01T00:00:00.000Z'
       WHERE singleton = 1`);
}

export function insertCatalogueQueryRevisionsForSeedApiRevision(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_query_revisions (
         catalogue_revision_id, state, repaired_through_card_id
       ) VALUES (?, 'available', NULL)`);
}

export function setCatalogueStateCurrentRevisionIdPublishedAtForSeedApiRevision(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_state
       SET current_revision_id = ?,
           published_at = '2026-07-20T00:00:00.000Z'
       WHERE singleton = 1`);
}

export function insertRevisionCardQueryDocuments(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_card_query_documents (
         catalogue_revision_id, card_id, summary_json, search_text
       ) VALUES (?, ?, ?, ?)`);
}

export function readCatalogueRevisionsPresent(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT 1 AS present FROM catalogue_revisions WHERE id = 'catrev_products'");
}

export function insertRevisionProductsForProductRelease(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_products (
         catalogue_revision_id, product_id, supported_game, official_code,
         name, search_text, release_regions_json, document_json
       ) VALUES (
         'catrev_products', 'product_st15', 'one-piece', 'ST-15',
         'Starter Deck RED Edward.Newgate',
         'st-15 starter deck red edward.newgate',
         '["EN-OCEANIA"]', ?
       )`);
}

export function insertCatalogueQueryRevisionsForProductRelease(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_query_revisions (
         catalogue_revision_id, state, repaired_through_card_id
       ) VALUES ('catrev_products', 'available', NULL)`);
}

export function insertRevisionProductsFts(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_products_fts (
         catalogue_revision_id, product_id, search_text
       ) VALUES ('catrev_products', 'product_st15',
                 'st-15 starter deck red edward.newgate')`);
}

export function insertRevisionCardsForProductRelease(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_cards (
         catalogue_revision_id, card_id, document_json
       ) VALUES ('catrev_products', ?, ?)`);
}

export function insertRevisionPrintingsForProductRelease(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_printings (
         catalogue_revision_id, printing_id, card_id, document_json
       ) VALUES ('catrev_products', ?, ?, ?)`);
}

export function insertRevisionPrintingImages(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_printing_images (
         catalogue_revision_id, image_id, printing_id,
         media_type, content_sha256, content_byte_length, object_key
       ) VALUES ('catrev_products', ?, ?, ?, ?, ?, ?)`);
}

export function setCatalogueStateCurrentRevisionIdPublishedAtForProductRelease(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_state
       SET current_revision_id = 'catrev_products',
           published_at = '2026-01-01T00:00:00.000Z'
       WHERE singleton = 1`);
}

export function deleteRevisionProductsFts(database: D1Database): D1PreparedStatement {
  return database.prepare(`DELETE FROM revision_products_fts WHERE product_id = ?`);
}

export function deleteRevisionProducts(database: D1Database): D1PreparedStatement {
  return database.prepare(`DELETE FROM revision_products
         WHERE catalogue_revision_id = 'catrev_products'
           AND product_id = ?`);
}

export function insertRevisionPrintingImagesForPrintingImageContentServedFromRevisionProjectionNotReconciled(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_printing_images (
         catalogue_revision_id, image_id, printing_id,
         media_type, content_sha256, content_byte_length, object_key
       ) VALUES ('catrev_products', 'printing_image_st15_projected', 'printing_st15_event',
         'image/webp', ?, 15, ?)`);
}

export function insertRevisionCardsForPrintingDetailConditionalReadsBindExactResponseBytesOne(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_cards (
         catalogue_revision_id, card_id, document_json
       )
       SELECT 'catrev_products_next', card_id, document_json
       FROM revision_cards
       WHERE catalogue_revision_id = 'catrev_products'
         AND card_id = 'card_st15_event'`);
}

export function insertRevisionPrintingsForPrintingDetailConditionalReadsBindExactResponseBytesOne(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_printings (
         catalogue_revision_id, printing_id, card_id, document_json
       )
       SELECT 'catrev_products_next', printing_id, card_id, document_json
       FROM revision_printings
       WHERE catalogue_revision_id = 'catrev_products'
         AND printing_id = 'printing_st15_event'`);
}

export function setCatalogueStateCurrentRevisionIdPublishedAtForPrintingDetailConditionalReadsBindExactResponseBytesOne(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_state
       SET current_revision_id = 'catrev_products_next',
           published_at = '2026-01-02T00:00:00.000Z'
       WHERE singleton = 1`);
}

export function readRevisionPrintingsDocumentJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT document_json FROM revision_printings
     WHERE catalogue_revision_id = 'catrev_products'
       AND printing_id = 'printing_st15_event'`);
}

export function setRevisionPrintingsDocumentJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE revision_printings SET document_json = ?
     WHERE catalogue_revision_id = 'catrev_products'
       AND printing_id = 'printing_st15_event'`);
}

export function insertRevisionProductsForProductDetailReturnsRevisionPinnedImmutableProvenanceDisagreements(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_products (
       catalogue_revision_id, product_id, supported_game, official_code,
       name, search_text, release_regions_json, document_json
     ) VALUES (
       'catrev_products', 'product_unresolved', 'one-piece',
       'ST-UNRESOLVED', NULL, 'st-unresolved', '["EN-OCEANIA"]', ?
     )`);
}

export function deleteRevisionProductsForProductDetailReturnsRevisionPinnedImmutableProvenanceDisagreements(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`DELETE FROM revision_products
       WHERE catalogue_revision_id = 'catrev_products'
         AND product_id = 'product_unresolved'`);
}

export function readRevisionProductsDocumentJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT document_json FROM revision_products
     WHERE catalogue_revision_id = 'catrev_products'
       AND product_id = 'product_st15'`);
}

export function setRevisionProductsDocumentJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE revision_products SET document_json = ?
       WHERE catalogue_revision_id = 'catrev_products'
         AND product_id = 'product_st15'`);
}

export function insertRevisionProductsForExplicitlyUnknownReleaseRegionReadableSchemaValid(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_products (
       catalogue_revision_id, product_id, supported_game, official_code,
       name, search_text, release_regions_json, document_json
     ) VALUES (
       'catrev_products', 'product_unknown_region', 'digimon',
       'BT-UNKNOWN', 'Unknown-region Product',
       'bt-unknown unknown-region product', '["unknown"]', ?
     )`);
}

export function deleteRevisionProductsForExplicitlyUnknownReleaseRegionReadableSchemaValid(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`DELETE FROM revision_products
       WHERE catalogue_revision_id = 'catrev_products'
         AND product_id = 'product_unknown_region'`);
}

export function insertRevisionProductsForProductCursorsPinRoutePreserveFilteredKeysetOrder(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_products (
       catalogue_revision_id, product_id, supported_game, official_code,
       name, search_text, release_regions_json, document_json
     ) VALUES (
       'catrev_products', 'product_st14', 'one-piece', 'ST-14',
       'Starter Deck 14', 'st-14 starter deck 14', '["EN-OCEANIA"]', ?
     )`);
}

export function setCatalogueStateCurrentRevisionIdForProductCursorsPinRoutePreserveFilteredKeysetOrder(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_state
     SET current_revision_id = 'catrev_spine_000'
     WHERE singleton = 1`);
}

export function setCatalogueQueryRevisionsStateForProductCursorsPinRoutePreserveFilteredKeysetOrder(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_query_revisions SET state = 'archived'
     WHERE catalogue_revision_id = 'catrev_products'`);
}

export function setCatalogueQueryRevisionsStateForProductCursorsPinRoutePreserveFilteredKeysetOrderWithCatrevProducts(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_query_revisions SET state = 'available'
     WHERE catalogue_revision_id = 'catrev_products'`);
}

export function setCatalogueStateCurrentRevisionIdForProductCursorsPinRoutePreserveFilteredKeysetOrderWithCatrevProducts(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_state
     SET current_revision_id = 'catrev_products'
     WHERE singleton = 1`);
}

export function insertRevisionProductsForPrintingCollectionBindsEveryNormalizedFilterOneCardOrdered(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_products (
         catalogue_revision_id, product_id, supported_game, official_code,
         name, search_text, release_regions_json, document_json
       ) VALUES (
         'catrev_products', 'product_us', 'one-piece', 'ST-US',
         'US Product', 'st-us us product', '["EN-US"]', ?
       )`);
}

export function insertRevisionProductRelationshipsForPrintingCollectionBindsEveryNormalizedFilterOneCardOrdered(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_product_relationships (
           catalogue_revision_id, relationship_id, document_json
         ) VALUES ('catrev_products', ?, ?)`);
}

export function readCatalogueSchemaStateMigrationLevel(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1");
}

export function readCatalogueStateIdContentDigest(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT revision.id, revision.content_digest
    FROM catalogue_state AS state
    JOIN catalogue_revisions AS revision
      ON revision.id = state.current_revision_id
    WHERE state.singleton = 1`);
}

export function setCatalogueRevisionsContentDigest(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_revisions
      SET content_digest = ?
      WHERE id = ?`);
}

export function readSqliteMasterSql(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT sql FROM sqlite_master
     WHERE type = 'trigger' AND name = 'guard_catalogue_publication'`);
}

export function dropGuardCataloguePublication(database: D1Database): D1PreparedStatement {
  return database.prepare("DROP TRIGGER guard_catalogue_publication");
}

export function countCatalogueRevisionsCount(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT COUNT(*) AS count FROM catalogue_revisions");
}

export function countRevisionCardsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count
     FROM revision_cards
     WHERE catalogue_revision_id = ?`);
}

export function dropFailInitialObservationSetInsert(database: D1Database): D1PreparedStatement {
  return database.prepare("DROP TRIGGER fail_initial_observation_set_insert");
}

export function readRevisionCardsDocumentJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT document_json FROM revision_cards
       WHERE catalogue_revision_id = ? AND card_id = ?`);
}

export function insertRevisionCardsForProductionReleaseSearchFixturesComeFromRealisticRevisionPinned(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare("INSERT INTO revision_cards VALUES (?,?,?)");
}

export function insertRevisionCardQueryDocumentsForProductionReleaseSearchFixturesComeFromRealisticRevisionPinned(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_card_query_documents
       (catalogue_revision_id,card_id,summary_json,search_text)
       VALUES (?,?,?,?)`);
}

export function dropOfficialSourceCollectionPlanDiscoveryOwner(database: D1Database): D1PreparedStatement {
  return database.prepare(`DROP TRIGGER official_source_collection_plan_discovery_owner`);
}

export function readErratumProvenanceFirstRevisionIdLastObservedRevisionId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT first_revision_id, last_observed_revision_id
           FROM erratum_provenance WHERE erratum_id = ?`);
}

export function dropHoldChildWorkflowIds(database: D1Database): D1PreparedStatement {
  return database.prepare("DROP TRIGGER hold_child_workflow_ids");
}

export function countCatalogueQueryRevisionsDocumentCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT query.state,
              COUNT(document.card_id) AS document_count
       FROM catalogue_query_revisions AS query
       LEFT JOIN revision_card_query_documents AS document
         ON document.catalogue_revision_id =
              query.catalogue_revision_id
       WHERE query.catalogue_revision_id = ?
       GROUP BY query.catalogue_revision_id, query.state`);
}

export function deleteCatalogueQueryRevisions(database: D1Database): D1PreparedStatement {
  return database.prepare(`DELETE FROM catalogue_query_revisions
     WHERE catalogue_revision_id = ?`);
}

export function readCatalogueQueryRevisionsState(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT state FROM catalogue_query_revisions
       WHERE catalogue_revision_id = ?`);
}

export function readRevisionPrintingsDocumentJsonForRetainedImmutableEvidencePublishesStableIdentitiesWarnsEarlierMembership(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT document_json
     FROM revision_printings
     WHERE catalogue_revision_id = ? AND printing_id = ?`);
}

export function dropFailBatchSnapshotCommit(database: D1Database): D1PreparedStatement {
  return database.prepare("DROP TRIGGER fail_batch_snapshot_commit");
}

export function inspectCatalogueState(database: D1Database): D1PreparedStatement {
  return database.prepare(`WITH RECURSIVE lineage(revision_id, depth) AS (
         SELECT current_revision_id, 0
         FROM catalogue_state
         WHERE singleton = 1
         UNION ALL
         SELECT revision.expected_previous_revision_id,
                lineage.depth + 1
         FROM lineage
         JOIN catalogue_revisions AS revision
           ON revision.id = lineage.revision_id
         WHERE lineage.depth < 4
       )
       SELECT revision_id, depth
       FROM lineage
       ORDER BY depth`);
}

export function insertCatalogueSearchRepairRequests(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_search_repair_requests (
       idempotency_key, target_revision_id,
       expected_current_revision_id, request_json, result_json
     ) VALUES (?, ?, ?, ?, ?)`);
}

export function insertRevisionCardsForCuratedRevisions(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_cards (catalogue_revision_id, card_id, document_json)
       VALUES (?, ?, ?)`);
}

export function insertRevisionPrintingsForCuratedRevisions(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_printings (catalogue_revision_id, printing_id, card_id, document_json)
       VALUES (?, ?, ?, ?)`);
}

export function insertRevisionProductsForProductOnlySourceObservationsRemainValidCuratedRevisionEvidence(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_products (
         catalogue_revision_id, product_id, supported_game,
         official_code, name, search_text, release_regions_json,
         document_json
       ) VALUES (?, ?, 'one-piece', 'OP-01', 'Booster', 'op-01 booster',
         '["EN-OCEANIA"]', ?)`);
}

export function setRevisionPrintingsDocumentJsonForValidationUsesPinnedSharedGameProfileSchemas(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE revision_printings SET document_json = json_set(
       document_json, '$.game_data', json('{"profile":"one-piece@1","attributes":{}}')
     ) WHERE catalogue_revision_id = ? AND printing_id = ?`);
}

export function dropInjectCuratedReplacementFailure(database: D1Database): D1PreparedStatement {
  return database.prepare("DROP TRIGGER inject_curated_replacement_failure");
}

export function readRevisionProductsDocumentJsonForReconciliationProductIdentity(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT document_json FROM revision_products
       WHERE catalogue_revision_id = ? AND product_id = ?`);
}

export function readRevisionProductsDocumentJsonForProductObservationsDisappearanceRemainScopedTheirSourceLineage(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT document_json
     FROM revision_products
     WHERE catalogue_revision_id = ?
       AND official_code = 'GD-CROSS'`);
}

export function readRevisionProductsDocumentJsonForRegisteredProductDetailEvidenceOutranksConflictingListingThroughPublication(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT document_json
     FROM revision_products
     WHERE catalogue_revision_id = ?
       AND json_extract(document_json, '$.data.official_code') = ?`);
}

export function readRevisionProductsOfficialCode(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT json_extract(document_json, '$.data.official_code') AS official_code
       FROM revision_products
       WHERE catalogue_revision_id = ?
         AND product_id = ?`);
}

export function dropFailObservationSetInsert(database: D1Database): D1PreparedStatement {
  return database.prepare("DROP TRIGGER fail_observation_set_insert");
}

export function readRevisionCardsCardId(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT card_id FROM revision_cards WHERE catalogue_revision_id = ? ORDER BY card_id");
}

export function readRevisionPrintingsPrintingId(database: D1Database): D1PreparedStatement {
  return database.prepare(
    "SELECT printing_id FROM revision_printings WHERE catalogue_revision_id = ? ORDER BY printing_id",
  );
}

export function countRevisionCardQueryDocumentsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count
           FROM revision_card_query_documents
           WHERE catalogue_revision_id = ?`);
}

export function readCatalogueRevisionsIdExpectedPreviousRevisionId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT revision.id, revision.expected_previous_revision_id,
            state.current_revision_id
     FROM catalogue_revisions AS revision
     CROSS JOIN catalogue_state AS state
     WHERE revision.id IN (?, ?, ?, ?)`);
}

export function countCatalogueQueryRevisionsDocumentCountForCardSearchKeepsExactlyCurrentTwoPrecedingDistinctCatalogue(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT query.catalogue_revision_id, query.state,
            COUNT(document.card_id) AS document_count
     FROM catalogue_query_revisions AS query
     LEFT JOIN revision_card_query_documents AS document
       ON document.catalogue_revision_id =
            query.catalogue_revision_id
     WHERE query.catalogue_revision_id IN (?, ?, ?, ?)
     GROUP BY query.catalogue_revision_id, query.state`);
}

export function setCatalogueSchemaStateMigrationLevel(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_schema_state SET migration_level = migration_level + 1
     WHERE singleton = 1`);
}

export function setCatalogueSchemaStateMigrationLevelForRecoveryAcceptanceStaysBlockedIfGuardedSchemaLevelChanges(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare("UPDATE catalogue_schema_state SET migration_level = ? WHERE singleton = 1");
}

export function setCatalogueStateCurrentRevisionIdForExactAcceptedReplayRemainsImmutableAfterLaterPublication(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_state SET current_revision_id = 'catrev_later_publication'
     WHERE singleton = 1`);
}

export function setCatalogueStateCurrentRevisionIdForRaceDuringExternalPreworkCannotAcquireBlockOrBegin(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare("UPDATE catalogue_state SET current_revision_id = 'catrev_raced' WHERE singleton = 1");
}

export function setCatalogueStateCurrentRevisionIdForAcceptedJournalHydrationStaysBlockedAgainstWrongLocalCatalogue(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_state SET current_revision_id = 'catrev_wrong_local'
     WHERE singleton = 1`);
}

export function countSqliteSchemaCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT count(*) AS count FROM sqlite_schema
         WHERE type = 'table'
           AND name LIKE 'revision_card%'
           AND lower(sql) LIKE '%create virtual table%'`);
}

export function dropSyntheticLostExportTransition(database: D1Database): D1PreparedStatement {
  return database.prepare("DROP TRIGGER synthetic_lost_export_transition");
}

export function archiveFixtureQueryRevision(database: D1Database, revisionId: string): D1PreparedStatement {
  return database
    .prepare("UPDATE catalogue_query_revisions SET state = 'archived' WHERE catalogue_revision_id = ?")
    .bind(revisionId);
}
