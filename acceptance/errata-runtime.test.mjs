import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const runtimePort = 18_793;

test("the repository CLI rejects Official Errata authority outside the documented Bandai surface", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-errata-authority-"));
  const statePath = join(directory, "shared-state");
  const apiKey = crypto.randomUUID();
  const administrationKey = crypto.randomUUID();
  const environmentFile = join(directory, "runtime.env");
  const runtimeConfig = join(directory, "runtime.wrangler.json");
  await Promise.all([
    writeFile(
      environmentFile,
      `API_BEARER_KEY=${apiKey}\nADMINISTRATION_KEY=${administrationKey}\n`,
      { mode: 0o600 },
    ),
    writeRuntimeConfig(runtimeConfig),
  ]);
  applyMigrations(runtimeConfig, statePath);
  const port = runtimePort + 1;
  const runtime = startWorker({
    config: runtimeConfig,
    envFile: environmentFile,
    inspectorPort: 19_235,
    port,
    statePath,
  });
  t.after(async () => {
    await stopWorker(runtime);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(
    runtime,
    port,
    apiKey,
    "Errata authority runtime",
  );
  const environment = {
    KEEPR_ADMINISTRATION_KEY: administrationKey,
    KEEPR_INGESTION_URL: `http://127.0.0.1:${port}`,
  };
  const result = await runCli(
    [
      "source",
      "collect",
      "--game",
      "one-piece",
      "--lineage",
      "one-piece-en",
      "--adapter",
      "one-piece-official-errata-html@1",
      "--request-id",
      "untrusted-errata",
      "--url",
      "https://publisher.example/claims/official-errata.json",
      "--idempotency-key",
      "reject-untrusted-errata-authority",
      "--json",
    ],
    environment,
  );
  assert.equal(result.code, 8, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "official_source_surface_mismatch",
    detail:
      "The Official Errata adapter accepts only https://en.onepiece-cardgame.com/rules/errata_card/.",
  });

  const untrustedRun = await collectSource(
    {
      adapter: "one-piece-json-document@1",
      idempotencyKey: "retain-untrusted-generic-surface",
      requestId: "untrusted-generic",
      url: "https://publisher.example/claims/untrusted-card-list.json",
    },
    environment,
    runtime,
  );
  const completed = await resumeAndWait(
    untrustedRun.id,
    environment,
    runtime,
  );
  const snapshotId = completed.snapshots?.[0]?.id;
  assert.equal(typeof snapshotId, "string");
  const reparse = await runCli(
    [
      "snapshot",
      "reparse",
      "--snapshot-id",
      snapshotId,
      "--adapter",
      "one-piece-official-errata-html@1",
      "--idempotency-key",
      "reject-retained-untrusted-errata-authority",
      "--json",
    ],
    environment,
  );
  assert.equal(reparse.code, 8, reparse.stderr);
  assert.deepEqual(JSON.parse(reparse.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "official_source_surface_mismatch",
    detail:
      "The Official Errata adapter accepts only https://en.onepiece-cardgame.com/rules/errata_card/.",
  });
});

test("Bandai Errata HTML shape drift fails closed through the CLI and Worker seam", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-errata-drift-"));
  const statePath = join(directory, "shared-state");
  const apiKey = crypto.randomUUID();
  const administrationKey = crypto.randomUUID();
  const environmentFile = join(directory, "runtime.env");
  const runtimeConfig = join(directory, "runtime.wrangler.json");
  await Promise.all([
    writeFile(
      environmentFile,
      `API_BEARER_KEY=${apiKey}\nADMINISTRATION_KEY=${administrationKey}\n`,
      { mode: 0o600 },
    ),
    writeRuntimeConfig(
      runtimeConfig,
      "AcceptanceShapeDriftOfficialSourceTransport",
    ),
  ]);
  applyMigrations(runtimeConfig, statePath);
  const port = runtimePort + 2;
  const runtime = startWorker({
    config: runtimeConfig,
    envFile: environmentFile,
    inspectorPort: 19_236,
    port,
    statePath,
  });
  t.after(async () => {
    await stopWorker(runtime);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(runtime, port, apiKey, "Errata drift runtime");
  const environment = {
    KEEPR_ADMINISTRATION_KEY: administrationKey,
    KEEPR_INGESTION_URL: `http://127.0.0.1:${port}`,
  };
  const run = await collectSource(
    {
      adapter: "one-piece-official-errata-html@1",
      idempotencyKey: "reject-bandai-errata-shape-drift",
      requestId: "one-piece-en:errata",
      url: "https://en.onepiece-cardgame.com/rules/errata_card/",
    },
    environment,
    runtime,
  );
  const resumed = await runCli(
    ["source", "resume", "--run-id", run.id, "--json"],
    environment,
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  const failed = await waitForFailedRun(run.id, environment, runtime);
  assert.equal(failed.failure_code, "source_parse_failed");
  assert.equal(failed.observation_sets.length, 0);
});

test("retained Bandai Errata HTML publishes through CLI and authenticated HTTP/export seams", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-errata-"));
  const statePath = join(directory, "shared-state");
  const apiKey = crypto.randomUUID();
  const administrationKey = crypto.randomUUID();
  const environmentFile = join(directory, "runtime.env");
  const runtimeConfig = join(directory, "runtime.wrangler.json");
  const heterogeneousPlan = join(directory, "heterogeneous-plan.json");
  await Promise.all([
    writeFile(
      environmentFile,
      `API_BEARER_KEY=${apiKey}\nADMINISTRATION_KEY=${administrationKey}\n`,
      { mode: 0o600 },
    ),
    writeRuntimeConfig(runtimeConfig),
    writeFile(
      heterogeneousPlan,
      JSON.stringify({
        plans: [
          {
            supported_game: "one-piece",
            source_lineage: "one-piece-en",
            adapter_version: "one-piece-official-errata-html@1",
            requests: [{
              id: "one-piece-en:errata",
              url:
                "https://en.onepiece-cardgame.com/rules/errata_card/",
              headers: { accept: "text/html" },
            }],
          },
          digimonOfficialPlan(),
        ],
      }),
      { mode: 0o600 },
    ),
  ]);
  applyMigrations(runtimeConfig, statePath);

  const runtime = startWorker({
    config: runtimeConfig,
    envFile: environmentFile,
    inspectorPort: 19_234,
    port: runtimePort,
    statePath,
  });
  t.after(async () => {
    await stopWorker(runtime);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(runtime, runtimePort, apiKey, "combined runtime");

  const cliEnvironment = {
    KEEPR_API_KEY: apiKey,
    KEEPR_API_URL: `http://127.0.0.1:${runtimePort}`,
    KEEPR_ADMINISTRATION_KEY: administrationKey,
    KEEPR_INGESTION_URL: `http://127.0.0.1:${runtimePort}`,
  };
  const initialStatus = await runCli(["status", "--json"], cliEnvironment);
  assert.equal(initialStatus.code, 0, initialStatus.stderr);
  const initialStatusDocument = JSON.parse(initialStatus.stdout);
  const bootstrapRevision =
    initialStatusDocument.safe_state.current_revision_id;
  assert.deepEqual(
    initialStatusDocument.repairable_catalogue_revision_ids,
    [],
  );
  cliEnvironment.KEEPR_ACCEPTANCE_PRODUCTION_CONFIRMATION =
    JSON.stringify(initialStatusDocument.production_target);

  const heterogeneous = await runCli(
    [
      "source",
      "collect",
      "--plan-file",
      heterogeneousPlan,
      "--idempotency-key",
      "reject-heterogeneous-coverage-before-mutation",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(heterogeneous.code, 8, heterogeneous.stderr);
  assert.deepEqual(JSON.parse(heterogeneous.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "heterogeneous_reconciliation_coverage",
    detail:
      "One Evidence Plan cannot mix Errata-only and complete Catalogue coverage.",
  });
  const statusAfterHeterogeneousPlan = await runCli(
    ["status", "--json"],
    cliEnvironment,
  );
  assert.equal(statusAfterHeterogeneousPlan.code, 0);
  assert.equal(
    JSON.parse(statusAfterHeterogeneousPlan.stdout).safe_state
      .current_revision_id,
    bootstrapRevision,
  );
  assert.equal(
    JSON.parse(statusAfterHeterogeneousPlan.stdout).safe_state
      .active_ingestion_run_id,
    null,
  );

  const seedRun = await collectFixtureSource(
    {
      adapter: "fixture-one-piece-json@1",
      idempotencyKey: "seed-published-errata-targets",
      requestId: "published-card-list",
      url: "https://synthetic-fixture.invalid/card-list",
    },
    cliEnvironment,
  );
  await resumeAndWait(seedRun.id, cliEnvironment, runtime);
  const seedReconciled = await reconcileAndWait(
    seedRun.id,
    bootstrapRevision,
    "reconcile-published-errata-targets",
    cliEnvironment,
    runtime,
  );
  assert.equal(
    seedReconciled.publishable,
    true,
    JSON.stringify(seedReconciled),
  );
  const seededRevision = await approveCandidate(
    seedRun.id,
    "approve-published-errata-targets",
    cliEnvironment,
    runtime,
  );
  const seededCard = seedReconciled.cards.find(
    (candidate) => candidate.official_identity.value === "OP07-097",
  );
  assert.notEqual(seededCard, undefined);
  const seededPrinting = seedReconciled.printings.find(
    (candidate) => candidate.card_id === seededCard.id,
  );
  assert.notEqual(seededPrinting, undefined);
  const [
    seededCardRead,
    seededPrintingRead,
    seededCardsBytes,
    seededPrintingsBytes,
  ] = await Promise.all([
    apiJson(`/v1/cards/${seededCard.id}?include=evidence`, apiKey),
    apiJson(`/v1/printings/${seededPrinting.id}?include=evidence`, apiKey),
    exportComponent(seededRevision, "cards", apiKey),
    exportComponent(seededRevision, "printings", apiKey),
  ]);
  const seededExportedCard = seededCardsBytes.trim().split("\n").map(
    (line) => JSON.parse(line),
  ).find((candidate) => candidate.id === seededCard.id);
  const seededExportedPrinting = seededPrintingsBytes.trim().split("\n").map(
    (line) => JSON.parse(line),
  ).find((candidate) => candidate.id === seededPrinting.id);
  assert.notEqual(seededExportedCard, undefined);
  assert.notEqual(seededExportedPrinting, undefined);
  const seededManifest = await apiJson(
    `/v1/catalogue-exports/${seededRevision}`,
    apiKey,
  );
  const seededCardFreshness = seededManifest.data.source_freshness.find(
    (check) =>
      check.game === "one-piece" &&
      check.area === "cards-and-printings",
  );
  assert.notEqual(seededCardFreshness, undefined);
  assert.equal(
    seededManifest.data.source_freshness.some(
      (check) => check.game === "one-piece" && check.area === "errata",
    ),
    false,
  );

  const run = await collectSource(
    {
      adapter: "one-piece-official-errata-html@1",
      idempotencyKey: "errata-runtime-source",
      requestId: "one-piece-en:errata",
      url: "https://en.onepiece-cardgame.com/rules/errata_card/",
    },
    cliEnvironment,
    runtime,
  );
  await resumeAndWait(run.id, cliEnvironment, runtime);
  const evidence = await runCli(
    ["source", "show", "--run-id", run.id, "--json"],
    cliEnvironment,
  );
  assert.equal(evidence.code, 0, evidence.stderr);
  assert.equal(
    JSON.parse(evidence.stdout).observation_sets[0].observation_count,
    3,
  );
  const reconciled = await reconcileAndWait(
    run.id,
    seededRevision,
    "reconcile-retained-bandai-errata-html",
    cliEnvironment,
    runtime,
  );
  assert.equal(reconciled.publishable, true, JSON.stringify(reconciled));
  const revisionId = await approveCandidate(
    run.id,
    "approve-retained-bandai-errata-html",
    cliEnvironment,
    runtime,
  );
  const card = reconciled.cards.find(
    (candidate) => candidate.official_identity.value === "OP07-097",
  );
  const zeff = reconciled.cards.find(
    (candidate) => candidate.official_identity.value === "OP03-047",
  );
  assert.notEqual(card, undefined);
  assert.notEqual(zeff, undefined);
  assert.equal(card.id, seededCard.id);
  const printing = seedReconciled.printings.find(
    (candidate) => candidate.card_id === card.id,
  );
  assert.notEqual(printing, undefined);
  assert.equal(printing.id, seededPrinting.id);

  const searched = await runCli(
    [
      "cards",
      "search",
      "--query",
      "rest 1 of your DON!! cards: Select",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(searched.code, 0, searched.stderr);
  assert.equal(JSON.parse(searched.stdout).data[0].id, card.id);

  const luffy = seedReconciled.cards.find(
    (candidate) => candidate.official_identity.value === "OP01-001",
  );
  assert.notEqual(luffy, undefined);
  for (const query of ["uffy", "ＵＦＦＹ", "op01-001"]) {
    const result = await apiJson(
      `/v1/cards?q=${encodeURIComponent(query)}`,
      apiKey,
    );
    assert.equal(result.data.some((candidate) => candidate.id === luffy.id), true);
  }
  const oneCharacter = await apiJson("/v1/cards?q=D", apiKey);
  assert.equal(
    oneCharacter.data.some((candidate) => candidate.id === luffy.id),
    true,
  );
  const punctuationMustRemainExact = await apiJson(
    `/v1/cards?q=${encodeURIComponent("DON cards")}`,
    apiKey,
  );
  assert.equal(
    punctuationMustRemainExact.data.some(
      (candidate) => candidate.id === card.id,
    ),
    false,
  );
  const fieldsMustNotBeConcatenated = await apiJson(
    `/v1/cards?q=${encodeURIComponent("OP01-001 Monkey")}`,
    apiKey,
  );
  assert.equal(fieldsMustNotBeConcatenated.data.length, 0);
  const maximumQuery = await fetch(
    `http://127.0.0.1:${runtimePort}/v1/cards?q=${"x".repeat(500)}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(maximumQuery.status, 200, await maximumQuery.text());
  const oversizedQuery = await fetch(
    `http://127.0.0.1:${runtimePort}/v1/cards?q=${"x".repeat(501)}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(oversizedQuery.status, 400);
  assert.equal((await oversizedQuery.json()).code, "invalid_parameter");

  const cardResponse = await fetch(
    `http://127.0.0.1:${runtimePort}/v1/cards/${card.id}` +
      "?include=printings,evidence,disagreements",
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  if (cardResponse.status !== 200) {
    assert.equal(cardResponse.status, 200, await cardResponse.text());
  }
  const cardRead = await cardResponse.json();
  assert.match(
    cardRead.data.effective_rules_text,
    /DON!! cards: Select up to 1 \{Egghead\} type card/,
  );
  const cardIncluded = cardRead.included ?? [];
  assert.equal(
    cardIncluded.some(
      (resource) =>
        resource.type === "printing" && resource.id === printing.id,
    ),
    true,
  );
  const effectiveRulesEvidenceIds =
    cardRead.provenance["/data/effective_rules_text"];
  assert.equal(effectiveRulesEvidenceIds.length, 1);
  const errataEvidence = cardIncluded.find(
    (resource) => resource.id === effectiveRulesEvidenceIds[0],
  );
  assert.notEqual(errataEvidence, undefined);
  assert.equal(errataEvidence.type, "source_observation");
  const seededCardEvidence = seededCardRead.included.filter(
    (resource) => resource.type === "source_observation",
  );
  for (const resource of seededCardEvidence) {
    assert.deepEqual(
      cardIncluded.find((candidate) => candidate.id === resource.id),
      resource,
    );
  }
  assert.deepEqual(
    cardRead.data.source_lineages,
    seededCardRead.data.source_lineages,
  );
  assert.deepEqual(cardRead.data.lifecycle, seededCardRead.data.lifecycle);
  assert.deepEqual(cardRead.disagreements, []);
  const cardEtag = cardResponse.headers.get("etag");
  assert.notEqual(cardEtag, null);
  const conditionalCard = await fetch(
    `http://127.0.0.1:${runtimePort}/v1/cards/${card.id}` +
      "?include=printings,evidence,disagreements",
    {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "if-none-match": cardEtag,
      },
    },
  );
  const conditionalCardBody = await conditionalCard.text();
  assert.equal(conditionalCard.status, 304, conditionalCardBody);
  assert.equal(conditionalCardBody, "");
  const invalidCardInclude = await fetch(
    `http://127.0.0.1:${runtimePort}/v1/cards/${card.id}?include=unknown`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  const invalidCardIncludeBody = await invalidCardInclude.json();
  assert.equal(invalidCardInclude.status, 400);
  assert.equal(invalidCardIncludeBody.code, "invalid_parameter");
  const printingRead = await apiJson(
    `/v1/printings/${printing.id}?include=evidence`,
    apiKey,
  );
  assert.match(
    printingRead.data.printed_rules_text,
    /DON!! cards Select up to 1 \{Egghead\}/,
  );
  assert.deepEqual(
    printingRead.data.lifecycle,
    seededPrintingRead.data.lifecycle,
  );
  assert.deepEqual(
    printingRead.data.locator_evidence,
    seededPrintingRead.data.locator_evidence,
  );
  assert.deepEqual(
    printingRead.data.relationship_evidence,
    seededPrintingRead.data.relationship_evidence,
  );
  assert.deepEqual(
    printingRead.data.source_lineages,
    seededPrintingRead.data.source_lineages,
  );
  assert.deepEqual(printingRead.included, seededPrintingRead.included);
  assert.deepEqual(printingRead.provenance, seededPrintingRead.provenance);
  const manifest = await apiJson(
    `/v1/catalogue-exports/${revisionId}`,
    apiKey,
  );
  assert.equal(manifest.meta.catalogue_revision_id, revisionId);
  const preservedCardFreshness = manifest.data.source_freshness.find(
    (check) =>
      check.game === "one-piece" &&
      check.area === "cards-and-printings",
  );
  assert.deepEqual(preservedCardFreshness, seededCardFreshness);
  const errataFreshness = manifest.data.source_freshness.find(
    (check) => check.game === "one-piece" && check.area === "errata",
  );
  assert.notEqual(errataFreshness, undefined);
  assert.equal(
    Date.parse(errataFreshness.checked_at) >=
      Date.parse(seededManifest.data.published_at),
    true,
  );

  const [cardsBytes, printingsBytes, errataBytes, relationshipBytes] =
    await Promise.all([
    exportComponent(revisionId, "cards", apiKey),
    exportComponent(revisionId, "printings", apiKey),
    exportComponent(revisionId, "errata", apiKey),
    exportComponent(revisionId, "relationships", apiKey),
  ]);
  const exportedCard = cardsBytes.trim().split("\n").map((line) =>
    JSON.parse(line)
  ).find(
    (candidate) => candidate.id === card.id,
  );
  const exportedErratum = errataBytes.trim().split("\n").map((line) =>
    JSON.parse(line)
  ).find(
    (candidate) => candidate.target_id === card.id,
  );
  const exportedZeffErratum = errataBytes.trim().split("\n").map((line) =>
    JSON.parse(line)
  ).find(
    (candidate) => candidate.target_id === zeff.id,
  );
  const exportedPrinting = printingsBytes.trim().split("\n").map((line) =>
    JSON.parse(line)
  ).find(
    (candidate) => candidate.id === printing.id,
  );
  assert.equal(exportedCard.id, card.id);
  assert.match(
    exportedCard.effective_rules_text,
    /DON!! cards: Select up to 1 \{Egghead\} type card/,
  );
  assert.deepEqual(exportedCard.lifecycle, seededExportedCard.lifecycle);
  assert.deepEqual(
    exportedCard.source_lineages,
    seededExportedCard.source_lineages,
  );
  assert.equal(exportedErratum.target_id, card.id);
  assert.equal(exportedErratum.target_type, "card");
  assert.equal(exportedErratum.effective_from, null);
  assert.match(
    exportedErratum.official_wording,
    /^Note: This correction applies in every game format\.\nBefore: .+\nAfter: .+$/s,
  );
  assert.match(
    exportedErratum.corrected_value,
    /DON!! cards: Select up to 1 \{Egghead\} type card/,
  );
  assert.equal(exportedZeffErratum.target_type, "card");
  assert.equal(exportedZeffErratum.target_id, zeff.id);
  assert.equal(exportedZeffErratum.effective_from, null);
  assert.match(
    exportedZeffErratum.corrected_value,
    /and you may trash 2 cards/,
  );
  assert.equal(exportedPrinting.id, printing.id);
  assert.match(
    exportedPrinting.printed_rules_text,
    /DON!! cards Select up to 1 \{Egghead\}/,
  );
  assert.deepEqual(
    exportedPrinting.lifecycle,
    seededExportedPrinting.lifecycle,
  );
  assert.deepEqual(
    exportedPrinting.locator_evidence,
    seededExportedPrinting.locator_evidence,
  );
  assert.deepEqual(
    exportedPrinting.relationship_evidence,
    seededExportedPrinting.relationship_evidence,
  );
  assert.deepEqual(
    exportedPrinting.source_lineages,
    seededExportedPrinting.source_lineages,
  );
  const erratumRelationship = relationshipBytes.trim().split("\n").map(
    (line) => JSON.parse(line),
  ).find(
    (candidate) =>
      candidate.kind === "erratum-target" &&
      candidate.from.id === exportedErratum.id,
  );
  assert.equal(erratumRelationship.to.id, card.id);
  assert.equal(erratumRelationship.source_lineage, "one-piece-en");
  assert.equal(erratumRelationship.source_observation_ids.length, 1);
  assert.doesNotMatch(
    cardsBytes + printingsBytes + errataBytes + relationshipBytes,
    /snapshot|raw_payload/i,
  );

  const repeatedRun = await collectSource(
    {
      adapter: "one-piece-official-errata-html@1",
      idempotencyKey: "errata-runtime-source-repeated",
      requestId: "one-piece-en:errata",
      url: "https://en.onepiece-cardgame.com/rules/errata_card/",
    },
    cliEnvironment,
    runtime,
  );
  await resumeAndWait(repeatedRun.id, cliEnvironment, runtime);
  const repeatedCandidate = await reconcileAndWait(
    repeatedRun.id,
    revisionId,
    "reconcile-repeated-bandai-errata-html",
    cliEnvironment,
    runtime,
  );
  const repeatedErratum = repeatedCandidate.errata.find(
    (candidate) => candidate.id === exportedErratum.id,
  );
  assert.notEqual(repeatedErratum, undefined);
  const accumulatedErrataEvidenceIds = repeatedErratum.provenance.map(
    ({ source_observation_id }) => source_observation_id,
  ).sort();
  assert.equal(accumulatedErrataEvidenceIds.length, 2);
  assert.deepEqual(
    accumulatedErrataEvidenceIds.filter((id) =>
      effectiveRulesEvidenceIds.includes(id)
    ),
    effectiveRulesEvidenceIds,
  );
  const repeatedRevision = await approveCandidate(
    repeatedRun.id,
    "approve-repeated-bandai-errata-html",
    cliEnvironment,
    runtime,
  );
  assert.equal(repeatedRevision, revisionId);

  const refreshRun = await collectFixtureSource(
    {
      adapter: "fixture-one-piece-json@1",
      idempotencyKey: "catalogue-refresh-after-repeated-errata",
      requestId: "published-card-list-refreshed",
      url: "https://synthetic-fixture.invalid/card-list-refreshed",
    },
    cliEnvironment,
  );
  await resumeAndWait(refreshRun.id, cliEnvironment, runtime);
  const refreshCandidate = await reconcileAndWait(
    refreshRun.id,
    repeatedRevision,
    "reconcile-catalogue-refresh-after-repeated-errata",
    cliEnvironment,
    runtime,
  );
  const refreshedErratum = refreshCandidate.errata.find(
    (candidate) => candidate.id === exportedErratum.id,
  );
  assert.notEqual(refreshedErratum, undefined);
  assert.deepEqual(
    refreshedErratum.provenance.map(
      ({ source_observation_id }) => source_observation_id,
    ).sort(),
    accumulatedErrataEvidenceIds,
  );
  const refreshRevision = await approveCandidate(
    refreshRun.id,
    "approve-catalogue-refresh-after-repeated-errata",
    cliEnvironment,
    runtime,
  );
  assert.notEqual(refreshRevision, repeatedRevision);
  const refreshedCardRead = await apiJson(
    `/v1/cards/${card.id}?include=evidence`,
    apiKey,
  );
  assert.match(
    refreshedCardRead.data.effective_rules_text,
    /DON!! cards: Select up to 1 \{Egghead\} type card/,
  );
  assert.deepEqual(
    refreshedCardRead.provenance["/data/effective_rules_text"],
    accumulatedErrataEvidenceIds,
  );
  const refreshedCardsBytes = await exportComponent(
    refreshRevision,
    "cards",
    apiKey,
  );
  const refreshedRelationshipsBytes = await exportComponent(
    refreshRevision,
    "relationships",
    apiKey,
  );
  const refreshedExportedCard = refreshedCardsBytes.trim().split("\n").map(
    (line) => JSON.parse(line),
  ).find((candidate) => candidate.id === card.id);
  const refreshedErratumRelationship = refreshedRelationshipsBytes.trim()
    .split("\n").map((line) => JSON.parse(line)).find(
      (candidate) =>
        candidate.kind === "erratum-target" &&
        candidate.from.id === exportedErratum.id,
    );
  assert.equal(
    refreshedExportedCard.effective_rules_text,
    exportedCard.effective_rules_text,
  );
  assert.deepEqual(
    refreshedErratumRelationship.source_observation_ids,
    accumulatedErrataEvidenceIds,
  );

  const omissionRun = await collectFixtureSource(
    {
      adapter: "fixture-one-piece-official-errata-json@1",
      idempotencyKey: "errata-runtime-omit-vegapunk",
      requestId: "errata-without-vegapunk",
      url: "https://synthetic-fixture.invalid/errata-without-vegapunk",
    },
    cliEnvironment,
  );
  await resumeAndWait(omissionRun.id, cliEnvironment, runtime);
  const omissionCandidate = await reconcileAndWait(
    omissionRun.id,
    refreshRevision,
    "reconcile-errata-without-vegapunk",
    cliEnvironment,
    runtime,
  );
  assert.equal(
    omissionCandidate.warnings.some(
      (warning) => warning.code === "erratum_not_observed",
    ),
    true,
  );
  const omissionRevision = await approveCandidate(
    omissionRun.id,
    "approve-errata-without-vegapunk",
    cliEnvironment,
    runtime,
  );
  const carriedCardRead = await apiJson(
    `/v1/cards/${card.id}?include=evidence`,
    apiKey,
  );
  assert.match(
    carriedCardRead.data.effective_rules_text,
    /DON!! cards: Select up to 1 \{Egghead\} type card/,
  );
  assert.deepEqual(
    carriedCardRead.provenance["/data/effective_rules_text"],
    accumulatedErrataEvidenceIds,
  );
  const carriedCardsBytes = await exportComponent(
    omissionRevision,
    "cards",
    apiKey,
  );
  const carriedExportedCard = carriedCardsBytes.trim().split("\n").map(
    (line) => JSON.parse(line),
  ).find((candidate) => candidate.id === card.id);
  assert.equal(
    carriedExportedCard.effective_rules_text,
    exportedCard.effective_rules_text,
  );
  assert.deepEqual(
    carriedExportedCard.source_lineages,
    exportedCard.source_lineages,
  );
});

function digimonOfficialPlan() {
  const urls = {
    "card-list":
      "https://world.digimoncard.com/cards/index.php?search=true",
    products: "https://world.digimoncard.com/products/",
    releases: "https://world.digimoncard.com/products/",
    "restrictions-current":
      "https://world.digimoncard.com/rule/restriction_card/",
    "restrictions-history":
      "https://world.digimoncard.com/rule/restriction_card/",
    errata: "https://world.digimoncard.com/rule/errata_card/",
  };
  return {
    supported_game: "digimon",
    source_lineage: "digimon-en",
    adapter_version: "digimon-en@2",
    requests: Object.entries(urls).map(([surface, url]) => ({
      id: `digimon-en:${surface}`,
      url,
      headers: { accept: "text/html" },
    })),
  };
}

async function collectSource(input, environment, runtime) {
  const result = await runCli(
    [
      "source",
      "collect",
      "--game",
      "one-piece",
      "--lineage",
      "one-piece-en",
      "--adapter",
      input.adapter,
      "--request-id",
      input.requestId,
      "--url",
      input.url,
      "--idempotency-key",
      input.idempotencyKey,
      "--json",
    ],
    environment,
  );
  assert.equal(
    result.code,
    0,
    `${result.stdout}\n${result.stderr}\n${runtime.getOutput()}`,
  );
  return JSON.parse(result.stdout);
}

async function collectFixtureSource(input, environment) {
  const response = await fetch(
    new URL(
      "/acceptance/synthetic-evidence",
      environment.KEEPR_INGESTION_URL,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${environment.KEEPR_ADMINISTRATION_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: input.adapter,
        idempotency_key: input.idempotencyKey,
        requests: [{
          id: input.requestId,
          method: "GET",
          url: input.url,
          headers: { accept: "application/json" },
        }],
      }),
    },
  );
  const document = await response.json();
  assert.equal(response.status, 201, JSON.stringify(document));
  return document;
}

async function resumeAndWait(runId, environment, runtime) {
  const resumed = await runCli(
    ["source", "resume", "--run-id", runId, "--json"],
    environment,
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  return waitForRunState(runId, "parsing", environment, runtime);
}

async function reconcileAndWait(
  runId,
  expectedRevision,
  idempotencyKey,
  environment,
  runtime,
) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await runCli(
      [
        "run",
        "reconcile",
        "--run-id",
        runId,
        "--expected-current-revision",
        expectedRevision,
        "--idempotency-key",
        idempotencyKey,
        "--environment",
        "production",
        "--confirm",
        environment.KEEPR_ACCEPTANCE_PRODUCTION_CONFIRMATION,
        "--yes",
        "--json",
      ],
      environment,
    );
    if (result.code === 10) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    assert.equal(
      result.code === 0 || result.code === 10,
      true,
      `${result.stdout}\n${result.stderr}\n${runtime.getOutput()}`,
    );
    const workflow = JSON.parse(result.stdout);
    if (workflow.status === "complete") return workflow.output;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Reconciliation Workflow did not complete for ${runId}`);
}

async function approveCandidate(runId, idempotencyKey, environment, runtime) {
  const inspected = await runCli(
    ["candidate", "inspect", "--run-id", runId, "--json"],
    environment,
  );
  assert.equal(inspected.code, 0, inspected.stderr);
  const candidate = JSON.parse(inspected.stdout);
  const approved = await runCli(
    [
      "run",
      "approve",
      "--run-id",
      runId,
      "--candidate-digest",
      candidate.candidate_digest,
      "--expected-current-revision",
      candidate.expected_current_revision_id,
      "--idempotency-key",
      idempotencyKey,
      "--yes",
      "--json",
    ],
    environment,
  );
  assert.equal(
    approved.code,
    0,
    `${approved.stdout}\n${approved.stderr}\n${runtime.getOutput()}`,
  );
  return JSON.parse(approved.stdout).resulting_revision_id;
}

async function writeRuntimeConfig(
  destination,
  sourceEntrypoint = "AcceptanceOfficialSourceTransport",
) {
  const config = JSON.parse(
    readFileSync(resolve(root, "apps/ingestion/wrangler.jsonc"), "utf8"),
  );
  const apiConfig = JSON.parse(
    readFileSync(resolve(root, "apps/api/wrangler.jsonc"), "utf8"),
  );
  delete config.$schema;
  config.name = "card-keepr-combined-acceptance-runtime";
  config.main = resolve(
    root,
    "acceptance/fixtures/combined-card-keepr-runtime.ts",
  );
  config.d1_databases[0].migrations_dir = resolve(root, "migrations");
  config.services = [{
    binding: "OFFICIAL_SOURCE_TRANSPORT",
    service: config.name,
    entrypoint: sourceEntrypoint,
  }];
  config.ratelimits.find(
    ({ name }) => name === "ADMINISTRATION_RATE_LIMIT",
  ).simple.limit = 300;
  config.ratelimits.push(...apiConfig.ratelimits);
  config.vars.CORS_ALLOWED_ORIGINS = apiConfig.vars.CORS_ALLOWED_ORIGINS;
  await writeFile(destination, JSON.stringify(config));
}

function applyMigrations(config, statePath) {
  const result = spawnSync(
    resolve(root, "node_modules/.bin/wrangler"),
    [
      "d1",
      "migrations",
      "apply",
      "CATALOGUE_DB",
      "--local",
      "--config",
      config,
      "--persist-to",
      statePath,
    ],
    {
      cwd: root,
      env: {
        ...processEnvWithoutSecrets(),
        CI: "1",
        WRANGLER_LOG_PATH: join(statePath, "logs"),
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function startWorker({ config, envFile, inspectorPort, port, statePath }) {
  let output = "";
  const child = spawn(
    resolve(root, "node_modules/.bin/wrangler"),
    [
      "dev",
      "--config",
      config,
      "--env-file",
      envFile,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      statePath,
      "--log-level",
      "error",
      "--show-interactive-dev-session",
      "false",
    ],
    {
      cwd: root,
      env: {
        ...processEnvWithoutSecrets(),
        WRANGLER_LOG_PATH: join(statePath, "logs"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return { process: child, getOutput: () => output };
}

async function waitForHealth(worker, port, key, name) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (worker.process.exitCode !== null) {
      throw new Error(`${name} exited\n${worker.getOutput()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${key}` },
      });
      if (response.ok) return;
    } catch {
      // Wrangler has not started accepting requests.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${name} did not become healthy\n${worker.getOutput()}`);
}

async function apiJson(pathname, apiKey) {
  const response = await fetch(
    `http://127.0.0.1:${runtimePort}${pathname}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function waitForRunState(id, expected, environment, runtime) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const shown = await runCli(
      ["source", "show", "--run-id", id, "--json"],
      environment,
    );
    if (shown.code === 0) {
      const document = JSON.parse(shown.stdout);
      if (document.state === expected) return document;
      if (document.state === "failed") {
        throw new Error(`${shown.stdout}\n${runtime.getOutput()}`);
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Run ${id} did not reach ${expected}\n${runtime.getOutput()}`);
}

async function waitForFailedRun(id, environment, runtime) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const shown = await runCli(
      ["source", "show", "--run-id", id, "--json"],
      environment,
    );
    if (shown.code === 0) {
      const document = JSON.parse(shown.stdout);
      if (document.state === "failed") return document;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Run ${id} did not fail closed\n${runtime.getOutput()}`);
}

async function exportComponent(revisionId, component, apiKey) {
  const response = await fetch(
    `http://127.0.0.1:${runtimePort}/v1/catalogue-exports/${revisionId}/components/${component}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  if (response.status !== 200) {
    assert.equal(response.status, 200, await response.text());
  }
  return gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
}

async function stopWorker(worker) {
  if (worker.process.exitCode !== null) return;
  worker.process.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => worker.process.once("exit", resolveExit)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
  ]);
  if (worker.process.exitCode === null) worker.process.kill("SIGKILL");
}

function runCli(arguments_, environment) {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [resolve(root, "cli/keepr.mjs"), ...arguments_],
      {
        cwd: root,
        env: { ...processEnvWithoutSecrets(), ...environment },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}

function processEnvWithoutSecrets() {
  const environment = { ...process.env };
  delete environment.KEEPR_API_KEY;
  delete environment.KEEPR_ADMINISTRATION_KEY;
  return environment;
}
