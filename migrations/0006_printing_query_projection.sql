-- Printing collection filters use publication-time facts, sharing one source
-- for Printing and future Card rarity/Product filters (#73, #52).
SELECT CASE
  WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 5
  THEN 1
  ELSE json_extract('schema_level_mismatch_expected_5', '$')
END;

CREATE TABLE revision_printing_query (
  catalogue_revision_id TEXT NOT NULL,
  printing_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  supported_game TEXT NOT NULL CHECK (supported_game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')),
  normalized_rarity TEXT,
  PRIMARY KEY (catalogue_revision_id, printing_id),
  FOREIGN KEY (catalogue_revision_id, printing_id)
    REFERENCES revision_printings(catalogue_revision_id, printing_id) ON DELETE CASCADE
);
CREATE INDEX revision_printing_query_by_card
  ON revision_printing_query(catalogue_revision_id, card_id, printing_id);
CREATE INDEX revision_printing_query_by_game
  ON revision_printing_query(catalogue_revision_id, supported_game, card_id, printing_id);
CREATE INDEX revision_printing_query_by_rarity
  ON revision_printing_query(catalogue_revision_id, normalized_rarity, card_id, printing_id);
CREATE INDEX revision_printing_query_by_game_rarity
  ON revision_printing_query(catalogue_revision_id, supported_game, normalized_rarity, card_id, printing_id);

CREATE TABLE revision_printing_product_query (
  catalogue_revision_id TEXT NOT NULL,
  printing_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  -- Empty means this current Product membership has no published Release region.
  release_region TEXT NOT NULL,
  PRIMARY KEY (catalogue_revision_id, printing_id, product_id, release_region),
  FOREIGN KEY (catalogue_revision_id, printing_id)
    REFERENCES revision_printing_query(catalogue_revision_id, printing_id) ON DELETE CASCADE,
  FOREIGN KEY (catalogue_revision_id, product_id)
    REFERENCES revision_products(catalogue_revision_id, product_id) ON DELETE CASCADE
);
CREATE INDEX revision_printing_products_by_product
  ON revision_printing_product_query(catalogue_revision_id, product_id, card_id, printing_id, release_region);
CREATE INDEX revision_printing_products_by_region
  ON revision_printing_product_query(catalogue_revision_id, release_region, card_id, printing_id, product_id);
CREATE INDEX revision_printing_products_by_product_region
  ON revision_printing_product_query(catalogue_revision_id, product_id, release_region, card_id, printing_id);

-- Existing retained projections include both earlier bare documents and current
-- detail envelopes. This one-time backfill resolves them; the read path never does.
INSERT INTO revision_printing_query
SELECT printing.catalogue_revision_id, printing.printing_id, printing.card_id,
       coalesce(json_extract(card.document_json, '$.data.game'), json_extract(card.document_json, '$.game')),
       coalesce(json_extract(printing.document_json, '$.data.rarity.normalized'),
                json_extract(printing.document_json, '$.rarity.normalized'))
FROM revision_printings AS printing
JOIN revision_cards AS card ON card.catalogue_revision_id = printing.catalogue_revision_id
  AND card.card_id = printing.card_id;

INSERT INTO revision_printing_product_query
SELECT DISTINCT projection.catalogue_revision_id, projection.printing_id, projection.card_id,
       product.product_id, coalesce(region.value, '')
FROM revision_product_relationships AS relationship
JOIN revision_printing_query AS projection
  ON projection.catalogue_revision_id = relationship.catalogue_revision_id
 AND projection.printing_id = json_extract(relationship.document_json, '$.from.id')
JOIN revision_products AS product
  ON product.catalogue_revision_id = relationship.catalogue_revision_id
 AND product.product_id = json_extract(relationship.document_json, '$.to.id')
LEFT JOIN json_each(product.release_regions_json) AS region
WHERE json_extract(relationship.document_json, '$.kind') = 'printing-product'
  AND coalesce(json_extract(relationship.document_json, '$.lifecycle.current'), 1) = 1;

UPDATE catalogue_schema_state SET migration_level = 6 WHERE singleton = 1;
