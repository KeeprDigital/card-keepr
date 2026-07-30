PRAGMA foreign_keys = ON;

CREATE TABLE revision_products (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  product_id TEXT NOT NULL,
  supported_game TEXT NOT NULL,
  official_code TEXT,
  name TEXT,
  search_text TEXT NOT NULL,
  release_regions_json TEXT NOT NULL,
  document_json TEXT NOT NULL,
  PRIMARY KEY (catalogue_revision_id, product_id)
);

CREATE INDEX revision_products_catalogue_order
ON revision_products (
  catalogue_revision_id,
  supported_game,
  (official_code IS NULL),
  official_code,
  (name IS NULL),
  name,
  product_id
);

CREATE INDEX revision_products_region
ON revision_products (catalogue_revision_id, release_regions_json);

CREATE TABLE reconciled_products (
  id TEXT PRIMARY KEY,
  supported_game TEXT NOT NULL,
  official_code TEXT,
  name TEXT,
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
  withdrawal_revision_id TEXT REFERENCES catalogue_revisions(id),
  withdrawal_evidence_json TEXT
);

CREATE UNIQUE INDEX reconciled_product_official_identity
ON reconciled_products (supported_game, official_code)
WHERE official_code IS NOT NULL;

CREATE TABLE reconciled_releases (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES reconciled_products(id),
  region TEXT NOT NULL,
  date_precision TEXT CHECK (
    date_precision IN ('day', 'month', 'quarter', 'year', 'unknown')
  ),
  date_value TEXT,
  release_status TEXT CHECK (
    release_status IN ('announced', 'released')
  ),
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id)
);

CREATE TABLE reconciled_distribution_contexts (
  id TEXT PRIMARY KEY,
  supported_game TEXT NOT NULL,
  context_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'product',
      'tournament_pack',
      'winner_prize',
      'promotion',
      'other'
    )
  ),
  label TEXT NOT NULL,
  product_id TEXT REFERENCES reconciled_products(id),
  evidence_category TEXT NOT NULL CHECK (
    evidence_category IN ('explicit', 'derived', 'curated')
  ),
  UNIQUE (supported_game, context_key)
);

CREATE TABLE reconciled_product_relationships (
  id TEXT PRIMARY KEY,
  supported_game TEXT NOT NULL,
  relationship_kind TEXT NOT NULL CHECK (
    relationship_kind IN (
      'printing-product',
      'printing-distribution-context',
      'distribution-context-product',
      'product-card'
    )
  ),
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  evidence_category TEXT NOT NULL CHECK (
    evidence_category IN ('explicit', 'derived', 'curated')
  ),
  source_lineage TEXT NOT NULL,
  source_observation_ids_json TEXT NOT NULL,
  relationship_value TEXT NOT NULL,
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  current INTEGER NOT NULL CHECK (current IN (0, 1)),
  last_missing_revision_id TEXT REFERENCES catalogue_revisions(id),
  document_json TEXT NOT NULL
);

CREATE INDEX reconciled_product_relationship_entities
ON reconciled_product_relationships (
  supported_game, from_type, from_id, to_type, to_id, current
);

CREATE TABLE revision_product_relationships (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  relationship_id TEXT NOT NULL,
  document_json TEXT NOT NULL,
  PRIMARY KEY (catalogue_revision_id, relationship_id)
);

CREATE TRIGGER reconciled_product_identity_is_immutable
BEFORE UPDATE OF id, supported_game, official_code, first_revision_id
ON reconciled_products
BEGIN
  SELECT RAISE(ABORT, 'reconciled_product_identity_immutable');
END;

CREATE TRIGGER reconciled_product_relationship_identity_is_immutable
BEFORE UPDATE OF
  id,
  supported_game,
  relationship_kind,
  from_type,
  from_id,
  to_type,
  to_id,
  source_lineage,
  first_revision_id
ON reconciled_product_relationships
BEGIN
  SELECT RAISE(
    ABORT,
    'reconciled_product_relationship_identity_immutable'
  );
END;
