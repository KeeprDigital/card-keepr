// Fixed retained-decision fixture. The caller supplies all acknowledged values
// and owns execution against its isolated native database.
export function retainedCuratedCreationSql(row) {
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  return `
    INSERT INTO curated_revisions (
      id, game, target_key, target_kind, effective_from, effective_to,
      proposal_json, content_digest, reviewed_source_digest,
      schema_binding_json, author, created_at, status, event_version
    ) VALUES (${quote(row.revisionId)}, ${quote(row.game)}, ${quote(row.targetKey)}, 'relationship', NULL, NULL,
      ${quote(row.proposalJson)}, ${quote(row.contentDigest)}, ${quote(row.reviewedSourceDigest)},
      ${quote(row.schemaBindingJson)}, 'owner', ${quote(row.createdAt)}, 'active', 1);
    INSERT INTO curated_revision_events (revision_id, event_version, kind, event_json, created_at, author)
    VALUES (${quote(row.revisionId)}, 1, 'authored', ${quote(row.eventJson)}, ${quote(row.createdAt)}, 'owner');
    INSERT INTO curated_revision_idempotency (idempotency_key, request_digest, response_json, response_status, created_at)
    VALUES (${quote(row.idempotencyKey)}, ${quote(row.requestDigest)}, ${quote(row.receiptJson)}, 201, ${quote(row.createdAt)});
  `;
}
