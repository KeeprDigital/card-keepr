import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, freemem, totalmem, cpus } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pilotPublicationApprovals, pilotSnapshotEvidence } from "./helpers/query-helpers/capacity-objects.mjs";
import { readWorkerConfig } from "../cli/lib/config.mjs";
import {
  capacityCollectionScopes,
  capacitySourceResponse,
  syntheticCapacityTier,
} from "../test/support/fake-publisher/capacity-workloads.ts";
import {
  applyMigrations,
  persistedDatabaseDirectory,
  runCli,
  startWorker,
  stopWorker,
  waitForAdministrationDocument,
  waitForHealth,
} from "./helpers/acceptance-runtime.mjs";
import { syntheticSourceAdapterMigrations } from "./helpers/synthetic-source-adapters.mjs";
import {
  inspectNativeCollection,
  nativeCheckpointTransport,
  publishNativeCollection,
} from "./helpers/native-catalogue-runtime.mjs";
import { isNativeCheckpointRequest } from "./helpers/native-checkpoint-hosts.mjs";
import { nativeExportReader } from "./helpers/native-export-reader.mjs";
import { verifiedBackupApiState } from "./helpers/verified-backup-api-state.mjs";
import {
  nativeRetainedOccupancy,
  nativeObjectCensus,
  operationalCapacityMetrics,
} from "./helpers/native-capacity-metrics.mjs";
import { onePieceEvidenceMetrics } from "./helpers/one-piece-evidence-metrics.mjs";

// Explicit benchmark selection: small synthetic bodies, real native publication and SQL restore.
test(
  "bounded scopes compose and refresh stable identities through native publication and actual restore",
  { timeout: 300000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "keepr-accounting-pilot-"));
    const statePath = join(directory, "state");
    const started = performance.now();
    const usage = process.resourceUsage();
    const report = {
      contract: "card-keepr-bounded-accounting-pilot@1",
      software: {
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        working_tree_status: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      workload: syntheticCapacityTier("accounting-pilot"),
      arrangement: ["tier-1", "tier-2"].map((id) => ({
        id,
        scopes: capacityCollectionScopes(syntheticCapacityTier(id)),
      })),
      headroom: {
        logical_cpus: cpus().length,
        total_memory_bytes: totalmem(),
        free_memory_bytes: freemem(),
        before: await nativeRetainedOccupancy(directory),
      },
      owner_actions: [],
      publications: [],
      checkpoints: [],
      limitations: [
        "Synthetic offline input, simulated provider control plane and actual isolated SQLite import; not live source coverage.",
        "Full tier arrangements are census only: 5/50 GiB workloads were not executed.",
        "No isolate peak, Worker CPU, billed requests, write amplification or production operating budget is certified.",
        "P-001 remains bounded overlapping One Piece coverage; Riftbound retains 1189/1197 records and lacks 1183 image bodies.",
        "Point-in-time local storage is not a continuous peak; logical and filesystem totals must not be added together.",
        "The shared runner serializes this coordination group's heavy checks; unrelated OS and lightweight activity may remain.",
        "This small synthetic pilot does not qualify #312's expanded launch sources/model; final capacity and recovery evidence remain required.",
      ],
    };
    let worker,
      api,
      passed = false;
    t.after(async () => {
      if (api) await stopWorker(api);
      if (worker) await stopWorker(worker);
      report.passed = passed;
      report.elapsed_ms = performance.now() - started;
      report.driver_only = { final: process.resourceUsage(), initial: usage };
      if (process.env.KEEPR_ACCOUNTING_OUTPUT_PREFIX) {
        const output = `${process.env.KEEPR_ACCOUNTING_OUTPUT_PREFIX}-pilot.json`;
        await mkdir(resolve(output, ".."), { recursive: true });
        await writeFile(output, JSON.stringify(report, null, 2) + "\n");
      }
      if (passed) await rm(directory, { recursive: true, force: true });
      else console.error(`Failed pilot state retained at ${directory}`);
    });
    const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
    config.main = resolve("acceptance/fixtures/native-retained-evidence-harness.ts");
    config.d1_databases[0].migrations_dir = resolve("migrations");
    config.ratelimits[0].simple.limit = 300;
    const configPath = join(directory, "ingestion.json");
    await writeFile(configPath, JSON.stringify(config));
    await applyMigrations(statePath, configPath, await syntheticSourceAdapterMigrations());
    const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
    const adminKey = crypto.randomUUID(),
      apiKey = crypto.randomUUID();
    const deliveries = [];
    worker = await startWorker({
      ...checkpoint,
      config: configPath,
      statePath,
      vars: { ...checkpoint.vars, ADMINISTRATION_KEY: adminKey, SOURCE_HOST_PACING_MODE: "immediate" },
      outboundService: (request) => {
        if (isNativeCheckpointRequest(request)) return checkpoint.outboundService(request);
        const response = capacitySourceResponse(new URL(request.url));
        assert.ok(response, `Unexpected pilot request ${request.url}`);
        deliveries.push({ url: request.url, status: response.status });
        return response;
      },
    });
    await waitForHealth(`${worker.url}/health`, adminKey, worker);
    api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: apiKey } });
    await waitForHealth(`${api.url}/health`, apiKey, api);
    const environment = {
      KEEPR_INGESTION_URL: worker.url,
      KEEPR_ADMINISTRATION_KEY: adminKey,
      KEEPR_NATIVE_REQUEST_INTERVAL_MS: "250",
    };
    const cli = async (args) => {
      const result = await runCli([...args, "--json"], environment);
      report.owner_actions.push({ command: args, exit_code: result.code });
      assert.equal(result.code, 0, result.stdout + result.stderr + worker.getOutput());
      return JSON.parse(result.stdout);
    };
    const reader = nativeExportReader(250);
    const scopes = capacityCollectionScopes(report.workload);
    let predecessor = "catrev_spine_000",
      previousCards = [],
      previousPrintings = [],
      finalCards,
      finalPrintings,
      finalImages;
    for (const [iteration, scope] of [scopes[0], scopes[1], scopes[0]].entries()) {
      const planFile = join(directory, "plan.json");
      const sourceUrl = `https://official-source.invalid/reconciliation/capacity-accounting-pilot-page-${scope.firstPage}?scope=${scope.subset}`;
      await writeFile(
        planFile,
        JSON.stringify({
          plans: [
            {
              supported_game: "one-piece",
              source_lineage: "one-piece-en",
              adapter_version: "fixture-one-piece-capacity@1",
              subset: scope.subset,
              requests: [{ id: "one-piece-en:catalogue", url: sourceUrl }],
            },
          ],
        }),
      );
      const run = await cli([
        "source",
        "collect",
        "--plan-file",
        planFile,
        "--idempotency-key",
        `pilot-source-${iteration}`,
      ]);
      const prepared = await cli([
        "game-candidate",
        "prepare",
        "--run-id",
        run.id,
        "--game",
        "one-piece",
        "--expected-game-revision-id",
        predecessor,
        "--idempotency-key",
        `pilot-candidate-${iteration}`,
        "--yes",
      ]);
      await waitForAdministrationDocument(
        `/v1/game-candidates/${prepared.id}`,
        (d) => d.state === "sealed" || (["failed", "paused"].includes(d.state) ? JSON.stringify(d) : false),
        environment,
        worker,
        { deadlineMs: 120000 },
      );
      const inspection = await inspectNativeCollection(run.id, environment);
      assert.equal(inspection.records.cards.length, iteration === 0 ? 16 : 17);
      assert.equal(inspection.records.printings.length, iteration === 0 ? 16 : 17);
      if (iteration > 0) {
        assert.equal(inspection.counts.cards.carry_forward, iteration === 1 ? 16 : 17);
        assert.equal(inspection.counts.printings.carry_forward, iteration === 1 ? 16 : 17);
      }
      const unpublished = await cli(["status"]);
      assert.equal(unpublished.safe_state.current_revision_id, predecessor);
      const evidence = await cli(["source", "show", "--run-id", run.id]);
      assert.equal(evidence.source_coverage[0].coverage.subset, scope.subset);
      assert.equal(evidence.source_coverage[0].status, "complete");
      // Source Coverage counts structured requests; images have an independent tolerated-gap contract.
      assert.equal(evidence.source_coverage[0].observed_requests, scope.lastPage - scope.firstPage + 1);
      assert.equal(evidence.snapshots.length, scope.requests);
      report.checkpoints.push({
        iteration,
        scope,
        source_coverage: evidence.source_coverage,
        inspection_counts: inspection.counts,
        evidence_snapshots: evidence.snapshots,
        candidate_id: prepared.id,
      });
      const published = await publishNativeCollection(
        inspection,
        `pilot-publication-${iteration}`,
        environment,
        worker,
        120000,
      );
      report.publications.push(published);
      predecessor = published.resulting_revision_id;
      finalCards = await reader.records(api.url, apiKey, predecessor, "cards");
      finalPrintings = await reader.records(api.url, apiKey, predecessor, "printings");
      finalImages = await reader.records(api.url, apiKey, predecessor, "printing-images");
      for (const card of previousCards)
        assert.deepEqual(
          finalCards.find((value) => value.id === card.id),
          card,
        );
      for (const printing of previousPrintings)
        assert.deepEqual(
          finalPrintings.find((value) => value.id === printing.id),
          printing,
        );
      assert.equal(finalImages.length, iteration === 0 ? 32 : 34);
      previousCards = finalCards;
      previousPrintings = finalPrintings;
    }
    const inspectConsumer = async () => {
      const records = [];
      for (const printing of [finalPrintings[0], finalPrintings.at(-1)]) {
        const response = await fetch(`${api.url}/v1/printings/${printing.id}?revision=${predecessor}`, {
          headers: { authorization: `Bearer ${apiKey}` },
        });
        assert.equal(response.status, 200);
        const { data } = await response.json();
        assert.equal(data.id, printing.id);
        assert.equal(data.card_id, printing.card_id);
        assert.deepEqual(
          data.printing_images.map((image) => image.id).sort(),
          finalImages
            .filter((image) => image.printing_id === printing.id)
            .map((image) => image.id)
            .sort(),
        );
        records.push({
          id: data.id,
          card_id: data.card_id,
          image_ids: data.printing_images.map((image) => image.id).sort(),
        });
      }
      return records;
    };
    const consumerRecords = await inspectConsumer();
    const imageDigests = [];
    for (const image of finalImages) {
      const response = await fetch(`${api.url}/v1/printing-images/${image.id}/content?revision=${predecessor}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, 100 * 1024);
      const digest = createHash("sha256").update(bytes).digest("hex");
      assert.equal(digest, image.content_sha256);
      imageDigests.push({ id: image.id, sha256: digest });
    }
    report.deliveries = deliveries;
    report.operations = operationalCapacityMetrics(worker.getOutput());
    await stopWorker(api);
    api = undefined;
    await stopWorker(worker);
    worker = undefined;
    report.d1_tables_indexes = (
      await onePieceEvidenceMetrics(
        await persistedDatabaseDirectory(statePath),
        "",
        new Map(),
        [],
        performance.now() - started,
        {},
        {},
      )
    ).storage;
    report.headroom.after = await nativeRetainedOccupancy(directory);
    report.local_runtime_storage = await nativeRetainedOccupancy(join(directory, "miniflare"));
    report.r2_objects = await nativeObjectCensus(join(directory, "miniflare", "r2"));
    assert.equal(report.r2_objects.by_key_prefix["source-snapshots"].objects, 69);
    assert.equal(report.r2_objects.by_key_prefix["source-snapshots"].logical_bytes, 6955008);
    assert.equal(report.r2_objects.by_key_prefix["printing-images"].logical_bytes, report.workload.imageBytes);
    const imports = (await readdir(directory))
      .filter((name) => /^restore-[0-9]+\.sqlite$/u.test(name))
      .sort((a, b) => Number(a.match(/[0-9]+/u)[0]) - Number(b.match(/[0-9]+/u)[0]));
    assert.equal(imports.length, 3);
    const restoredDatabase = new DatabaseSync(join(directory, imports.at(-1)), { readOnly: true });
    try {
      const approvals = pilotPublicationApprovals(restoredDatabase).all();
      assert.equal(approvals.length, 3);
      for (const publication of report.publications) {
        const approval = approvals.find((row) => row.id === publication.id);
        assert.equal(approval.candidate_id, publication.candidate_id);
        assert.equal(approval.manifest_digest, publication.manifest_digest);
        assert.equal(approval.expected_game_revision_id, publication.expected_game_revision_id);
        assert.equal(approval.approved_at, publication.approved_at);
        assert.equal(JSON.parse(approval.approval_json).approval_scope, "whole_candidate");
      }
      const snapshots = pilotSnapshotEvidence(restoredDatabase).all();
      assert.equal(snapshots.length, 69);
      for (const checkpoint of report.checkpoints)
        for (const snapshot of checkpoint.evidence_snapshots) {
          const restoredSnapshot = snapshots.find((row) => row.id === snapshot.id);
          assert.equal(restoredSnapshot.retrieved_at, snapshot.retrieval.retrieved_at);
          assert.equal(restoredSnapshot.content_digest, snapshot.content.digest);
        }
      report.restore = { imports: imports.length, approvals: approvals.length, snapshots: snapshots.length };
    } finally {
      restoredDatabase.close();
    }
    const restored = await verifiedBackupApiState(statePath, directory);
    reader.clear();
    api = await startWorker({
      config: "apps/api/wrangler.jsonc",
      statePath: restored,
      vars: { API_BEARER_KEY: apiKey },
    });
    await waitForHealth(`${api.url}/health`, apiKey, api);
    assert.deepEqual(await reader.records(api.url, apiKey, predecessor, "cards"), finalCards);
    assert.deepEqual(await reader.records(api.url, apiKey, predecessor, "printings"), finalPrintings);
    assert.deepEqual(await reader.records(api.url, apiKey, predecessor, "printing-images"), finalImages);
    assert.deepEqual(await inspectConsumer(), consumerRecords);
    for (const image of imageDigests) {
      const response = await fetch(`${api.url}/v1/printing-images/${image.id}/content?revision=${predecessor}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(response.status, 200);
      assert.equal(
        createHash("sha256")
          .update(Buffer.from(await response.arrayBuffer()))
          .digest("hex"),
        image.sha256,
      );
    }
    passed = true;
  },
);
