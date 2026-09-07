SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=21
THEN 1 ELSE json_extract('schema_level_mismatch_expected_21','$') END;

-- Approval is an immutable owner decision, independently of subsequent work.
CREATE TABLE game_publication_operations (
 id TEXT PRIMARY KEY,
 candidate_id TEXT NOT NULL UNIQUE REFERENCES game_candidates(id),
 manifest_digest TEXT NOT NULL,
 expected_game_revision_id TEXT NOT NULL,
 candidate_generation INTEGER NOT NULL,
 deadline TEXT NOT NULL,
 approved_at TEXT NOT NULL,
 inspection_receipt TEXT NOT NULL,
 idempotency_key TEXT NOT NULL UNIQUE,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 approval_json TEXT NOT NULL CHECK(json_valid(approval_json)),
 generation INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK(state IN ('approved','waiting_artifacts','waiting_backup','retry_paused','published','failed')),
 failure_code TEXT,
 resulting_revision_id TEXT,
 backup_attempt_id TEXT,
 published_at TEXT
);
CREATE TRIGGER game_publication_approval_immutable BEFORE UPDATE ON game_publication_operations
WHEN NEW.id<>OLD.id OR NEW.candidate_id<>OLD.candidate_id OR NEW.manifest_digest<>OLD.manifest_digest
 OR NEW.expected_game_revision_id<>OLD.expected_game_revision_id OR NEW.candidate_generation<>OLD.candidate_generation
 OR NEW.deadline<>OLD.deadline OR NEW.approved_at<>OLD.approved_at OR NEW.inspection_receipt<>OLD.inspection_receipt
 OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.request_json<>OLD.request_json OR NEW.approval_json<>OLD.approval_json
BEGIN SELECT RAISE(ABORT,'publication_approval_immutable'); END;
CREATE TRIGGER game_publication_operation_retained BEFORE DELETE ON game_publication_operations
BEGIN SELECT RAISE(ABORT,'publication_operation_retained'); END;
CREATE TABLE game_publication_actions (
 idempotency_key TEXT PRIMARY KEY,
 publication_operation_id TEXT NOT NULL REFERENCES game_publication_operations(id),
 request_json TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json))
);
CREATE TRIGGER game_publication_actions_immutable BEFORE UPDATE ON game_publication_actions
BEGIN SELECT RAISE(ABORT,'publication_action_immutable'); END;
CREATE TRIGGER game_publication_actions_retained BEFORE DELETE ON game_publication_actions
BEGIN SELECT RAISE(ABORT,'publication_action_retained'); END;
-- Retain the common ancestry spine, without making collection identity a
-- unique publication identity. Deferred FK checks close over the rebuilt table.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE catalogue_revisions_native (
 id TEXT PRIMARY KEY,
 ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
 published_at TEXT NOT NULL,
 content_digest TEXT NOT NULL,
 expected_previous_revision_id TEXT NOT NULL,
 approved_candidate_digest TEXT NOT NULL,
 publication_operation_id TEXT UNIQUE REFERENCES game_publication_operations(id)
);
CREATE TABLE publication_revision_migration_copy AS SELECT * FROM catalogue_revisions;
DROP TABLE catalogue_revisions;
ALTER TABLE catalogue_revisions_native RENAME TO catalogue_revisions;
INSERT INTO catalogue_revisions SELECT *,NULL FROM publication_revision_migration_copy;
DROP TABLE publication_revision_migration_copy;
CREATE UNIQUE INDEX catalogue_legacy_collection_identity ON catalogue_revisions(ingestion_run_id)
 WHERE publication_operation_id IS NULL;
CREATE TABLE catalogue_composition_games (
 catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
 supported_game TEXT NOT NULL,
 candidate_id TEXT NOT NULL REFERENCES game_candidates(id),
 game_revision_id TEXT NOT NULL,
 root_digest TEXT NOT NULL,
 PRIMARY KEY(catalogue_revision_id,supported_game)
);
CREATE TRIGGER catalogue_composition_immutable BEFORE UPDATE ON catalogue_composition_games
BEGIN SELECT RAISE(ABORT,'catalogue_composition_immutable'); END;
CREATE TRIGGER catalogue_composition_retained BEFORE DELETE ON catalogue_composition_games
BEGIN SELECT RAISE(ABORT,'catalogue_composition_retained'); END;
ALTER TABLE catalogue_backup_attempts ADD COLUMN publication_operation_id TEXT REFERENCES game_publication_operations(id);
CREATE UNIQUE INDEX catalogue_publication_backup ON catalogue_backup_attempts(publication_operation_id)
 WHERE publication_operation_id IS NOT NULL AND linked_attempt_id IS NULL;
-- Prepared public query facts remain private until selected by a composition.
CREATE TABLE publication_read_entities (
 candidate_id TEXT NOT NULL REFERENCES publication_preparations(candidate_id),
 kind TEXT NOT NULL,entity_id TEXT NOT NULL,batch_ordinal INTEGER NOT NULL,
 preparation_id TEXT NOT NULL,supported_game TEXT NOT NULL,
 card_id TEXT,identity_kind TEXT,identity_value TEXT,name TEXT,official_code TEXT,rarity TEXT,
 relationship_kind TEXT,from_id TEXT,to_id TEXT,product_id TEXT,
 sort1 TEXT NOT NULL,sort2 TEXT NOT NULL,sort3 TEXT NOT NULL,sort4 TEXT NOT NULL,sort5 TEXT NOT NULL,
 record_bytes INTEGER NOT NULL,
 PRIMARY KEY(candidate_id,kind,entity_id),
 FOREIGN KEY(candidate_id,batch_ordinal) REFERENCES publication_projection_batches(candidate_id,ordinal)
);
CREATE INDEX publication_read_order ON publication_read_entities(candidate_id,kind,sort1,sort2,sort3,sort4,sort5,entity_id);
CREATE INDEX publication_read_card ON publication_read_entities(candidate_id,kind,card_id,entity_id);
CREATE INDEX publication_read_rarity ON publication_read_entities(candidate_id,kind,rarity,card_id,entity_id);
CREATE INDEX publication_read_identity ON publication_read_entities(candidate_id,kind,identity_kind,identity_value,entity_id);
CREATE INDEX publication_read_from ON publication_read_entities(candidate_id,kind,from_id,entity_id);
CREATE INDEX publication_read_to ON publication_read_entities(candidate_id,kind,relationship_kind,to_id,from_id);
CREATE INDEX publication_read_product ON publication_read_entities(candidate_id,kind,product_id,entity_id);
CREATE TABLE publication_read_attributes (
 candidate_id TEXT NOT NULL,card_id TEXT NOT NULL,profile TEXT NOT NULL,attribute TEXT NOT NULL,value TEXT NOT NULL,
 PRIMARY KEY(candidate_id,card_id,profile,attribute,value)
);
CREATE INDEX publication_read_attribute_value ON publication_read_attributes(candidate_id,profile,attribute,value,card_id);
CREATE TABLE publication_read_release_regions (
 candidate_id TEXT NOT NULL,product_id TEXT NOT NULL,region TEXT NOT NULL,
 PRIMARY KEY(candidate_id,product_id,region)
);
CREATE INDEX publication_read_region ON publication_read_release_regions(candidate_id,region,product_id);
CREATE TABLE publication_read_text_chunks (
 candidate_id TEXT NOT NULL REFERENCES publication_preparations(candidate_id),
 sha256 TEXT NOT NULL,ordinal INTEGER NOT NULL,content TEXT NOT NULL CHECK(length(CAST(content AS BLOB))<=131072),
 PRIMARY KEY(candidate_id,sha256,ordinal)
);

-- Preserve schema-21 prepared candidates without re-running sealed preparation.
INSERT INTO publication_read_entities
 SELECT b.candidate_id,b.kind,json_extract(b.content,'$.records[0].value.id'),b.ordinal,c.preparation_id,c.supported_game,
 coalesce(json_extract(b.content,'$.records[0].value.card_id'),json_extract(b.content,'$.records[0].value.printing_id')),json_extract(b.content,'$.records[0].value.official_identity.kind'),
 json_extract(b.content,'$.records[0].value.official_identity.value'),json_extract(b.content,'$.records[0].value.name'),
 json_extract(b.content,'$.records[0].value.official_code'),lower(json_extract(b.content,'$.records[0].value.rarity')),
 json_extract(b.content,'$.records[0].value.kind'),json_extract(b.content,'$.records[0].value.from.id'),json_extract(b.content,'$.records[0].value.to.id'),json_extract(b.content,'$.records[0].value.product_id'),
 CASE WHEN b.kind='printings' THEN coalesce(json_extract(b.content,'$.records[0].value.card_id'),'') ELSE c.supported_game END,
 CASE WHEN b.kind='cards' THEN coalesce(json_extract(b.content,'$.records[0].value.official_identity.kind'),'unknown') WHEN b.kind='products' THEN CASE WHEN json_extract(b.content,'$.records[0].value.official_code') IS NULL THEN '1' ELSE '0' END ELSE '' END,
 CASE WHEN b.kind='cards' THEN coalesce(json_extract(b.content,'$.records[0].value.official_identity.value'),'') WHEN b.kind='products' THEN coalesce(json_extract(b.content,'$.records[0].value.official_code'),'') ELSE '' END,
 CASE WHEN b.kind='products' THEN CASE WHEN json_extract(b.content,'$.records[0].value.name') IS NULL THEN '1' ELSE '0' END ELSE '' END,
 CASE WHEN b.kind='products' THEN coalesce(json_extract(b.content,'$.records[0].value.name'),'') ELSE '' END,
 length(CAST(b.content AS BLOB))+coalesce((SELECT sum(json_extract(value,'$.byte_length')) FROM json_each(b.content,'$.records[0].text_parts')),0)
 FROM publication_projection_batches b JOIN game_candidates c ON c.id=b.candidate_id;
INSERT INTO publication_read_attributes
 WITH RECURSIVE attributes(candidate_id,card_id,profile,attribute,value,kind) AS (
 SELECT b.candidate_id,json_extract(b.content,'$.records[0].value.id'),json_extract(b.content,'$.records[0].value.game_data.profile'),field.key,field.value,field.type
 FROM publication_projection_batches b,json_each(b.content,'$.records[0].value.game_data.attributes') field WHERE b.kind='cards'
 UNION ALL SELECT p.candidate_id,p.card_id,p.profile,p.attribute || CASE WHEN p.kind='array' THEN '' ELSE '.' || child.key END,child.value,child.type
 FROM attributes p,json_each(CASE WHEN p.kind IN ('array','object') THEN p.value ELSE '[]' END) child)
 SELECT DISTINCT candidate_id,card_id,profile,attribute,CASE kind WHEN 'text' THEN json_quote(value) WHEN 'null' THEN 'null' WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(value AS TEXT) END FROM attributes WHERE kind NOT IN ('array','object');
INSERT INTO publication_read_release_regions SELECT DISTINCT b.candidate_id,json_extract(b.content,'$.records[0].value.id'),json_extract(release.value,'$.region')
 FROM publication_projection_batches b,json_each(b.content,'$.records[0].value.releases') release
 WHERE b.kind='products' AND json_extract(release.value,'$.region') IS NOT NULL;

INSERT INTO publication_read_text_chunks
SELECT DISTINCT c.id,t.sha256,t.ordinal,t.content
FROM publication_projection_batches b JOIN game_candidates c ON c.id=b.candidate_id
JOIN json_each(b.content,'$.records[0].text_parts') part
JOIN reconciliation_text_chunks t ON t.preparation_id=c.preparation_id AND t.sha256=json_extract(part.value,'$.sha256');

CREATE TRIGGER publication_read_entities_immutable BEFORE UPDATE ON publication_read_entities
BEGIN SELECT RAISE(ABORT,'publication_read_immutable'); END;
CREATE TRIGGER publication_read_text_immutable BEFORE UPDATE ON publication_read_text_chunks
BEGIN SELECT RAISE(ABORT,'publication_read_immutable'); END;
CREATE TRIGGER publication_read_attributes_immutable BEFORE UPDATE ON publication_read_attributes
BEGIN SELECT RAISE(ABORT,'publication_read_immutable'); END;
CREATE TRIGGER publication_read_regions_immutable BEFORE UPDATE ON publication_read_release_regions
BEGIN SELECT RAISE(ABORT,'publication_read_immutable'); END;
UPDATE catalogue_schema_state SET migration_level=22 WHERE singleton=1;
