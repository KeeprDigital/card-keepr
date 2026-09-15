import { type CatalogueStore, repositoryStatements } from "../shared";

export function retainedObservationAuthority(db: CatalogueStore, id: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT next_ordinal,sealed,requests_complete,manifest_digest,
    EXISTS(SELECT 1 FROM source_observation_sets s WHERE s.id=p.observation_set_id
      AND NOT EXISTS(SELECT 1 FROM evidence_cleanup_objects d WHERE d.object_key=s.content_object_key)) AS authoritative
    FROM source_record_progress p WHERE observation_set_id=?`,
    )
    .bind(id);
}
export function retainedObservationRecord(db: CatalogueStore, id: string, ordinal: number) {
  return repositoryStatements(db)
    .prepare("SELECT content,sha256 FROM source_record_pages WHERE observation_set_id=? AND ordinal=?")
    .bind(id, ordinal);
}

/** The decision and its existing physical dependencies commit as one unit.
 * Published legacy evidence already has a retained owner; canonical sealed
 * observations also need a pin independent of the source run's later outcome. */
export function curatedEvidenceReferences(
  db: CatalogueStore,
  input: { revisionId: string; proposalJson: string; observedAt: string },
) {
  return repositoryStatements(db)
    .prepare(
      `INSERT INTO evidence_object_references (object_key,owner_kind,owner_id,created_at)
    SELECT dependencies.object_key,'curated_revision',?2,?3 FROM (
      SELECT snapshot.content_object_key AS object_key
      FROM json_each(?1,'$.evidence') evidence
      JOIN source_observation_sets observations
        ON observations.id='srcobsset_' || substr(json_extract(evidence.value,'$.id'),8,64)
      JOIN source_snapshots snapshot ON snapshot.id=observations.source_snapshot_id
      WHERE json_extract(evidence.value,'$.kind')='source_observation'
      UNION
      SELECT observations.content_object_key
      FROM json_each(?1,'$.evidence') evidence
      JOIN source_observation_sets observations
        ON observations.id='srcobsset_' || substr(json_extract(evidence.value,'$.id'),8,64)
      WHERE json_extract(evidence.value,'$.kind')='source_observation'
    ) dependencies WHERE true ON CONFLICT DO NOTHING`,
    )
    .bind(input.proposalJson, input.revisionId, input.observedAt);
}
