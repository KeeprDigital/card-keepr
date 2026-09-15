import { type CatalogueStore, repositoryStatements } from "../shared";

export type ArchiveDecode = {
  source_snapshot_id: string;
  pin_json: string;
  next_block: number;
  next_record: number;
  decoded_bytes: number;
  digest: string;
  decoded_digest: string | null;
  state: "decoding" | "decoded";
};

export type ArchiveBlock = {
  ordinal: number;
  byte_offset: number;
  first_record: number;
  record_count: number;
  byte_length: number;
  sha256: string;
  object_key: string;
  state: "planned" | "retained";
};

export type ArchiveParseProgress = {
  observation_set_id: string;
  next_block: number;
  block_offset: number;
  next_record: number;
  next_variant: number;
  observation_count: number;
  selected_records: number;
  excluded_counts_json: string;
  discovery_ordinal: number;
  discovery_digest: string | null;
  state: "normalizing" | "normalized" | "complete";
};

export function archiveParseProgress(db: CatalogueStore, set: string) {
  return repositoryStatements(db)
    .prepare("SELECT * FROM source_archive_parse_progress WHERE observation_set_id=?")
    .bind(set);
}

export function initializeArchiveParse(db: CatalogueStore, set: string) {
  return repositoryStatements(db)
    .prepare("INSERT INTO source_archive_parse_progress(observation_set_id) VALUES (?) ON CONFLICT DO NOTHING")
    .bind(set);
}

export function advanceArchiveParse(db: CatalogueStore, prior: ArchiveParseProgress, next: ArchiveParseProgress) {
  return repositoryStatements(db)
    .prepare(
      `UPDATE source_archive_parse_progress SET
    next_block=?,block_offset=?,next_record=?,next_variant=?,observation_count=?,selected_records=?,excluded_counts_json=?,state=?
    WHERE observation_set_id=? AND next_record=? AND next_variant=? AND observation_count=? AND state='normalizing'`,
    )
    .bind(
      next.next_block,
      next.block_offset,
      next.next_record,
      next.next_variant,
      next.observation_count,
      next.selected_records,
      next.excluded_counts_json,
      next.state,
      prior.observation_set_id,
      prior.next_record,
      prior.next_variant,
      prior.observation_count,
    );
}

export type ArchiveRecordReceipt = {
  ordinal: number;
  source_key: string;
  block_ordinal: number;
  block_offset: number;
  byte_length: number;
  sha256: string;
  exclusion: string | null;
};

export function insertArchiveRecordReceipt(db: CatalogueStore, set: string, record: ArchiveRecordReceipt) {
  return repositoryStatements(db)
    .prepare(
      `INSERT INTO source_archive_record_receipts
    (observation_set_id,ordinal,source_key,block_ordinal,block_offset,byte_length,sha256,exclusion)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(observation_set_id,ordinal) DO NOTHING`,
    )
    .bind(
      set,
      record.ordinal,
      record.source_key,
      record.block_ordinal,
      record.block_offset,
      record.byte_length,
      record.sha256,
      record.exclusion,
    );
}

export function archiveRecordReceipt(db: CatalogueStore, set: string, ordinal: number) {
  return repositoryStatements(db)
    .prepare(
      `SELECT ordinal,source_key,block_ordinal,block_offset,byte_length,sha256,exclusion
    FROM source_archive_record_receipts WHERE observation_set_id=? AND ordinal=?`,
    )
    .bind(set, ordinal);
}

export function advanceArchiveDiscovery(
  db: CatalogueStore,
  set: string,
  after: number,
  next: number,
  digest: string,
  complete: boolean,
) {
  return repositoryStatements(db)
    .prepare(
      `UPDATE source_archive_parse_progress SET discovery_ordinal=?,discovery_digest=?,state=?
    WHERE observation_set_id=? AND discovery_ordinal=? AND state='normalized'`,
    )
    .bind(next, digest, complete ? "complete" : "normalized", set, after);
}

export function archiveDecode(db: CatalogueStore, snapshot: string) {
  return repositoryStatements(db)
    .prepare("SELECT * FROM source_archive_decodes WHERE source_snapshot_id=?")
    .bind(snapshot);
}

export function adoptedArchiveDecode(db: CatalogueStore, set: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT d.* FROM source_archive_decodes d
    JOIN source_observation_sets s ON s.source_snapshot_id=d.source_snapshot_id
    WHERE s.id=? AND d.state='decoded'`,
    )
    .bind(set);
}

export function initializeArchiveDecode(db: CatalogueStore, snapshot: string, pin: string, digest: string) {
  return repositoryStatements(db)
    .prepare(
      `INSERT INTO source_archive_decodes
    (source_snapshot_id,pin_json,next_block,next_record,decoded_bytes,digest,state)
    VALUES (?,?,0,0,0,?,'decoding') ON CONFLICT DO NOTHING`,
    )
    .bind(snapshot, pin, digest);
}

export function archiveBlock(db: CatalogueStore, snapshot: string, ordinal: number) {
  return repositoryStatements(db)
    .prepare(
      `SELECT ordinal,byte_offset,first_record,record_count,byte_length,sha256,object_key,state
    FROM source_archive_blocks WHERE source_snapshot_id=? AND ordinal=?`,
    )
    .bind(snapshot, ordinal);
}

export function planArchiveBlock(db: CatalogueStore, snapshot: string, block: ArchiveBlock) {
  return repositoryStatements(db)
    .prepare(
      `INSERT INTO source_archive_blocks
    (source_snapshot_id,ordinal,byte_offset,first_record,record_count,byte_length,sha256,object_key,state)
    VALUES (?,?,?,?,?,?,?,?,'planned') ON CONFLICT DO NOTHING`,
    )
    .bind(
      snapshot,
      block.ordinal,
      block.byte_offset,
      block.first_record,
      block.record_count,
      block.byte_length,
      block.sha256,
      block.object_key,
    );
}

export function retainArchiveBlock(db: CatalogueStore, snapshot: string, ordinal: number) {
  return repositoryStatements(db)
    .prepare(
      `UPDATE source_archive_blocks SET state='retained'
    WHERE source_snapshot_id=? AND ordinal=? AND state='planned'`,
    )
    .bind(snapshot, ordinal);
}

export function advanceArchiveDecode(
  db: CatalogueStore,
  snapshot: string,
  prior: ArchiveDecode,
  block: ArchiveBlock,
  digest: string,
) {
  return repositoryStatements(db)
    .prepare(
      `UPDATE source_archive_decodes
    SET next_block=?,next_record=?,decoded_bytes=?,digest=?
    WHERE source_snapshot_id=? AND state='decoding' AND next_block=? AND digest=?`,
    )
    .bind(
      block.ordinal + 1,
      block.first_record + block.record_count,
      block.byte_offset + block.byte_length,
      digest,
      snapshot,
      prior.next_block,
      prior.digest,
    );
}

export function sealArchiveDecode(db: CatalogueStore, snapshot: string, receipt: ArchiveDecode, decodedDigest: string) {
  return repositoryStatements(db)
    .prepare(
      `UPDATE source_archive_decodes SET state='decoded',decoded_digest=?
    WHERE source_snapshot_id=? AND state='decoding' AND next_block=? AND next_record=? AND decoded_bytes=? AND digest=?`,
    )
    .bind(decodedDigest, snapshot, receipt.next_block, receipt.next_record, receipt.decoded_bytes, receipt.digest);
}
