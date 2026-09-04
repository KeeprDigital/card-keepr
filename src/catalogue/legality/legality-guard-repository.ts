import { type CatalogueStore, repositoryStatements } from "../shared";

// NULL WHEN predicates skip their original trigger; coalescing to zero
// preserves that behavior. Checks retain reverse-creation trigger precedence.
export function guardLegalityRuleFactsStatement(database: CatalogueStore, payload: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`WITH incoming AS (SELECT
      json_extract(value, '$.id') AS id,
      json_extract(value, '$.official_id') AS official_id,
      json_extract(value, '$.game') AS supported_game,
      json_extract(value, '$.region') AS region,
      json_extract(value, '$.format') AS format,
      json_extract(value, '$.event_tier') AS event_tier,
      json_extract(value, '$.effective_from') AS effective_from,
      json_extract(value, '$.effective_until') AS effective_until,
      json_extract(value, '$.official_wording') AS official_wording,
      json_extract(value, '$.unresolved_scope_json') AS unresolved_scope_json,
      json_extract(value, '$.effect_json') AS effect_json,
      json_extract(value, '$.card_ids_json') AS card_ids_json,
      json_extract(value, '$.direct_card_ids_json') AS direct_card_ids_json,
      json_extract(value, '$.source_lineage') AS source_lineage,
      json_extract(value, '$.source_snapshot_id') AS source_snapshot_id,
      json_extract(value, '$.source_observation_set_id') AS source_observation_set_id,
      json_extract(value, '$.source_observation_id') AS source_observation_id,
      json_extract(value, '$.source_observation_pointer') AS source_observation_pointer,
      json_extract(value, '$.source_field_pointers_json') AS source_field_pointers_json,
      json_extract(value, '$.first_revision_id') AS first_revision_id,
      json_extract(value, '$.last_observed_revision_id') AS last_observed_revision_id,
      json_extract(value, '$.current') AS current,
      json_extract(value, '$.last_missing_revision_id') AS last_missing_revision_id
    FROM json_each(?))
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM incoming WHERE COALESCE((NOT (
  (
    json_type(incoming.unresolved_scope_json) = 'null'
    AND incoming.effective_from IS NOT NULL
  )
  OR (
    json_type(incoming.unresolved_scope_json) = 'object'
    AND json_extract(incoming.effect_json, '$.type') = 'unresolved'
    AND json_array_length(incoming.direct_card_ids_json) >= 1
    AND (SELECT COUNT(*) FROM json_each(incoming.unresolved_scope_json)) = 1
    AND json_type(incoming.unresolved_scope_json, '$.dimensions') = 'array'
    AND json_array_length(incoming.unresolved_scope_json, '$.dimensions') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(incoming.unresolved_scope_json, '$.dimensions')
      WHERE type <> 'text'
        OR value NOT IN ('effective_interval', 'event_tier', 'target_scope')
    )
    AND NOT EXISTS (
      SELECT value
      FROM json_each(incoming.unresolved_scope_json, '$.dimensions')
      GROUP BY value HAVING COUNT(*) > 1
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(incoming.unresolved_scope_json, '$.dimensions') AS item
      JOIN json_each(
        incoming.unresolved_scope_json,
        '$.dimensions'
      ) AS prior ON prior.key = item.key - 1
      WHERE CAST(prior.value AS BLOB) >= CAST(item.value AS BLOB)
    )
    AND (
      (
        EXISTS (
          SELECT 1
          FROM json_each(incoming.unresolved_scope_json, '$.dimensions')
          WHERE value = 'effective_interval'
        )
        AND incoming.effective_from IS NULL
        AND incoming.effective_until IS NULL
      )
      OR (
        NOT EXISTS (
          SELECT 1
          FROM json_each(incoming.unresolved_scope_json, '$.dimensions')
          WHERE value = 'effective_interval'
        )
        AND incoming.effective_from IS NOT NULL
      )
    )
    AND (
      NOT EXISTS (
        SELECT 1
        FROM json_each(incoming.unresolved_scope_json, '$.dimensions')
        WHERE value = 'event_tier'
      )
      OR incoming.event_tier IS NULL
    )
  )
)), 0))
      THEN json_extract('{}', 'legality_rule_scope_invalid')
    WHEN EXISTS (SELECT 1 FROM incoming WHERE COALESCE((NOT EXISTS (
  SELECT 1
  FROM source_observation_sets AS observation_set
  JOIN source_snapshots AS snapshot
    ON snapshot.id = observation_set.source_snapshot_id
  WHERE observation_set.id = incoming.source_observation_set_id
    AND observation_set.source_snapshot_id = incoming.source_snapshot_id
    AND observation_set.source_lineage = incoming.source_lineage
    AND observation_set.supported_game = incoming.supported_game
    AND snapshot.source_lineage = incoming.source_lineage
    AND snapshot.supported_game = incoming.supported_game
)), 0))
      THEN json_extract('{}', 'legality_rule_provenance_owner_mismatch')
    WHEN EXISTS (SELECT 1 FROM incoming WHERE COALESCE((NOT (
  json_valid(incoming.card_ids_json)
  AND json_type(incoming.card_ids_json) = 'array'
  AND json_valid(incoming.direct_card_ids_json)
  AND json_type(incoming.direct_card_ids_json) = 'array'
  AND json_valid(incoming.effect_json)
  AND json_type(incoming.effect_json) = 'object'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(incoming.direct_card_ids_json) AS item
    WHERE item.type <> 'text'
      OR length(item.value) NOT BETWEEN 1 AND 200
      OR substr(item.value, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR item.value GLOB '*[^A-Za-z0-9._:-]*'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(incoming.direct_card_ids_json) AS item
    JOIN json_each(incoming.direct_card_ids_json) AS prior
      ON prior.key = item.key - 1
    WHERE CAST(prior.value AS BLOB) >= CAST(item.value AS BLOB)
  )
  AND (
    (
      json_extract(incoming.effect_json, '$.type') =
        'prohibited_combination'
      AND json_type(
        incoming.effect_json,
        '$.with_card_ids'
      ) = 'array'
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(CASE WHEN json_type(incoming.effect_json, '$.with_card_ids') = 'array' THEN json_extract(incoming.effect_json, '$.with_card_ids') ELSE '[]' END) AS item
        WHERE item.type <> 'text'
          OR length(item.value) NOT BETWEEN 1 AND 200
          OR substr(item.value, 1, 1) NOT GLOB '[A-Za-z0-9]'
          OR item.value GLOB '*[^A-Za-z0-9._:-]*'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(CASE WHEN json_type(incoming.effect_json, '$.with_card_ids') = 'array' THEN json_extract(incoming.effect_json, '$.with_card_ids') ELSE '[]' END) AS item
        JOIN json_each(CASE WHEN json_type(incoming.effect_json, '$.with_card_ids') = 'array' THEN json_extract(incoming.effect_json, '$.with_card_ids') ELSE '[]' END) AS prior ON prior.key = item.key - 1
        WHERE CAST(prior.value AS BLOB) >= CAST(item.value AS BLOB)
      )
    )
    OR (
      COALESCE(json_extract(incoming.effect_json, '$.type'), '') <>
        'prohibited_combination'
      AND json_type(
        incoming.effect_json,
        '$.with_card_ids'
      ) IS NULL
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(incoming.card_ids_json) AS item
    WHERE item.type <> 'text'
      OR length(item.value) NOT BETWEEN 1 AND 200
      OR substr(item.value, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR item.value GLOB '*[^A-Za-z0-9._:-]*'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(incoming.card_ids_json) AS item
    JOIN json_each(incoming.card_ids_json) AS prior
      ON prior.key = item.key - 1
    WHERE CAST(prior.value AS BLOB) >= CAST(item.value AS BLOB)
  )
  AND NOT EXISTS (
    SELECT value FROM json_each(incoming.card_ids_json)
    EXCEPT
    SELECT value FROM (
      SELECT value FROM json_each(incoming.direct_card_ids_json)
      UNION
      SELECT value
      FROM json_each(
        CASE
          WHEN json_type(
            incoming.effect_json,
            '$.with_card_ids'
          ) = 'array'
          THEN json_extract(incoming.effect_json, '$.with_card_ids')
          ELSE '[]'
        END
      )
    )
  )
  AND NOT EXISTS (
    SELECT value FROM (
      SELECT value FROM json_each(incoming.direct_card_ids_json)
      UNION
      SELECT value
      FROM json_each(
        CASE
          WHEN json_type(
            incoming.effect_json,
            '$.with_card_ids'
          ) = 'array'
          THEN json_extract(incoming.effect_json, '$.with_card_ids')
          ELSE '[]'
        END
      )
    )
    EXCEPT
    SELECT value FROM json_each(incoming.card_ids_json)
  )
  AND json_array_length(incoming.card_ids_json) =
    json_array_length(incoming.direct_card_ids_json) +
    json_array_length(
      CASE
        WHEN json_type(
          incoming.effect_json,
          '$.with_card_ids'
        ) = 'array'
        THEN json_extract(incoming.effect_json, '$.with_card_ids')
        ELSE '[]'
      END
    )
)), 0))
      THEN json_extract('{}', 'legality_rule_card_ids_not_canonical')
    WHEN EXISTS (SELECT 1 FROM incoming WHERE COALESCE((NOT (
  (
    json_extract(incoming.effect_json, '$.type') IN ('eligible', 'ban')
    AND (SELECT COUNT(*) FROM json_each(incoming.effect_json)) = 1
  )
  OR (
    json_extract(incoming.effect_json, '$.type') = 'copy_limit'
    AND (SELECT COUNT(*) FROM json_each(incoming.effect_json)) = 2
    AND json_type(incoming.effect_json, '$.maximum_copies') = 'integer'
    AND json_extract(incoming.effect_json, '$.maximum_copies') >= 1
  )
  OR (
    json_extract(incoming.effect_json, '$.type') = 'prohibited_combination'
    AND (SELECT COUNT(*) FROM json_each(incoming.effect_json)) = 2
    AND json_type(incoming.effect_json, '$.with_card_ids') = 'array'
    AND json_array_length(incoming.direct_card_ids_json) >= 1
    AND json_array_length(incoming.effect_json, '$.with_card_ids') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(incoming.effect_json, '$.with_card_ids')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value FROM json_each(incoming.effect_json, '$.with_card_ids')
      GROUP BY value HAVING COUNT(*) > 1
    )
  )
  OR (
    json_extract(incoming.effect_json, '$.type') = 'membership'
    AND (SELECT COUNT(*) FROM json_each(incoming.effect_json)) = 3
    AND json_type(incoming.effect_json, '$.attribute') = 'text'
    AND length(trim(json_extract(incoming.effect_json, '$.attribute'))) > 0
    AND json_type(incoming.effect_json, '$.includes_any') = 'array'
    AND json_array_length(incoming.effect_json, '$.includes_any') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(incoming.effect_json, '$.includes_any')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value FROM json_each(incoming.effect_json, '$.includes_any')
      GROUP BY value HAVING COUNT(*) > 1
    )
  )
  OR (
    json_extract(incoming.effect_json, '$.type') = 'rotation'
    AND (SELECT COUNT(*) FROM json_each(incoming.effect_json)) = 2
    AND json_type(incoming.effect_json, '$.eligible_blocks') = 'array'
    AND json_array_length(incoming.effect_json, '$.eligible_blocks') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(incoming.effect_json, '$.eligible_blocks')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value FROM json_each(incoming.effect_json, '$.eligible_blocks')
      GROUP BY value HAVING COUNT(*) > 1
    )
  )
  OR (
    json_extract(incoming.effect_json, '$.type') = 'release_timing'
    AND (SELECT COUNT(*) FROM json_each(incoming.effect_json)) = 2
    AND json_type(incoming.effect_json, '$.legal_from') = 'text'
    AND json_extract(incoming.effect_json, '$.legal_from')
      GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(json_extract(incoming.effect_json, '$.legal_from')) =
      json_extract(incoming.effect_json, '$.legal_from')
  )
  OR (
    json_extract(incoming.effect_json, '$.type') = 'unresolved'
    AND (SELECT COUNT(*) FROM json_each(incoming.effect_json)) = 2
    AND json_type(incoming.effect_json, '$.reason') = 'text'
    AND length(trim(json_extract(incoming.effect_json, '$.reason'))) > 0
  )
)), 0))
      THEN json_extract('{}', 'legality_rule_effect_invalid')
    ELSE 1 END`)
    .bind(payload);
}

// The canonical equality predicate uses a balanced AND tree to stay within
// D1's expression-depth limit while checking every public document field.
export function guardRevisionLegalityRulesStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; payload: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`WITH incoming AS (
    SELECT projected.* FROM revision_legality_rules AS projected
    WHERE catalogue_revision_id = ? AND legality_rule_id IN (
      SELECT json_extract(value, '$.id') FROM json_each(?)
    )
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM incoming WHERE COALESCE((NOT (
  json_extract(incoming.document_json, '$.unresolved_scope') IS
    json_extract(incoming.unresolved_scope_json, '$')
  AND (
    (
      json_type(incoming.unresolved_scope_json) = 'null'
      AND incoming.effective_from IS NOT NULL
    )
    OR (
      json_type(incoming.unresolved_scope_json) = 'object'
      AND json_extract(incoming.document_json, '$.effect.type') = 'unresolved'
      AND json_array_length(incoming.document_json, '$.card_ids') >= 1
      AND (SELECT COUNT(*) FROM json_each(incoming.unresolved_scope_json)) = 1
      AND json_type(incoming.unresolved_scope_json, '$.dimensions') = 'array'
      AND json_array_length(incoming.unresolved_scope_json, '$.dimensions') >= 1
      AND NOT EXISTS (
        SELECT 1 FROM json_each(incoming.unresolved_scope_json, '$.dimensions')
        WHERE type <> 'text'
          OR value NOT IN (
            'effective_interval', 'event_tier', 'target_scope'
          )
      )
      AND NOT EXISTS (
        SELECT value
        FROM json_each(incoming.unresolved_scope_json, '$.dimensions')
        GROUP BY value HAVING COUNT(*) > 1
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(incoming.unresolved_scope_json, '$.dimensions') AS item
        JOIN json_each(
          incoming.unresolved_scope_json,
          '$.dimensions'
        ) AS prior ON prior.key = item.key - 1
        WHERE CAST(prior.value AS BLOB) >= CAST(item.value AS BLOB)
      )
      AND (
        (
          EXISTS (
            SELECT 1
            FROM json_each(incoming.unresolved_scope_json, '$.dimensions')
            WHERE value = 'effective_interval'
          )
          AND incoming.effective_from IS NULL
          AND incoming.effective_until IS NULL
        )
        OR (
          NOT EXISTS (
            SELECT 1
            FROM json_each(incoming.unresolved_scope_json, '$.dimensions')
            WHERE value = 'effective_interval'
          )
          AND incoming.effective_from IS NOT NULL
        )
      )
      AND (
        NOT EXISTS (
          SELECT 1
          FROM json_each(incoming.unresolved_scope_json, '$.dimensions')
          WHERE value = 'event_tier'
        )
        OR incoming.event_tier IS NULL
      )
    )
  )
)), 0))
      THEN json_extract('{}', 'revision_legality_rule_scope_invalid')
    WHEN EXISTS (SELECT 1 FROM incoming WHERE COALESCE((NOT EXISTS (
  SELECT 1
  FROM legality_rules AS canonical
  WHERE (((((canonical.id = incoming.legality_rule_id
    AND canonical.supported_game = incoming.supported_game)
    AND (canonical.region = incoming.region
    AND canonical.format = incoming.format))
    AND ((canonical.event_tier IS incoming.event_tier
    AND canonical.effective_from IS incoming.effective_from)
    AND (canonical.effective_until IS incoming.effective_until
    AND (canonical.unresolved_scope_json = incoming.unresolved_scope_json
    AND canonical.card_ids_json = incoming.card_ids_json))))
    AND (((json_extract(incoming.document_json, '$.id') = canonical.id
    AND json_extract(incoming.document_json, '$.official_id') =
      canonical.official_id)
    AND (json_extract(incoming.document_json, '$.game') =
      canonical.supported_game
    AND (json_extract(incoming.document_json, '$.region') = canonical.region
    AND json_extract(incoming.document_json, '$.format') = canonical.format)))
    AND ((json_extract(incoming.document_json, '$.event_tier') IS
      canonical.event_tier
    AND json_extract(incoming.document_json, '$.effective_from') IS
      canonical.effective_from)
    AND (json_extract(incoming.document_json, '$.effective_until') IS
      canonical.effective_until
    AND (json_extract(incoming.document_json, '$.unresolved_scope') IS
      json_extract(canonical.unresolved_scope_json, '$')
    AND json_type(incoming.document_json, '$.card_ids') = 'array')))))
    AND ((((json_extract(incoming.document_json, '$.card_ids') =
      canonical.direct_card_ids_json
    AND json_array_length(
      json_extract(incoming.document_json, '$.card_ids')
    ) = json_array_length(canonical.direct_card_ids_json))
    AND (json_extract(incoming.document_json, '$.official_wording') =
      canonical.official_wording
    AND json_type(incoming.document_json, '$.effect') = 'object'))
    AND ((json_extract(incoming.document_json, '$.effect') =
      canonical.effect_json
    AND (
      (
        json_extract(canonical.effect_json, '$.type') =
          'prohibited_combination'
        AND json_type(
          incoming.document_json,
          '$.effect.with_card_ids'
        ) = 'array'
        AND json_extract(
          incoming.document_json,
          '$.effect.with_card_ids'
        ) = json_extract(canonical.effect_json, '$.with_card_ids')
        AND json_array_length(
          json_extract(
            incoming.document_json,
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
          incoming.document_json,
          '$.effect.with_card_ids'
        ) IS NULL
      )
    ))
    AND (json_extract(incoming.document_json, '$.source_lineage') =
      canonical.source_lineage
    AND (json_extract(incoming.document_json, '$.source_snapshot_id') =
      canonical.source_snapshot_id
    AND json_extract(incoming.document_json, '$.source_observation_set_id') =
      canonical.source_observation_set_id))))
    AND (((json_extract(incoming.document_json, '$.source_observation_id') =
      canonical.source_observation_id
    AND json_extract(incoming.document_json, '$.source_observation_pointer') =
      canonical.source_observation_pointer)
    AND (json_extract(incoming.document_json, '$.source_field_pointers') =
      canonical.source_field_pointers_json
    AND (json_extract(incoming.document_json, '$.first_revision_id') =
      canonical.first_revision_id
    AND json_extract(incoming.document_json, '$.last_observed_revision_id') =
      canonical.last_observed_revision_id)))
    AND ((json_extract(incoming.document_json, '$.current') = canonical.current
    AND json_extract(incoming.document_json, '$.last_missing_revision_id') IS
      canonical.last_missing_revision_id)
    AND ((SELECT COUNT(*) FROM json_each(incoming.document_json)) = 22
    AND (NOT EXISTS (
      SELECT value
      FROM json_each(
        '["card_ids","current","effect","effective_from",'
        || '"effective_until","event_tier","first_revision_id",'
        || '"format","game","id","last_missing_revision_id",'
        || '"last_observed_revision_id","official_id",'
        || '"official_wording","region","source_field_pointers",'
        || '"source_lineage","source_observation_id",'
        || '"source_observation_pointer",'
        || '"source_observation_set_id","source_snapshot_id",'
        || '"unresolved_scope"]'
      )
      EXCEPT
      SELECT key FROM json_each(incoming.document_json)
    )
    AND NOT EXISTS (
      SELECT key FROM json_each(incoming.document_json)
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
        || '"source_observation_set_id","source_snapshot_id",'
        || '"unresolved_scope"]'
      )
    )))))))
)), 0))
      THEN json_extract('{}', 'revision_legality_rule_canonical_mismatch')
    WHEN EXISTS (SELECT 1 FROM incoming WHERE COALESCE((NOT (
  (
    json_extract(incoming.document_json, '$.effect.type') IN ('eligible', 'ban')
    AND (SELECT COUNT(*) FROM json_each(incoming.document_json, '$.effect')) = 1
  )
  OR (
    json_extract(incoming.document_json, '$.effect.type') = 'copy_limit'
    AND (SELECT COUNT(*) FROM json_each(incoming.document_json, '$.effect')) = 2
    AND json_type(incoming.document_json, '$.effect.maximum_copies') = 'integer'
    AND json_extract(incoming.document_json, '$.effect.maximum_copies') >= 1
  )
  OR (
    json_extract(incoming.document_json, '$.effect.type') = 'prohibited_combination'
    AND (SELECT COUNT(*) FROM json_each(incoming.document_json, '$.effect')) = 2
    AND json_type(incoming.document_json, '$.effect.with_card_ids') = 'array'
    AND json_array_length(incoming.document_json, '$.card_ids') >= 1
    AND json_array_length(incoming.document_json, '$.effect.with_card_ids') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(incoming.document_json, '$.effect.with_card_ids')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value
      FROM json_each(incoming.document_json, '$.effect.with_card_ids')
      GROUP BY value HAVING COUNT(*) > 1
    )
    AND NOT EXISTS (
      SELECT direct.value
      FROM json_each(incoming.document_json, '$.card_ids') AS direct
      JOIN json_each(
        incoming.document_json,
        '$.effect.with_card_ids'
      ) AS companion ON companion.value = direct.value
    )
  )
  OR (
    json_extract(incoming.document_json, '$.effect.type') = 'membership'
    AND (SELECT COUNT(*) FROM json_each(incoming.document_json, '$.effect')) = 3
    AND json_type(incoming.document_json, '$.effect.attribute') = 'text'
    AND length(trim(json_extract(incoming.document_json, '$.effect.attribute'))) > 0
    AND json_type(incoming.document_json, '$.effect.includes_any') = 'array'
    AND json_array_length(incoming.document_json, '$.effect.includes_any') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(incoming.document_json, '$.effect.includes_any')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value
      FROM json_each(incoming.document_json, '$.effect.includes_any')
      GROUP BY value HAVING COUNT(*) > 1
    )
  )
  OR (
    json_extract(incoming.document_json, '$.effect.type') = 'rotation'
    AND (SELECT COUNT(*) FROM json_each(incoming.document_json, '$.effect')) = 2
    AND json_type(incoming.document_json, '$.effect.eligible_blocks') = 'array'
    AND json_array_length(incoming.document_json, '$.effect.eligible_blocks') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(incoming.document_json, '$.effect.eligible_blocks')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value
      FROM json_each(incoming.document_json, '$.effect.eligible_blocks')
      GROUP BY value HAVING COUNT(*) > 1
    )
  )
  OR (
    json_extract(incoming.document_json, '$.effect.type') = 'release_timing'
    AND (SELECT COUNT(*) FROM json_each(incoming.document_json, '$.effect')) = 2
    AND json_type(incoming.document_json, '$.effect.legal_from') = 'text'
    AND json_extract(incoming.document_json, '$.effect.legal_from')
      GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(json_extract(incoming.document_json, '$.effect.legal_from')) =
      json_extract(incoming.document_json, '$.effect.legal_from')
  )
  OR (
    json_extract(incoming.document_json, '$.effect.type') = 'unresolved'
    AND (SELECT COUNT(*) FROM json_each(incoming.document_json, '$.effect')) = 2
    AND json_type(incoming.document_json, '$.effect.reason') = 'text'
    AND length(trim(json_extract(incoming.document_json, '$.effect.reason'))) > 0
  )
)), 0))
      THEN json_extract('{}', 'revision_legality_rule_effect_invalid')
    WHEN EXISTS (SELECT 1 FROM incoming WHERE COALESCE((incoming.source_retrieved_at IS NULL), 0))
      THEN json_extract('{}', 'revision_legality_rule_source_retrieved_at_missing')
    ELSE 1 END`)
    .bind(input.revisionId, input.payload);
}

export function retainPublishedLegalityEvidenceStatement(
  database: CatalogueStore,
  payload: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`WITH evidence AS (
    SELECT canonical.source_observation_id, canonical.id,
      row_number() OVER (
        PARTITION BY canonical.source_observation_id ORDER BY CAST(incoming.key AS INTEGER)
      ) AS ordinal
    FROM json_each(?) AS incoming
    JOIN legality_rules AS canonical ON canonical.id = json_extract(incoming.value, '$.id')
  ) INSERT INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
    SELECT source_observation_id, 'legality_rules', id FROM evidence
    WHERE ordinal = 1 AND NOT EXISTS (
      SELECT 1 FROM retained_source_observation_evidence AS retained
      WHERE retained.source_observation_id = evidence.source_observation_id
    )`)
    .bind(payload);
}

export function publishLegalityApplicabilityStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; payload: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`WITH projected AS (
    SELECT * FROM revision_legality_rules
    WHERE catalogue_revision_id = ? AND legality_rule_id IN (
      SELECT json_extract(value, '$.id') FROM json_each(?)
    )
  ) INSERT OR IGNORE INTO revision_legality_rule_applicability
    (catalogue_revision_id, legality_rule_id, applicability_kind, card_id)
    SELECT projected.catalogue_revision_id, projected.legality_rule_id, 'card', card.value
    FROM projected, json_each(projected.card_ids_json) AS card
    UNION ALL
    SELECT catalogue_revision_id, legality_rule_id, 'all_cards', ''
    FROM projected
    WHERE (json_array_length(card_ids_json) = 0 AND json_type(unresolved_scope_json) = 'null')
      OR EXISTS (SELECT 1 FROM json_each(unresolved_scope_json, '$.dimensions') WHERE value = 'target_scope')`)
    .bind(input.revisionId, input.payload);
}
