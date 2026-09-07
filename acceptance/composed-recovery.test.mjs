import { gunzipSync } from "node:zlib";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { proveNativePopulatedHandoff } from "./helpers/native-fresh-baseline.mjs";
import { nativeRecoveryCloudflare } from "./helpers/native-recovery-cloudflare.mjs";
import { persistedDatabaseDirectory, executeSql } from "./helpers/acceptance-runtime.mjs";
import { runCli, startWorker, stopWorker, waitForHealth } from "./helpers/acceptance-runtime.mjs";

// Synthetic publisher responses exercise the shipped native collection/preparation Workflows.
// The legacy publication acceptance harness is deliberately absent.
async function proveNativeComposition(t, proof) {
  const fetch = async (url, options) => {
    try {
      return await globalThis.fetch(url, options);
    } catch (cause) {
      throw new Error(`Local HTTP request failed: ${options?.method ?? "GET"} ${url}`, { cause });
    }
  };
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-native-preparation-"));
  const statePath = join(directory, "shared-state"),
    adminKey = randomUUID(),
    apiKey = randomUUID();
  const config = JSON.parse(await readFile(resolve("apps/ingestion/wrangler.jsonc"), "utf8"));
  delete config.$schema;
  config.main = resolve("acceptance/fixtures/cleanup-native-runtime.ts");
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
  let proofCompleted = false;
  const redact = (text) =>
    [adminKey, apiKey, "local-export", "local-verify"].reduce(
      (value, secret) => value.replaceAll(secret, "<REDACTED>"),
      text,
    );
  let releaseFirstExport, signalFirstExport, releaseFirstImport, signalFirstImport;
  t.after(async () => {
    releaseFirstExport?.();
    releaseFirstImport?.();
    for (const worker of workers) await stopWorker(worker);
    if (proofCompleted) await rm(directory, { recursive: true, force: true });
    else {
      await writeFile(
        join(directory, "failure-runtime.log"),
        redact(workers.map((worker) => worker.getOutput()).join("\n")),
      );
      await writeFile(adminEnv, "ADMINISTRATION_KEY=<REDACTED>\n");
      await writeFile(apiEnv, "API_BEARER_KEY=<REDACTED>\n");
      t.diagnostic(`Native failure state retained after runtime shutdown: ${directory}`);
    }
  });
  const source = await startWorker({
    config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    statePath: join(directory, "source-state"),
  });
  workers.push(source);
  const cloudflare = nativeRecoveryCloudflare({
    databaseDirectory: await persistedDatabaseDirectory(statePath),
    directory,
  });
  const firstExport = new Promise((resolve) => {
    signalFirstExport = resolve;
  });
  const firstExportRelease = new Promise((resolve) => {
    releaseFirstExport = resolve;
  });
  cloudflare.hooks.afterExport = async () => {
    cloudflare.hooks.afterExport = undefined;
    signalFirstExport();
    await firstExportRelease;
  };
  const firstImport = new Promise((resolve) => {
    signalFirstImport = resolve;
  });
  const firstImportRelease = new Promise((resolve) => {
    releaseFirstImport = resolve;
  });
  cloudflare.hooks.afterImport = async () => {
    cloudflare.hooks.afterImport = undefined;
    signalFirstImport();
    await firstImportRelease;
  };
  t.after(() => {
    releaseFirstExport();
    releaseFirstImport();
    cloudflare.close();
  });
  const ingestion = await startWorker({
    config: configPath,
    envFile: adminEnv,
    statePath,
    migrate: true,
    outboundService: async (request) => {
      try {
        return await cloudflare.fetch(request);
      } catch (error) {
        console.error(error);
        return Response.json({ success: false, errors: [{ message: error.message }] });
      }
    },
    vars: { D1_EXPORT_TOKEN: "local-export", D1_VERIFICATION_TOKEN: "local-verify" },
  });
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
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}\n${redact(ingestion.getOutput())}`);
    return response.json();
  };
  const consumer = async (path) => {
    const response = await fetch(`${api.url}${path}`, { headers: { authorization: `Bearer ${apiKey}` } });
    const body = await response.json();
    delete body.request_id;
    return { status: response.status, body };
  };
  const seededCleanupResponse = await fetch(`${ingestion.url}/acceptance/unused-cleanup-capture`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminKey}` },
  });
  assert.equal(seededCleanupResponse.status, 200);
  const cleanupFixture = await seededCleanupResponse.json();
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
  const initialGameRevision = publication.resulting_revision_id;
  await Promise.race([
    firstExport,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Native export did not start.")), 30000);
      timer.unref();
    }),
  ]);
  const duringExport = await fetch(`${ingestion.url}/v1/game-candidates`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      ingestion_run_id: run.id,
      supported_game: "digimon",
      expected_game_revision_id: initialGameRevision,
      idempotency_key: "blocked-during-export",
    }),
  });
  assert.equal(duringExport.status, 409);
  const unavailableSearch = await consumer("/v1/cards?game=digimon&q=Synthetic");
  assert.equal(unavailableSearch.status, 503, JSON.stringify(unavailableSearch));
  assert.equal(unavailableSearch.body.code, "catalogue_query_unavailable");
  releaseFirstExport();
  await firstImport;

  const visible = await consumer("/v1/cards?game=digimon&limit=1");
  assert.equal(visible.status, 200, JSON.stringify(visible));
  assert.equal(visible.body.meta.catalogue_revision_id, publication.resulting_revision_id);
  assert.equal(visible.body.data.length, 1);
  assert.equal(visible.body.data[0].type, "card");
  const detail = await consumer(`/v1/cards/${cards.records[0].id}?include=printings`);
  assert.equal(detail.status, 200, JSON.stringify(detail));
  assert.equal(detail.body.data.name, cards.records[0].name);
  assert.ok(detail.body.included.length > 0);
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
    assert.equal((await image.arrayBuffer()).byteLength, page.records[0].content_byte_length);
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

  const exportPath = `/v1/catalogue-exports/${publication.resulting_revision_id}`;
  let componentCursor = null;
  const exportedCards = [];
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  const manifestSchema = JSON.parse(
    await readFile(
      resolve("prototype/formalize-implementation-contracts/schemas/catalogue-export-manifest-v5.schema.json"),
      "utf8",
    ),
  );
  const recordSchema = JSON.parse(
    await readFile(
      resolve("prototype/formalize-implementation-contracts/schemas/catalogue-export-record-v5.schema.json"),
      "utf8",
    ),
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
  await Promise.race([
    firstImport,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Native import did not start.")), 30000);
      timer.unref();
    }),
  ]);
  const awaitCandidate = async (runId) => {
    const deadline = Date.now() + 30000;
    let candidate;
    do {
      const list = await get(`/v1/ingestion-runs/${runId}/game-candidates`);
      if (list.candidates.length) {
        candidate = await get(`/v1/game-candidates/${list.candidates.at(-1).id}`);
        if (candidate.state !== "preparing") return candidate;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail(JSON.stringify({ candidate, source: await get(`/v1/ingestion-runs/${runId}`) }));
  };
  const prepare = async (candidate, key) => {
    await cli([
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
      key,
    ]);
    const deadline = Date.now() + 30000;
    let result;
    do {
      result = await get(`/v1/game-candidates/${candidate.id}/publication-preparation`);
      if (result.state !== "preparing") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(result.state, "verified", JSON.stringify(result));
  };
  const approve = async (candidate, key) =>
    cli([
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
      key,
    ]);
  const awaitPublication = async (id, state) => {
    const deadline = Date.now() + 30000;
    let result;
    do {
      result = await get(`/v1/publications/${id}`);
      if (result.state === state) return result;
      assert.notEqual(result.state, "failed", JSON.stringify(result));
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail(JSON.stringify(result));
  };
  const onePiecePlan = join(directory, "onePiece-plan.json");
  await writeFile(
    onePiecePlan,
    JSON.stringify({
      plans: [
        {
          supported_game: "one-piece",
          source_lineage: "one-piece-en",
          adapter_version: "one-piece-en@6",
          requests: [
            {
              id: "one-piece-en:discovery",
              url: "https://en.onepiece-cardgame.com/cardlist/?series=569116",
              headers: { accept: "text/html", "user-agent": "card-keepr-one-piece-complete-v1" },
            },
          ],
        },
      ],
    }),
  );
  const onePieceRun = await cli([
    "source",
    "collect",
    "--plan-file",
    onePiecePlan,
    "--idempotency-key",
    "native-onePiece-source",
  ]);
  await cli(["source", "resume", "--run-id", onePieceRun.id]);
  const onePiece = await awaitCandidate(onePieceRun.id);
  assert.equal(onePiece.state, "sealed");
  await prepare(onePiece, "native-onePiece-artifacts");
  const onePieceApproval = await approve(onePiece, "native-onePiece-approval");
  const waiting = await awaitPublication(onePieceApproval.id, "waiting_backup");
  assert.equal(waiting.deadline, onePiece.deadline);
  assert.equal((await consumer("/v1/cards?game=one-piece")).body.data.length, 0);
  releaseFirstImport();
  const backupDeadline = Date.now() + 30000;
  let backup;
  while (Date.now() < backupDeadline) {
    backup = await get(`/v1/backups/${publication.backup_attempt_id}`);
    if (["verified", "failed"].includes(backup.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(backup?.state, "verified", JSON.stringify(backup) + ingestion.getOutput());
  publication = await awaitPublication(onePieceApproval.id, "published");
  const onePieceCards = (await consumer("/v1/cards?game=one-piece")).body.data;
  assert.ok(onePieceCards.length > 0);
  assert.equal((await consumer(`/v1/cards/${cards.records[0].id}`)).body.data.id, cards.records[0].id);
  const onePieceBackupDeadline = Date.now() + 30000;
  do {
    backup = await get(`/v1/backups/${publication.backup_attempt_id}`);
    if (["verified", "failed"].includes(backup.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < onePieceBackupDeadline);
  assert.equal(backup.state, "verified", JSON.stringify(backup));
  const cleanupIntent = await cli([
    "evidence-cleanup",
    "start",
    "--run-id",
    cleanupFixture.run,
    "--idempotency-key",
    "native-unused-cleanup",
  ]);
  let cleanupStatus;
  for (let i = 0; i < 100; i++) {
    cleanupStatus = await get(`/v1/evidence-cleanups/${cleanupIntent.id}`);
    if (cleanupStatus.state === "paused") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(cleanupStatus.failure_code, "evidence_cleanup_waiting_backup_retention");
  assert.equal(cleanupStatus.deleted_objects, 0);

  assert.equal(cloudflare.snapshots.length, 2);
  const mutate = async (args, env = environment) => {
    const full = [...args, "--environment", "production", "--yes", "--json"];
    const preview = await runCli(full, env);
    assert.equal(preview.code, 3, preview.stdout + preview.stderr);
    const confirmation = JSON.parse(preview.stdout).detail.match(/--confirm '(.+)'/)[1];
    const result = await runCli([...full, "--confirm", confirmation], env);
    assert.ok([0, 10].includes(result.code), result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const proposalFile = join(directory, "admission.json");
  const firstPrinting = detail.body.included.find((row) => row.type === "printing");
  assert.ok(firstPrinting);
  await writeFile(
    proposalFile,
    JSON.stringify({
      game: "digimon",
      source_lineage: "owner",
      reference: "synthetic-recovery-admission",
      content: {
        card: {
          game: "digimon",
          official_identity: { kind: "unknown", value: null },
          name: "Recovery admitted Digimon",
          effective_rules_text: null,
          game_data: detail.body.data.game_data,
        },
        printing: {
          rarity: { raw: null, normalized: null },
          printed_rules_text: null,
          game_data: firstPrinting.game_data,
        },
      },
      evidence: { attestation: "Synthetic fault fixture: owner inspected a distinct issued Printing" },
      idempotency_key: "native-recovery-proposal",
    }),
  );
  const proposal = await cli(["entity-proposal", "create", "--proposal", proposalFile, "--yes"]);
  await writeFile(
    proposalFile,
    JSON.stringify({
      expected_generation: "0",
      rationale: "Synthetic recovery admission proof",
      exception: {
        scope: ["identity"],
        attestation: "Synthetic owner inspection establishes the issued distinction",
      },
      idempotency_key: "native-recovery-admit",
    }),
  );
  const admitted = await cli([
    "entity-proposal",
    "admit",
    "--proposal-id",
    proposal.id,
    "--decision",
    proposalFile,
    "--yes",
  ]);
  assert.equal(admitted.history.length, 1);
  const correctionPrintings = (await consumer(`/v1/printings?card_id=${cards.records[0].id}`)).body.data;
  assert.ok(correctionPrintings.length > 1);
  const correctedPrintingId = correctionPrintings[1].id;
  const survivorPrintingId = correctionPrintings[0].id;
  const correctionProposal = {
    game: "digimon",
    entity_kind: "printing",
    action: "merge",
    source_ids: [correctedPrintingId],
    replacement_ids: [survivorPrintingId],
    printing_assignments: {},
    expected_current_revision_id: publication.resulting_revision_id,
    rationale: "Synthetic recovery proof of a reviewed duplicate",
    evidence: { attestation: "Synthetic owner review establishes the retained survivor" },
  };
  await writeFile(proposalFile, JSON.stringify(correctionProposal));
  const correctionReview = await cli(["identity-correction", "validate", "--proposal", proposalFile]);
  await writeFile(
    proposalFile,
    JSON.stringify({
      ...correctionProposal,
      review_digest: correctionReview.review_digest,
      idempotency_key: "native-recovery-correction",
    }),
  );
  const correction = await cli(["identity-correction", "create", "--proposal", proposalFile, "--yes"]);
  const correctionHistory = await cli(["identity-correction", "inspect", "--correction-id", correction.id]);

  const post = async (path, body) => {
    const response = await fetch(`${ingestion.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const document = await response.json();
    assert.ok(response.ok, JSON.stringify(document));
    return document;
  };
  let pending = await post("/v1/game-candidates", {
    ingestion_run_id: run.id,
    supported_game: "digimon",
    expected_game_revision_id: initialGameRevision,
    idempotency_key: "native-restored-pending",
  });
  const pendingDeadline = Date.now() + 30000;
  while (pending.state === "preparing" && Date.now() < pendingDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    pending = await get(`/v1/game-candidates/${pending.id}`);
  }
  assert.equal(pending.state, "sealed", JSON.stringify(pending));
  let pendingApproval = await post("/v1/publications", {
    candidate_id: pending.id,
    manifest_digest: pending.manifest_digest,
    expected_game_revision_id: initialGameRevision,
    generation: pending.generation,
    idempotency_key: "native-restored-approval",
  });
  await prepare(pending, "native-digimon-update-artifacts");
  await approve(pending, "native-restored-approval");
  publication = await awaitPublication(pendingApproval.id, "published");
  const updatedBackupDeadline = Date.now() + 30000;
  do {
    backup = await get(`/v1/backups/${publication.backup_attempt_id}`);
    if (["verified", "failed"].includes(backup.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < updatedBackupDeadline);
  assert.equal(backup.state, "verified", JSON.stringify(backup));
  assert.deepEqual(
    (await consumer("/v1/cards?game=one-piece")).body.data.map((card) => card.id),
    onePieceCards.map((card) => card.id),
  );
  const admittedCardId = admitted.history[0].decision.card.id;
  assert.equal((await consumer(`/v1/cards/${admittedCardId}`)).body.data.name, "Recovery admitted Digimon");
  assert.equal((await consumer("/v1/catalogue-exports")).body.data.length, 3);
  if (proof === "fresh baseline") {
    // A fourth native publication supplies an actually archived cursor while
    // retaining the current revision and its two verified predecessors.
    const fourthRun = await cli([
      "source",
      "collect",
      "--plan-file",
      onePiecePlan,
      "--idempotency-key",
      "native-fresh-fourth-source",
    ]);
    await cli(["source", "resume", "--run-id", fourthRun.id]);
    const fourth = await awaitCandidate(fourthRun.id);
    assert.equal(fourth.state, "sealed", JSON.stringify(fourth));
    await prepare(fourth, "native-fresh-fourth-artifacts");
    const fourthApproval = await approve(fourth, "native-fresh-fourth-approval");
    const fourthPublication = await awaitPublication(fourthApproval.id, "published");
    assert.equal(typeof fourthPublication.backup_attempt_id, "string", JSON.stringify(fourthPublication));
    const deadline = Date.now() + 30000;
    let fourthBackup;
    do {
      fourthBackup = await get(`/v1/backups/${fourthPublication.backup_attempt_id}`);
      if (["verified", "failed"].includes(fourthBackup.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(fourthBackup.state, "verified", JSON.stringify(fourthBackup));
    await proveNativePopulatedHandoff({
      t,
      directory,
      statePath,
      configPath,
      environment,
      sourceFile: cloudflare.sourceFile,
      consumer,
    });
    proofCompleted = true;
    return;
  }
  const correctedResponse = await consumer(`/v1/printings/${correctedPrintingId}`);
  assert.equal(correctedResponse.status, 200);
  assert.equal(correctedResponse.body.data.action, "merge");
  assert.deepEqual(correctedResponse.body.data.replacement_ids, [survivorPrintingId]);
  const retainedPublicExports = async (baseUrl, expectedCount = 3) => {
    const listing = await fetch(`${baseUrl}/v1/catalogue-exports`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(listing.status, 200);
    const exports = (await listing.json()).data;
    assert.equal(exports.length, expectedCount);
    const retained = [];
    for (const item of exports) {
      const pages = [],
        components = [];
      let after = null;
      do {
        const response = await fetch(
          `${baseUrl}/v1/catalogue-exports/${item.catalogue_revision_id}${after ? `?after=${after}` : ""}`,
          {
            headers: { authorization: `Bearer ${apiKey}` },
          },
        );
        assert.equal(response.status, 200);
        const page = await response.json();
        pages.push(page.data);
        for (const descriptor of page.data.components) {
          const component = await fetch(page.links.components[descriptor.name], {
            headers: { authorization: `Bearer ${apiKey}` },
          });
          assert.equal(component.status, 200);
          const bytes = Buffer.from(await component.arrayBuffer());
          assert.equal(bytes.length, descriptor.compressed_bytes);
          assert.equal(createHash("sha256").update(bytes).digest("hex"), descriptor.compressed_sha256);
          components.push({ name: descriptor.name, bytes: bytes.toString("hex") });
        }
        after = page.data.page.next_cursor;
      } while (after);
      retained.push({ id: item.catalogue_revision_id, pages, components });
    }
    return retained;
  };
  const beforeRecoveryExports = await retainedPublicExports(api.url);
  const deletedPackage = beforeRecoveryExports.find((item) => item.id === initialGameRevision);
  assert.ok(deletedPackage);
  const deletedManifestDigest = deletedPackage.pages[0].catalogue_revision.content_sha256;
  const knownDeletedComponent = deletedPackage.components[0].name;
  const deletionPlan = await cli([
    "catalogue-export",
    "deletion",
    "prepare",
    "--catalogue-revision",
    deletedPackage.id,
    "--manifest-digest",
    deletedManifestDigest,
    "--expected-current-revision",
    publication.resulting_revision_id,
    "--plan-id",
    "native-recovery-delete-plan",
  ]);
  assert.deepEqual(deletionPlan.object_keys, [
    `catalogue-public-manifests/${deletedPackage.id}/${deletedManifestDigest}.json`,
  ]);
  assert.ok(
    deletionPlan.dependencies.some((dependency) => dependency.code === "shared_components_retained_for_recovery"),
  );
  const deletionArgs = [
    "catalogue-export",
    "deletion",
    "confirm",
    "--plan-id",
    deletionPlan.id,
    "--plan-digest",
    deletionPlan.plan_digest,
    "--catalogue-revision",
    deletedPackage.id,
    "--manifest-digest",
    deletedManifestDigest,
    "--expected-current-revision",
    publication.resulting_revision_id,
    "--confirm-revision",
    deletedPackage.id,
    "--deletion-id",
    "native-recovery-delete",
    "--idempotency-key",
    "native-recovery-delete-intent",
  ];
  const deletion = await mutate(deletionArgs);
  assert.equal(deletion.state, "deleted", JSON.stringify(deletion));
  assert.deepEqual(await mutate(deletionArgs), deletion);
  const deletionStatusArgs = ["catalogue-export", "deletion", "status", "--deletion-id", "native-recovery-delete"];
  const beforeRecoveryDeletion = await cli(deletionStatusArgs);
  const assertDeletedPackage = async (baseUrl) => {
    for (const [path, status] of [
      [`/v1/catalogue-exports/${deletedPackage.id}`, 410],
      [`/v1/catalogue-exports/${deletedPackage.id}/components/${knownDeletedComponent}`, 410],
      [`/v1/catalogue-exports/${deletedPackage.id}/components/never-known`, 404],
      ["/v1/catalogue-exports/never-published", 404],
    ]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${apiKey}` } });
      assert.equal(response.status, status, `${path}: ${await response.text()}`);
    }
  };
  await assertDeletedPackage(api.url);
  const survivingExports = beforeRecoveryExports.filter((item) => item.id !== deletedPackage.id);
  assert.deepEqual(await retainedPublicExports(api.url, 2), survivingExports);
  const beforeRecoveryDetail = await consumer(`/v1/cards/${cards.records[0].id}`);

  pending = await post("/v1/game-candidates", {
    ingestion_run_id: run.id,
    supported_game: "digimon",
    expected_game_revision_id: publication.resulting_revision_id,
    idempotency_key: "native-restored-last-pending",
  });
  const lastCandidateDeadline = Date.now() + 30000;
  while (pending.state === "preparing" && Date.now() < lastCandidateDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    pending = await get(`/v1/game-candidates/${pending.id}`);
  }
  assert.equal(pending.state, "sealed", JSON.stringify(pending));
  pendingApproval = await post("/v1/publications", {
    candidate_id: pending.id,
    manifest_digest: pending.manifest_digest,
    expected_game_revision_id: publication.resulting_revision_id,
    generation: pending.generation,
    idempotency_key: "native-restored-last-approval",
  });
  const waitBackup = async (id) => {
    const deadline = Date.now() + 60000;
    let result;
    do {
      const response = await fetch(`${ingestion.url}/v1/backups/${id}`, {
        headers: { authorization: `Bearer ${adminKey}` },
      });
      result = await response.json();
      assert.ok(response.ok || response.status === 404, JSON.stringify(result));
      if (["verified", "failed"].includes(result.state)) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail(JSON.stringify(result));
  };
  cloudflare.faults.exportFailures = 4;
  await mutate([
    "backup",
    "create",
    "--expected-current-revision",
    publication.resulting_revision_id,
    "--idempotency-key",
    "native-export-failure",
  ]);
  const exportFailed = await waitBackup("native-export-failure");
  assert.equal(exportFailed.state, "failed", JSON.stringify(exportFailed));
  assert.equal(exportFailed.content_sha256, null);
  assert.equal((await get(`/v1/game-candidates/${pending.id}`)).deadline, pending.deadline);
  cloudflare.faults.lostImportResponses = 4;
  await mutate([
    "backup",
    "retry",
    "--expected-current-revision",
    publication.resulting_revision_id,
    "--failed-attempt-id",
    exportFailed.idempotency_key,
    "--failed-attempt-digest",
    exportFailed.attempt_digest,
    "--idempotency-key",
    "native-failed-backup",
  ]);

  const failed = await waitBackup("native-failed-backup");
  assert.equal(failed.state, "failed", JSON.stringify(failed));
  assert.equal(failed.publication_operation_id, publication.id);
  assert.equal(failed.publication_ingestion_run_id, run.id);
  cloudflare.faults.lostImportResponses = 1;
  await mutate([
    "backup",
    "retry",
    "--expected-current-revision",
    publication.resulting_revision_id,
    "--failed-attempt-id",
    failed.idempotency_key,
    "--failed-attempt-digest",
    failed.attempt_digest,
    "--idempotency-key",
    "native-retry-backup",
  ]);
  backup = await waitBackup("native-retry-backup");
  assert.equal(backup.state, "verified", JSON.stringify(backup));
  assert.equal(backup.linked_attempt_id, failed.idempotency_key);
  assert.equal(backup.publication_operation_id, publication.id);
  assert.equal(backup.publication_ingestion_run_id, run.id);
  assert.equal(backup.restore_generation, 2);
  assert.equal(cloudflare.snapshots.length, 5);
  // Advance only the synthetic cleanup clock beyond the existing dated 90-day
  // retention. No backup is deleted or its policy changed. The newest verified
  // checkpoint was exported/imported after reservation and contains the fence.
  const cleanupAdvance = await fetch(`${ingestion.url}/v1/evidence-cleanups/${cleanupIntent.id}/advance`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminKey}`,
      "content-type": "application/json",
      "x-keepr-test-now": new Date(Date.now() + 366 * 86400000).toISOString(),
    },
    body: "{}",
  });
  assert.equal(cleanupAdvance.status, 200, await cleanupAdvance.clone().text());
  assert.equal((await cleanupAdvance.json()).deleted_objects, 1);
  const recoveryId = "native-recovery-proof";
  const recovery = await mutate([
    "recovery",
    "begin",
    "--recovery-id",
    recoveryId,
    "--method",
    "replacement_database",
    "--target-revision",
    publication.resulting_revision_id,
    "--target-bookmark",
    backup.d1_bookmark,
    "--target-digest",
    backup.manifest_sha256,
    "--backup-attempt-id",
    backup.idempotency_key,
    "--expected-current-revision",
    publication.resulting_revision_id,
    "--idempotency-key",
    "native-recovery-begin",
  ]);
  assert.equal(recovery.state, "validating");
  const blocked = await fetch(`${ingestion.url}/v1/game-candidates`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      ingestion_run_id: run.id,
      supported_game: "digimon",
      expected_game_revision_id: publication.resulting_revision_id,
      idempotency_key: "fenced-during-recovery",
    }),
  });
  assert.equal(blocked.status, 409);
  const verified = await mutate([
    "recovery",
    "verify",
    "--recovery-id",
    recoveryId,
    "--target-digest",
    backup.manifest_sha256,
    "--idempotency-key",
    "native-recovery-verify",
  ]);
  assert.equal(verified.state, "awaiting_acceptance");
  // Rebind the isolated local Worker to the independently restored database.
  const restoredConfig = {
    ...config,
    d1_databases: [{ ...config.d1_databases[0], database_id: recovery.restored_database_id }],
    vars: { ...config.vars, CATALOGUE_D1_DATABASE_ID: recovery.restored_database_id },
  };
  const restoredConfigPath = join(directory, "restored-ingestion.json");
  await writeFile(restoredConfigPath, JSON.stringify(restoredConfig));
  const { reconstructCardSearchAfterD1RestoreStatements } = await import(
    "../src/catalogue/backup-recovery/card-search-recovery-statements.ts"
  );
  const sqlPath = join(directory, "restored.sql");
  await writeFile(
    sqlPath,
    cloudflare.snapshots.at(-1).replace(/^PRAGMA foreign_keys=OFF;|^BEGIN TRANSACTION;|^COMMIT;/gm, "") +
      "\n" +
      reconstructCardSearchAfterD1RestoreStatements.join(";\n") +
      ";\nUPDATE card_search_fts_state SET state='ready',owner_token=NULL,lease_expires_at=NULL;",
  );
  await executeSql(statePath, sqlPath, restoredConfigPath);
  const replacement = await startWorker({
    config: restoredConfigPath,
    envFile: adminEnv,
    statePath,
    outboundService: (request) => cloudflare.fetch(request),
    vars: { D1_EXPORT_TOKEN: "local-export", D1_VERIFICATION_TOKEN: "local-verify" },
  });
  workers.push(replacement);
  const replacedEnvironment = { ...environment, KEEPR_INGESTION_URL: replacement.url };
  const accepted = await mutate(
    [
      "recovery",
      "accept",
      "--recovery-id",
      recoveryId,
      "--expected-restored-revision",
      publication.resulting_revision_id,
      "--target-digest",
      backup.manifest_sha256,
      "--confirmation-recovery-id",
      recoveryId,
      "--idempotency-key",
      "native-recovery-accept",
    ],
    replacedEnvironment,
  );
  assert.equal(accepted.state, "accepted");
  const reclaimedAfterRestore = await fetch(
    `${replacedEnvironment.KEEPR_INGESTION_URL}/v1/source-snapshots/${cleanupFixture.id}/content`,
    { headers: { authorization: `Bearer ${adminKey}` } },
  );
  assert.equal(reclaimedAfterRestore.status, 410, await reclaimedAfterRestore.clone().text());

  assert.ok(
    accepted.restored_work.some((row) => row.classification === "abandoned_after_restore" && row.operations === 1),
  );
  const restoredPending = await fetch(`${replacement.url}/v1/game-candidates/${pending.id}`, {
    headers: { authorization: `Bearer ${adminKey}` },
  });
  const restoredPendingDocument = await restoredPending.json();
  assert.equal(restoredPendingDocument.state, "abandoned");
  assert.equal(restoredPendingDocument.deadline, pending.deadline);
  const stale = await fetch(`${replacement.url}/v1/publications/${pendingApproval.id}/advance`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
    body: JSON.stringify({ generation: pendingApproval.generation }),
  });
  const staleDocument = await stale.json();
  assert.notEqual(staleDocument.state, "published");
  const restoredProposal = await runCli(
    ["entity-proposal", "inspect", "--proposal-id", proposal.id, "--json"],
    replacedEnvironment,
  );
  assert.equal(restoredProposal.code, 0, restoredProposal.stdout);
  assert.deepEqual(JSON.parse(restoredProposal.stdout).history, admitted.history);
  const restoredCorrection = await runCli(
    ["identity-correction", "inspect", "--correction-id", correction.id, "--json"],
    replacedEnvironment,
  );
  assert.equal(restoredCorrection.code, 0, restoredCorrection.stdout);
  assert.deepEqual(JSON.parse(restoredCorrection.stdout), correctionHistory);

  const restoredApiConfig = JSON.parse(await readFile(resolve("apps/api/wrangler.jsonc"), "utf8"));
  restoredApiConfig.main = resolve("apps/api/src/index.ts");
  restoredApiConfig.d1_databases[0].database_id = recovery.restored_database_id;
  const restoredApiPath = join(directory, "restored-api.json");
  await writeFile(restoredApiPath, JSON.stringify(restoredApiConfig));
  const restoredApi = await startWorker({ config: restoredApiPath, envFile: apiEnv, statePath });
  workers.push(restoredApi);
  await assertDeletedPackage(restoredApi.url);
  assert.deepEqual(await retainedPublicExports(restoredApi.url, 2), survivingExports);
  const restoredDeletion = await runCli([...deletionStatusArgs, "--json"], replacedEnvironment);
  assert.equal(restoredDeletion.code, 0, restoredDeletion.stdout + restoredDeletion.stderr);
  assert.deepEqual(JSON.parse(restoredDeletion.stdout), beforeRecoveryDeletion);
  const restoredRetired = await fetch(`${restoredApi.url}/v1/printings/${correctedPrintingId}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(restoredRetired.status, 200);
  const restoredCorrectionDocument = await restoredRetired.json();
  assert.equal(restoredCorrectionDocument.data.action, "merge");
  assert.deepEqual(restoredCorrectionDocument.data.replacement_ids, [survivorPrintingId]);
  assert.ok(restoredCorrectionDocument.data.links.survivor.endsWith(`/v1/printings/${survivorPrintingId}`));

  const restoredResponse = await fetch(`${restoredApi.url}/v1/cards/${cards.records[0].id}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(restoredResponse.status, 200);
  const withoutLinks = (value) =>
    Array.isArray(value)
      ? value.map(withoutLinks)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key !== "links")
              .map(([key, item]) => [key, withoutLinks(item)]),
          )
        : value;
  assert.deepEqual(withoutLinks((await restoredResponse.json()).data), withoutLinks(beforeRecoveryDetail.body.data));
  assert.equal((await fetch(`${restoredApi.url}/v1/cards/${cards.records[0].id}`)).status, 401);
  const restoredSearch = await fetch(`${restoredApi.url}/v1/cards?q=${encodeURIComponent(cards.records[0].name)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(restoredSearch.status, 200);
  assert.ok((await restoredSearch.json()).data.some((card) => card.id === cards.records[0].id));
  const restoredAdmitted = await fetch(`${restoredApi.url}/v1/cards/${admittedCardId}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(restoredAdmitted.status, 200);
  assert.equal((await restoredAdmitted.json()).data.name, "Recovery admitted Digimon");
  const restoredSibling = await fetch(`${restoredApi.url}/v1/cards?game=one-piece`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(restoredSibling.status, 200);
  assert.deepEqual(
    (await restoredSibling.json()).data.map((card) => card.id),
    onePieceCards.map((card) => card.id),
  );
  proofCompleted = true;
}

for (const proof of ["recovery", "fresh baseline"])
  test(`native owner publication Workflow verifies ${proof} with retained composition`, (t) =>
    proveNativeComposition(t, proof));
