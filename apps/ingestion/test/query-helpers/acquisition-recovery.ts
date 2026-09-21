export function rawWriterCompletion(db: D1Database, token: string) {
  return db.prepare("SELECT completed_at FROM evidence_object_writers WHERE token=?").bind(token);
}
export function dispatchReservation(db: D1Database, id: string) {
  return db.prepare("SELECT settled_at, charged_source_bytes FROM source_dispatch_reservations WHERE id=?").bind(id);
}
