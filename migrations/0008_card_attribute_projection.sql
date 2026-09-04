SELECT CASE
  WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 7
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_7', '$')
END;

CREATE TABLE revision_card_attributes (
  catalogue_revision_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (catalogue_revision_id, card_id, attribute, value),
  FOREIGN KEY (catalogue_revision_id, card_id)
    REFERENCES revision_cards(catalogue_revision_id, card_id) ON DELETE CASCADE
);
CREATE INDEX revision_card_attributes_by_value
  ON revision_card_attributes(catalogue_revision_id, profile, attribute, value, card_id);

-- Backfill published canonical Game Profile values; reads use only these indexed facts.
INSERT INTO revision_card_attributes (catalogue_revision_id, card_id, profile, attribute, value)
WITH RECURSIVE attributes(catalogue_revision_id, card_id, profile, attribute, value, kind) AS (
  SELECT card.catalogue_revision_id, card.card_id,
         coalesce(json_extract(card.document_json, '$.data.game_data.profile'), json_extract(card.document_json, '$.game_data.profile')),
         field.key, field.value, field.type
  FROM revision_cards AS card,
       json_each(coalesce(json_extract(card.document_json, '$.data.game_data.attributes'), json_extract(card.document_json, '$.game_data.attributes'))) AS field
  UNION ALL
  SELECT parent.catalogue_revision_id, parent.card_id, parent.profile,
         parent.attribute || CASE WHEN parent.kind = 'array' THEN '' ELSE '.' || child.key END,
         child.value, child.type
  FROM attributes AS parent,
       json_each(CASE WHEN parent.kind IN ('array', 'object') THEN parent.value ELSE '[]' END) AS child
)
SELECT DISTINCT catalogue_revision_id, card_id, profile, attribute,
       CASE kind WHEN 'text' THEN json_quote(value) WHEN 'null' THEN 'null'
         WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(value AS TEXT) END
FROM attributes WHERE kind NOT IN ('array', 'object');

UPDATE catalogue_schema_state SET migration_level = 8 WHERE singleton = 1;
