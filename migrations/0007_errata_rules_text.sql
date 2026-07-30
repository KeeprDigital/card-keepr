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
