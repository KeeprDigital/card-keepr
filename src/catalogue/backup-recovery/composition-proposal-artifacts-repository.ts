/** Proposal roots and pins resolve through literal ownership, never descendant cleanup closure. */
export function proposalArtifactsQuery(after: string) {
  return {
    sql: `WITH pins AS (
      SELECT reference.object_key FROM evidence_object_references reference
      JOIN entity_proposals proposal ON proposal.id=reference.owner_id
      WHERE reference.owner_kind='entity_proposal'
    ), required_snapshots AS (
      SELECT source_snapshot_id AS id FROM entity_proposal_source_evidence
      UNION SELECT snapshot.id FROM source_snapshots snapshot JOIN pins ON pins.object_key=snapshot.content_object_key
      UNION SELECT parse.source_snapshot_id FROM source_parse_operations parse JOIN pins ON pins.object_key=parse.content_object_key
      UNION SELECT block.source_snapshot_id FROM source_archive_blocks block JOIN pins ON pins.object_key=block.object_key
    ), receipts AS (
      SELECT snapshot.id AS snapshot_id,snapshot.content_object_key AS object_key,
        snapshot.content_digest AS sha256,snapshot.content_byte_length AS byte_length,'raw' AS kind FROM source_snapshots snapshot
      UNION ALL SELECT observation.source_snapshot_id,observation.content_object_key,
        observation.content_digest,observation.content_byte_length,'observations' FROM source_observation_sets observation
      UNION ALL SELECT block.source_snapshot_id,block.object_key,block.sha256,block.byte_length,'derived'
        FROM source_archive_blocks block JOIN source_archive_decodes archive
          ON archive.source_snapshot_id=block.source_snapshot_id AND archive.state='decoded'
        WHERE block.state='retained' AND EXISTS(SELECT 1 FROM source_observation_sets observation
          WHERE observation.source_snapshot_id=block.source_snapshot_id)
    ), required_keys AS (
      SELECT object_key FROM receipts JOIN required_snapshots ON required_snapshots.id=receipts.snapshot_id
      UNION SELECT object_key FROM pins
    ) SELECT required.object_key,min(receipt.sha256) AS sha256,min(receipt.byte_length) AS byte_length,
      min(receipt.kind) AS kind,
      count(receipt.object_key)>0 AND min(receipt.sha256)=max(receipt.sha256)
        AND min(receipt.byte_length)=max(receipt.byte_length) AND min(receipt.kind)=max(receipt.kind) AS consistent
      FROM required_keys required LEFT JOIN receipts receipt ON receipt.object_key=required.object_key
      WHERE required.object_key>? GROUP BY required.object_key
      -- Compare every receipt for each selected physical key before applying the page limit.
      ORDER BY required.object_key LIMIT 64`,
    params: [after],
  };
}
