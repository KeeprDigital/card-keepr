import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  applyMigrations,
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
  waitForAdministrationDocument,
  persistedDatabaseDirectory,
} from "./helpers/acceptance-runtime.mjs";
import {
  nativeCheckpointTransport,
  waitForNativeCollection,
  inspectNativeCollection,
  publishNativeCollection,
  nativeExportRecords,
} from "./helpers/native-catalogue-runtime.mjs";

import { withNativeRequestPacing } from "./helpers/native-request-pacing.mjs";
import { verifiedBackupApiState } from "./helpers/verified-backup-api-state.mjs";
import { onePieceEvidenceMetrics } from "./helpers/one-piece-evidence-metrics.mjs";

// Actual retained HTTP bodies. External HTTP and Cloudflare control plane are
// replayed locally; collection, parsing and all owner operations are shipped code.
test("retained P-001: owner collects every declared Bandai record through native workflows", async (t) => {
  const started = performance.now();
  const initialCpu = process.cpuUsage();
  const directory = await mkdtemp(join(tmpdir(), "keepr-real-one-piece-"));
  const statePath = join(directory, "state");
  const pack = resolve("acceptance/fixtures/real-sources/2026-09-06");
  const replay = spawnSync(process.execPath, [resolve("scripts/source-evidence/replay.mjs"), pack], {
    encoding: "utf8",
  });
  assert.equal(replay.status, 0, replay.stderr);
  const manifest = JSON.parse(await readFile(join(pack, "manifest.json"), "utf8"));
  const captures = new Map(
    await Promise.all(
      manifest.captures.map(async (capture) => {
        const bodyBytes = await readFile(join(pack, capture.body));
        const headerBytes = await readFile(join(pack, capture.headers));
        assert.equal(createHash("sha256").update(bodyBytes).digest("hex"), capture.sha256);
        assert.equal(createHash("sha256").update(headerBytes).digest("hex"), capture.headersSha256);
        const headers = {};
        let previous = null;
        for (const line of headerBytes.toString("utf8").split("\n")) {
          if (/^[ \t]/u.test(line) && previous) {
            headers[previous] += ` ${line.trim()}`;
            continue;
          }
          const colon = line.indexOf(":");
          if (colon > 0) {
            previous = line.slice(0, colon).toLowerCase();
            headers[previous] = line.slice(colon + 1).trim();
          }
        }
        // Transfer framing belongs to the local replay response, not retained entity bytes.
        delete headers["transfer-encoding"];
        delete headers["content-encoding"];
        delete headers["connection"];
        return [capture.url, { ...capture, bodyBytes, headers, headerByteLength: headerBytes.length }];
      }),
    ),
  );
  const config = JSON.parse(await readFile("apps/ingestion/wrangler.jsonc", "utf8"));
  delete config.$schema;
  config.main = resolve("apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  await applyMigrations(statePath);
  const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
  const key = crypto.randomUUID();
  const apiKey = crypto.randomUUID();
  let api;
  let restoredApi;
  const served = [];
  let fault = null;
  const worker = await startWorker({
    ...checkpoint,
    config: configPath,
    statePath,
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: key },
    outboundService: async (request) => {
      if (
        ["api.cloudflare.com", "native-export.invalid", "native-upload.invalid"].includes(new URL(request.url).hostname)
      )
        return checkpoint.outboundService(request);
      const capture = captures.get(request.url);
      assert.ok(capture, `undeclared network request ${request.url}`);
      served.push(capture.id);
      if (request.url.includes("en.onepiece-cardgame.com/cardlist/") && fault === "disappearance") {
        const original = capture.bodyBytes.toString("utf8");
        const body = original
          .replace(/<dl class="modalCol" id="P-001_p6">[\s\S]*?<\/dl>/u, "")
          .replace('<div class="countCol">7 results</div>', '<div class="countCol">6 results</div>');
        assert.notEqual(body, original);
        return new Response(body, { headers: capture.headers });
      }
      if (request.url.includes("onepiece.limitlesstcg.com") && fault === "outage")
        return new Response("Injected optional-source outage", { status: 503 });
      if (request.url.includes("onepiece.limitlesstcg.com") && fault === "conflict") {
        const body = capture.bodyBytes.toString("utf8").replace(/[0-9]+ Cost/u, "999 Cost");
        assert.notEqual(body, capture.bodyBytes.toString("utf8"));
        return new Response(body, { headers: capture.headers });
      }
      if (request.url.includes("onepiece.limitlesstcg.com") && fault === "missing-id")
        return new Response(
          capture.bodyBytes.toString("utf8").replace(/<span class="card-text-id">[\s\S]*?<\/span>/u, ""),
          { headers: capture.headers },
        );
      return new Response(capture.bodyBytes, { headers: capture.headers });
    },
  });
  const redact = (value) =>
    String(value)
      .replaceAll(key, "[redacted]")
      .replaceAll(apiKey, "[redacted]")
      .replaceAll("local-export", "[redacted]")
      .replaceAll("local-verify", "[redacted]");
  t.after(async () => {
    await Promise.all([
      stopWorker(worker),
      ...(api ? [stopWorker(api)] : []),
      ...(restoredApi ? [stopWorker(restoredApi)] : []),
    ]);
    if (t.passed) await rm(directory, { recursive: true, force: true });
    else {
      await writeFile(join(directory, "worker-failure.log"), redact(worker.getOutput()));
      t.diagnostic(`P-001 failure state retained after runtime shutdown: ${directory}`);
    }
  });
  worker.administrationPollIntervalMs = 2200;
  await waitForHealth(`${worker.url}/health`, key, worker);
  const environment = {
    KEEPR_INGESTION_URL: worker.url,
    KEEPR_ADMINISTRATION_KEY: key,
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "2200",
  };
  const pacedCli = async (args) => {
    return runCli(args, environment);
  };
  const planPath = join(directory, "plan.json");
  await writeFile(planPath, await readFile("docs/examples/one-piece-two-source-plan.json"));
  const collected = await pacedCli([
    "source",
    "collect",
    "--plan-file",
    planPath,
    "--idempotency-key",
    "real-p001",
    "--json",
  ]);
  assert.equal(collected.code, 0, `${collected.stdout} ${collected.stderr}`);
  const run = JSON.parse(collected.stdout);
  const resumed = await pacedCli(["source", "resume", "--run-id", run.id, "--json"]);
  assert.equal(resumed.code, 0, resumed.stderr);
  await waitForAdministrationDocument(
    `/v1/ingestion-runs/${run.id}/evidence`,
    (d) => d.state === "parsing" || (d.state === "failed" ? JSON.stringify(d) : false),
    environment,
    worker,
  );
  const intakeCandidates = await waitForAdministrationDocument(
    `/v1/ingestion-runs/${run.id}/game-candidates`,
    (d) => d.candidates.length && d.candidates.every((c) => ["sealed", "failed"].includes(c.state)),
    environment,
    worker,
  );
  const shown = await pacedCli(["source", "show", "--run-id", run.id, "--json"]);
  assert.equal(shown.code, 0, shown.stdout);
  const evidence = JSON.parse(shown.stdout);
  const proposed = await pacedCli(["entity-proposal", "list", "--game", "one-piece", "--json"]);
  assert.equal(proposed.code, 0, proposed.stdout);
  assert.equal(JSON.parse(proposed.stdout).proposals.length, 15);
  assert.equal(evidence.evidence_plans[0].coverage.subset, "p-001-catalogue-and-corroboration");
  assert.equal(evidence.snapshots.length, 26);
  for (const snapshot of evidence.snapshots)
    assert.equal(snapshot.content.digest, captures.get(snapshot.request.url).sha256);
  assert.deepEqual(
    [...new Set(served)].sort(),
    [
      "bandai-p001",
      "bandai-store-championship",
      "bandai-store-trophy-image",
      ...Array.from({ length: 7 }, (_, i) => `bandai-p001-image-${i}`),
      "limitless-p001",
      ...Array.from({ length: 7 }, (_, i) => `limitless-p001-v${i + 1}`),
      ...Array.from({ length: 8 }, (_, i) => `limitless-p001-image-${i}`),
    ].sort(),
  );
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, `${result.stdout} ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const sealed = async (id) => {
    try {
      return await waitForNativeCollection(id, "sealed", environment, worker);
    } catch (error) {
      let diagnostic;
      try {
        const response = await withNativeRequestPacing(environment, () =>
          fetch(`${worker.url}/v1/ingestion-runs/${id}/game-candidates`, {
            headers: { authorization: `Bearer ${key}` },
          }),
        );
        diagnostic = `HTTP ${response.status}: ${await response.text()}`;
      } catch (diagnosticError) {
        diagnostic = `Diagnostic request failed: ${String(diagnosticError)}`;
      }
      throw new Error(redact(`Native collection ${id} failed; ${diagnostic}`), { cause: error });
    }
  };
  for (const candidate of intakeCandidates.candidates) {
    if (candidate.state === "sealed")
      await cli([
        "game-candidate",
        "abandon",
        "--candidate-id",
        candidate.id,
        "--generation",
        String(candidate.generation),
        "--idempotency-key",
        "retain-intake-before-owner-decisions",
        "--yes",
      ]);
  }
  const proposals = JSON.parse(proposed.stdout).proposals;
  const base = proposals.find((p) => p.source_lineage === "one-piece-en" && JSON.parse(p.reference)[0] === "P-001");
  assert.ok(base);
  const baseIntake = await cli(["entity-proposal", "inspect", "--proposal-id", base.id]);
  assert.deepEqual(baseIntake.content.card.game_data.attributes.block_icons, ["1"]);
  const decisionPath = join(directory, "decision.json");
  await writeFile(
    decisionPath,
    JSON.stringify({
      expected_generation: "0",
      idempotency_key: "review-base",
      rationale:
        "Replay of retained #219 visual review: P-001 punching Luffy, white frame, red panel, P/block-1 markings. Physical finish remains unestablished.",
      exception: {
        scope: ["identity"],
        attestation:
          "The retained Bandai P-001 front image establishes this issued appearance. Reviewed in the 2026-09-06 evidence pack; no unobserved physical finish claim.",
      },
    }),
  );
  const admitted = await cli([
    "entity-proposal",
    "admit",
    "--proposal-id",
    base.id,
    "--decision",
    decisionPath,
    "--yes",
  ]);
  assert.equal(admitted.status, "admitted");
  const cardId = admitted.history[0].decision.card.id;
  const basePrintingId = admitted.history[0].decision.printing.id;
  const firstRun = await cli(["source", "collect", "--plan-file", planPath, "--idempotency-key", "first-admitted"]);
  await cli(["source", "resume", "--run-id", firstRun.id]);
  try {
    await waitForNativeCollection(firstRun.id, "sealed", environment, worker);
  } catch (error) {
    const source = await cli(["source", "show", "--run-id", firstRun.id]);
    throw new Error(JSON.stringify(source), { cause: error });
  }
  const firstInspection = await inspectNativeCollection(firstRun.id, environment);
  assert.equal(firstInspection.records.cards.length, 1);
  assert.equal(firstInspection.records.printings.length, 1);
  assert.equal(
    new Set(firstInspection.warnings.filter((w) => w.code === "entity_proposal_excluded").map((w) => w.proposal_id))
      .size,
    14,
  );
  const firstPublication = await publishNativeCollection(firstInspection, "first-base", environment, worker);
  assert.ok(firstPublication.resulting_revision_id);

  const pendingOfficial = proposals.find((p) => p.source_lineage === "one-piece-en" && p.id !== base.id);
  await writeFile(
    decisionPath,
    JSON.stringify({
      expected_generation: "0",
      idempotency_key: "absent-native-card",
      card_id: "card_absent",
      rationale: "Verify current native target visibility.",
      exception: {
        scope: ["identity"],
        attestation: "Retained appearance review; the requested target is deliberately absent.",
      },
    }),
  );
  const absent = await runCli(
    ["entity-proposal", "admit", "--proposal-id", pendingOfficial.id, "--decision", decisionPath, "--yes", "--json"],
    environment,
  );
  assert.notEqual(absent.code, 0);
  assert.match(absent.stdout + absent.stderr, /admission_link_invalid/u);
  assert.equal((await cli(["entity-proposal", "inspect", "--proposal-id", pendingOfficial.id])).history.length, 0);

  const printingIds = new Map([["P-001", basePrintingId]]);
  for (const proposal of proposals.filter((p) => p.source_lineage === "one-piece-en" && p.id !== base.id)) {
    const locator = JSON.parse(proposal.reference)[0];
    await writeFile(
      decisionPath,
      JSON.stringify({
        expected_generation: "0",
        idempotency_key: `review-${locator}`,
        card_id: cardId,
        rationale: `Retained #219 review establishes the distinct issued ${locator} appearance in the seven-image Bandai catalogue, independently of distribution labels or encoding.`,
        exception: {
          scope: ["identity"],
          attestation: `Replay of the retained 2026-09-06 comparison: ${locator} has its separately reviewed printed artwork/frame/stamp appearance. No physical finish inference.`,
        },
      }),
    );
    const decision = await cli([
      "entity-proposal",
      "admit",
      "--proposal-id",
      proposal.id,
      "--decision",
      decisionPath,
      "--yes",
    ]);
    printingIds.set(locator, decision.history[0].decision.printing.id);
  }
  const winner = proposals.find(
    (p) => p.source_lineage === "limitless-one-piece-en" && JSON.parse(p.reference)[1] === "v4",
  );
  assert.ok(winner);
  const publishedEvidence = await cli(["source", "show", "--run-id", firstRun.id]);
  const event = publishedEvidence.snapshots.find((s) => s.request.url.includes("store_championship_wave1.php"));
  const trophy = publishedEvidence.snapshots.find((s) => s.request.url.includes("/championship/prize/P-001.png"));
  assert.ok(event && trophy);
  await writeFile(
    decisionPath,
    JSON.stringify({
      expected_generation: "0",
      idempotency_key: "review-winner-v4",
      card_id: cardId,
      rationale:
        "Retained #219 finding: WINNER stamp, gold name, harbour artwork and blue full-art corners are absent from all seven captured Bandai catalogue images. The separately captured official event corroborates issue; no global official absence claim.",
      exception: {
        scope: ["identity"],
        attestation: `Replay of retained visual review, not new physical authentication. Event ${event.id} SHA256 ${event.content.digest}; Trophy depiction ${trophy.id} SHA256 ${trophy.content.digest} corroborate Limitless v4. Finish remains unknown.`,
      },
    }),
  );
  const winnerDecision = await cli([
    "entity-proposal",
    "admit",
    "--proposal-id",
    winner.id,
    "--decision",
    decisionPath,
    "--yes",
  ]);
  const winnerPrintingId = winnerDecision.history[0].decision.printing.id;
  assert.ok(![...printingIds.values()].includes(winnerPrintingId));
  const secondRun = await cli(["source", "collect", "--plan-file", planPath, "--idempotency-key", "eight-appearances"]);
  await cli(["source", "resume", "--run-id", secondRun.id]);
  await sealed(secondRun.id);
  const secondInspection = await inspectNativeCollection(secondRun.id, environment);
  assert.equal(secondInspection.records.cards.length, 1);
  assert.equal(secondInspection.records.printings.length, 8);
  assert.equal(
    new Set(secondInspection.warnings.filter((w) => w.code === "entity_proposal_excluded").map((w) => w.proposal_id))
      .size,
    7,
  );
  const secondPublication = await publishNativeCollection(secondInspection, "eight-appearances", environment, worker);
  assert.ok(secondPublication.resulting_revision_id);

  const samePrinting = new Map([
    ["base", "P-001"],
    ["v1", "P-001_p1"],
    ["v2", "P-001_p2"],
    ["v3", "P-001_p3"],
    ["v5", "P-001_p4"],
    ["v6", "P-001_p5"],
    ["v7", "P-001_p6"],
  ]);
  for (const proposal of proposals.filter((p) => p.source_lineage === "limitless-one-piece-en" && p.id !== winner.id)) {
    const variant = JSON.parse(proposal.reference)[1];
    const target = printingIds.get(samePrinting.get(variant));
    assert.ok(target, `reviewed mapping for ${variant}`);
    await writeFile(
      decisionPath,
      JSON.stringify({
        expected_generation: "0",
        idempotency_key: `same-printing-${variant}`,
        printing_id: target,
        rationale: `Retained #219 visual comparison matches Limitless ${variant} to Bandai ${samePrinting.get(variant)} by artwork, crop, frame and printed markings; different encodings are not identity evidence.`,
        exception: {
          scope: ["identity"],
          attestation:
            "Replay of the retained seven-pair visual review. Distribution labels and physical finish are not inferred.",
        },
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
    assert.equal(linked.history[0].decision.printing.id, target);
  }
  const linkedRun = await cli([
    "source",
    "collect",
    "--plan-file",
    planPath,
    "--idempotency-key",
    "linked-appearances",
  ]);
  await cli(["source", "resume", "--run-id", linkedRun.id]);
  await sealed(linkedRun.id);
  const linkedInspection = await inspectNativeCollection(linkedRun.id, environment);
  assert.equal(linkedInspection.records.cards.length, 1);
  assert.deepEqual(
    linkedInspection.records.printings.map((p) => p.id).sort(),
    [...printingIds.values(), winnerPrintingId].sort(),
  );
  assert.equal(linkedInspection.warnings.filter((w) => w.code === "entity_proposal_excluded").length, 0);
  const linkedPublication = await publishNativeCollection(linkedInspection, "linked-appearances", environment, worker);
  let finalPublication = linkedPublication;
  const fullPlan = JSON.parse(await readFile(planPath, "utf8"));
  for (const scenario of ["official-only", "scoped-disappearance", "optional-outage"]) {
    const scenarioPlan = structuredClone(fullPlan);
    if (scenario !== "optional-outage") {
      scenarioPlan.plans = scenarioPlan.plans.slice(0, 1);
      if (scenario === "scoped-disappearance") fault = "disappearance";
    } else {
      scenarioPlan.plans[1].participation = "optional";
      fault = "outage";
    }
    await writeFile(planPath, JSON.stringify(scenarioPlan));
    const refreshed = await cli(["source", "collect", "--plan-file", planPath, "--idempotency-key", scenario]);
    await cli(["source", "resume", "--run-id", refreshed.id]);
    await sealed(refreshed.id);
    const inspection = await inspectNativeCollection(refreshed.id, environment);
    const coverage = (await cli(["source", "show", "--run-id", refreshed.id])).source_coverage;
    if (scenario !== "optional-outage")
      assert.deepEqual(
        coverage.map((c) => c.source_lineage),
        ["one-piece-en"],
      );
    else {
      const supplemental = coverage.find((c) => c.source_lineage === "limitless-one-piece-en");
      assert.equal(supplemental.status, "incomplete");
      assert.equal(supplemental.successful_checked_at, null);
      assert.equal(supplemental.content_captured_at, null);
    }
    assert.deepEqual(
      inspection.records.printings.map((p) => p.id).sort(),
      [...printingIds.values(), winnerPrintingId].sort(),
    );
    const missing = inspection.warnings.filter((warning) => warning.code === "record_not_observed");
    if (scenario === "scoped-disappearance") {
      assert.ok(missing.length > 0);
      for (const warning of missing) {
        assert.equal(warning.printing_id, printingIds.get("P-001_p6"));
        assert.equal(warning.source_lineage, "one-piece-en");
        assert.equal(warning.card_id, undefined);
      }
    } else assert.deepEqual(missing, []);
    finalPublication = await publishNativeCollection(inspection, scenario, environment, worker);
    fault = null;
  }
  await writeFile(planPath, JSON.stringify(fullPlan));
  for (const injected of ["missing-id", "conflict"]) {
    fault = injected;
    const failed = await cli(["source", "collect", "--plan-file", planPath, "--idempotency-key", injected]);
    await cli(["source", "resume", "--run-id", failed.id]);
    await waitForNativeCollection(failed.id, "failed", environment, worker);
    fault = null;
  }
  const metrics = await onePieceEvidenceMetrics(
    await persistedDatabaseDirectory(statePath),
    worker.getOutput(),
    captures,
    served,
    performance.now() - started,
    {
      cpu_microseconds: process.cpuUsage(initialCpu),
      maximum_rss_kib: process.resourceUsage().maxRSS,
      limitation:
        "Node test driver only; excludes workerd and short-lived CLI processes. Workflow elapsed time is not CPU time.",
    },
    {
      parsed_catalogue_records_per_complete_two_source_collection: proposals.length,
      accepted_printings: linkedInspection.records.printings.length,
    },
  );
  await stopWorker(worker);
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: apiKey } });
  await waitForHealth(`${api.url}/health`, apiKey, api);
  const [cards, printings, images] = await Promise.all(
    ["cards", "printings", "printing-images"].map((kind) =>
      nativeExportRecords(api.url, apiKey, finalPublication.resulting_revision_id, kind),
    ),
  );
  assert.equal(cards.length, 1);
  assert.deepEqual(printings.map((p) => p.id).sort(), [...printingIds.values(), winnerPrintingId].sort());
  assert.equal(images.length, 15);
  assert.equal(printings.find((p) => p.id === winnerPrintingId).printed_rules_text, null);
  const publicJson = JSON.stringify({ cards, printings, images });
  assert.doesNotMatch(publicJson, /source_lineage|proposal_id|eligibility|admission_history/u);
  const headers = { authorization: `Bearer ${apiKey}` };
  const search = await fetch(`${api.url}/v1/cards?q=P-001&game=one-piece`, { headers });
  assert.equal(search.status, 200);
  const found = await search.json();
  assert.deepEqual(
    found.data.map((card) => card.id),
    [cardId],
  );
  for (const printing of printings.filter((p) => [...printingIds.values()].includes(p.id))) {
    assert.deepEqual(printing.rarity, baseIntake.content.printing.rarity);
    assert.equal(printing.printed_rules_text, baseIntake.content.printing.printed_rules_text);
  }
  for (const printing of printings) {
    const response = await fetch(`${api.url}/v1/printings/${printing.id}`, { headers });
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.type, "printing");
    assert.equal(new URL(data.links.self).pathname, `/v1/printings/${printing.id}`);
    assert.deepEqual(
      data.printing_images.map((image) => image.id).sort(),
      images
        .filter((image) => image.printing_id === printing.id)
        .map((image) => image.id)
        .sort(),
    );
    for (const [field, value] of Object.entries(printing)) assert.deepEqual(data[field], value, `Printing ${field}`);
    for (const image of data.printing_images) {
      const content = await fetch(new URL(image.links.content, api.url), { headers });
      assert.equal(content.status, 200);
      const bytes = Buffer.from(await content.arrayBuffer());
      assert.equal(bytes.length, image.content_byte_length);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), image.content_sha256);
      assert.ok([...captures.values()].some((c) => c.sha256 === image.content_sha256));
    }
  }
  const cardResponse = await fetch(`${api.url}/v1/cards/${cardId}`, { headers });
  assert.equal(cardResponse.status, 200);
  const card = (await cardResponse.json()).data;
  for (const [field, value] of Object.entries(cards[0])) assert.deepEqual(card[field], value, `Card ${field}`);
  assert.deepEqual(card.printing_ids.sort(), [...printingIds.values(), winnerPrintingId].sort());
  const exportBytes = { compressed: 0, uncompressed: 0, records: 0, components: 0 };
  let after = null;
  do {
    const response = await fetch(
      `${api.url}/v1/catalogue-exports/${finalPublication.resulting_revision_id}${after ? `?after=${encodeURIComponent(after)}` : ""}`,
      { headers },
    );
    assert.equal(response.status, 200);
    const manifest = await response.json();
    for (const component of manifest.data.components) {
      exportBytes.compressed += component.compressed_bytes;
      exportBytes.uncompressed += component.uncompressed_bytes;
      exportBytes.records += component.records;
      exportBytes.components++;
    }
    after = manifest.data.page.next_cursor;
  } while (after);
  await stopWorker(api);
  const restoredState = await verifiedBackupApiState(statePath, directory);
  restoredApi = await startWorker({
    config: "apps/api/wrangler.jsonc",
    statePath: restoredState,
    vars: { API_BEARER_KEY: apiKey },
  });
  await waitForHealth(`${restoredApi.url}/health`, apiKey, restoredApi);
  const restoredPrintings = await nativeExportRecords(
    restoredApi.url,
    apiKey,
    finalPublication.resulting_revision_id,
    "printings",
  );
  assert.deepEqual(restoredPrintings, printings);
  const restoredWinner = await fetch(`${restoredApi.url}/v1/printings/${winnerPrintingId}`, { headers });
  assert.equal(restoredWinner.status, 200);
  const restoredWinnerData = (await restoredWinner.json()).data;
  assert.equal(restoredWinnerData.id, winnerPrintingId);
  assert.equal(restoredWinnerData.printing_images.length, 1);
  for (const image of restoredWinnerData.printing_images) {
    const content = await fetch(new URL(image.links.content, restoredApi.url), { headers });
    assert.equal(content.status, 200);
    const bytes = Buffer.from(await content.arrayBuffer());
    assert.equal(bytes.length, image.content_byte_length);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), image.content_sha256);
    assert.ok([...captures.values()].some((c) => c.sha256 === image.content_sha256));
  }
  metrics.restored_api_and_export_verified = true;
  metrics.verified_public_export = exportBytes;
  metrics.complete_journey_elapsed_ms = performance.now() - started;
  metrics.complete_journey_driver_cpu_microseconds = process.cpuUsage(initialCpu);
  if (process.env.KEEPR_P001_METRICS_PATH)
    await writeFile(process.env.KEEPR_P001_METRICS_PATH, JSON.stringify(metrics, null, 2) + "\n");
  t.diagnostic(
    JSON.stringify({ source: metrics.source, export: exportBytes, elapsed_ms: metrics.complete_journey_elapsed_ms }),
  );
});
