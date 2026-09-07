import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
} from "./helpers/acceptance-runtime.mjs";
import {
  nativeCheckpointTransport,
  publishNativeCollection,
  nativeExportRecords,
} from "./helpers/native-catalogue-runtime.mjs";

// Actual retained HTTP bodies. External HTTP and Cloudflare control plane are
// replayed locally; collection, parsing and all owner operations are shipped code.
test("retained Riot inventory: owner collects all returned English records without dropping unknown Printings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-real-riftbound-"));
  const statePath = join(directory, "state");
  const pack = resolve("acceptance/fixtures/real-sources/2026-09-06");
  const previous = JSON.parse(await readFile(join(pack, "manifest.json"), "utf8"));
  const currentPack = resolve("acceptance/fixtures/real-sources/2026-09-08-riftbound");
  const current = JSON.parse(await readFile(join(currentPack, "manifest.json"), "utf8"));
  const manifest = {
    captures: [
      ...previous.captures.filter((c) => c.id.startsWith("riftbound-image-")).map((c) => ({ ...c, root: pack })),
      ...current.captures.map((c) => ({ ...c, root: currentPack })),
    ],
  };
  const captures = new Map(
    await Promise.all(
      manifest.captures.map(async (c) => [c.url, { ...c, bodyBytes: await readFile(join(c.root, c.body)) }]),
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
  const served = [];
  const worker = await startWorker({
    ...checkpoint,
    config: configPath,
    statePath,
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: key, SOURCE_HOST_PACING_MODE: "immediate" },
    outboundService: async (request) => {
      if (new URL(request.url).hostname === "api.cloudflare.com") return checkpoint.outboundService(request);
      const capture = captures.get(request.url);
      if (!capture) {
        assert.equal(new URL(request.url).hostname, "cmsassets.rgpub.io", `undeclared request ${request.url}`);
        // Injected unavailable image, not an observed Riot outage or a retained image.
        return new Response("Image not retained in this deterministic replay", { status: 404 });
      }
      served.push(capture.id);
      return new Response(capture.bodyBytes, { headers: { "content-type": capture.contentType } });
    },
  });
  let api;
  t.after(async () => {
    if (api) await stopWorker(api);
    await stopWorker(worker);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(`${worker.url}/health`, key, worker);
  const environment = {
    KEEPR_INGESTION_URL: worker.url,
    KEEPR_ADMINISTRATION_KEY: key,
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "2200",
  };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  for (const area of ["card_facts", "printing_details", "corrected_card_content"])
    await cli([
      "source",
      "designate",
      "--game",
      "riftbound",
      "--locale",
      "en",
      "--release-region",
      "US",
      "--area",
      area,
      "--source-lineage",
      "riftbound-en",
      "--expected-generation",
      "0",
      "--rationale",
      "Use retained Riot evidence for this English catalogue replay.",
      "--idempotency-key",
      `riot-authority-${area}`,
    ]);
  const planPath = join(directory, "plan.json");
  await writeFile(
    planPath,
    JSON.stringify({
      plans: [
        {
          supported_game: "riftbound",
          source_lineage: "riftbound-en",
          adapter_version: "riftbound-en@1",
          subset: "public-english-inventory",
          requests: [{ id: "riftbound-en:catalogue", url: current.captures[0].url }],
        },
      ],
    }),
  );
  const collected = await runCli(
    ["source", "collect", "--plan-file", planPath, "--idempotency-key", "real-riftbound", "--json"],
    environment,
  );
  assert.equal(collected.code, 0, `${collected.stdout} ${collected.stderr}\n${worker.getOutput()}`);
  const run = JSON.parse(collected.stdout);
  const resumed = await runCli(["source", "resume", "--run-id", run.id, "--json"], environment);
  assert.equal(resumed.code, 0, resumed.stderr);
  await waitForAdministrationDocument(
    `/v1/ingestion-runs/${run.id}/evidence`,
    (d) => d.state === "parsing" || (d.state === "failed" ? JSON.stringify(d) : false),
    environment,
    worker,
    { deadlineMs: 600_000 },
  );
  await waitForAdministrationDocument(
    `/v1/ingestion-runs/${run.id}/game-candidates`,
    (d) =>
      d.candidates.some((c) => c.state === "failed")
        ? JSON.stringify(d)
        : d.candidates.length > 0 && d.candidates.every((c) => c.state === "sealed"),
    environment,
    worker,
    { deadlineMs: 600_000 },
  );
  const shown = await runCli(["source", "show", "--run-id", run.id, "--json"], environment);
  assert.equal(shown.code, 0, shown.stdout);
  const evidence = JSON.parse(shown.stdout);
  assert.deepEqual(evidence.evidence_plans[0].coverage, {
    locale: "en",
    area: "catalogue",
    subset: "public-english-inventory",
  });
  assert.equal(evidence.snapshots.length, 12);
  for (const snapshot of evidence.snapshots)
    assert.equal(snapshot.content.digest, captures.get(snapshot.request.url).sha256);
  assert.equal(
    evidence.observation_sets.reduce((sum, set) => sum + set.observation_count, 0),
    1189,
  );
  const proposals = [];
  let after = null;
  do {
    const result = await runCli(
      ["entity-proposal", "list", "--game", "riftbound", ...(after ? ["--after", after] : []), "--json"],
      environment,
    );
    assert.equal(result.code, 0, result.stdout);
    const page = JSON.parse(result.stdout);
    proposals.push(...page.proposals);
    after = page.next_cursor;
  } while (after);
  assert.equal(proposals.length, 1189);
  assert.equal(new Set(proposals.map((p) => p.id)).size, 1189);
  assert.deepEqual(
    [...new Set(served)].sort(),
    [
      ...current.captures.filter((c) => c.id.startsWith("riftbound-cards-")).map((c) => c.id),
      ...previous.captures.filter((c) => c.id.startsWith("riftbound-image-")).map((c) => c.id),
    ].sort(),
  );
  const intake = await cli(["game-candidate", "list", "--run-id", run.id]);
  for (const candidate of intake.candidates)
    await cli([
      "game-candidate",
      "abandon",
      "--candidate-id",
      candidate.id,
      "--generation",
      String(candidate.generation),
      "--idempotency-key",
      `retain-intake-${candidate.id}`,
      "--yes",
    ]);
  const reviewed = [
    ["ogn-001-298", "Blazing Scorcher: red frame, Noxus/Dragon unit, 5 energy and 5 might, OGN-001/298."],
    ["ogn-066a-298", "Ahri, Alluring: arcade alternate artwork, green Calm frame, AHRI/IONIA, OGN-066a/298."],
    ["ogn-067-298", "Blitzcrank, Impassive: extended metal-robot artwork, BLITZCRANK/ZAUN/MECH, OGN-067/298."],
    [
      "ogn-141-298",
      "Kinkou Monk: original printed buff two wording, Body frame, OGN-141/298. Printed wording is independent of corrected gallery text.",
    ],
    [
      "sfd-227-star-221",
      "Ahri, Inquisitive: signature-style pink artwork and gold border, AHRI/IONIA printed tags, SFD-227*/221. Gallery omits Ionia; this admission does not approve that omission as printed evidence.",
    ],
    [
      "unl-205-219",
      "Abandoned Hall: landscape battlefield, duplicated inverted text on one front, UNL-205/219. No reverse face established.",
    ],
  ];
  const admittedPrintings = new Map();
  const decisionPath = join(directory, "decision.json");
  for (const [locator, evidenceText] of reviewed) {
    const proposal = proposals.find((p) => JSON.parse(p.reference)[0] === locator);
    assert.ok(proposal, locator);
    await writeFile(
      decisionPath,
      JSON.stringify({
        expected_generation: "0",
        idempotency_key: `review-${locator}`,
        rationale: evidenceText,
        exception: {
          scope: ["identity"],
          attestation: `Visual review of retained 2026-09-06 Riot image: ${evidenceText} Physical finish remains unknown.`,
        },
      }),
    );
    const admitted = await cli([
      "entity-proposal",
      "admit",
      "--proposal-id",
      proposal.id,
      "--decision",
      decisionPath,
      "--yes",
    ]);
    assert.equal(admitted.status, "admitted");
    admittedPrintings.set(locator, admitted.history[0].decision.printing.id);
  }
  const prepared = await cli([
    "game-candidate",
    "prepare",
    "--run-id",
    run.id,
    "--game",
    "riftbound",
    "--expected-game-revision-id",
    "catrev_spine_000",
    "--idempotency-key",
    "reviewed-riftbound",
    "--yes",
  ]);
  const candidate = await waitForAdministrationDocument(
    `/v1/game-candidates/${prepared.id}`,
    (d) => d.state === "sealed" || (d.state === "failed" ? JSON.stringify(d) : false),
    environment,
    worker,
    { deadlineMs: 600_000 },
  );
  const publication = await publishNativeCollection(
    { candidates: [candidate] },
    "reviewed-riftbound-publication",
    environment,
    worker,
    120_000,
  );
  const apiKey = crypto.randomUUID();
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: apiKey } });
  await waitForHealth(`${api.url}/health`, apiKey, api);
  const exported = await nativeExportRecords(api.url, apiKey, publication.resulting_revision_id, "printings");
  assert.deepEqual(exported.map((p) => p.id).sort(), [...admittedPrintings.values()].sort());
  assert.ok(
    exported.every((p) => p.game_data.attributes.reverse_face === null && p.game_data.attributes.finish === null),
  );
  const headers = { authorization: `Bearer ${apiKey}` };
  assert.equal((await fetch(`${api.url}/v1/printings/${exported[0].id}`)).status, 401);
  for (const [locator, id] of admittedPrintings) {
    const response = await fetch(`${api.url}/v1/printings/${id}`, { headers });
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    const record = exported.find((p) => p.id === id);
    for (const [field, value] of Object.entries(record)) assert.deepEqual(data[field], value, field);
    assert.equal(data.printing_images.length, 1);
    const image = data.printing_images[0];
    const content = await fetch(image.links.content, { headers });
    assert.equal(content.status, 200);
    const bytes = Buffer.from(await content.arrayBuffer());
    const capture = manifest.captures.find((c) => c.id === `riftbound-image-${locator}`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), capture.sha256);
  }
});
