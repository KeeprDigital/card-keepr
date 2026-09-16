export function rawWriterCompletion(db: D1Database, token: string) {
  return db.prepare("SELECT completed_at FROM evidence_object_writers WHERE token=?").bind(token);
}
