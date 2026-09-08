import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const digest = (value) => createHash("sha256").update(value).digest("hex");
export function curatedNativeFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE catalogue_state (singleton INTEGER PRIMARY KEY, current_revision_id TEXT);
    CREATE TABLE catalogue_revisions (id TEXT PRIMARY KEY, publication_operation_id TEXT);
    CREATE TABLE catalogue_query_revisions (catalogue_revision_id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE catalogue_composition_games (catalogue_revision_id TEXT, supported_game TEXT, candidate_id TEXT, game_revision_id TEXT);
    CREATE TABLE game_candidates (id TEXT PRIMARY KEY, preparation_id TEXT, supported_game TEXT, state TEXT);
    CREATE TABLE publication_read_entities (candidate_id TEXT, kind TEXT, entity_id TEXT, card_id TEXT, product_id TEXT, from_id TEXT, to_id TEXT, relationship_kind TEXT);
    CREATE TABLE reconciliation_correction_pins (preparation_id TEXT PRIMARY KEY, decision_cutoff INTEGER, games_json TEXT);
    INSERT INTO reconciliation_correction_pins VALUES ('preparation_native',0,'["riftbound"]');
    CREATE TABLE reconciliation_checkpoints (preparation_id TEXT, phase TEXT, ordinal INTEGER, content TEXT, sha256 TEXT);
    CREATE TABLE reconciliation_reducer_state (preparation_id TEXT, namespace TEXT, key_digest TEXT, observation_ordinal INTEGER, content TEXT, sha256 TEXT);
    CREATE TABLE reconciliation_text_chunks (preparation_id TEXT, sha256 TEXT, ordinal INTEGER, content TEXT);
    CREATE TABLE revision_cards (catalogue_revision_id TEXT, card_id TEXT, document_json TEXT);
    CREATE TABLE revision_printings (catalogue_revision_id TEXT, printing_id TEXT, document_json TEXT);
    INSERT INTO catalogue_state VALUES (1,'composition_current');
    INSERT INTO catalogue_revisions VALUES ('composition_current','publication_native');
    INSERT INTO catalogue_query_revisions VALUES ('composition_current','available');
    INSERT INTO catalogue_composition_games VALUES ('composition_current','riftbound','candidate_native','game_revision_earlier');
    INSERT INTO game_candidates VALUES ('candidate_native','preparation_native','riftbound','published');
    INSERT INTO publication_read_entities (candidate_id,kind,entity_id,card_id) VALUES ('candidate_native','cards','card_monk',NULL),('candidate_native','printings','printing_monk','card_monk');`);
  function checkpoint(phase, value) {
    const content = JSON.stringify(value);
    db.prepare(
      "INSERT INTO reconciliation_checkpoints VALUES ('preparation_native',?,(SELECT coalesce(max(ordinal),0)+1 FROM reconciliation_checkpoints),?,?)",
    ).run(phase, content, digest(content));
  }
  function entity(namespace, value, ordinal = 1, textParts = []) {
    const content = JSON.stringify({
      contract: "card-keepr-partitioned-record@1",
      value: { id: value.id, entity: value },
      text_parts: textParts,
    });
    db.prepare("INSERT INTO reconciliation_reducer_state VALUES ('preparation_native',?,?,?, ?,?)").run(
      namespace,
      digest(value.id),
      ordinal,
      content,
      digest(content),
    );
  }
  checkpoint("curated_revisions", {
    progress: { stage: "complete" },
    official: { cards: 1, printings: 1 },
    curated: {},
  });
  entity("candidate_before_curated_cards", {
    id: "card_monk",
    game: "riftbound",
    name: "Kinkou Monk",
    official_identity: { kind: "publisher_name", value: "Kinkou Monk" },
    effective_rules_text: null,
    game_data: {
      profile: "riftbound@1",
      attributes: {
        tags: [],
        ability_text: null,
        card_types: ["unit"],
        domains: ["calm"],
        effect_text: null,
        energy: 1,
        might: 1,
        might_bonus: null,
        power: null,
        supertypes: [],
      },
    },
  });
  entity("candidate_before_curated_printings", {
    id: "printing_monk",
    card_id: "card_monk",
    printed_rules_text: null,
    rarity: { normalized: "uncommon", raw: "Uncommon" },
    game_data: null,
  });
  return { db, checkpoint, entity };
}
export function retireCuratedFixture(db) {
  db.prepare("UPDATE catalogue_query_revisions SET state='unavailable'").run();
}
export function unpublishCuratedFixture(db) {
  db.prepare("DELETE FROM catalogue_composition_games").run();
}
export function corruptCuratedFixture(db) {
  db.prepare(
    "UPDATE reconciliation_reducer_state SET sha256=? WHERE namespace='candidate_before_curated_printings'",
  ).run("0".repeat(64));
}

export function corruptCuratedCheckpoint(db) {
  db.prepare("UPDATE reconciliation_checkpoints SET sha256=?").run("0".repeat(64));
}
export function appendCuratedText(db, digest, content) {
  db.prepare("INSERT INTO reconciliation_text_chunks VALUES ('preparation_native',?,0,?)").run(digest, content);
}

export function requireCuratedCorrection(db) {
  db.prepare("UPDATE reconciliation_correction_pins SET decision_cutoff=1").run();
}

/** Reuse the same fixture records in actual D1 without a mock query dispatcher. */
export function curatedNativeD1Statements() {
  const fixture = curatedNativeFixture();
  addCuratedProductFixture(fixture);
  try {
    return fixture.db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all()
      .flatMap(({ name, sql }) => {
        const rows = fixture.db.prepare(`SELECT * FROM ${name}`).all();
        return [
          { sql, params: [] },
          ...rows.map((row) => ({
            sql: `INSERT INTO ${name} VALUES (${Object.keys(row)
              .map(() => "?")
              .join(",")})`,
            params: Object.values(row),
          })),
        ];
      });
  } finally {
    fixture.db.close();
  }
}

export function addCuratedProductFixture(fixture) {
  const { db, checkpoint, entity } = fixture;
  db.exec(`INSERT INTO publication_read_entities (candidate_id,kind,entity_id,product_id,from_id,to_id,relationship_kind) VALUES
    ('candidate_native','products','product_native',NULL,NULL,NULL,NULL),
    ('candidate_native','releases','release_native','product_native',NULL,NULL,NULL),
    ('candidate_native','distribution_contexts','context_native',NULL,NULL,NULL,NULL),
    ('candidate_native','product_relationships','relationship_native',NULL,'printing_monk','product_native','printing-product');`);
  checkpoint("product_reduction:riftbound", {
    stage: "complete",
    result: { products: 1, distribution_contexts: 1, product_relationships: 1 },
  });
  checkpoint("official_errata", { errataComplete: true, productGames: ["riftbound"], prior: { priorProducts: {} } });
  entity("candidate_product_result_riftbound_products", {
    id: "product_native",
    game: "riftbound",
    name: "Official product",
    reference: { kind: "official_code", value: "OGN" },
    official_code: "OGN",
    releases: [
      {
        id: "release_native",
        product_id: "product_native",
        event_key: "event_native",
        region: null,
        date: { precision: "quarter", value: "2027-Q1" },
        status: "announced",
      },
    ],
  });
  entity("candidate_product_result_riftbound_distribution_contexts", {
    id: "context_native",
    game: "riftbound",
    label: "Official context",
    kind: "promotion",
  });
  entity("candidate_product_result_riftbound_product_relationships", {
    id: "relationship_native",
    game: "riftbound",
    kind: "printing-product",
    from: { type: "printing", id: "printing_monk" },
    to: { type: "product", id: "product_native" },
    observed: false,
    evidence_category: "official",
    curated_provenance: [{ reviewed_source_value: "present" }],
  });
}

export function removeCuratedProductCheckpoint(f) {
  f.db.exec("DELETE FROM reconciliation_checkpoints WHERE phase='product_reduction:riftbound'");
}
export function corruptCuratedProduct(f) {
  f.db.exec(
    "UPDATE reconciliation_reducer_state SET sha256='invalid' WHERE namespace='candidate_product_result_riftbound_products'",
  );
}
export function wrongGameCuratedProduct(f) {
  f.db.exec("DELETE FROM reconciliation_reducer_state WHERE namespace='candidate_product_result_riftbound_products'");
  f.entity("candidate_product_result_riftbound_products", { id: "product_native", game: "gundam" }, 1);
}
export function addCuratedErratumMembership(f) {
  f.db.exec(
    "INSERT INTO publication_read_entities (candidate_id,kind,entity_id) VALUES ('candidate_native','errata','erratum_native')",
  );
}
