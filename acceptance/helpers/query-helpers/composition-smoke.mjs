import { createHash } from "node:crypto";

// Projection-only fixture for read/preflight contracts; this does not simulate publication authority.
export function seedCompositionSmoke(db, defect) {
  db.exec("PRAGMA foreign_keys=OFF");
  const revisions = ["revision_current", "revision_previous", "revision_oldest"];
  for (const revision of [...revisions, "revision_archived"]) {
    db.prepare("INSERT INTO catalogue_revisions VALUES (?, 'run', '2026-09-08T00:00:00Z', ?, 'previous', ?, ?)").run(
      revision,
      "a".repeat(64),
      "b".repeat(64),
      `operation_${revision}`,
    );
    db.prepare("INSERT INTO catalogue_query_revisions(catalogue_revision_id,state) VALUES (?,?)").run(
      revision,
      revision === "revision_archived" ? "archived" : "available",
    );
    db.prepare("INSERT INTO catalogue_composition_games VALUES (?,'one-piece',?,?,?)").run(
      revision,
      defect === "older-image-free" && revision !== revisions[0] ? "candidate_history" : "candidate",
      revision,
      "a".repeat(64),
    );
  }
  let ordinal = 0;
  for (const [kind, value] of [
    [
      "cards",
      {
        id: "card_a",
        game: "one-piece",
        official_identity: { kind: "card_number", value: "OP01-001" },
        name: "First Card",
      },
    ],
    [
      "cards",
      {
        id: "card_b",
        game: "one-piece",
        official_identity: { kind: "unknown", value: null },
        name: "Searchable Curated Card",
      },
    ],
    ["printings", { id: "printing_a", card_id: "card_a" }],
    ["printings", { id: "printing_b", card_id: "card_b" }],
    [
      "printing_images",
      { id: "image_a", printing_id: "printing_a", content_sha256: "c".repeat(64), content_byte_length: 1 },
    ],
  ]) {
    if (defect === "missing-image" && kind === "printing_images") continue;
    if (defect === "missing-printing" && value.id === "printing_b") continue;
    const content = JSON.stringify({ records: [{ value, text_parts: [] }] });
    const digest =
      defect === "corrupt-card" && value.id === "card_b"
        ? "f".repeat(64)
        : createHash("sha256").update(content).digest("hex");
    db.prepare("INSERT INTO publication_projection_batches VALUES ('candidate',?,?,?,?)").run(
      ordinal,
      kind,
      content,
      digest,
    );
    db.prepare(
      `INSERT INTO publication_read_entities(candidate_id,kind,entity_id,batch_ordinal,preparation_id,supported_game,card_id,sort1,sort2,sort3,sort4,sort5,record_bytes) VALUES ('candidate',?,?,?,'preparation','one-piece',?,'','','','','',?)`,
    ).run(kind, value.id, ordinal++, value.card_id ?? value.printing_id ?? null, Buffer.byteLength(content));
  }
  if (defect !== "missing-search")
    db.prepare(
      "INSERT INTO publication_search_fts VALUES ('|candidate|','candidate','card_b','searchable curated card')",
    ).run();
  if (defect === "older-image-free") {
    for (const table of ["publication_read_entities", "publication_projection_batches"]) {
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
      db.exec(
        `INSERT INTO ${table} SELECT ${columns.map((name) => (name === "candidate_id" ? "'candidate_history'" : name)).join(",")} FROM ${table} WHERE candidate_id='candidate' AND kind<>'printing_images'`,
      );
    }
    db.exec(
      "INSERT INTO publication_search_fts VALUES ('|candidate_history|','candidate_history','card_b','searchable curated card')",
    );
  }
  return revisions;
}
