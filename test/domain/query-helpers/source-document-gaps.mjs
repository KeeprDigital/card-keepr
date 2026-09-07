export function createSourceDocumentCheckpointTable(database) {
  database.exec(`CREATE TABLE reconciliation_checkpoints (
    preparation_id TEXT NOT NULL, phase TEXT NOT NULL, ordinal INTEGER NOT NULL,
    content TEXT NOT NULL, sha256 TEXT NOT NULL,
    PRIMARY KEY(preparation_id, phase, ordinal))`);
}
