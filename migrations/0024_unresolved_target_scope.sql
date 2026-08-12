-- Issue #58: represent open-predicate Official Source restrictions
-- explicitly. The Legality Rule unresolved-scope vocabulary gains the
-- 'target_scope' dimension: the rule's retained Card list is the enumerated
-- set of known matches while the Official Source states that unenumerated
-- (including future) Cards are also in scope. Such a rule additionally
-- materializes one explicit 'all_cards' applicability row so every
-- contextual Legality Status query in its game, region, and format retains
-- the uncertainty instead of silently missing it.

DROP TRIGGER legality_rule_scope_valid_insert;
CREATE TRIGGER legality_rule_scope_valid_insert
BEFORE INSERT ON legality_rules
WHEN NOT (
  (
    json_type(NEW.unresolved_scope_json) = 'null'
    AND NEW.effective_from IS NOT NULL
  )
  OR (
    json_type(NEW.unresolved_scope_json) = 'object'
    AND json_extract(NEW.effect_json, '$.type') = 'unresolved'
    AND json_array_length(NEW.direct_card_ids_json) >= 1
    AND (SELECT COUNT(*) FROM json_each(NEW.unresolved_scope_json)) = 1
    AND json_type(NEW.unresolved_scope_json, '$.dimensions') = 'array'
    AND json_array_length(NEW.unresolved_scope_json, '$.dimensions') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
      WHERE type <> 'text'
        OR value NOT IN ('effective_interval', 'event_tier', 'target_scope')
    )
    AND NOT EXISTS (
      SELECT value
      FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
      GROUP BY value HAVING COUNT(*) > 1
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.unresolved_scope_json, '$.dimensions') AS item
      JOIN json_each(
        NEW.unresolved_scope_json,
        '$.dimensions'
      ) AS prior ON prior.key = item.key - 1
      WHERE CAST(prior.value AS BLOB) >= CAST(item.value AS BLOB)
    )
    AND (
      (
        EXISTS (
          SELECT 1
          FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
          WHERE value = 'effective_interval'
        )
        AND NEW.effective_from IS NULL
        AND NEW.effective_until IS NULL
      )
      OR (
        NOT EXISTS (
          SELECT 1
          FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
          WHERE value = 'effective_interval'
        )
        AND NEW.effective_from IS NOT NULL
      )
    )
    AND (
      NOT EXISTS (
        SELECT 1
        FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
        WHERE value = 'event_tier'
      )
      OR NEW.event_tier IS NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_scope_invalid');
END;

DROP TRIGGER revision_legality_rule_scope_valid_insert;
CREATE TRIGGER revision_legality_rule_scope_valid_insert
BEFORE INSERT ON revision_legality_rules
WHEN NOT (
  json_extract(NEW.document_json, '$.unresolved_scope') IS
    json_extract(NEW.unresolved_scope_json, '$')
  AND (
    (
      json_type(NEW.unresolved_scope_json) = 'null'
      AND NEW.effective_from IS NOT NULL
    )
    OR (
      json_type(NEW.unresolved_scope_json) = 'object'
      AND json_extract(NEW.document_json, '$.effect.type') = 'unresolved'
      AND json_array_length(NEW.document_json, '$.card_ids') >= 1
      AND (SELECT COUNT(*) FROM json_each(NEW.unresolved_scope_json)) = 1
      AND json_type(NEW.unresolved_scope_json, '$.dimensions') = 'array'
      AND json_array_length(NEW.unresolved_scope_json, '$.dimensions') >= 1
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
        WHERE type <> 'text'
          OR value NOT IN (
            'effective_interval', 'event_tier', 'target_scope'
          )
      )
      AND NOT EXISTS (
        SELECT value
        FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
        GROUP BY value HAVING COUNT(*) > 1
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(NEW.unresolved_scope_json, '$.dimensions') AS item
        JOIN json_each(
          NEW.unresolved_scope_json,
          '$.dimensions'
        ) AS prior ON prior.key = item.key - 1
        WHERE CAST(prior.value AS BLOB) >= CAST(item.value AS BLOB)
      )
      AND (
        (
          EXISTS (
            SELECT 1
            FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
            WHERE value = 'effective_interval'
          )
          AND NEW.effective_from IS NULL
          AND NEW.effective_until IS NULL
        )
        OR (
          NOT EXISTS (
            SELECT 1
            FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
            WHERE value = 'effective_interval'
          )
          AND NEW.effective_from IS NOT NULL
        )
      )
      AND (
        NOT EXISTS (
          SELECT 1
          FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
          WHERE value = 'event_tier'
        )
        OR NEW.event_tier IS NULL
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_scope_invalid');
END;

DROP TRIGGER revision_legality_rule_applicability_insert;
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
  WHERE (
    json_array_length(NEW.card_ids_json) = 0
    AND json_type(NEW.unresolved_scope_json) = 'null'
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
    WHERE value = 'target_scope'
  );
END;

-- Issue #58 adapter generation: the Gundam legality parser represents the
-- 2026-07-24 compound open-predicate policy as an explicit unresolved
-- target-scope rule, and the One Piece don-rules surface accepts a
-- coverage-only rules hub without DON!! payload evidence. Earlier identities
-- remain installed for retained replay.
INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin
) VALUES
  (
    'one-piece-en@6',
    'one-piece-en',
    'one-piece',
    'one-piece@1',
    'one-piece-en-restructured-complete-catalogue@6',
    'production'
  ),
  (
    'gundam-en-asia@7',
    'gundam-en-asia',
    'gundam',
    'gundam@1',
    'gundam-en-asia-restructured-complete-catalogue@6',
    'production'
  ),
  (
    'gundam-en-us@7',
    'gundam-en-us',
    'gundam',
    'gundam@1',
    'gundam-en-us-restructured-complete-catalogue@6',
    'production'
  );

UPDATE catalogue_schema_state
SET migration_level = 24
WHERE singleton = 1 AND migration_level = 23;
