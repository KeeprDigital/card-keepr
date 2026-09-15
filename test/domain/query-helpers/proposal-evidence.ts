import type { DatabaseSync, StatementSync } from "node:sqlite";

export const proposalEvidenceSchema = `CREATE TABLE source_snapshots(id TEXT,content_object_key TEXT,content_digest TEXT,content_byte_length INTEGER);
      CREATE TABLE source_observation_sets(source_snapshot_id TEXT,content_object_key TEXT,content_digest TEXT,content_byte_length INTEGER);
      CREATE TABLE source_parse_operations(source_snapshot_id TEXT,content_object_key TEXT);
      CREATE TABLE source_archive_blocks(source_snapshot_id TEXT,object_key TEXT,sha256 TEXT,byte_length INTEGER,state TEXT);
      CREATE TABLE source_archive_decodes(source_snapshot_id TEXT,state TEXT);
      CREATE TABLE entity_proposal_source_evidence(source_snapshot_id TEXT);
      CREATE TABLE entity_proposals(id TEXT);
      CREATE TABLE evidence_object_references(owner_id TEXT,owner_kind TEXT,object_key TEXT);`;

export function insertSourceSnapshot(database: DatabaseSync): StatementSync {
  return database.prepare("INSERT INTO source_snapshots VALUES (?,?,?,?)");
}

export function insertProposalSourceEvidence(database: DatabaseSync): StatementSync {
  return database.prepare("INSERT INTO entity_proposal_source_evidence VALUES (?)");
}

export function insertSourceObservationSet(database: DatabaseSync): StatementSync {
  return database.prepare("INSERT INTO source_observation_sets VALUES (?,?,?,?)");
}

export function insertProposal(database: DatabaseSync): StatementSync {
  return database.prepare("INSERT INTO entity_proposals VALUES (?)");
}

export function insertEvidenceObjectReference(database: DatabaseSync): StatementSync {
  return database.prepare("INSERT INTO evidence_object_references VALUES (?,?,?)");
}
