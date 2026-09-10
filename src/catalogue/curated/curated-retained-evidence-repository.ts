import { type CatalogueStore, repositoryStatements } from "../shared";

export function retainedObservationAuthority(db: CatalogueStore, id: string) {
  return repositoryStatements(db)
    .prepare(`SELECT next_ordinal,sealed,requests_complete,manifest_digest,
    EXISTS(SELECT 1 FROM source_observation_sets s WHERE s.id=p.observation_set_id
      AND NOT EXISTS(SELECT 1 FROM evidence_cleanup_objects d WHERE d.object_key=s.content_object_key)) AS authoritative
    FROM source_record_progress p WHERE observation_set_id=?`)
    .bind(id);
}
export function retainedObservationRecord(db: CatalogueStore, id: string, ordinal: number) {
  return repositoryStatements(db)
    .prepare("SELECT content,sha256 FROM source_record_pages WHERE observation_set_id=? AND ordinal=?")
    .bind(id, ordinal);
}
