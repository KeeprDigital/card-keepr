-- 2026-08-12 production feedback (#55): the third full-scale Fusion World run
-- retained five live page shapes the frozen fusion-world-en@7 contract
-- refused: anchored AVAILABLE NOW / COMING SOON product sections, face-scoped
-- "(Errata Applied)" card-detail annotations with pinned Errata Notice links,
-- a season-precision Release ("Winter, 2026"), and the pinned
-- legality-history publication's exact restriction lift. fusion-world-en@8
-- models each shape exactly; earlier identities remain installed for
-- retained replay. Releases gain the 'season' precision Bandai publishes.
PRAGMA foreign_keys = ON;

ALTER TABLE reconciled_releases RENAME TO reconciled_releases_before_season_precision;

CREATE TABLE reconciled_releases (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES reconciled_products(id),
  event_key TEXT NOT NULL,
  region TEXT NOT NULL,
  date_precision TEXT CHECK (
    date_precision IN ('day', 'month', 'quarter', 'season', 'year', 'unknown')
  ),
  date_value TEXT,
  release_status TEXT CHECK (
    release_status IN ('announced', 'released')
  ),
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id)
);

INSERT INTO reconciled_releases (
  id, product_id, event_key, region, date_precision, date_value,
  release_status, first_revision_id, last_observed_revision_id
)
SELECT
  id, product_id, event_key, region, date_precision, date_value,
  release_status, first_revision_id, last_observed_revision_id
FROM reconciled_releases_before_season_precision;

DROP TABLE reconciled_releases_before_season_precision;

INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin
) VALUES
  (
    'fusion-world-en@8',
    'fusion-world-en',
    'fusion-world',
    'fusion-world@1',
    'fusion-world-en-restructured-complete-catalogue@7',
    'production'
  );

UPDATE catalogue_schema_state
SET migration_level = 26
WHERE singleton = 1 AND migration_level = 25;
