import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { build } from "esbuild";
import { readWorkerConfig } from "../cli/lib/config.mjs";
import {
  applyMigrations,
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
  waitForAdministrationDocument,
} from "./helpers/acceptance-runtime.mjs";
import { nativeCheckpointTransport, publishNativeCollection } from "./helpers/native-catalogue-runtime.mjs";
import { isNativeCheckpointRequest } from "./helpers/native-checkpoint-hosts.mjs";
import { verifiedBackupApiState } from "./helpers/verified-backup-api-state.mjs";
import {
  readPokemonProfilePredecessor,
  installPokemonProfilePredecessor,
} from "./helpers/pokemon-profile-predecessor.mjs";
import { d1Adapter } from "./helpers/query-helpers/sqlite-d1-adapter.mjs";
import * as queries from "./helpers/query-helpers/pokemon-profile-transition.mjs";
import { schemaMigrationLevel } from "./helpers/query-helpers/schema.mjs";

const bundle = await build({
  stdin: {
    contents: [
      'export { initializeReconciliationProgress } from "./src/catalogue/reconciliation/reconciliation-progress";',
      'export { assertCurrentCardModel } from "./src/catalogue/reconciliation/card-model-definition";',
      'export { publicationPreparationGuard } from "./src/catalogue/reconciliation/publication-preparation-repository";',
      'export { catalogueStore } from "./src/catalogue/shared/catalogue-store-repository";',
    ].join("\n"),
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const withoutLinks = (value) => JSON.parse(JSON.stringify(value, (key, item) => (key === "links" ? undefined : item)));

function immutablePokemonHistory(database) {
  return [
    { kind: "admission", rows: queries.pokemonAdmissionHistory(database).all() },
    { kind: "observations", rows: queries.pokemonObservationHistory(database).all() },
    { kind: "snapshots", rows: queries.pokemonSnapshotHistory(database).all() },
    { kind: "published_exports", rows: queries.pokemonPublishedExportHistory(database).all() },
  ];
}

test("actual old Pokémon definitions preserve published history and require fresh unfinished preparation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-pokemon-profile-transition-"));
  const statePath = join(directory, "state"),
    key = crypto.randomUUID();
  let ingestion,
    api,
    passed = false;
  t.after(async () => {
    if (api) await stopWorker(api);
    if (ingestion) await stopWorker(ingestion);
    if (passed) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained Pokémon profile transition: ${directory}`);
  });
  const fixture = await readPokemonProfilePredecessor();
  const frozen = fixture.current;

  // Inspect the real sealed predecessor at its captured clock. This is a guard
  // eligibility check, not publication of an expired fixture or receipt rewrite.
  const sealedPath = join(directory, "old-sealed.sqlite");
  await writeFile(sealedPath, Buffer.from(fixture.states.sealed.database, "base64"));
  const sealedDb = new DatabaseSync(sealedPath);
  try {
    const row = queries.candidateDefinition(sealedDb).get(fixture.states.sealed.candidate.id);
    const sealedHistory = immutablePokemonHistory(sealedDb);
    assert.equal(schemaMigrationLevel(sealedDb).get().migration_level, fixture.schema);
    for (const name of ["0038_source_archives.sql", "0039_source_parent_context.sql"]) {
      sealedDb.exec("BEGIN");
      sealedDb.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      sealedDb.exec("COMMIT");
    }
    assert.equal(schemaMigrationLevel(sealedDb).get().migration_level, 39);
    assert.deepEqual(immutablePokemonHistory(sealedDb), sealedHistory);
    assert.deepEqual(queries.foreignKeyViolations(sealedDb).all(), []);
    const store = runtime.catalogueStore(d1Adapter(sealedDb));
    assert.equal(row.state, "sealed");
    await runtime.assertCurrentCardModel(store, row.id);
    assert.ok(
      await runtime
        .publicationPreparationGuard(store, row.id, row.manifest_digest, row.generation, fixture.captured_at)
        .first(),
    );
    assert.deepEqual(queries.candidateDefinition(sealedDb).get(row.id), row);
  } finally {
    sealedDb.close();
  }

  const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  delete config.$schema;
  config.main = resolve("apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  const databasePath = await installPokemonProfilePredecessor(statePath, configPath, fixture, "preparing");
  let pending, history, exportReceipts;
  const before = new DatabaseSync(databasePath);
  try {
    pending = queries.candidateDefinition(before).get(fixture.states.preparing.candidate.id);
    assert.equal(pending.state, "preparing");
    assert.equal(pending.definition_pins_json, fixture.states.preparing.candidate.definition_pins_json);
    history = immutablePokemonHistory(before);
    exportReceipts = queries.pokemonExportReceipts(before).all();
    await assert.rejects(
      runtime.initializeReconciliationProgress(
        runtime.catalogueStore(d1Adapter(before)),
        pending.id,
        fixture.captured_at,
      ),
      (error) => error.status === 409 && error.code === "reconciliation_definition_changed",
    );
    assert.deepEqual(queries.candidateDefinition(before).get(pending.id), pending);
    assert.deepEqual(immutablePokemonHistory(before), history);
  } finally {
    before.close();
  }
  await applyMigrations(statePath, configPath);
  const migrated = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(schemaMigrationLevel(migrated).get().migration_level, 44);
    assert.deepEqual(queries.candidateDefinition(migrated).get(pending.id), pending);
    assert.deepEqual(immutablePokemonHistory(migrated), history);
    assert.deepEqual(queries.foreignKeyViolations(migrated).all(), []);
  } finally {
    migrated.close();
  }
  const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
  ingestion = await startWorker({
    ...checkpoint,
    config: configPath,
    statePath,
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: key, SOURCE_HOST_PACING_MODE: "immediate" },
    outboundService: (request) => {
      assert.ok(isNativeCheckpointRequest(request), `Retained-evidence preparation must not fetch ${request.url}`);
      return checkpoint.outboundService(request);
    },
  });
  await waitForHealth(`${ingestion.url}/health`, key, ingestion);
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  const environment = {
    KEEPR_INGESTION_URL: ingestion.url,
    KEEPR_ADMINISTRATION_KEY: key,
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "2200",
  };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 10, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const get = async (path) => {
    const response = await fetch(`${api.url}${path}`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const verifyExport = async (revision, expected) => {
    const records = { cards: [], printings: [], products: [], errata: [] };
    let after;
    do {
      const index = await get(`/v1/catalogue-exports/${revision}${after ? `?after=${encodeURIComponent(after)}` : ""}`);
      for (const component of index.data.components) {
        const receipt = exportReceipts.find(
          (entry) => entry.revision_id === revision && entry.sha256 === component.compressed_sha256,
        );
        assert.ok(receipt, `No original receipt for ${revision}/${component.name}`);
        const original = fixture.objects.find(
          (object) => object.key === receipt.object_key && object.sha256 === receipt.sha256,
        );
        assert.ok(original);
        const response = await fetch(index.links.components[component.name], {
          headers: { authorization: `Bearer ${key}` },
        });
        assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.deepEqual(bytes, Buffer.from(original.bytes, "base64"));
        assert.equal(bytes.length, component.compressed_bytes);
        assert.equal(sha(bytes), component.compressed_sha256);
        const raw = gunzipSync(bytes);
        assert.equal(sha(raw), component.content_sha256);
        const values = raw
          .toString("utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        assert.equal(values.length, component.records);
        if (component.kind in records) records[component.kind].push(...values);
      }
      after = index.data.page.next_cursor;
    } while (after);
    assert.deepEqual(records, expected);
  };
  const verifyReads = async () => {
    for (const suffix of ["", `&revision=${frozen.revision}`]) {
      const cards = (await get(`/v1/cards?game=pokemon${suffix}`)).data;
      assert.deepEqual(cards.map((card) => card.id).sort(), frozen.cards.map((card) => card.id).sort());
      assert.deepEqual(
        withoutLinks((await get(`/v1/printings?game=pokemon${suffix}`)).data),
        withoutLinks(frozen.printings),
      );
      assert.deepEqual(
        withoutLinks((await get(`/v1/products?game=pokemon${suffix}`)).data),
        withoutLinks(frozen.products),
      );
    }
    for (const card of frozen.cards)
      assert.deepEqual(withoutLinks((await get(`/v1/cards/${card.id}`)).data), withoutLinks(card));
    for (const original of frozen.original_exported.cards) {
      const card = (await get(`/v1/cards/${original.id}?revision=${frozen.original_revision}`)).data;
      assert.equal(card.effective_rules_text, original.effective_rules_text);
      assert.deepEqual(card.game_data, original.game_data);
    }
    for (const printing of (await get("/v1/printings?game=pokemon")).data) {
      for (const image of printing.printing_images) {
        const original = fixture.objects.find(
          (object) => object.binding === "PRINTING_IMAGES" && object.sha256 === image.content_sha256,
        );
        assert.ok(original);
        const response = await fetch(image.links.content, { headers: { authorization: `Bearer ${key}` } });
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(original.bytes, "base64"));
      }
    }
    await verifyExport(frozen.original_revision, frozen.original_exported);
    await verifyExport(frozen.revision, frozen.exported);
  };
  await verifyReads();
  await cli([
    "game-candidate",
    "pause",
    "--candidate-id",
    pending.id,
    "--generation",
    String(pending.generation),
    "--idempotency-key",
    "old-profile-pause",
    "--yes",
  ]);
  const paused = await waitForAdministrationDocument(
    `/v1/game-candidates/${pending.id}`,
    (document) => document.state === "paused",
    environment,
    ingestion,
  );
  await cli([
    "game-candidate",
    "abandon",
    "--candidate-id",
    pending.id,
    "--generation",
    String(paused.generation),
    "--idempotency-key",
    "old-profile-abandon",
    "--yes",
  ]);
  const accepted = await cli([
    "game-candidate",
    "prepare",
    "--run-id",
    pending.ingestion_run_id,
    "--game",
    "pokemon",
    "--expected-game-revision-id",
    frozen.revision,
    "--idempotency-key",
    "new-profile-prepare",
    "--yes",
  ]);
  const candidate = await waitForAdministrationDocument(
    `/v1/game-candidates/${accepted.id}`,
    (document) =>
      document.state === "sealed" || (["failed", "paused"].includes(document.state) ? JSON.stringify(document) : false),
    environment,
    ingestion,
    { deadlineMs: 120000 },
  );
  assert.equal(candidate.state, "sealed");
  const preparedDb = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const fresh = queries.candidateDefinition(preparedDb).get(candidate.id);
    assert.notEqual(fresh.definition_pins_json, pending.definition_pins_json);
    assert.equal(
      queries.candidateDefinition(preparedDb).get(pending.id).definition_pins_json,
      pending.definition_pins_json,
    );
  } finally {
    preparedDb.close();
  }
  const publication = await publishNativeCollection(
    { candidates: [candidate] },
    "pokemon-profile-transition",
    environment,
    ingestion,
    120000,
  );
  assert.equal(publication.state, "published");
  assert.equal(publication.checkpoint.state, "verified");
  await verifyReads();
  await stopWorker(api);
  await stopWorker(ingestion);
  const imports = (await readdir(directory)).filter((name) => /^restore-\d+\.sqlite$/u.test(name));
  assert.ok(imports.length > 0, "Fresh approval produced an actual independently imported SQL checkpoint");
  const restored = await verifiedBackupApiState(statePath, directory);
  const restoredDb = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const retained = immutablePokemonHistory(restoredDb);
    for (const previous of history) {
      const current = retained.find((entry) => entry.kind === previous.kind);
      for (const row of previous.rows)
        assert.ok(
          current.rows.some((value) => JSON.stringify(value) === JSON.stringify(row)),
          previous.kind,
        );
    }
    assert.equal(
      queries.candidateDefinition(restoredDb).get(pending.id).definition_pins_json,
      pending.definition_pins_json,
    );
    assert.deepEqual(queries.foreignKeyViolations(restoredDb).all(), []);
  } finally {
    restoredDb.close();
  }
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath: restored, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  await verifyReads();
  passed = true;
});
