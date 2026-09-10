/** Current recovery follows the latest accepted mutation; older revisions retain their own publication lineage. */
export function acceptedRevisionBackupSql(revision: string) {
  return `EXISTS(SELECT 1 FROM catalogue_revisions retained_revision WHERE retained_revision.id=${revision}
    AND ((retained_revision.publication_operation_id IS NULL AND backup.publication_operation_id IS NULL)
      OR (retained_revision.publication_operation_id IS NOT NULL AND EXISTS(
        SELECT 1 FROM game_publication_operations accepted WHERE accepted.id=backup.publication_operation_id
        AND accepted.state='published' AND accepted.resulting_revision_id=retained_revision.id
        AND accepted.id=CASE WHEN retained_revision.id=(SELECT current_revision_id FROM catalogue_state WHERE singleton=1)
          THEN (SELECT publication_operation_id FROM catalogue_acceptance_head WHERE singleton=1)
          ELSE retained_revision.publication_operation_id END))))`;
}
