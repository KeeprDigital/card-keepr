import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const at = "2026-09-09T00:00:00.000Z";
const digest = "a".repeat(64);
const migrations = new URL("../../../migrations/", import.meta.url);

/** Actual schema and synthetic relational facts isolate the decision integrity boundary. */
export async function identityDecisionDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
    if (Number.parseInt(file, 10) > 31) continue;
    database.exec(await readFile(new URL(file, migrations), "utf8"));
  }
  seedRun(database, "retained-publication");
  database
    .prepare(`INSERT INTO catalogue_revisions
    (id,ingestion_run_id,published_at,content_digest,expected_previous_revision_id,approved_candidate_digest)
    VALUES ('retained-revision','retained-publication',?,?,'catrev_spine_000',?)`)
    .run(at, digest, digest);
  return database;
}

export async function migrateIdentityDecisionTargets(database) {
  database.exec("BEGIN");
  try {
    database.exec(await readFile(new URL("0032_native_identity_review_targets.sql", migrations), "utf8"));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function seedRun(database, id) {
  database
    .prepare(`INSERT INTO ingestion_runs(id,started_at,expected_current_revision_id,idempotency_key)
    VALUES (?,?,'catrev_spine_000',?)`)
    .run(id, at, id);
}

function seedPreparation(database, id, game, published = false) {
  seedRun(database, id);
  database
    .prepare(`INSERT INTO reconciliation_operations
    (id,ingestion_run_id,supported_game,expected_game_revision_id,state,created_at,deadline,
      definition_pins_json,observation_cutoff,identity_decision_cutoff,authority_decision_cutoff)
    VALUES (?,?,?,'catrev_spine_000',?,?,?,'{}',0,0,0)`)
    .run(id, id, game, published ? "sealed" : "failed", at, at);
  database
    .prepare(`INSERT INTO game_candidates
    (id,preparation_id,ingestion_run_id,supported_game,expected_game_revision_id,created_at,deadline,state,generation)
    VALUES (?,?,?,?,'catrev_spine_000',?,?,?,0)`)
    .run(id, id, id, game, at, at, published ? "published" : "failed");
}

export function seedHistoricalPrinting(database, id, game = "one-piece") {
  database
    .prepare(`INSERT INTO reconciled_cards
    (id,supported_game,official_identity_kind,official_identity_value,first_revision_id,last_observed_revision_id)
    VALUES (?,?,'card_number',?,'retained-revision','retained-revision')`)
    .run(`${id}-card`, game, id);
  database
    .prepare(`INSERT INTO reconciled_printings
    (id,card_id,source_lineage,artwork_fingerprint,printed_fields_digest,first_revision_id,last_observed_revision_id)
    VALUES (?,?,'one-piece-en',?,?,'retained-revision','retained-revision')`)
    .run(id, `${id}-card`, digest, digest);
}

export function seedNativeIdentityTarget(
  database,
  candidate,
  printing,
  { game = "one-piece", kind = "printings", published = true } = {},
) {
  seedPreparation(database, candidate, game, published);
  database
    .prepare(`INSERT INTO publication_preparations
    (candidate_id,manifest_digest,generation,sequence,state,phase,cursor_json,created_at)
    VALUES (?,?,0,0,'verified','composition','{}',?)`)
    .run(candidate, digest, at);
  database
    .prepare(`INSERT INTO publication_projection_batches(candidate_id,ordinal,kind,content,sha256)
    VALUES (?,0,?,'{}',?)`)
    .run(candidate, kind, digest);
  database
    .prepare(`INSERT INTO publication_read_entities
    (candidate_id,kind,entity_id,batch_ordinal,preparation_id,supported_game,sort1,sort2,sort3,sort4,sort5,record_bytes)
    VALUES (?,?,?,0,?,?,'','','','','',2)`)
    .run(candidate, kind, printing, candidate, game);
  if (published)
    database.prepare("INSERT INTO catalogue_candidate_publications VALUES (?,'retained-revision')").run(candidate);
}

export function seedIdentityReview(
  database,
  id,
  candidates,
  { game = "one-piece", predecessor, missingPin = false } = {},
) {
  const run = `${id}-source`;
  seedRun(database, run);
  database
    .prepare(`INSERT INTO source_requests
    (ingestion_run_id,request_id,sequence_number,method,url,request_headers_json,representation_fingerprint,state)
    VALUES (?,'request',1,'GET','https://example.test/evidence','{}',?,'captured')`)
    .run(run, digest);
  database
    .prepare(`INSERT INTO source_fetch_attempts
    (id,ingestion_run_id,request_id,attempt_number,requested_at,completed_at,outcome,http_status,response_headers_json)
    VALUES (?,?,'request',1,?,?,'success',200,'{}')`)
    .run(`${id}-fetch`, run, at, at);
  database
    .prepare(`INSERT INTO source_snapshots
    (id,ingestion_run_id,request_id,fetch_attempt_id,request_method,request_url,request_headers_json,
     representation_fingerprint,response_vary_json,retrieved_at,http_status,response_headers_json,media_type,
     content_digest,content_byte_length,content_object_key,source_lineage,supported_game,game_profile_version,adapter_version)
    SELECT ?,?,'request',?,'GET','https://example.test/evidence','{}',?,'[]',?,200,'{}','text/plain',?,0,?,
      source_lineage,supported_game,game_profile_version,adapter_version
    FROM source_adapter_versions WHERE supported_game=? ORDER BY adapter_version LIMIT 1`)
    .run(`${id}-snapshot`, run, `${id}-fetch`, digest, at, digest, `${id}-body`, game);
  database
    .prepare(`INSERT INTO canonical_identity_reviews
    (id,ingestion_run_id,source_lineage,source_observation_id,source_snapshot_id,evidence_json,candidate_printing_ids_json,created_at)
    SELECT ?,?,source_lineage,?,id,'{}',?,? FROM source_snapshots WHERE id=?`)
    .run(id, run, `${id}-observation`, JSON.stringify(candidates), at, `${id}-snapshot`);
  if (predecessor !== undefined || missingPin) {
    seedPreparation(database, `${id}-preparation`, game);
    database
      .prepare("INSERT INTO reconciliation_identity_reviews VALUES (?,?,?,?)")
      .run(`${id}-preparation`, id, `${id}-observation`, `${id}-snapshot`);
    if (!missingPin)
      database.prepare("INSERT INTO game_candidate_predecessors VALUES (?,?)").run(`${id}-preparation`, predecessor);
  }
}

export function identityDecision(review, printing) {
  const request = {
    review_id: review,
    printing_id: printing,
    rationale: "Retained owner evidence",
    idempotency_key: review,
  };
  return { ...request, request_json: JSON.stringify(request), decided_at: at };
}

export function seedRepeatedIdentityReview(database, review, preparation, predecessor) {
  seedPreparation(database, preparation, "one-piece");
  database
    .prepare(`INSERT INTO reconciliation_identity_reviews
    SELECT ?,id,source_observation_id,source_snapshot_id FROM canonical_identity_reviews WHERE id=?`)
    .run(preparation, review);
  database.prepare("INSERT INTO game_candidate_predecessors VALUES (?,?)").run(preparation, predecessor);
}

function decisionFields(decision) {
  return [
    decision.review_id,
    decision.printing_id,
    decision.rationale,
    decision.idempotency_key,
    decision.request_json,
    decision.decided_at,
  ];
}

export function seedHistoricalDecision(database, rowid, review, printing) {
  const decision = identityDecision(review, printing);
  database
    .prepare(`INSERT INTO canonical_identity_decisions
    (rowid,review_id,printing_id,rationale,idempotency_key,request_json,decided_at) VALUES (?,?,?,?,?,?,?)`)
    .run(rowid, ...decisionFields(decision));
}

export function decisionRows(database) {
  return database
    .prepare(`SELECT rowid,review_id,printing_id,rationale,idempotency_key,request_json,decided_at
    FROM canonical_identity_decisions ORDER BY rowid`)
    .all();
}

export function insertExplicitTarget(database, review, printing, candidate) {
  const decision = identityDecision(review, printing);
  return database
    .prepare(`INSERT INTO canonical_identity_decisions
    (review_id,printing_id,rationale,idempotency_key,request_json,decided_at,native_candidate_id,historical_printing_id)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(...decisionFields(decision), candidate, candidate === null ? printing : null);
}
