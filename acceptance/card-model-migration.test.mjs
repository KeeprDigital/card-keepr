import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as httpValidators from "../test/support/http-response-validators.mjs";
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
import { nativeExportReader } from "./helpers/native-export-reader.mjs";
import { verifiedBackupApiState } from "./helpers/verified-backup-api-state.mjs";
import { installCardModelPredecessor } from "./helpers/card-model-predecessor.mjs";
import * as queries from "./helpers/query-helpers/card-model-migration.mjs";

test("populated category migration preserves history and permits sequential refresh with real checkpoints", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-card-model-migration-"));
  const statePath = join(directory, "state"),
    key = crypto.randomUUID();
  const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  delete config.$schema;
  config.main = resolve("acceptance/fixtures/native-retained-evidence-harness.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  config.ratelimits.find(({ name }) => name === "ADMINISTRATION_RATE_LIMIT").simple.limit = 500;
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  let api,
    ingestion,
    passed = false;
  t.after(async () => {
    if (api) await stopWorker(api);
    if (ingestion) await stopWorker(ingestion);
    if (passed) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained migration proof: ${directory}`);
  });
  const { fixture, databasePath } = await installCardModelPredecessor(statePath, configPath);
  const beforeDb = new DatabaseSync(databasePath, { readOnly: true });
  let before, oldIndex;
  try {
    assert.deepEqual(
      { ...queries.candidateState(beforeDb).get(fixture.pending.id) },
      {
        state: fixture.pending.state,
        generation: fixture.pending.generation,
        manifest_digest: fixture.pending.manifest_digest,
      },
    );
    before = queries
      .immutableHistoryStatements(beforeDb)
      .map(({ table, statement }) => ({ table, rows: statement.all() }));
    oldIndex = queries.nativeReadEntities(beforeDb).all();
  } finally {
    beforeDb.close();
  }
  await applyMigrations(statePath, configPath);
  const token = fixture.records.riftbound.cards.find((card) => card.game_data.attributes.supertypes.includes("token"));
  let readinessIndexes;
  const migrated = new DatabaseSync(databasePath);
  try {
    assert.deepEqual(
      queries.immutableHistoryStatements(migrated).map(({ table, statement }) => ({ table, rows: statement.all() })),
      before,
    );
    assert.deepEqual(queries.foreignKeys(migrated).all(), []);
    assert.deepEqual(
      queries
        .nativeReadEntities(migrated)
        .all()
        .map(({ category, ...row }) => row),
      oldIndex.map((row) => ({ ...row })),
    );
    assert.throws(() => queries.changeNativeCategory(migrated).run(), /publication_read_immutable/u);
    assert.equal(queries.nativeCategory(migrated).get(token.id).category, "token");
    readinessIndexes = queries.readinessIndexes(migrated).all();
    assert.equal(readinessIndexes.length, 2);
  } finally {
    migrated.close();
  }
  const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
  ingestion = await startWorker({
    ...checkpoint,
    config: configPath,
    statePath,
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: key, SOURCE_HOST_PACING_MODE: "immediate" },
    outboundService: (request) =>
      isNativeCheckpointRequest(request)
        ? checkpoint.outboundService(request)
        : Response.json(fixture.sources[new URL(request.url).pathname.slice(1)]),
  });
  await waitForHealth(`${ingestion.url}/health`, key, ingestion);
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  const environment = { KEEPR_INGESTION_URL: ingestion.url, KEEPR_ADMINISTRATION_KEY: key };
  const rawCli = (args) => runCli([...args, "--json"], environment);
  const cli = async (args) => {
    const result = await rawCli(args);
    assert.equal(
      result.code,
      args[0] === "game-candidate" && ["prepare", "pause", "resume", "abandon"].includes(args[1]) ? 10 : 0,
      result.stdout + result.stderr,
    );
    return JSON.parse(result.stdout);
  };
  const inspectPartitions = async (candidate) => {
    const records = {},
      changes = [];
    let after;
    do {
      const page = await cli([
        "game-candidate",
        "partitions",
        "--candidate-id",
        candidate.id,
        "--manifest",
        candidate.manifest_digest,
        ...(after ? ["--after", after] : []),
      ]);
      assert.equal(page.candidate.id, candidate.id);
      assert.equal(page.candidate.manifest_digest, candidate.manifest_digest);
      for (const partition of page.partitions) {
        const content = await cli([
          "game-candidate",
          "partition",
          "--candidate-id",
          candidate.id,
          "--manifest",
          candidate.manifest_digest,
          "--ordinal",
          String(partition.ordinal),
        ]);
        const validate =
          httpValidators[
            httpValidators.responseValidators[
              "admin get /v1/game-candidates/{candidate}/partitions/{ordinal} 200 application/json"
            ]
          ];
        assert.equal(validate(content), true, JSON.stringify(validate.errors));
        assert.equal(content.manifest_digest, candidate.manifest_digest);
        assert.equal(content.expected_game_revision_id, candidate.expected_game_revision_id);
        assert.equal(content.card_model, candidate.id === fixture.pending.id ? "pre_categories" : "categories");
        assert.equal(content.predecessor_card_model, "pre_categories");
        if (
          content.card_model === "categories" &&
          ["cards", "printings"].includes(content.kind) &&
          content.records.length
        ) {
          const incomplete = structuredClone(content);
          delete incomplete.records[0].gameplay_applicability;
          assert.equal(validate(incomplete), false, "Current candidate facts must retain their required model fields.");
        }
        if (content.kind === "inspection") changes.push(...content.records);
        else (records[content.kind] ??= []).push(...content.records);
      }
      after = page.next_cursor;
    } while (after);
    return { records, changes };
  };
  const retained = await inspectPartitions(fixture.pending);
  assert.deepEqual(retained.records.cards, fixture.records.riftbound.cards);
  assert.deepEqual(retained.records.printings, fixture.records.riftbound.printings);
  const retainedDocument = async (path, route) => {
    const response = await fetch(`${ingestion.url}${path}`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    const document = await response.json();
    const validate = httpValidators[httpValidators.responseValidators[`admin get ${route} 200 application/json`]];
    assert.equal(validate(document), true, JSON.stringify(validate.errors));
    return document;
  };
  let inputAfter;
  do {
    const page = await retainedDocument(
      `/v1/game-candidates/${fixture.pending.id}/inputs${inputAfter ? `?after=${encodeURIComponent(inputAfter)}` : ""}`,
      "/v1/game-candidates/{candidate}/inputs",
    );
    for (const partition of page.partitions)
      await retainedDocument(
        `/v1/game-candidates/${fixture.pending.id}/inputs/${partition.ordinal}`,
        "/v1/game-candidates/{candidate}/inputs/{ordinal}",
      );
    inputAfter = page.next_cursor;
  } while (inputAfter);
  for (const kind of ["identity", "admission", "correction", "curated"]) {
    let after;
    do {
      const query = new URLSearchParams({ manifest: fixture.pending.manifest_digest, ...(after ? { after } : {}) });
      const page = await retainedDocument(
        `/v1/game-candidates/${fixture.pending.id}/inspection/evidence/${kind}?${query}`,
        "/v1/game-candidates/{candidate}/inspection/evidence/{kind}",
      );
      after = page.next_cursor;
    } while (after);
  }
  const request = (path, options = {}) =>
    fetch(`${api.url}${path}`, { ...options, headers: { authorization: `Bearer ${key}`, ...options.headers } });
  const get = async (path) => {
    const response = await request(path);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const oldRevision = fixture.publications.at(-1).resulting_revision_id;
  const unavailable = async (revision) => {
    for (const path of ["/v1/cards", "/v1/printings", `/v1/cards/${token.id}`, `/v1/catalogue-exports/${revision}`]) {
      const response = await request(path, { headers: { "if-none-match": "*" } });
      assert.equal(response.status, 503, `${path}: ${await response.text()}`);
    }
  };
  await unavailable(oldRevision);
  const cursor = await request(`/v1/cards?limit=1&after=${encodeURIComponent(fixture.cursorPage.page.next_cursor)}`);
  assert.equal(cursor.status, 409);
  assert.ok((await cursor.json()).links.collection.endsWith("/v1/cards"));
  const legacyCursor = Buffer.from(
    JSON.stringify({
      contract: "card-keepr-card-cursor@1",
      route: "/v1/cards",
      order: "game,official_identity.kind,official_identity.value,id",
      revision_id: oldRevision,
      filters: { q: null, game: null, cardNumber: null, productId: null, rarity: null, attributes: {}, limit: 1 },
      after: {
        game: "one-piece",
        identity_kind: "card_number",
        identity_value: "OP01-001",
        id: fixture.records["one-piece"].cards[0].id,
      },
    }),
  ).toString("base64url");
  const legacyStale = await request(`/v1/cards?limit=1&after=${legacyCursor}`);
  assert.equal(legacyStale.status, 409);
  assert.ok((await legacyStale.json()).links.collection.endsWith("/v1/cards"));
  const componentPath = `/v1/catalogue-exports/${oldRevision}/components/${fixture.retainedComponent.name}`;
  const oldBytes = Buffer.from(fixture.retainedComponent.bytes, "base64");
  const component = await request(componentPath);
  assert.equal(component.status, 200);
  assert.deepEqual(Buffer.from(await component.arrayBuffer()), oldBytes);
  assert.equal(component.headers.get("etag"), `"${createHash("sha256").update(oldBytes).digest("hex")}"`);
  assert.equal((await request(componentPath, { method: "HEAD" })).status, 200);
  assert.equal(
    (await request(componentPath, { headers: { "if-none-match": fixture.retainedComponent.etag } })).status,
    304,
  );
  const ranged = await request(componentPath, { headers: { range: "bytes=0-7" } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), oldBytes.subarray(0, 8));
  const rejected = await rawCli([
    "publication-preparation",
    "start",
    "--candidate-id",
    fixture.pending.id,
    "--manifest-digest",
    fixture.pending.manifest_digest,
    "--generation",
    "0",
    "--sequence",
    "0",
    "--idempotency-key",
    "old-definition",
  ]);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stdout + rejected.stderr, /reconciliation_definition_changed/u);
  assert.equal(
    (
      await fetch(`${ingestion.url}/v1/game-candidates/${fixture.pending.id}/publication-preparation`, {
        headers: { authorization: `Bearer ${key}` },
      })
    ).status,
    404,
  );
  await cli([
    "game-candidate",
    "abandon",
    "--candidate-id",
    fixture.pending.id,
    "--generation",
    "0",
    "--idempotency-key",
    "abandon-old-definition",
    "--yes",
  ]);
  // Link retained gameplay/token identities before regeneration makes their model current.
  for (const retained of [fixture.records["one-piece"].cards[0], token]) {
    const { id, ...card } = retained;
    const proposalPath = join(directory, `link-${id}.json`);
    const decisionPath = join(directory, `link-${id}-decision.json`);
    await writeFile(
      proposalPath,
      JSON.stringify({
        game: card.game,
        source_lineage: "owner",
        reference: `link-${id}`,
        content: { card },
        evidence: { attestation: "Synthetic inspection of the retained issued Card." },
        idempotency_key: `link-${id}`,
      }),
    );
    const proposal = await cli(["entity-proposal", "create", "--proposal", proposalPath, "--yes"]);
    await writeFile(
      decisionPath,
      JSON.stringify({
        card_id: id,
        expected_generation: "0",
        rationale: "The issued identity is unchanged after migration",
        idempotency_key: `decide-link-${id}`,
      }),
    );
    const linked = await cli([
      "entity-proposal",
      "link",
      "--proposal-id",
      proposal.id,
      "--decision",
      decisionPath,
      "--yes",
    ]);
    assert.equal(linked.history[0].decision.card.id, id);
    assert.equal(linked.history[0].decision.card.category, id === token.id ? "token" : "gameplay");
  }
  let publication, newGameplayId;
  for (const game of ["one-piece", "riftbound"]) {
    const prior = fixture.publications.find((entry) => entry.supported_game === game);
    // The missing token remains a retained Card, exercising regeneration of carried facts.
    if (game === "riftbound") {
      fixture.sources.riftbound.cards = fixture.sources.riftbound.cards.slice(0, 1);
      const { id: _id, ...card } = token;
      fixture.sources.riftbound.cards.push({
        card: {
          ...card,
          game_data: { ...card.game_data, attributes: { ...card.game_data.attributes, supertypes: [] } },
        },
        memberships: { products: [], distribution_contexts: [], source_buckets: ["category-pilot"] },
        completeness: {
          structurally_complete: true,
          required_surfaces_complete: true,
          partitions_complete: true,
          declared_record_count: 1,
          parsed_record_count: 1,
        },
      });
    }
    const planPath = join(directory, `${game}.json`);
    await writeFile(
      planPath,
      JSON.stringify({
        plans: [
          {
            supported_game: game,
            source_lineage: game === "riftbound" ? "riftbound-en" : "one-piece-en",
            adapter_version: `fixture-${game}-json@${game === "one-piece" ? 3 : 1}`,
            requests: [{ id: "discovery", url: `https://model-source.invalid/${game}` }],
          },
        ],
      }),
    );
    const run = await cli(["source", "collect", "--plan-file", planPath, "--idempotency-key", `refresh-${game}`]);
    const preparing = await cli([
      "game-candidate",
      "prepare",
      "--run-id",
      run.id,
      "--game",
      game,
      "--expected-game-revision-id",
      prior.resulting_revision_id,
      "--idempotency-key",
      `refresh-${game}`,
      "--yes",
    ]);
    const candidate = await waitForAdministrationDocument(
      `/v1/game-candidates/${preparing.id}`,
      (d) => d.state === "sealed" || (["failed", "paused"].includes(d.state) ? JSON.stringify(d) : false),
      environment,
      ingestion,
      { deadlineMs: 120000 },
    );
    const inspected = await inspectPartitions(candidate);
    for (const kind of ["cards", "printings"]) {
      const changes = inspected.changes.filter((change) => change.entity_class === kind);
      const historical = changes.filter((change) => change.before !== null).map((change) => change.before);
      assert.deepEqual(
        historical.sort((a, b) => a.id.localeCompare(b.id)),
        [...fixture.records[game][kind]].sort((a, b) => a.id.localeCompare(b.id)),
      );
      assert.ok(historical.every((record) => !Object.hasOwn(record, "gameplay_applicability")));
      assert.ok(
        changes
          .filter((change) => change.after !== null)
          .every((change) => change.after.gameplay_applicability === "applicable"),
      );
    }
    if (game === "riftbound") {
      const gameplay = inspected.records.cards.find((card) => card.category === "gameplay" && card.name === token.name);
      assert.ok(gameplay, "A gameplay Card may share the retained token's publisher identity.");
      assert.notEqual(gameplay.id, token.id);
      newGameplayId = gameplay.id;
    }
    assert.deepEqual(
      inspected.records.cards
        .map((card) => card.id)
        .filter((id) => id !== newGameplayId)
        .sort(),
      fixture.records[game].cards.map((card) => card.id).sort(),
    );
    assert.deepEqual(
      inspected.records.printings.map((printing) => printing.id).sort(),
      fixture.records[game].printings.map((printing) => printing.id).sort(),
    );
    assert.ok(
      inspected.records.cards.every(
        (card) =>
          ["gameplay", "token"].includes(card.category) &&
          card.gameplay_applicability === "applicable" &&
          Array.isArray(card.related_cards),
      ),
    );
    publication = await publishNativeCollection(
      { candidates: [candidate] },
      `regenerate-${game}`,
      environment,
      ingestion,
      120000,
    );
    if (game === "one-piece") await unavailable(publication.resulting_revision_id);
  }
  const cards = (await get("/v1/cards")).data;
  assert.equal(cards.length, 4);
  assert.equal(cards.find((card) => card.id === newGameplayId).category, "gameplay");
  assert.equal((await get("/v1/cards?category=token")).data[0].id, token.id);
  const reader = nativeExportReader(0);
  const records = await reader.records(api.url, key, publication.resulting_revision_id, "cards");
  assert.equal(records.find((card) => card.id === token.id).category, "token");
  await stopWorker(api);
  await stopWorker(ingestion);
  // This helper replaces the original binding file with the verified SQL import.
  const restored = await verifiedBackupApiState(statePath, directory);
  const restoredDatabase = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.deepEqual(queries.readinessIndexes(restoredDatabase).all(), readinessIndexes);
  } finally {
    restoredDatabase.close();
  }
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath: restored, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  assert.deepEqual(
    (await get("/v1/cards")).data.map(({ links, ...card }) => card),
    cards.map(({ links, ...card }) => card),
  );
  reader.clear();
  assert.deepEqual(await reader.records(api.url, key, publication.resulting_revision_id, "cards"), records);
  passed = true;
});
