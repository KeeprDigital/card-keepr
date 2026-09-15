import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "vite";
import { d1Adapter } from "./helpers/query-helpers/sqlite-d1-adapter.mjs";
import {
  seedRows,
  schemaObjectRows,
  schemaMigrationLevel,
  setUnexpectedSchemaLevel,
  foreignKeyViolations,
} from "./helpers/query-helpers/schema.mjs";
import * as queries from "./helpers/query-helpers/curated-evidence-migration.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

test("Curated retention and archive migrations preserve acknowledged dependencies, history and tombstones", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const root = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(root))
    .filter((name) => name.endsWith(".sql") && Number.parseInt(name, 10) < 37)
    .sort()) {
    database.exec("BEGIN");
    database.exec(await readFile(new URL(name, root), "utf8"));
    database.exec("COMMIT");
  }
  assert.equal(schemaMigrationLevel(database).get().migration_level, 36);
  const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true } });
  t.after(() => vite.close());
  const { seedRunFixtureStatement } = await vite.ssrLoadModule("/apps/ingestion/test/query-helpers/run-events.ts");
  const evidence = await vite.ssrLoadModule("/apps/ingestion/test/query-helpers/curated-evidence.ts");
  const curated = await vite.ssrLoadModule("/apps/ingestion/test/query-helpers/curated.ts");
  const owner = await vite.ssrLoadModule("/src/catalogue/curated/curated-repository.ts");
  const { catalogueStore, canonicalJson } = await vite.ssrLoadModule("/src/catalogue/shared/index.ts");
  const db = d1Adapter(database),
    store = catalogueStore(db);
  const keys = [];
  for (const status of ["active", "superseded", "retired", "uncited"]) {
    const run = `historical-${status}`,
      identity = digest(run),
      set = `srcobsset_${identity}`;
    const raw = `source-snapshots/${run}`,
      manifest = `source-observations/${run}`;
    if (status !== "uncited") keys.push(raw, manifest);
    await seedRunFixtureStatement(db, {
      id: run,
      state: "failed",
      failure_code: "fixture",
      idempotency_key: run,
      started_at: "2026-08-01T00:00:00.000Z",
      terminal_at: "2026-08-01T00:00:00.000Z",
    }).run();
    await db.batch([
      evidence.curatedEvidenceRequest(db).bind(run, run, "https://owner.example/source"),
      evidence.curatedEvidenceFetch(db).bind(run, run, run),
      evidence
        .curatedEvidenceSnapshot(db)
        .bind(run, run, run, run, "https://owner.example/source", digest(run), 1, raw),
    ]);
    queries.finalizedCuratedParse(database).run(run, run, run, set, manifest, digest(run));
    queries.sealedCuratedSet(database).run(set, run, run, digest(run), manifest);
    queries.historicalCleanup(database).run(run, run, run);
    if (status === "uncited") continue;
    // These reclamations happened before the closure fix, while old Curated rows had no pins.
    if (status !== "active")
      queries
        .historicalTombstone(database)
        .run(
          raw,
          run,
          status === "retired" ? "deleted" : "reserved",
          status === "retired" ? "2026-09-08T00:00:00.000Z" : null,
        );
    const proposal = canonicalJson({
      game: "one-piece",
      target: { kind: "field", entity_type: "card", entity_id: run, path: "/name" },
      assertion: { kind: "field", value: "Reviewed name" },
      rationale: "Historical evidence review",
      evidence: [{ kind: "source_observation", id: `srcobs_${identity}_1` }],
      effective_interval: { from: null, to: null },
      reviewed_source_digest: digest("source"),
      supersedes_revision_id: null,
      "": "retained extension",
    });
    const receipt = canonicalJson({
      operation_id: `curop_${digest(run).slice(0, 32)}`,
      curated_revision_id: run,
      status: "active",
      event_version: 1,
      content_digest: digest(proposal),
      current_catalogue_revision_id: "catrev_spine_000",
      code: "curated_revision_created",
    });
    await curated
      .insertCuratedRevisions(db)
      .bind(
        run,
        run,
        proposal,
        digest(proposal),
        digest("source"),
        canonicalJson({ catalogue_revision_id: "catrev_spine_000", game_profile: "one-piece@1" }),
        "2026-08-01T00:00:00.000Z",
      )
      .run();
    if (status !== "active") await evidence.historicalCuratedStatus(db).bind(status, run).run();
    await owner
      .insertCuratedAuthoredEventStatement(store, {
        revisionId: run,
        eventJson: canonicalJson({ reviewed_source_digest: digest("source") }),
        observedAt: "2026-08-01T00:00:00.000Z",
      })
      .run();
    await owner
      .insertCuratedCreationResponseStatement(store, {
        idempotencyKey: run,
        requestDigest: digest(run),
        documentJson: receipt,
        observedAt: "2026-08-01T00:00:00.000Z",
      })
      .run();
  }
  assert.deepEqual(queries.retainedCuratedKeys(database).all(), []);
  const history = seedRows(database);
  let migration = await readFile(new URL("0037_curated_evidence_retention.sql", root), "utf8");
  database.exec("BEGIN");
  database.exec(migration);
  database.exec("COMMIT");
  assert.equal(schemaMigrationLevel(database).get().migration_level, 37);
  assert.deepEqual(seedRows(database), history);
  assert.deepEqual(
    queries
      .retainedCuratedKeys(database)
      .all()
      .map((row) => row.object_key),
    keys.sort(),
  );
  assert.deepEqual(foreignKeyViolations(database).all(), []);
  const retained = queries.retainedCuratedKeys(database).all();
  const retentionView = schemaObjectRows(database)
    .all()
    .find(({ name }) => name === "evidence_cleanup_retained_snapshots");
  migration = await readFile(new URL("0038_source_archives.sql", root), "utf8");
  database.exec("BEGIN");
  database.exec(migration);
  database.exec("COMMIT");
  assert.equal(schemaMigrationLevel(database).get().migration_level, 38);
  assert.deepEqual(seedRows(database), history);
  assert.deepEqual(queries.retainedCuratedKeys(database).all(), retained);
  assert.deepEqual(
    schemaObjectRows(database)
      .all()
      .find(({ name }) => name === "evidence_cleanup_retained_snapshots"),
    retentionView,
  );
  assert.deepEqual(foreignKeyViolations(database).all(), []);
  setUnexpectedSchemaLevel(database).run();
  const before = schemaObjectRows(database).all();
  database.exec("BEGIN");
  assert.throws(() => database.exec(migration), /malformed JSON/u);
  database.exec("ROLLBACK");
  assert.deepEqual(schemaObjectRows(database).all(), before);
  assert.equal(schemaMigrationLevel(database).get().migration_level, 99);
  assert.deepEqual(seedRows(database), history);
});
