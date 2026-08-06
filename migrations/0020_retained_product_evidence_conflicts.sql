DROP TRIGGER retain_reconciliation_candidate_evidence;
DROP TRIGGER retain_legality_rule_evidence;
DROP TRIGGER retain_revision_product_evidence;
DROP TRIGGER retain_product_relationship_evidence;
DROP TRIGGER retain_updated_product_relationship_evidence;

CREATE TRIGGER retain_reconciliation_candidate_evidence
AFTER INSERT ON reconciliation_candidates
BEGIN
  INSERT INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
  SELECT NEW.source_observation_id,
         'reconciliation_candidates', NEW.source_observation_set_id
  WHERE NOT EXISTS (
    SELECT 1 FROM retained_source_observation_evidence AS retained
    WHERE retained.source_observation_id = NEW.source_observation_id
  );
END;

CREATE TRIGGER retain_legality_rule_evidence
AFTER INSERT ON legality_rules
BEGIN
  INSERT INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
  SELECT NEW.source_observation_id, 'legality_rules', NEW.id
  WHERE NOT EXISTS (
    SELECT 1 FROM retained_source_observation_evidence AS retained
    WHERE retained.source_observation_id = NEW.source_observation_id
  );
END;

CREATE TRIGGER retain_revision_product_evidence
AFTER INSERT ON revision_products
BEGIN
  INSERT INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
  SELECT json_extract(evidence.value, '$.id'),
         'revision_products', NEW.product_id
  FROM json_each(NEW.document_json, '$.included') AS evidence
  WHERE json_extract(evidence.value, '$.type') = 'source_observation'
    AND json_extract(evidence.value, '$.id') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM retained_source_observation_evidence AS retained
      WHERE retained.source_observation_id =
        json_extract(evidence.value, '$.id')
    );
END;

CREATE TRIGGER retain_product_relationship_evidence
AFTER INSERT ON reconciled_product_relationships
BEGIN
  INSERT INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
  SELECT observation.value,
         'reconciled_product_relationships', NEW.id
  FROM json_each(NEW.source_observation_ids_json) AS observation
  WHERE NOT EXISTS (
    SELECT 1 FROM retained_source_observation_evidence AS retained
    WHERE retained.source_observation_id = observation.value
  );
END;

CREATE TRIGGER retain_updated_product_relationship_evidence
AFTER UPDATE OF source_observation_ids_json
ON reconciled_product_relationships
BEGIN
  INSERT INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
  SELECT observation.value,
         'reconciled_product_relationships', NEW.id
  FROM json_each(NEW.source_observation_ids_json) AS observation
  WHERE NOT EXISTS (
    SELECT 1 FROM retained_source_observation_evidence AS retained
    WHERE retained.source_observation_id = observation.value
  );
END;

UPDATE catalogue_schema_state
SET migration_level = 20
WHERE singleton = 1 AND migration_level = 19;
