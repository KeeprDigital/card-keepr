PRAGMA foreign_keys = ON;

CREATE TABLE revision_products (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  product_id TEXT NOT NULL,
  document_json TEXT NOT NULL,
  PRIMARY KEY (catalogue_revision_id, product_id)
);

CREATE INDEX revision_products_catalogue_order
ON revision_products (catalogue_revision_id, product_id);

CREATE TABLE reconciled_products (
  id TEXT PRIMARY KEY,
  supported_game TEXT NOT NULL,
  official_code TEXT,
  name TEXT NOT NULL,
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1))
);

CREATE UNIQUE INDEX reconciled_product_official_identity
ON reconciled_products (supported_game, official_code)
WHERE official_code IS NOT NULL;

CREATE TABLE reconciled_releases (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES reconciled_products(id),
  region TEXT NOT NULL,
  date_precision TEXT NOT NULL CHECK (
    date_precision IN ('day', 'month', 'quarter', 'year', 'unknown')
  ),
  date_value TEXT,
  release_status TEXT NOT NULL CHECK (
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

CREATE TRIGGER reconciled_product_identity_is_immutable
BEFORE UPDATE OF id, supported_game, official_code, first_revision_id
ON reconciled_products
BEGIN
  SELECT RAISE(ABORT, 'reconciled_product_identity_immutable');
END;
