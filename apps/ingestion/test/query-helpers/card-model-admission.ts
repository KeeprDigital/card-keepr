export function retainUnattributedCardAllocation(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO canonical_identity_allocations
    (allocation_key,entity_id,entity_kind,allocated_at)
    VALUES (?,'card_unattributed','card','2026-09-01T00:00:00.000Z')`);
}
