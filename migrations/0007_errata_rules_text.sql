ALTER TABLE revision_cards RENAME TO revision_cards_legacy;

CREATE TABLE revision_cards (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  card_id TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  sort_game TEXT GENERATED ALWAYS AS (
    CAST(json_extract(document_json, '$.game') AS TEXT)
  ) STORED NOT NULL,
  sort_identity_kind TEXT GENERATED ALWAYS AS (
    CAST(json_extract(document_json, '$.official_identity.kind') AS TEXT)
  ) STORED NOT NULL,
  sort_identity_value TEXT GENERATED ALWAYS AS (
    CAST(json_extract(document_json, '$.official_identity.value') AS TEXT)
  ) STORED NOT NULL,
  sort_id TEXT GENERATED ALWAYS AS (
    CAST(json_extract(document_json, '$.id') AS TEXT)
  ) STORED NOT NULL,
  search_text TEXT NOT NULL,
  PRIMARY KEY (catalogue_revision_id, card_id)
);

INSERT INTO revision_cards (
  catalogue_revision_id, card_id, document_json, search_text
)
SELECT catalogue_revision_id, card_id, document_json,
       lower(trim(
         coalesce(CAST(json_extract(
           document_json, '$.official_identity.value'
         ) AS TEXT), '') || ' ' ||
         coalesce(CAST(json_extract(document_json, '$.name') AS TEXT), '') ||
         ' ' ||
         coalesce(CAST(json_extract(
           document_json, '$.effective_rules_text'
         ) AS TEXT), '')
       ))
FROM revision_cards_legacy;

DROP TABLE revision_cards_legacy;

CREATE INDEX revision_cards_by_order
  ON revision_cards(
    catalogue_revision_id, sort_game, sort_identity_kind,
    sort_identity_value, sort_id
  );

CREATE INDEX revision_cards_by_identity
  ON revision_cards(
    catalogue_revision_id, sort_identity_kind, sort_identity_value,
    sort_game, sort_id
  );

CREATE TABLE revision_card_search_terms (
  catalogue_revision_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  term TEXT NOT NULL CHECK (
    length(term) > 0 AND length(term) <= 128
  ),
  PRIMARY KEY (catalogue_revision_id, card_id, term),
  FOREIGN KEY (catalogue_revision_id, card_id)
    REFERENCES revision_cards(catalogue_revision_id, card_id)
    ON DELETE CASCADE
);

CREATE INDEX revision_card_search_by_term
  ON revision_card_search_terms(catalogue_revision_id, term, card_id);

WITH RECURSIVE search_terms(
  catalogue_revision_id, card_id, term, remaining
) AS (
  SELECT catalogue_revision_id, card_id, '',
         trim(search_text) || ' '
  FROM revision_cards
  UNION ALL
  SELECT catalogue_revision_id, card_id,
         substr(remaining, 1, instr(remaining, ' ') - 1),
         ltrim(substr(remaining, instr(remaining, ' ') + 1))
  FROM search_terms
  WHERE remaining <> ''
)
INSERT OR IGNORE INTO revision_card_search_terms (
  catalogue_revision_id, card_id, term
)
SELECT catalogue_revision_id, card_id, term
FROM search_terms
WHERE length(term) > 0 AND length(term) <= 128;

CREATE TABLE reconciled_errata (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL CHECK (
    game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')
  ),
  target_type TEXT NOT NULL CHECK (target_type IN ('card', 'printing')),
  target_id TEXT NOT NULL,
  effective_from TEXT CHECK (
    effective_from IS NULL
    OR effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  official_wording TEXT NOT NULL CHECK (length(official_wording) > 0),
  corrected_value_json TEXT NOT NULL CHECK (
    json_valid(corrected_value_json)
    AND json_type(corrected_value_json) IN ('text', 'null')
    AND (
      json_type(corrected_value_json) = 'null'
      OR length(json_extract(corrected_value_json, '$')) > 0
    )
  ),
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id)
);

CREATE TABLE erratum_provenance (
  erratum_id TEXT NOT NULL REFERENCES reconciled_errata(id),
  source_lineage TEXT NOT NULL CHECK (length(source_lineage) > 0),
  source_observation_id TEXT NOT NULL CHECK (
    length(source_observation_id) > 0
  ),
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  PRIMARY KEY (erratum_id, source_lineage, source_observation_id)
);

CREATE TABLE revision_errata (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  erratum_id TEXT NOT NULL REFERENCES reconciled_errata(id),
  PRIMARY KEY (catalogue_revision_id, erratum_id)
);

CREATE INDEX revision_errata_by_revision
  ON revision_errata(catalogue_revision_id, erratum_id);

CREATE TRIGGER reconciled_errata_semantics_are_immutable
BEFORE UPDATE OF
  id,
  game,
  target_type,
  target_id,
  effective_from,
  official_wording,
  corrected_value_json,
  first_revision_id
ON reconciled_errata
BEGIN
  SELECT RAISE(ABORT, 'reconciled_erratum_immutable');
END;

CREATE TRIGGER reconciled_errata_are_not_deleted
BEFORE DELETE ON reconciled_errata
BEGIN
  SELECT RAISE(ABORT, 'reconciled_erratum_immutable');
END;

CREATE TRIGGER erratum_provenance_identity_is_immutable
BEFORE UPDATE OF
  erratum_id,
  source_lineage,
  source_observation_id,
  first_revision_id
ON erratum_provenance
BEGIN
  SELECT RAISE(ABORT, 'erratum_provenance_immutable');
END;

CREATE TRIGGER erratum_provenance_is_not_deleted
BEFORE DELETE ON erratum_provenance
BEGIN
  SELECT RAISE(ABORT, 'erratum_provenance_immutable');
END;

CREATE TRIGGER revision_errata_are_immutable_on_update
BEFORE UPDATE ON revision_errata
BEGIN
  SELECT RAISE(ABORT, 'revision_erratum_immutable');
END;

CREATE TRIGGER revision_errata_are_immutable_on_delete
BEFORE DELETE ON revision_errata
BEGIN
  SELECT RAISE(ABORT, 'revision_erratum_immutable');
END;
