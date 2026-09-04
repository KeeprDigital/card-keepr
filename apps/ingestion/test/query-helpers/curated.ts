// Dedicated test queries. Tests retain binding, execution, and atomic batch composition.

export function insertCuratedRevisions(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO curated_revisions (
           id, game, target_key, target_kind, effective_from, effective_to,
           proposal_json, content_digest, reviewed_source_digest,
           schema_binding_json, author, created_at, status, event_version
         ) VALUES (
           ?, 'one-piece', ?, 'field', NULL, NULL, ?, ?, ?, ?, 'owner', ?,
           'active', 1
         )`);
}

export function insertCatalogueCuratedProvenance(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_curated_provenance (
           catalogue_revision_id, curated_revision_id, target_key,
           content_digest, provenance_json
         ) VALUES ('catrev_products', ?, ?, ?, ?)`);
}

export function readCatalogueCuratedProvenanceCuratedRevisionId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT curated_revision_id FROM catalogue_curated_provenance
       WHERE catalogue_revision_id = ? AND curated_revision_id = ?`);
}

export function setCuratedRevisionsStatusEventVersion(database: D1Database): D1PreparedStatement {
  return database.prepare(
    "UPDATE curated_revisions SET status = 'retired', event_version = event_version + 1 WHERE status IN ('active', 'reconfirmation_required')",
  );
}

export function setCuratedRevisionIdempotencyResponseStatus(database: D1Database): D1PreparedStatement {
  return database.prepare("UPDATE curated_revision_idempotency SET response_status = 202 WHERE idempotency_key = ?");
}

export function insertCatalogueCuratedProvenanceForCreateIdempotentServerAuthoredAvailableThroughStableListShow(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_curated_provenance (
       catalogue_revision_id, curated_revision_id, target_key,
       content_digest, provenance_json
     ) VALUES (?, ?, 'target', ?, '{}')`);
}

export function deleteCatalogueCuratedProvenance(database: D1Database): D1PreparedStatement {
  return database.prepare(
    "DELETE FROM catalogue_curated_provenance WHERE catalogue_revision_id = ? AND curated_revision_id = ?",
  );
}

export function insertCuratedRevisionsForAtomicMutationBoundaryRechecksCurrentCatalogueRevision(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO curated_revisions (
       id, game, target_key, target_kind, proposal_json, content_digest,
       reviewed_source_digest, schema_binding_json, author, created_at,
       status, event_version
     ) VALUES ('currev_stale_atomic', 'one-piece', 'stale-target', 'field',
       ?, ?, ?, ?, 'owner', ?, 'active', 1)`);
}

export function insertCuratedRevisionEvents(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO curated_revision_events (
       revision_id, event_version, kind, event_json, created_at, author
     ) VALUES (?, 2, 'retired', ?, ?, 'owner')`);
}

export function readCuratedRevisionsStatusEventVersion(database: D1Database): D1PreparedStatement {
  return database.prepare(
    "SELECT status, event_version FROM curated_revisions WHERE id IN (SELECT value FROM json_each(?))",
  );
}

export function countCuratedRevisionEventsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(
    "SELECT COUNT(*) AS count FROM curated_revision_events WHERE revision_id IN (SELECT value FROM json_each(?)) AND kind = 'source_change_detected'",
  );
}

export function readCuratedRevisionsStatusEventVersionForChangedOfficialValueRequiresReconfirmationInsteadSilentlyApplying(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare("SELECT status, event_version FROM curated_revisions WHERE id = ?");
}

export function countCuratedRevisionEventsCountForChangedOfficialValueRequiresReconfirmationInsteadSilentlyApplying(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(
    "SELECT COUNT(*) AS count FROM curated_revision_events WHERE revision_id = ? AND kind = 'source_change_detected'",
  );
}

export function readCuratedRevisionsIdStatus(database: D1Database): D1PreparedStatement {
  return database.prepare(
    "SELECT id, status FROM curated_revisions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
  );
}

export function createInjectCuratedReplacementFailure(database: D1Database): D1PreparedStatement {
  return database.prepare(`CREATE TRIGGER inject_curated_replacement_failure
     BEFORE INSERT ON curated_revisions
     BEGIN
       SELECT RAISE(ABORT, 'injected_replacement_failure');
     END`);
}

export function countCuratedRevisionIdempotencyCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count
     FROM curated_revision_idempotency
     WHERE idempotency_key = ?`);
}

export function countCuratedRevisionsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count
     FROM curated_revisions
     WHERE json_extract(proposal_json, '$.supersedes_revision_id') = ?`);
}
