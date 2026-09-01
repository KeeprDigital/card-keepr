-- Issue #63: replace the fixed 5,000-request discovery threshold with an
-- immutable request-capacity policy owned by each exact Source Adapter
-- Version, constrained by the larger global emergency ceiling (25,000)
-- declared in src/catalogue/source-adapters.ts. Every version registered
-- before this migration keeps the historical 5,000-request behavior through
-- the column default. fusion-world-en@9 advances the active Fusion World
-- registration immutably: it parses byte-for-byte like fusion-world-en@8 and
-- differs only in the request capacity sized for the legitimate production
-- Fusion World graph. This seed remains a database constraint copy of
-- installedSourceAdapterRegistrations; the Worker drift test requires exact
-- agreement, request_capacity included.
PRAGMA foreign_keys = ON;

ALTER TABLE source_adapter_versions
ADD COLUMN request_capacity INTEGER NOT NULL DEFAULT 5000
CHECK (request_capacity BETWEEN 1 AND 24999);

INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin,
  request_capacity
) VALUES
  (
    'fusion-world-en@9',
    'fusion-world-en',
    'fusion-world',
    'fusion-world@1',
    'fusion-world-en-restructured-complete-catalogue@7',
    'production',
    15000
  );

UPDATE catalogue_schema_state
SET migration_level = 27
WHERE singleton = 1 AND migration_level = 26;
