import { readWorkerConfig } from "../cli/lib/config.mjs";
import { gunzipSync } from "node:zlib";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runCli, startWorker, stopWorker, waitForHealth } from "./helpers/acceptance-runtime.mjs";

// Synthetic publisher responses exercise the shipped native collection/preparation Workflows.
// The legacy publication acceptance harness is deliberately absent.
test("one owner CLI start verifies native artifacts without exposing any unfinished catalogue data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-native-preparation-"));
  const statePath = join(directory, "shared-state"),
    adminKey = randomUUID(),
    apiKey = randomUUID();
  const config = await readWorkerConfig(resolve("apps/ingestion/wrangler.jsonc"));
  delete config.$schema;
  config.main = resolve("apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  config.ratelimits[0].simple.limit = 300;
  config.services = [{ binding: "OFFICIAL_SOURCE_TRANSPORT", service: "card-keepr-synthetic-official-source" }];
  const configPath = join(directory, "ingestion.json"),
    adminEnv = join(directory, "admin.env"),
    apiEnv = join(directory, "api.env"),
    planPath = join(directory, "plan.json");
  await Promise.all([
    writeFile(configPath, JSON.stringify(config)),
    writeFile(adminEnv, `ADMINISTRATION_KEY=${adminKey}\n`, { mode: 0o600 }),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
    writeFile(
      planPath,
      JSON.stringify({
        plans: [
          {
            supported_game: "digimon",
            source_lineage: "digimon-en",
            adapter_version: "digimon-en@7",
            requests: [
              {
                id: "digimon-en:discovery",
                url: "https://world.digimoncard.com/cards/index.php?search=true",
                headers: {
                  accept: "text/html; card-keepr-digimon-scenario=card-keepr-acceptance-digimon/complete",
                  "user-agent": "card-keepr-acceptance-digimon/complete",
                },
              },
            ],
          },
        ],
      }),
    ),
  ]);
  const workers = [];
  t.after(async () => {
    for (const worker of workers) await stopWorker(worker);
    await rm(directory, { recursive: true, force: true });
  });
  const source = await startWorker({
    config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    statePath: join(directory, "source-state"),
  });
  workers.push(source);
  const ingestion = await startWorker({ config: configPath, envFile: adminEnv, statePath, migrate: true });
  workers.push(ingestion);
  await waitForHealth(`${ingestion.url}/health`, adminKey, ingestion);
  const api = await startWorker({ config: "apps/api/wrangler.jsonc", envFile: apiEnv, statePath });
  workers.push(api);
  await waitForHealth(`${api.url}/health`, apiKey, api);
  const environment = { KEEPR_INGESTION_URL: ingestion.url, KEEPR_ADMINISTRATION_KEY: adminKey };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const get = async (path) => {
    const response = await fetch(`${ingestion.url}${path}`, { headers: { authorization: `Bearer ${adminKey}` } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const consumer = async (path) => {
    const response = await fetch(`${api.url}${path}`, { headers: { authorization: `Bearer ${apiKey}` } });
    const body = await response.json();
    delete body.request_id;
    return { status: response.status, body };
  };
  const before = await consumer("/v1/cards?game=digimon");
  const run = await cli(["source", "collect", "--plan-file", planPath, "--idempotency-key", "native-artifact-source"]);
  await cli(["source", "resume", "--run-id", run.id]);
  let candidate;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const collection = await get(`/v1/ingestion-runs/${run.id}/game-candidates`);
    if (collection.candidates.length) {
      candidate = await get(`/v1/game-candidates/${collection.candidates[0].id}`);
      if (candidate.state !== "preparing") break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(candidate?.state, "sealed", JSON.stringify(candidate) + ingestion.getOutput());
  const args = [
    "publication-preparation",
    "start",
    "--candidate-id",
    candidate.id,
    "--manifest-digest",
    candidate.manifest_digest,
    "--generation",
    String(candidate.generation),
    "--sequence",
    "0",
    "--idempotency-key",
    "native-artifact-start",
  ];
  await cli(args);
  let status;
  const preparationDeadline = Date.now() + 30000;
  while (Date.now() < preparationDeadline) {
    status = await get(`/v1/game-candidates/${candidate.id}/publication-preparation`);
    if (status.state !== "preparing") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status?.state, "verified", JSON.stringify(status) + ingestion.getOutput());
  assert.equal(status.deadline, candidate.deadline);
  assert.equal(
    (await cli(["publication-preparation", "status", "--candidate-id", candidate.id])).root_digest,
    status.root_digest,
  );
  assert.deepEqual(await consumer("/v1/cards?game=digimon"), before);
  const partitions = await get(`/v1/game-candidates/${candidate.id}/partitions`);
  const cards = await get(
    `/v1/game-candidates/${candidate.id}/partitions/${partitions.partitions.find((part) => part.kind === "cards").ordinal}`,
  );
  assert.equal((await consumer(`/v1/cards/${cards.records[0].id}`)).status, 404);
  const images = partitions.partitions.find((part) => part.kind === "printing_images");
  if (images) {
    const page = await get(`/v1/game-candidates/${candidate.id}/partitions/${images.ordinal}`);
    assert.equal((await consumer(`/v1/printing-images/${page.records[0].id}/content`)).status, 404);
  }
  await cli(args);
  assert.equal(
    (await get(`/v1/game-candidates/${candidate.id}/publication-preparation`)).root_digest,
    status.root_digest,
  );
  const approval = await cli([
    "publication",
    "approve",
    "--candidate-id",
    candidate.id,
    "--manifest-digest",
    candidate.manifest_digest,
    "--expected-game-revision-id",
    candidate.expected_game_revision_id,
    "--generation",
    String(candidate.generation),
    "--idempotency-key",
    "native-publication",
  ]);
  let publication;
  const publicationDeadline = Date.now() + 30000;
  while (Date.now() < publicationDeadline) {
    publication = await cli(["publication", "status", "--operation-id", approval.id]);
    if (publication.state === "published" || publication.state === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(publication.state, "published", JSON.stringify(publication) + ingestion.getOutput());
  const visible = await consumer("/v1/cards?game=digimon&limit=1");
  assert.equal(visible.status, 200, JSON.stringify(visible));
  assert.equal(visible.body.meta.catalogue_revision_id, publication.resulting_revision_id);
  assert.equal(visible.body.data.length, 1);
  assert.equal(visible.body.data[0].type, "card");
  const detail = await consumer(`/v1/cards/${cards.records[0].id}?include=printings`);
  assert.equal(detail.status, 200, JSON.stringify(detail));
  assert.equal(detail.body.data.name, cards.records[0].name);
  assert.ok(detail.body.included.length > 0);
  const rarity = detail.body.included.find((printing) => printing.rarity?.normalized)?.rarity.normalized;
  assert.ok(rarity, "Synthetic publisher provides a normalized Printing rarity.");
  const filteredCards = await consumer(`/v1/cards?game=digimon&rarity=${encodeURIComponent(rarity)}`);
  assert.equal(filteredCards.status, 200, JSON.stringify(filteredCards));
  assert.ok(filteredCards.body.data.some((card) => card.id === cards.records[0].id));
  const filteredPrintings = await consumer(`/v1/printings?game=digimon&rarity=${encodeURIComponent(rarity)}`);
  assert.equal(filteredPrintings.status, 200, JSON.stringify(filteredPrintings));
  assert.ok(filteredPrintings.body.data.some((printing) => printing.card_id === cards.records[0].id));

  assert.equal(
    (await consumer(`/v1/cards?game=digimon&q=${encodeURIComponent(cards.records[0].name)}`)).body.data.length > 0,
    true,
  );
  if (images) {
    const page = await get(`/v1/game-candidates/${candidate.id}/partitions/${images.ordinal}`);
    const image = await fetch(`${api.url}/v1/printing-images/${page.records[0].id}/content`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(image.status, 200);
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.equal(bytes.byteLength, page.records[0].content_byte_length);
    const range = await fetch(image.url, { headers: { authorization: `Bearer ${apiKey}`, range: "bytes=0-7" } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 8));
    const head = await fetch(image.url, { method: "HEAD", headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("etag"), image.headers.get("etag"));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const invalid = await fetch(image.url, {
      headers: { authorization: `Bearer ${apiKey}`, range: `bytes=${bytes.length}-` },
    });
    assert.equal(invalid.status, 416);
    assert.equal((await invalid.json()).code, "range_not_satisfiable");
  }
  assert.equal(
    (
      await cli([
        "publication",
        "approve",
        "--candidate-id",
        candidate.id,
        "--manifest-digest",
        candidate.manifest_digest,
        "--expected-game-revision-id",
        candidate.expected_game_revision_id,
        "--generation",
        String(candidate.generation),
        "--idempotency-key",
        "native-publication",
      ])
    ).id,
    approval.id,
  );

  const listing = await consumer("/v1/catalogue-exports");
  assert.equal(listing.status, 200, JSON.stringify(listing));
  assert.ok(listing.body.data.some((value) => value.catalogue_revision_id === publication.resulting_revision_id));
  if (visible.body.page.next_cursor) {
    const next = await consumer(
      `/v1/cards?game=digimon&limit=1&after=${encodeURIComponent(visible.body.page.next_cursor)}`,
    );
    assert.equal(next.status, 200, JSON.stringify(next));
    assert.notEqual(next.body.data[0].id, visible.body.data[0].id);
    const override = await consumer(
      `/v1/cards?game=digimon&limit=1&after=${encodeURIComponent(visible.body.page.next_cursor)}&revision=catrev_spine_000`,
    );
    assert.equal(override.status, 400);
  }
  assert.equal((await consumer("/v1/cards?game=digimon&attribute.not_defined=1")).status, 400);
  const exportPath = `/v1/catalogue-exports/${publication.resulting_revision_id}`;
  let componentCursor = null;
  const exportedCards = [];
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  const manifestSchema = JSON.parse(
    await readFile(resolve("contracts/schemas/catalogue-export-manifest-v5.schema.json"), "utf8"),
  );
  const recordSchema = JSON.parse(
    await readFile(resolve("contracts/schemas/catalogue-export-record-v5.schema.json"), "utf8"),
  );
  const validateManifest = ajv.compile(manifestSchema),
    validateRecord = ajv.compile(recordSchema);
  do {
    const index = await consumer(exportPath + (componentCursor ? `?after=${componentCursor}` : ""));
    assert.equal(index.status, 200, JSON.stringify(index));
    assert.equal(validateManifest(index.body.data), true, JSON.stringify(validateManifest.errors));
    const canonical = (value) =>
      Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, canonical(value[key])]),
            )
          : value;
    assert.equal(
      index.body.data.manifest_sha256,
      createHash("sha256")
        .update(JSON.stringify(canonical({ ...index.body.data, manifest_sha256: "0".repeat(64) })))
        .digest("hex"),
    );
    for (const component of index.body.data.components) {
      const contentUrl = index.body.links.components[component.name];
      const response = await fetch(contentUrl, { headers: { authorization: `Bearer ${apiKey}` } });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, component.compressed_bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), component.compressed_sha256);
      const raw = gunzipSync(bytes);
      assert.equal(raw.byteLength, component.uncompressed_bytes);
      assert.equal(createHash("sha256").update(raw).digest("hex"), component.content_sha256);
      const value = JSON.parse(raw);
      assert.equal(validateRecord(value), true, JSON.stringify(validateRecord.errors));
      if (component.kind === "cards") exportedCards.push(value);
      {
        const inspect = (value) => {
          if (!value || typeof value !== "object") return;
          for (const [key, item] of Object.entries(value)) {
            assert.ok(
              ![
                "source_lineage",
                "provenance",
                "source_url",
                "object_key",
                "legality",
                "eligibility",
                "candidate_id",
                "preparation_id",
                "ingestion_run_id",
              ].includes(key),
              key,
            );
            if (key !== "game_data") inspect(item);
          }
        };
        inspect(value);
      }
      const range = await fetch(contentUrl, {
        headers: { authorization: `Bearer ${apiKey}`, range: "bytes=0-7" },
      });
      assert.equal(range.status, 206);
      assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 8));
      const conditional = await fetch(contentUrl, {
        headers: { authorization: `Bearer ${apiKey}`, "if-none-match": response.headers.get("etag") },
      });
      assert.equal(conditional.status, 304);
    }
    componentCursor = index.body.data.page.next_cursor;
  } while (componentCursor);
  assert.deepEqual(
    exportedCards.find((card) => card.id === cards.records[0].id),
    Object.fromEntries(Object.entries(detail.body.data).filter(([key]) => !["printing_ids", "links"].includes(key))),
  );
});
