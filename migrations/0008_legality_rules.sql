PRAGMA foreign_keys = ON;

ALTER TABLE source_freshness RENAME TO source_freshness_before_legality_scope;

CREATE TABLE source_freshness (
  game TEXT NOT NULL CHECK (
    game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')
  ),
  area TEXT NOT NULL CHECK (
    area IN (
      'cards-and-printings', 'products-and-releases',
      'legality-rules', 'errata'
    )
  ),
  source_lineage TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  PRIMARY KEY (game, area, source_lineage, region),
  CHECK (
    (
      area <> 'legality-rules'
      AND source_lineage = ''
      AND region = ''
    )
    OR
    (
      area = 'legality-rules'
      AND source_lineage <> ''
      AND region <> ''
    )
  )
);

INSERT INTO source_freshness (
  game, area, source_lineage, region, checked_at, ingestion_run_id
)
SELECT game, area, '', '', checked_at, ingestion_run_id
FROM source_freshness_before_legality_scope
WHERE area <> 'legality-rules';

DROP TABLE source_freshness_before_legality_scope;

CREATE TABLE official_source_collection_plans (
  ingestion_run_id TEXT NOT NULL
    REFERENCES ingestion_evidence_plans(ingestion_run_id),
  source_lineage TEXT NOT NULL,
  discovery_observation_set_id TEXT NOT NULL
    REFERENCES source_observation_sets(id),
  contract TEXT NOT NULL
    CHECK (contract = 'card-keepr-official-source-collection-plan@1'),
  collection_plan_json TEXT NOT NULL CHECK (json_valid(collection_plan_json)),
  content_digest TEXT NOT NULL
    CHECK (
      length(content_digest) = 64
      AND content_digest NOT GLOB '*[^0-9a-f]*'
    ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (ingestion_run_id, source_lineage),
  UNIQUE (discovery_observation_set_id)
);

CREATE TRIGGER official_source_collection_plan_discovery_owner
BEFORE INSERT ON official_source_collection_plans
WHEN NOT EXISTS (
  SELECT 1
  FROM source_observation_sets AS observation_set
  JOIN source_snapshots AS snapshot
    ON snapshot.id = observation_set.source_snapshot_id
  WHERE observation_set.id = NEW.discovery_observation_set_id
    AND snapshot.ingestion_run_id = NEW.ingestion_run_id
    AND snapshot.source_lineage = NEW.source_lineage
)
BEGIN
  SELECT RAISE(
    ABORT,
    'official_source_collection_plan_discovery_owner_mismatch'
  );
END;

CREATE TRIGGER official_source_collection_plans_immutable_update
BEFORE UPDATE ON official_source_collection_plans
BEGIN
  SELECT RAISE(ABORT, 'official_source_collection_plan_immutable');
END;

CREATE TRIGGER ingestion_evidence_plan_request_set_immutable
BEFORE UPDATE OF ingestion_run_id, source_lineage, supported_game,
  game_profile_version, adapter_version, request_plan_json, plan_origin
ON ingestion_evidence_plans
BEGIN
  SELECT RAISE(ABORT, 'ingestion_evidence_plan_request_set_immutable');
END;

CREATE TRIGGER ingestion_evidence_plans_immutable_delete
BEFORE DELETE ON ingestion_evidence_plans
BEGIN
  SELECT RAISE(ABORT, 'ingestion_evidence_plan_immutable');
END;

CREATE TRIGGER official_source_collection_plans_immutable_delete
BEFORE DELETE ON official_source_collection_plans
BEGIN
  SELECT RAISE(ABORT, 'official_source_collection_plan_immutable');
END;

CREATE TRIGGER source_requests_plan_fields_immutable
BEFORE UPDATE OF ingestion_run_id, request_id, sequence_number, method,
  url, request_headers_json, representation_fingerprint, request_role,
  discovered_from_request_id
ON source_requests
BEGIN
  SELECT RAISE(ABORT, 'source_request_plan_fields_immutable');
END;

CREATE TABLE source_discovery_request_plans (
  ingestion_run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  parent_request_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method = 'GET'),
  url TEXT NOT NULL,
  request_headers_json TEXT NOT NULL CHECK (json_valid(request_headers_json)),
  representation_fingerprint TEXT NOT NULL CHECK (
    length(representation_fingerprint) = 64
    AND representation_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  request_role TEXT NOT NULL CHECK (
    request_role IN ('listing', 'detail', 'product_detail', 'image')
  ),
  PRIMARY KEY (ingestion_run_id, request_id),
  UNIQUE (ingestion_run_id, sequence_number),
  FOREIGN KEY (ingestion_run_id, parent_request_id)
    REFERENCES source_requests(ingestion_run_id, request_id)
);

CREATE TRIGGER source_discovery_request_plans_immutable_update
BEFORE UPDATE ON source_discovery_request_plans
BEGIN
  SELECT RAISE(ABORT, 'source_discovery_request_plan_immutable');
END;

CREATE TRIGGER source_discovery_request_plans_immutable_delete
BEFORE DELETE ON source_discovery_request_plans
BEGIN
  SELECT RAISE(ABORT, 'source_discovery_request_plan_immutable');
END;

CREATE TRIGGER source_requests_must_match_immutable_plan
BEFORE INSERT ON source_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM ingestion_evidence_plans AS plan,
       json_each(
         CASE
           WHEN json_type(plan.request_plan_json, '$.plans') = 'array'
             THEN json_extract(plan.request_plan_json, '$.plans')
           ELSE json_array(json(plan.request_plan_json))
         END
       ) AS evidence_plan,
       json_each(evidence_plan.value, '$.requests') AS planned
  WHERE plan.ingestion_run_id = NEW.ingestion_run_id
    AND json_extract(planned.value, '$.id') = NEW.request_id
    AND CAST(planned.key AS INTEGER) + (
      SELECT COALESCE(
        SUM(json_array_length(json_extract(preceding.value, '$.requests'))),
        0
      )
      FROM json_each(
        CASE
          WHEN json_type(plan.request_plan_json, '$.plans') = 'array'
            THEN json_extract(plan.request_plan_json, '$.plans')
          ELSE json_array(json(plan.request_plan_json))
        END
      ) AS preceding
      WHERE CAST(preceding.key AS INTEGER) <
        CAST(evidence_plan.key AS INTEGER)
    ) = NEW.sequence_number
    AND json_extract(planned.value, '$.method') = NEW.method
    AND json_extract(planned.value, '$.url') = NEW.url
    AND json_extract(planned.value, '$.headers') = NEW.request_headers_json
    AND json_extract(planned.value, '$.representation_fingerprint') =
      NEW.representation_fingerprint
)
AND NOT EXISTS (
  SELECT 1
  FROM ingestion_evidence_plans AS plan
  JOIN official_source_collection_plans AS collection
    ON collection.ingestion_run_id = plan.ingestion_run_id,
       json_each(collection.collection_plan_json, '$.requests') AS planned
  WHERE plan.ingestion_run_id = NEW.ingestion_run_id
    AND json_extract(planned.value, '$.id') = NEW.request_id
    AND (
      SELECT SUM(json_array_length(json_extract(value, '$.requests')))
      FROM json_each(
        CASE
          WHEN json_type(plan.request_plan_json, '$.plans') = 'array'
            THEN json_extract(plan.request_plan_json, '$.plans')
          ELSE json_array(json(plan.request_plan_json))
        END
      )
    ) + 10000 * (
      SELECT CAST(key AS INTEGER)
      FROM json_each(
        CASE
          WHEN json_type(plan.request_plan_json, '$.plans') = 'array'
            THEN json_extract(plan.request_plan_json, '$.plans')
          ELSE json_array(json(plan.request_plan_json))
        END
      )
      WHERE json_extract(value, '$.source_lineage') =
        collection.source_lineage
    ) + CAST(planned.key AS INTEGER) = NEW.sequence_number
    AND json_extract(planned.value, '$.method') = NEW.method
    AND json_extract(planned.value, '$.url') = NEW.url
    AND json_extract(planned.value, '$.headers') = NEW.request_headers_json
    AND json_extract(planned.value, '$.representation_fingerprint') =
      NEW.representation_fingerprint
    AND json_type(planned.value, '$.surface') = 'text'
    AND length(json_extract(planned.value, '$.surface')) > 0
)
AND NOT EXISTS (
  SELECT 1
  FROM source_discovery_request_plans AS planned
  WHERE planned.ingestion_run_id = NEW.ingestion_run_id
    AND planned.request_id = NEW.request_id
    AND planned.sequence_number = NEW.sequence_number
    AND planned.method = NEW.method
    AND planned.url = NEW.url
    AND planned.request_headers_json = NEW.request_headers_json
    AND planned.representation_fingerprint = NEW.representation_fingerprint
    AND planned.request_role = NEW.request_role
    AND planned.parent_request_id = NEW.discovered_from_request_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_request_not_in_immutable_plan');
END;

CREATE TRIGGER source_requests_immutable_delete
BEFORE DELETE ON source_requests
BEGIN
  SELECT RAISE(ABORT, 'source_request_immutable');
END;

CREATE TABLE legality_rules (
  id TEXT PRIMARY KEY,
  official_id TEXT NOT NULL,
  supported_game TEXT NOT NULL CHECK (
    supported_game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')
  ),
  region TEXT NOT NULL CHECK (
    region IN ('EN-OCEANIA', 'EN-ASIA', 'EN-US')
  ),
  format TEXT NOT NULL CHECK (length(format) > 0),
  event_tier TEXT CHECK (event_tier IS NULL OR length(event_tier) > 0),
  effective_from TEXT NOT NULL,
  effective_until TEXT CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  official_wording TEXT NOT NULL CHECK (length(official_wording) > 0),
  effect_json TEXT NOT NULL CHECK (
    json_valid(effect_json) AND json_type(effect_json) = 'object'
  ),
  card_ids_json TEXT NOT NULL CHECK (
    json_valid(card_ids_json) AND json_type(card_ids_json) = 'array'
  ),
  direct_card_ids_json TEXT NOT NULL CHECK (
    json_valid(direct_card_ids_json)
    AND json_type(direct_card_ids_json) = 'array'
  ),
  source_lineage TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_observation_set_id TEXT NOT NULL
    REFERENCES source_observation_sets(id),
  source_observation_id TEXT NOT NULL,
  source_observation_pointer TEXT NOT NULL CHECK (
    source_observation_pointer LIKE '/observations/%'
  ),
  source_field_pointers_json TEXT NOT NULL CHECK (
    json_valid(source_field_pointers_json)
    AND json_type(source_field_pointers_json) = 'object'
  ),
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
  last_missing_revision_id TEXT REFERENCES catalogue_revisions(id),
  UNIQUE (source_lineage, official_id)
);

CREATE TRIGGER legality_rule_effect_valid_insert
BEFORE INSERT ON legality_rules
WHEN NOT (
  (
    json_extract(NEW.effect_json, '$.type') IN ('eligible', 'ban')
    AND (SELECT COUNT(*) FROM json_each(NEW.effect_json)) = 1
  )
  OR (
    json_extract(NEW.effect_json, '$.type') = 'copy_limit'
    AND (SELECT COUNT(*) FROM json_each(NEW.effect_json)) = 2
    AND json_type(NEW.effect_json, '$.maximum_copies') = 'integer'
    AND json_extract(NEW.effect_json, '$.maximum_copies') >= 1
  )
  OR (
    json_extract(NEW.effect_json, '$.type') = 'prohibited_combination'
    AND (SELECT COUNT(*) FROM json_each(NEW.effect_json)) = 2
    AND json_type(NEW.effect_json, '$.with_card_ids') = 'array'
    AND json_array_length(NEW.direct_card_ids_json) >= 1
    AND json_array_length(NEW.effect_json, '$.with_card_ids') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.effect_json, '$.with_card_ids')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value FROM json_each(NEW.effect_json, '$.with_card_ids')
      GROUP BY value HAVING COUNT(*) > 1
    )
  )
  OR (
    json_extract(NEW.effect_json, '$.type') = 'membership'
    AND (SELECT COUNT(*) FROM json_each(NEW.effect_json)) = 3
    AND json_type(NEW.effect_json, '$.attribute') = 'text'
    AND length(trim(json_extract(NEW.effect_json, '$.attribute'))) > 0
    AND json_type(NEW.effect_json, '$.includes_any') = 'array'
    AND json_array_length(NEW.effect_json, '$.includes_any') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.effect_json, '$.includes_any')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value FROM json_each(NEW.effect_json, '$.includes_any')
      GROUP BY value HAVING COUNT(*) > 1
    )
  )
  OR (
    json_extract(NEW.effect_json, '$.type') = 'rotation'
    AND (SELECT COUNT(*) FROM json_each(NEW.effect_json)) = 2
    AND json_type(NEW.effect_json, '$.eligible_blocks') = 'array'
    AND json_array_length(NEW.effect_json, '$.eligible_blocks') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.effect_json, '$.eligible_blocks')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value FROM json_each(NEW.effect_json, '$.eligible_blocks')
      GROUP BY value HAVING COUNT(*) > 1
    )
  )
  OR (
    json_extract(NEW.effect_json, '$.type') = 'release_timing'
    AND (SELECT COUNT(*) FROM json_each(NEW.effect_json)) = 2
    AND json_type(NEW.effect_json, '$.legal_from') = 'text'
    AND json_extract(NEW.effect_json, '$.legal_from')
      GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(json_extract(NEW.effect_json, '$.legal_from')) =
      json_extract(NEW.effect_json, '$.legal_from')
  )
  OR (
    json_extract(NEW.effect_json, '$.type') = 'unresolved'
    AND (SELECT COUNT(*) FROM json_each(NEW.effect_json)) = 2
    AND json_type(NEW.effect_json, '$.reason') = 'text'
    AND length(trim(json_extract(NEW.effect_json, '$.reason'))) > 0
  )
)
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_effect_invalid');
END;

CREATE TRIGGER legality_rule_card_ids_canonical_insert
BEFORE INSERT ON legality_rules
WHEN NOT (
  json_valid(NEW.card_ids_json)
  AND json_type(NEW.card_ids_json) = 'array'
  AND json_valid(NEW.direct_card_ids_json)
  AND json_type(NEW.direct_card_ids_json) = 'array'
  AND json_valid(NEW.effect_json)
  AND json_type(NEW.effect_json) = 'object'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(NEW.direct_card_ids_json) AS item
    WHERE item.type <> 'text'
      OR length(item.value) NOT BETWEEN 1 AND 200
      OR substr(item.value, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR item.value GLOB '*[^A-Za-z0-9._:-]*'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(NEW.direct_card_ids_json) AS item
    JOIN json_each(NEW.direct_card_ids_json) AS prior
      ON prior.key = item.key - 1
    WHERE CAST(prior.value AS BLOB) >= CAST(item.value AS BLOB)
  )
  AND (
    (
      json_extract(NEW.effect_json, '$.type') =
        'prohibited_combination'
      AND json_type(
        NEW.effect_json,
        '$.with_card_ids'
      ) = 'array'
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          json_extract(NEW.effect_json, '$.with_card_ids')
        ) AS item
        WHERE item.type <> 'text'
          OR length(item.value) NOT BETWEEN 1 AND 200
          OR substr(item.value, 1, 1) NOT GLOB '[A-Za-z0-9]'
          OR item.value GLOB '*[^A-Za-z0-9._:-]*'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          json_extract(NEW.effect_json, '$.with_card_ids')
        ) AS item
        JOIN json_each(
          json_extract(NEW.effect_json, '$.with_card_ids')
        ) AS prior ON prior.key = item.key - 1
        WHERE CAST(prior.value AS BLOB) >= CAST(item.value AS BLOB)
      )
    )
    OR (
      COALESCE(json_extract(NEW.effect_json, '$.type'), '') <>
        'prohibited_combination'
      AND json_type(
        NEW.effect_json,
        '$.with_card_ids'
      ) IS NULL
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(NEW.card_ids_json) AS item
    WHERE item.type <> 'text'
      OR length(item.value) NOT BETWEEN 1 AND 200
      OR substr(item.value, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR item.value GLOB '*[^A-Za-z0-9._:-]*'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(NEW.card_ids_json) AS item
    JOIN json_each(NEW.card_ids_json) AS prior
      ON prior.key = item.key - 1
    WHERE CAST(prior.value AS BLOB) >= CAST(item.value AS BLOB)
  )
  AND NOT EXISTS (
    SELECT value FROM json_each(NEW.card_ids_json)
    EXCEPT
    SELECT value FROM (
      SELECT value FROM json_each(NEW.direct_card_ids_json)
      UNION
      SELECT value
      FROM json_each(
        CASE
          WHEN json_type(
            NEW.effect_json,
            '$.with_card_ids'
          ) = 'array'
          THEN json_extract(NEW.effect_json, '$.with_card_ids')
          ELSE '[]'
        END
      )
    )
  )
  AND NOT EXISTS (
    SELECT value FROM (
      SELECT value FROM json_each(NEW.direct_card_ids_json)
      UNION
      SELECT value
      FROM json_each(
        CASE
          WHEN json_type(
            NEW.effect_json,
            '$.with_card_ids'
          ) = 'array'
          THEN json_extract(NEW.effect_json, '$.with_card_ids')
          ELSE '[]'
        END
      )
    )
    EXCEPT
    SELECT value FROM json_each(NEW.card_ids_json)
  )
  AND json_array_length(NEW.card_ids_json) =
    json_array_length(NEW.direct_card_ids_json) +
    json_array_length(
      CASE
        WHEN json_type(
          NEW.effect_json,
          '$.with_card_ids'
        ) = 'array'
        THEN json_extract(NEW.effect_json, '$.with_card_ids')
        ELSE '[]'
      END
    )
)
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_card_ids_not_canonical');
END;

CREATE TRIGGER legality_rule_card_ids_canonical_update
BEFORE UPDATE OF effect_json, card_ids_json, direct_card_ids_json
ON legality_rules
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_card_ids_not_canonical');
END;

CREATE INDEX legality_rules_context
  ON legality_rules (
    supported_game,
    region,
    format,
    event_tier,
    effective_from,
    effective_until
  );

CREATE TRIGGER legality_rule_provenance_owner_insert
BEFORE INSERT ON legality_rules
WHEN NOT EXISTS (
  SELECT 1
  FROM source_observation_sets AS observation_set
  JOIN source_snapshots AS snapshot
    ON snapshot.id = observation_set.source_snapshot_id
  WHERE observation_set.id = NEW.source_observation_set_id
    AND observation_set.source_snapshot_id = NEW.source_snapshot_id
    AND observation_set.source_lineage = NEW.source_lineage
    AND observation_set.supported_game = NEW.supported_game
    AND snapshot.source_lineage = NEW.source_lineage
    AND snapshot.supported_game = NEW.supported_game
)
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_provenance_owner_mismatch');
END;

CREATE TRIGGER legality_rule_provenance_owner_update
BEFORE UPDATE OF supported_game, source_lineage, source_snapshot_id,
  source_observation_set_id
ON legality_rules
WHEN NOT EXISTS (
  SELECT 1
  FROM source_observation_sets AS observation_set
  JOIN source_snapshots AS snapshot
    ON snapshot.id = observation_set.source_snapshot_id
  WHERE observation_set.id = NEW.source_observation_set_id
    AND observation_set.source_snapshot_id = NEW.source_snapshot_id
    AND observation_set.source_lineage = NEW.source_lineage
    AND observation_set.supported_game = NEW.supported_game
    AND snapshot.source_lineage = NEW.source_lineage
    AND snapshot.supported_game = NEW.supported_game
)
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_provenance_owner_mismatch');
END;

CREATE TRIGGER legality_rule_provenance_immutable
BEFORE UPDATE OF supported_game, source_lineage, source_snapshot_id,
  source_observation_set_id, source_observation_id,
  source_observation_pointer, source_field_pointers_json
ON legality_rules
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_provenance_immutable');
END;

CREATE TRIGGER guard_legality_rule_identity
BEFORE UPDATE ON legality_rules
WHEN OLD.id <> NEW.id
  OR OLD.first_revision_id <> NEW.first_revision_id
  OR OLD.supported_game <> NEW.supported_game
  OR OLD.official_id <> NEW.official_id
  OR OLD.region <> NEW.region
  OR OLD.format <> NEW.format
  OR COALESCE(OLD.event_tier, '') <> COALESCE(NEW.event_tier, '')
  OR OLD.effective_from <> NEW.effective_from
  OR COALESCE(OLD.effective_until, '') <> COALESCE(NEW.effective_until, '')
  OR OLD.official_wording <> NEW.official_wording
  OR OLD.effect_json <> NEW.effect_json
  OR OLD.card_ids_json <> NEW.card_ids_json
  OR OLD.direct_card_ids_json <> NEW.direct_card_ids_json
  OR OLD.source_lineage <> NEW.source_lineage
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_identity_conflict');
END;

CREATE TRIGGER legality_rules_immutable_delete
BEFORE DELETE ON legality_rules
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_immutable');
END;

CREATE TABLE revision_legality_rules (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  legality_rule_id TEXT NOT NULL REFERENCES legality_rules(id),
  supported_game TEXT NOT NULL CHECK (
    supported_game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')
  ),
  region TEXT NOT NULL CHECK (
    region IN ('EN-OCEANIA', 'EN-ASIA', 'EN-US')
  ),
  format TEXT NOT NULL CHECK (length(format) > 0),
  event_tier TEXT CHECK (event_tier IS NULL OR length(event_tier) > 0),
  effective_from TEXT NOT NULL,
  effective_until TEXT CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  card_ids_json TEXT NOT NULL CHECK (
    json_valid(card_ids_json) AND json_type(card_ids_json) = 'array'
  ),
  document_json TEXT NOT NULL CHECK (
    json_valid(document_json) AND json_type(document_json) = 'object'
  ),
  PRIMARY KEY (catalogue_revision_id, legality_rule_id)
);

CREATE INDEX revision_legality_rules_context
  ON revision_legality_rules (
    catalogue_revision_id,
    region,
    format,
    event_tier,
    effective_from,
    effective_until
  );

CREATE TABLE revision_legality_rule_applicability (
  catalogue_revision_id TEXT NOT NULL,
  legality_rule_id TEXT NOT NULL,
  applicability_kind TEXT NOT NULL CHECK (
    applicability_kind IN ('card', 'all_cards')
  ),
  card_id TEXT NOT NULL,
  CHECK (
    (applicability_kind = 'all_cards' AND card_id = '')
    OR (
      applicability_kind = 'card'
      AND length(card_id) BETWEEN 1 AND 200
      AND substr(card_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND card_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  PRIMARY KEY (
    catalogue_revision_id, legality_rule_id, applicability_kind, card_id
  ),
  FOREIGN KEY (catalogue_revision_id, legality_rule_id)
    REFERENCES revision_legality_rules (
      catalogue_revision_id, legality_rule_id
    )
);

CREATE INDEX revision_legality_rule_applicability_lookup
  ON revision_legality_rule_applicability (
    catalogue_revision_id, applicability_kind, card_id, legality_rule_id
  );

CREATE TRIGGER revision_legality_rule_applicability_insert
AFTER INSERT ON revision_legality_rules
BEGIN
  INSERT INTO revision_legality_rule_applicability (
    catalogue_revision_id, legality_rule_id, applicability_kind, card_id
  )
  SELECT NEW.catalogue_revision_id, NEW.legality_rule_id, 'card', value
  FROM json_each(NEW.card_ids_json);

  INSERT INTO revision_legality_rule_applicability (
    catalogue_revision_id, legality_rule_id, applicability_kind, card_id
  )
  SELECT NEW.catalogue_revision_id, NEW.legality_rule_id, 'all_cards', ''
  WHERE json_array_length(NEW.card_ids_json) = 0;
END;

CREATE TRIGGER revision_legality_rule_applicability_immutable_update
BEFORE UPDATE ON revision_legality_rule_applicability
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_applicability_immutable');
END;

CREATE TRIGGER revision_legality_rule_applicability_immutable_delete
BEFORE DELETE ON revision_legality_rule_applicability
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_applicability_immutable');
END;

CREATE TRIGGER revision_legality_rule_effect_valid_insert
BEFORE INSERT ON revision_legality_rules
WHEN NOT (
  (
    json_extract(NEW.document_json, '$.effect.type') IN ('eligible', 'ban')
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json, '$.effect')) = 1
  )
  OR (
    json_extract(NEW.document_json, '$.effect.type') = 'copy_limit'
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json, '$.effect')) = 2
    AND json_type(NEW.document_json, '$.effect.maximum_copies') = 'integer'
    AND json_extract(NEW.document_json, '$.effect.maximum_copies') >= 1
  )
  OR (
    json_extract(NEW.document_json, '$.effect.type') = 'prohibited_combination'
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json, '$.effect')) = 2
    AND json_type(NEW.document_json, '$.effect.with_card_ids') = 'array'
    AND json_array_length(NEW.document_json, '$.card_ids') >= 1
    AND json_array_length(NEW.document_json, '$.effect.with_card_ids') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.document_json, '$.effect.with_card_ids')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value
      FROM json_each(NEW.document_json, '$.effect.with_card_ids')
      GROUP BY value HAVING COUNT(*) > 1
    )
    AND NOT EXISTS (
      SELECT direct.value
      FROM json_each(NEW.document_json, '$.card_ids') AS direct
      JOIN json_each(
        NEW.document_json,
        '$.effect.with_card_ids'
      ) AS companion ON companion.value = direct.value
    )
  )
  OR (
    json_extract(NEW.document_json, '$.effect.type') = 'membership'
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json, '$.effect')) = 3
    AND json_type(NEW.document_json, '$.effect.attribute') = 'text'
    AND length(trim(json_extract(NEW.document_json, '$.effect.attribute'))) > 0
    AND json_type(NEW.document_json, '$.effect.includes_any') = 'array'
    AND json_array_length(NEW.document_json, '$.effect.includes_any') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.document_json, '$.effect.includes_any')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value
      FROM json_each(NEW.document_json, '$.effect.includes_any')
      GROUP BY value HAVING COUNT(*) > 1
    )
  )
  OR (
    json_extract(NEW.document_json, '$.effect.type') = 'rotation'
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json, '$.effect')) = 2
    AND json_type(NEW.document_json, '$.effect.eligible_blocks') = 'array'
    AND json_array_length(NEW.document_json, '$.effect.eligible_blocks') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.document_json, '$.effect.eligible_blocks')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value
      FROM json_each(NEW.document_json, '$.effect.eligible_blocks')
      GROUP BY value HAVING COUNT(*) > 1
    )
  )
  OR (
    json_extract(NEW.document_json, '$.effect.type') = 'release_timing'
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json, '$.effect')) = 2
    AND json_type(NEW.document_json, '$.effect.legal_from') = 'text'
    AND json_extract(NEW.document_json, '$.effect.legal_from')
      GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(json_extract(NEW.document_json, '$.effect.legal_from')) =
      json_extract(NEW.document_json, '$.effect.legal_from')
  )
  OR (
    json_extract(NEW.document_json, '$.effect.type') = 'unresolved'
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json, '$.effect')) = 2
    AND json_type(NEW.document_json, '$.effect.reason') = 'text'
    AND length(trim(json_extract(NEW.document_json, '$.effect.reason'))) > 0
  )
)
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_effect_invalid');
END;

CREATE TRIGGER revision_legality_rule_matches_canonical
BEFORE INSERT ON revision_legality_rules
WHEN NOT EXISTS (
  SELECT 1
  FROM legality_rules AS canonical
  WHERE canonical.id = NEW.legality_rule_id
    AND canonical.supported_game = NEW.supported_game
    AND canonical.region = NEW.region
    AND canonical.format = NEW.format
    AND canonical.event_tier IS NEW.event_tier
    AND canonical.effective_from = NEW.effective_from
    AND canonical.effective_until IS NEW.effective_until
    AND canonical.card_ids_json = NEW.card_ids_json
    AND json_extract(NEW.document_json, '$.id') = canonical.id
    AND json_extract(NEW.document_json, '$.official_id') =
      canonical.official_id
    AND json_extract(NEW.document_json, '$.game') =
      canonical.supported_game
    AND json_extract(NEW.document_json, '$.region') = canonical.region
    AND json_extract(NEW.document_json, '$.format') = canonical.format
    AND json_extract(NEW.document_json, '$.event_tier') IS
      canonical.event_tier
    AND json_extract(NEW.document_json, '$.effective_from') =
      canonical.effective_from
    AND json_extract(NEW.document_json, '$.effective_until') IS
      canonical.effective_until
    AND json_type(NEW.document_json, '$.card_ids') = 'array'
    AND json_extract(NEW.document_json, '$.card_ids') =
      canonical.direct_card_ids_json
    AND json_array_length(
      json_extract(NEW.document_json, '$.card_ids')
    ) = json_array_length(canonical.direct_card_ids_json)
    AND json_extract(NEW.document_json, '$.official_wording') =
      canonical.official_wording
    AND json_type(NEW.document_json, '$.effect') = 'object'
    AND json_extract(NEW.document_json, '$.effect') =
      canonical.effect_json
    AND (
      (
        json_extract(canonical.effect_json, '$.type') =
          'prohibited_combination'
        AND json_type(
          NEW.document_json,
          '$.effect.with_card_ids'
        ) = 'array'
        AND json_extract(
          NEW.document_json,
          '$.effect.with_card_ids'
        ) = json_extract(canonical.effect_json, '$.with_card_ids')
        AND json_array_length(
          json_extract(
            NEW.document_json,
            '$.effect.with_card_ids'
          )
        ) = json_array_length(
          json_extract(canonical.effect_json, '$.with_card_ids')
        )
      )
      OR (
        json_extract(canonical.effect_json, '$.type') <>
          'prohibited_combination'
        AND json_type(
          NEW.document_json,
          '$.effect.with_card_ids'
        ) IS NULL
      )
    )
    AND json_extract(NEW.document_json, '$.source_lineage') =
      canonical.source_lineage
    AND json_extract(NEW.document_json, '$.source_snapshot_id') =
      canonical.source_snapshot_id
    AND json_extract(NEW.document_json, '$.source_observation_set_id') =
      canonical.source_observation_set_id
    AND json_extract(NEW.document_json, '$.source_observation_id') =
      canonical.source_observation_id
    AND json_extract(NEW.document_json, '$.source_observation_pointer') =
      canonical.source_observation_pointer
    AND json_extract(NEW.document_json, '$.source_field_pointers') =
      canonical.source_field_pointers_json
    AND json_extract(NEW.document_json, '$.first_revision_id') =
      canonical.first_revision_id
    AND json_extract(NEW.document_json, '$.last_observed_revision_id') =
      canonical.last_observed_revision_id
    AND json_extract(NEW.document_json, '$.current') = canonical.current
    AND json_extract(NEW.document_json, '$.last_missing_revision_id') IS
      canonical.last_missing_revision_id
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json)) = 21
    AND NOT EXISTS (
      SELECT value
      FROM json_each(
        '["card_ids","current","effect","effective_from",'
        || '"effective_until","event_tier","first_revision_id",'
        || '"format","game","id","last_missing_revision_id",'
        || '"last_observed_revision_id","official_id",'
        || '"official_wording","region","source_field_pointers",'
        || '"source_lineage","source_observation_id",'
        || '"source_observation_pointer",'
        || '"source_observation_set_id","source_snapshot_id"]'
      )
      EXCEPT
      SELECT key FROM json_each(NEW.document_json)
    )
    AND NOT EXISTS (
      SELECT key FROM json_each(NEW.document_json)
      EXCEPT
      SELECT value
      FROM json_each(
        '["card_ids","current","effect","effective_from",'
        || '"effective_until","event_tier","first_revision_id",'
        || '"format","game","id","last_missing_revision_id",'
        || '"last_observed_revision_id","official_id",'
        || '"official_wording","region","source_field_pointers",'
        || '"source_lineage","source_observation_id",'
        || '"source_observation_pointer",'
        || '"source_observation_set_id","source_snapshot_id"]'
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_canonical_mismatch');
END;

CREATE TRIGGER revision_legality_rules_immutable_update
BEFORE UPDATE ON revision_legality_rules
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_immutable');
END;

CREATE TRIGGER revision_legality_rules_immutable_delete
BEFORE DELETE ON revision_legality_rules
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_immutable');
END;

-- Legality-aware adapters are new immutable parser contracts. Earlier adapter
-- identities remain bound to their original Card/Product/Release behavior.
INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin
) VALUES
  (
    'one-piece-en@2', 'one-piece-en', 'one-piece', 'one-piece@1',
    'one-piece-en-raw-surfaces-with-legality@2', 'production'
  ),
  (
    'fusion-world-en@3', 'fusion-world-en', 'fusion-world', 'fusion-world@1',
    'fusion-world-en-raw-surfaces-with-legality@2', 'production'
  ),
  (
    'digimon-en@3', 'digimon-en', 'digimon', 'digimon@1',
    'digimon-en-raw-surfaces-with-legality@2', 'production'
  ),
  (
    'gundam-en-asia@3', 'gundam-en-asia', 'gundam', 'gundam@1',
    'gundam-en-asia-raw-surfaces-with-legality@2', 'production'
  ),
  (
    'gundam-en-us@3', 'gundam-en-us', 'gundam', 'gundam@1',
    'gundam-en-us-raw-surfaces-with-legality@2', 'production'
  ),
  (
    'fixture-one-piece-json@3', 'one-piece-en', 'one-piece', 'one-piece@1',
    'synthetic-fixture-card-document-with-legality@2', 'synthetic_fixture'
  ),
  (
    'fixture-fusion-world-json@2', 'fusion-world-en', 'fusion-world',
    'fusion-world@1', 'synthetic-fixture-card-document-with-legality@2',
    'synthetic_fixture'
  ),
  (
    'fixture-digimon-json@2', 'digimon-en', 'digimon', 'digimon@1',
    'synthetic-fixture-card-document-with-legality@2', 'synthetic_fixture'
  ),
  (
    'fixture-gundam-en-asia-json@2', 'gundam-en-asia', 'gundam', 'gundam@1',
    'synthetic-fixture-card-document-with-legality@2', 'synthetic_fixture'
  ),
  (
    'fixture-gundam-en-us-json@2', 'gundam-en-us', 'gundam', 'gundam@1',
    'synthetic-fixture-card-document-with-legality@2', 'synthetic_fixture'
  );
