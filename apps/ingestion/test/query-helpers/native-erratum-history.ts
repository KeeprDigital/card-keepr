/** Read actual private Erratum and per-lineage target history at one accepted candidate. */
export function nativeErratumHistory(database: D1Database, candidateId: string, erratumId: string) {
  return database
    .prepare(`SELECT CASE WHEN lifecycle.kind='errata' THEN 'erratum' ELSE 'provenance' END AS kind,
      first.catalogue_revision_id AS first_revision_id,
      last.catalogue_revision_id AS last_observed_revision_id
      FROM publication_read_lifecycles lifecycle
      JOIN catalogue_candidate_publications first ON first.candidate_id=lifecycle.first_candidate_id
      JOIN catalogue_candidate_publications last ON last.candidate_id=lifecycle.last_observed_candidate_id
      JOIN publication_read_entities entity ON entity.candidate_id=lifecycle.candidate_id
        AND entity.kind=lifecycle.kind AND entity.entity_id=lifecycle.entity_id
      WHERE lifecycle.candidate_id=? AND ((lifecycle.kind='errata' AND lifecycle.entity_id=?)
        OR (lifecycle.kind='relationships' AND entity.relationship_kind='erratum-target' AND entity.from_id=?))
      ORDER BY lifecycle.kind,lifecycle.entity_id`)
    .bind(candidateId, erratumId, erratumId)
    .all<{ kind: string; first_revision_id: string; last_observed_revision_id: string }>();
}
