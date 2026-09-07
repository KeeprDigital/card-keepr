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
} from "./helpers/acceptance-runtime.mjs";
import { nativeCheckpointTransport } from "./helpers/native-catalogue-runtime.mjs";

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
  t.after(async () => {
    await stopWorker(worker);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(`${worker.url}/health`, key, worker);
  const environment = {
    KEEPR_INGESTION_URL: worker.url,
    KEEPR_ADMINISTRATION_KEY: key,
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "2200",
  };
  const planPath = join(directory, "plan.json");
  await writeFile(
    planPath,
    JSON.stringify({
      plans: [
        {
          supported_game: "riftbound",
          source_lineage: "riftbound-en",
          adapter_version: "riftbound-en@1",
          coverage: { locale: "en", area: "catalogue", subset: "public-english-inventory" },
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
  assert.equal(evidence.evidence_plans[0].coverage.subset, "public-english-inventory");
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
});
