import {
  inspectNativeCollection,
  publishNativeCollection,
  waitForNativeCollection,
  nativeCheckpointTransport,
  nativeExportRecords,
} from "./helpers/native-catalogue-runtime.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  applyMigrations,
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
} from "./fixtures/catalogue-runtime-harness.mjs";

const root = resolve(import.meta.dirname, "..");

test("native publication: the owner publishes a complete Digimon catalogue consumed through authenticated HTTP", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-digimon-boundary-"));
  const statePath = join(directory, "shared-state");
  const administrationKey = randomUUID();
  const apiKey = randomUUID();
  const ingestionEnv = join(directory, "ingestion.env");
  const apiEnv = join(directory, "api.env");
  const ingestionConfig = join(directory, "ingestion.wrangler.json");
  const planPath = join(directory, "digimon-source-plan.json");
  await Promise.all([
    writeFile(ingestionEnv, `ADMINISTRATION_KEY=${administrationKey}\nADMINISTRATION_CLOCK_MODE=request\n`, {
      mode: 0o600,
    }),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
    writeFile(planPath, JSON.stringify(digimonPlan("complete-malicious-root")), { mode: 0o600 }),
  ]);
  await applyMigrations(statePath);
  const config = JSON.parse(await readFile(resolve(root, "apps/ingestion/wrangler.jsonc"), "utf8"));
  delete config.$schema;
  config.main = resolve(root, "apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve(root, "migrations");
  config.ratelimits[0].simple.limit = 300;
  config.services = [
    {
      binding: "OFFICIAL_SOURCE_TRANSPORT",
      service: "card-keepr-synthetic-official-source",
    },
  ];
  await writeFile(ingestionConfig, JSON.stringify(config));

  const source = await startWorker({
    config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    statePath: join(directory, "source-state"),
  });
  t.after(() => stopWorker(source));
  const checkpointTransport = await nativeCheckpointTransport(t, statePath, directory, ingestionConfig);
  const ingestion = await startWorker({
    ...checkpointTransport,
    config: ingestionConfig,
    envFile: ingestionEnv,
    statePath,
  });
  let api = null;
  t.after(async () => {
    await Promise.all([stopWorker(source), stopWorker(ingestion), api === null ? Promise.resolve() : stopWorker(api)]);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    waitForHealth(`${source.url}/catalogue-discovery`, "", source),
    waitForHealth(`${ingestion.url}/health`, administrationKey, ingestion),
  ]);
  const cliEnvironment = {
    KEEPR_INGESTION_URL: ingestion.url,
    KEEPR_ADMINISTRATION_KEY: administrationKey,
  };

  const maliciousCollected = await runCli(
    ["source", "collect", "--plan-file", planPath, "--idempotency-key", "digimon-malicious-root-collect", "--json"],
    cliEnvironment,
  );
  assert.equal(maliciousCollected.code, 0, maliciousCollected.stderr);
  const maliciousRun = JSON.parse(maliciousCollected.stdout);
  const maliciousResumed = await runCli(["source", "resume", "--run-id", maliciousRun.id, "--json"], cliEnvironment);
  assert.equal(maliciousResumed.code, 0, maliciousResumed.stderr);
  const failed = await waitForRunState(maliciousRun.id, "failed", cliEnvironment, ingestion);
  assert.equal(failed.failure_code, "source_parse_failed");
  assert.ok(
    failed.snapshots.some(
      (snapshot) =>
        snapshot.request.url === "https://world.digimoncard.com/cards/index.php?search=true" &&
        !failed.observation_sets.some(({ source_snapshot_id }) => source_snapshot_id === snapshot.id),
    ),
    "malicious root catalogue facts must leave their snapshot unparsed and block approval",
  );
  await writeFile(planPath, JSON.stringify(digimonPlan("complete-no-errata")), { mode: 0o600 });
  const noErrataCollected = await runCli(
    ["source", "collect", "--plan-file", planPath, "--idempotency-key", "digimon-no-errata-collect", "--json"],
    cliEnvironment,
  );
  assert.equal(noErrataCollected.code, 0, noErrataCollected.stderr);
  const noErrataRun = JSON.parse(noErrataCollected.stdout);
  const noErrataResumed = await runCli(["source", "resume", "--run-id", noErrataRun.id, "--json"], cliEnvironment);
  assert.equal(noErrataResumed.code, 0, noErrataResumed.stderr);
  const noErrataFailed = await waitForRunState(noErrataRun.id, "failed", cliEnvironment, ingestion);
  assert.equal(
    noErrataFailed.failure_code,
    "printing_reconciliation_blocked",
    JSON.stringify(
      noErrataFailed.snapshots
        .filter(
          (snapshot) =>
            !noErrataFailed.observation_sets.some(({ source_snapshot_id }) => source_snapshot_id === snapshot.id),
        )
        .map(({ request }) => request.url),
    ),
  );
  await writeFile(planPath, JSON.stringify(digimonPlan("complete")), {
    mode: 0o600,
  });

  const collected = await runCli(
    ["source", "collect", "--plan-file", planPath, "--idempotency-key", "digimon-complete-collect", "--json"],
    cliEnvironment,
  );
  assert.equal(collected.code, 0, collected.stderr);
  const run = JSON.parse(collected.stdout);
  const resumed = await runCli(["source", "resume", "--run-id", run.id, "--json"], cliEnvironment);
  assert.equal(resumed.code, 0, resumed.stderr);
  const completed = await waitForRunState(run.id, "sealed", cliEnvironment, ingestion);
  const cardListSnapshots = completed.snapshots.filter(({ request }) => request.url.includes("/cards/index.php"));
  assert.deepEqual(
    cardListSnapshots.map(({ request }) => request.url),
    [
      // digimon-en@7 fetches the card search directly: the discovery root,
      // its cards navigation stage, and the card-list surface all pin the
      // same live URL before the facets close the exact leaf.
      "https://world.digimoncard.com/cards/index.php?search=true",
      "https://world.digimoncard.com/cards/index.php?search=true",
      "https://world.digimoncard.com/cards/index.php?search=true",
      "https://world.digimoncard.com/cards/index.php?search=true&category=booster",
      "https://world.digimoncard.com/cards/index.php?search=true&category=booster&cardcategory=digimon",
      "https://world.digimoncard.com/cards/index.php?search=true&category=booster&cardcategory=digimon&colour=blue",
    ],
    "the retained request order must deterministically close the exact Digimon leaf",
  );
  const observationCount = (snapshot) =>
    completed.observation_sets.find(({ source_snapshot_id }) => source_snapshot_id === snapshot.id)?.observation_count;
  assert.deepEqual(
    cardListSnapshots.map(observationCount),
    [1, 1, 0, 1, 1, 3],
    "only the exact Colour leaf may supply catalogue records, including both required popups",
  );
  const exactLeafSnapshot = cardListSnapshots.at(-1);
  assert.notEqual(exactLeafSnapshot, undefined);
  const exactLeafObservationSet = completed.observation_sets.find(
    ({ source_snapshot_id }) => source_snapshot_id === exactLeafSnapshot.id,
  );
  assert.notEqual(exactLeafObservationSet, undefined);
  const exactLeafEvidenceResponse = await fetch(
    `${ingestion.url}/v1/source-observation-sets/${exactLeafObservationSet.id}/content`,
    { headers: { authorization: `Bearer ${administrationKey}` } },
  );
  assert.equal(exactLeafEvidenceResponse.status, 200);
  const exactLeafEvidence = await exactLeafEvidenceResponse.json();
  assert.deepEqual(
    exactLeafEvidence.evidence_summary,
    {
      observation_count: 3,
      declared_record_count: 3,
      parsed_record_count: 3,
      required_surfaces_complete: true,
      partitions_complete: true,
      structurally_complete: true,
    },
    "the exact leaf summary must count each retained observation once",
  );

  const inspected = await inspectNativeCollection(run.id, cliEnvironment);
  const inspection = inspected;
  const replayedInspection = await inspectNativeCollection(run.id, cliEnvironment);
  const replay = replayedInspection;
  assert.deepEqual(
    replay.manifest_digests,
    inspection.manifest_digests,
    "replaying the controlled source candidate must preserve its digest",
  );
  assert.deepEqual(replay.changes, inspection.changes);
  assert.equal(inspection.counts.cards.added, 1);
  assert.equal(inspection.counts.printings.added, 2);
  assert.ok(
    inspection.warnings.some(
      ({ code, raw_value }) => code === "unknown_source_field" && raw_value === "Retain this future mechanic verbatim",
    ),
    "unknown labelled mechanics must remain visible for schema review",
  );
  assert.ok(
    inspection.warnings.some(({ code }) => code === "product_relationship_unresolved"),
    "a fuzzy Product label must remain unresolved",
  );

  const approved = await publishNativeCollection(inspection, "digimon-complete-approve", cliEnvironment, ingestion);
  const revisionId = approved.resulting_revision_id;
  await stopWorker(ingestion);

  api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    statePath,
  });
  await waitForHealth(`${api.url}/health`, apiKey, api);
  const headers = { authorization: `Bearer ${apiKey}` };
  const manifestResponse = await fetch(`${api.url}/v1/catalogue-exports/${revisionId}`, { headers });
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();

  assert.equal(Object.hasOwn(manifest.data, "source_freshness"), false);
  const cardsResponse = await fetch(`${api.url}/v1/cards?game=digimon&card_number=BT99-001`, { headers });
  assert.equal(cardsResponse.status, 200);
  const cardsDocument = await cardsResponse.json();
  assert.equal(cardsDocument.data.length, 1);
  const detailResponse = await fetch(`${api.url}/v1/cards/${cardsDocument.data[0].id}?include=printings`, { headers });
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.data.name, "Synthetic Base Digimon");
  assert.equal(detail.data.effective_rules_text, null);
  assert.deepEqual(detail.data.game_data, {
    profile: "digimon@1",
    attributes: {
      card_type: "digimon",
      colours: ["blue", "red"],
      level: 6,
      play_cost: 11,
      use_cost: null,
      dp: 12000,
      form: "Mega",
      attribute: "Vaccine",
      traits: ["Synthetic Dragon"],
      digivolution_requirements: [
        {
          index: 1,
          from_level: 5,
          colours: ["blue"],
          cost: 4,
          raw_condition: "Blue Lv.5: 4",
        },
      ],
      text_sections: [
        { kind: "effect", text: "Synthetic main effect." },
        { kind: "inherited_effect", text: "Synthetic inherited effect." },
        { kind: "security_effect", text: "Synthetic security effect." },
        { kind: "dual_effect", text: "Synthetic dual effect." },
        { kind: "dual_rule", text: "Synthetic dual rule." },
        { kind: "link_condition", text: "Synthetic link condition." },
        { kind: "link_effect", text: "Synthetic link effect." },
        {
          kind: "special_digivolution_condition",
          text: "Synthetic special digivolution condition.",
        },
      ],
      dual_colours: ["blue", "red"],
      dual_cost: 7,
      link_dp: 3000,
    },
  });
  assert.deepEqual(detail.included.map(({ game_data }) => game_data.attributes.alternative_art).sort(), [false, true]);

  const [cards, printings, relationships, errata] = await Promise.all(
    ["cards", "printings", "relationships", "errata"].map((component) =>
      nativeExportRecords(api.url, apiKey, revisionId, component),
    ),
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].game_data.profile, "digimon@1");
  assert.equal(printings.length, 2);
  assert.ok(
    printings.every(({ printed_rules_text }) => printed_rules_text === "Synthetic printed rules."),
    "explicit removal changes Effective Rules Text without rewriting Printed Rules Text",
  );
  assert.deepEqual(printings.map(({ game_data }) => game_data.attributes.alternative_art).sort(), [false, true]);
  assert.equal(
    relationships.filter(({ kind }) => kind === "printing-product").length,
    2,
    "only the explicit Product evidence should publish",
  );
  assert.deepEqual(
    errata.map(({ target_type, effective_from, corrected_value }) => ({
      target_type,
      effective_from,
      corrected_value,
    })),
    [
      {
        target_type: "card",
        effective_from: "2026-07-01",
        corrected_value: null,
      },
    ],
    "the standalone Official Errata surface must publish typed authority",
  );
});

function digimonPlan(marker) {
  return {
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
              accept: `text/html; card-keepr-digimon-scenario=card-keepr-acceptance-digimon/${marker}`,
              "user-agent": `card-keepr-acceptance-digimon/${marker}`,
            },
          },
        ],
      },
    ],
  };
}

// A run that never reaches its expected state is diagnosed with the candidate
// inspection the CLI would have produced, which names the blocking evidence.
async function waitForRunState(runId, expectedState, environment, worker) {
  try {
    return await waitForNativeCollection(runId, expectedState, environment, worker, {
      deadlineMs: 30_000,
    });
  } catch (error) {
    const inspected = await inspectNativeCollection(runId, environment);
    error.message += `\ncandidate inspection: ${JSON.stringify(inspected)}`;
    throw error;
  }
}
