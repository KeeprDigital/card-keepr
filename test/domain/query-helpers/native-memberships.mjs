// Projection-only SQLite fixture: no publication/checkpoint completion is simulated.
export function seedNativeMemberships(db) {
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("INSERT INTO catalogue_composition_games VALUES ('revision','one-piece','candidate','revision',?)").run(
    "a".repeat(64),
  );
  for (const [ordinal, kind, id, cardId, fromId, toId] of [
    [0, "cards", "card", null, null, null],
    [1, "printings", "printing", "card", null, null],
    [2, "product_relationships", "historical", null, "printing", "product_old"],
    [3, "product_relationships", "current", null, "printing", "product_current"],
  ]) {
    db.prepare("INSERT INTO publication_projection_batches VALUES ('candidate',?,?,?,?)").run(
      ordinal,
      kind,
      JSON.stringify({ records: [{ value: { id }, text_parts: [] }] }),
      "a".repeat(64),
    );
    db.prepare(
      `INSERT INTO publication_read_entities(candidate_id,kind,entity_id,batch_ordinal,preparation_id,supported_game,card_id,relationship_kind,from_id,to_id,sort1,sort2,sort3,sort4,sort5,record_bytes) VALUES ('candidate',?,?,?,'preparation','one-piece',?,'printing-product',?,?,'','','','','',32)`,
    ).run(kind, id, ordinal, cardId, fromId, toId);
  }
  for (const [id, withdrawn] of [
    ["historical", 1],
    ["current", 0],
  ])
    db.prepare(
      "INSERT INTO publication_read_lifecycles VALUES ('candidate','product_relationships',?,'candidate','candidate',?,NULL,NULL,NULL)",
    ).run(id, withdrawn);
  db.prepare(
    "INSERT INTO publication_read_release_regions VALUES ('candidate','product_old','EN-US'),('candidate','product_current','EN-OCEANIA')",
  ).run();
}
