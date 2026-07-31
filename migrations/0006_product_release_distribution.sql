PRAGMA foreign_keys = ON;

ALTER TABLE source_requests
ADD COLUMN request_role TEXT NOT NULL DEFAULT 'surface'
CHECK (
  request_role IN (
    'surface',
    'listing',
    'detail',
    'product_detail',
    'image'
  )
);

ALTER TABLE source_requests
ADD COLUMN discovered_from_request_id TEXT;

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

CREATE VIRTUAL TABLE revision_products_fts USING fts5(
  catalogue_revision_id UNINDEXED,
  product_id UNINDEXED,
  search_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE reconciled_printing_images (
  id TEXT PRIMARY KEY,
  printing_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('front', 'back', 'other')),
  media_type TEXT NOT NULL CHECK (media_type LIKE 'image/%'),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND
    content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  content_byte_length INTEGER NOT NULL CHECK (content_byte_length > 0),
  object_key TEXT NOT NULL,
  UNIQUE (printing_id, role, content_sha256)
);

CREATE INDEX reconciled_printing_images_printing
ON reconciled_printing_images (printing_id, role, id);

CREATE INDEX reconciled_printing_images_object
ON reconciled_printing_images (object_key);

CREATE TABLE revision_printing_images (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  image_id TEXT NOT NULL REFERENCES reconciled_printing_images(id),
  printing_id TEXT NOT NULL,
  PRIMARY KEY (catalogue_revision_id, image_id)
);

CREATE INDEX revision_printing_images_printing
ON revision_printing_images (catalogue_revision_id, printing_id, image_id);

CREATE TRIGGER reconciled_printing_image_is_immutable
BEFORE UPDATE ON reconciled_printing_images
WHEN
  OLD.printing_id IS NOT NEW.printing_id OR
  OLD.role IS NOT NEW.role OR
  OLD.media_type IS NOT NEW.media_type OR
  OLD.width IS NOT NEW.width OR
  OLD.height IS NOT NEW.height OR
  OLD.content_sha256 IS NOT NEW.content_sha256 OR
  OLD.content_byte_length IS NOT NEW.content_byte_length OR
  OLD.object_key IS NOT NEW.object_key
BEGIN
  SELECT RAISE(ABORT, 'reconciled_printing_image_immutable');
END;

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
  event_key TEXT NOT NULL,
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
  source_lineages_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(source_lineages_json)),
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
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
WHEN
  OLD.id IS NOT NEW.id OR
  OLD.supported_game IS NOT NEW.supported_game OR
  OLD.first_revision_id IS NOT NEW.first_revision_id OR
  (
    OLD.official_code IS NOT NEW.official_code AND
    NOT (
      OLD.official_code IS NULL AND
      NEW.official_code IS NOT NULL AND
      lower(trim(OLD.name)) = lower(trim(NEW.name))
    )
  )
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

-- Adapter versions are append-only identities. Existing rows retain the
-- parser contract and origin under which evidence was captured.
INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin
) VALUES
  (
    'one-piece-en@1',
    'one-piece-en',
    'one-piece',
    'one-piece@1',
    'one-piece-en-raw-surfaces@1',
    'production'
  ),
  (
    'fixture-one-piece-json@2',
    'one-piece-en',
    'one-piece',
    'one-piece@1',
    'synthetic-fixture-card-document@1',
    'synthetic_fixture'
  ),
  (
    'fixture-one-piece-json-capped@1',
    'one-piece-en',
    'one-piece',
    'one-piece@1',
    'synthetic-fixture-card-document@1',
    'synthetic_fixture'
  ),
  (
    'fusion-world-en@2',
    'fusion-world-en',
    'fusion-world',
    'fusion-world@1',
    'fusion-world-en-raw-surfaces@1',
    'production'
  ),
  (
    'digimon-en@2',
    'digimon-en',
    'digimon',
    'digimon@1',
    'digimon-en-raw-surfaces@1',
    'production'
  ),
  (
    'gundam-en-asia@2',
    'gundam-en-asia',
    'gundam',
    'gundam@1',
    'gundam-en-asia-raw-surfaces@1',
    'production'
  ),
  (
    'gundam-en-us@2',
    'gundam-en-us',
    'gundam',
    'gundam@1',
    'gundam-en-us-raw-surfaces@1',
    'production'
  );

CREATE TRIGGER source_adapter_version_is_immutable
BEFORE UPDATE ON source_adapter_versions
BEGIN
  SELECT RAISE(ABORT, 'source_adapter_version_immutable');
END;
