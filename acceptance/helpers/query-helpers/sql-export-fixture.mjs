export const createExportEvidence = (db) =>
  db.prepare("CREATE TABLE evidence(id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
export const insertExportEvidence = (db) => db.prepare("INSERT INTO evidence VALUES (?, ?)");
export const countExportEvidence = (db) => db.prepare("SELECT count(*) AS n FROM evidence");
export const exportEvidenceById = (db) => db.prepare("SELECT body FROM evidence WHERE id=?");
