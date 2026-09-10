import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runCli, startWorker, stopWorker, waitForHealth } from "./helpers/acceptance-runtime.mjs";
import { nativeCheckpointTransport, publishNativeCollection } from "./helpers/native-catalogue-runtime.mjs";
import { syntheticSourceAdapterMigrations } from "./helpers/synthetic-source-adapters.mjs";

const root = resolve(import.meta.dirname, "..");

import {
  digimonOfficialPlan,
  collectSource,
  collectFixtureSource,
  resumeAndWait,
  reconcileAndWait,
  approveCandidate,
  writeRuntimeConfig,
  apiJson,
  exportComponent,
  administrationFetch,
} from "./helpers/errata-runtime.mjs";

test("retained Bandai Errata HTML publishes through CLI and authenticated HTTP/export seams", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-errata-"));
  const statePath = join(directory, "shared-state");
  const apiKey = crypto.randomUUID();
  const administrationKey = crypto.randomUUID();
  const environmentFile = join(directory, "runtime.env");
  const runtimeConfig = join(directory, "runtime.wrangler.json");
  const heterogeneousPlan = join(directory, "heterogeneous-plan.json");
  await Promise.all([
    writeFile(environmentFile, `API_BEARER_KEY=${apiKey}\nADMINISTRATION_KEY=${administrationKey}\n`, { mode: 0o600 }),
    writeRuntimeConfig(runtimeConfig),
    writeFile(
      heterogeneousPlan,
      JSON.stringify({
        plans: [
          {
            supported_game: "one-piece",
            source_lineage: "one-piece-en",
            adapter_version: "one-piece-official-errata-html@1",
            requests: [
              {
                id: "one-piece-en:errata",
                url: "https://en.onepiece-cardgame.com/rules/errata_card/",
                headers: { accept: "text/html" },
              },
            ],
          },
          digimonOfficialPlan(),
        ],
      }),
      { mode: 0o600 },
    ),
  ]);
  const checkpointTransport = await nativeCheckpointTransport(t, statePath, directory, runtimeConfig);
  const runtime = await startWorker({
    ...checkpointTransport,
    config: runtimeConfig,
    envFile: environmentFile,
    migrate: true,
    testMigrations: await syntheticSourceAdapterMigrations(),
    statePath,
  });
  t.after(async () => {
    await stopWorker(runtime);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(`${runtime.url}/health`, apiKey, runtime);

  const cliEnvironment = {
    // This fixture permits 300 administration requests per minute. Keep CLI,
    // inspection, polling and direct owner calls below that shared allowance.
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "250",
    KEEPR_API_KEY: apiKey,
    KEEPR_API_URL: runtime.url,
    KEEPR_ADMINISTRATION_KEY: administrationKey,
    KEEPR_INGESTION_URL: runtime.url,
  };
  const initialStatus = await runCli(["status", "--json"], cliEnvironment);
  assert.equal(initialStatus.code, 0, initialStatus.stderr);
  const initialStatusDocument = JSON.parse(initialStatus.stdout);
  const bootstrapRevision = initialStatusDocument.safe_state.current_revision_id;
  assert.deepEqual(initialStatusDocument.repairable_catalogue_revision_ids, []);
  cliEnvironment.KEEPR_ACCEPTANCE_PRODUCTION_CONFIRMATION = JSON.stringify(initialStatusDocument.production_target);

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
    detail: "One Evidence Plan cannot mix Errata-only and complete Catalogue coverage.",
  });
  const statusAfterHeterogeneousPlan = await runCli(["status", "--json"], cliEnvironment);
  assert.equal(statusAfterHeterogeneousPlan.code, 0);
  assert.equal(JSON.parse(statusAfterHeterogeneousPlan.stdout).safe_state.current_revision_id, bootstrapRevision);
  assert.equal(JSON.parse(statusAfterHeterogeneousPlan.stdout).safe_state.active_ingestion_run_id, null);

  const seedRun = await collectFixtureSource(
    {
      adapter: "fixture-one-piece-json@3",
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
  assert.equal(seedReconciled.ready, true, JSON.stringify(seedReconciled));
  const seededRevision = await approveCandidate(
    seedRun.id,
    "approve-published-errata-targets",
    cliEnvironment,
    runtime,
  );
  const seededCard = seedReconciled.cards.find((candidate) => candidate.official_identity.value === "OP03-047");
  assert.notEqual(seededCard, undefined);
  const seededPrinting = seedReconciled.printings.find((candidate) => candidate.card_id === seededCard.id);
  assert.notEqual(seededPrinting, undefined);
  const [seededCardRead, seededPrintingRead, seededCardsBytes, seededPrintingsBytes] = await Promise.all([
    apiJson(runtime.url, `/v1/cards/${seededCard.id}`, apiKey),
    apiJson(runtime.url, `/v1/printings/${seededPrinting.id}`, apiKey),
    exportComponent(runtime.url, seededRevision, "cards", apiKey),
    exportComponent(runtime.url, seededRevision, "printings", apiKey),
  ]);
  const seededExportedCard = seededCardsBytes
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((candidate) => candidate.id === seededCard.id);
  const seededExportedPrinting = seededPrintingsBytes
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((candidate) => candidate.id === seededPrinting.id);
  assert.notEqual(seededExportedCard, undefined);
  assert.notEqual(seededExportedPrinting, undefined);
  const seededManifest = await apiJson(runtime.url, `/v1/catalogue-exports/${seededRevision}`, apiKey);
  assert.equal(Object.hasOwn(seededManifest.data, "source_freshness"), false);
  assert.equal(
    seededManifest.data.components.some(({ name }) => name === "legality-rules"),
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
  const evidence = await runCli(["source", "show", "--run-id", run.id, "--json"], cliEnvironment);
  assert.equal(evidence.code, 0, evidence.stderr);
  assert.equal(JSON.parse(evidence.stdout).observation_sets[0].observation_count, 3);
  const reconciled = await reconcileAndWait(
    run.id,
    seededRevision,
    "reconcile-retained-bandai-errata-html",
    cliEnvironment,
    runtime,
  );
  assert.equal(reconciled.ready, true, JSON.stringify(reconciled));
  const revisionId = await approveCandidate(run.id, "approve-retained-bandai-errata-html", cliEnvironment, runtime);
  const card = reconciled.cards.find((candidate) => candidate.official_identity.value === "OP03-047");
  const vegapunk = reconciled.cards.find((candidate) => candidate.official_identity.value === "OP07-097");
  assert.notEqual(card, undefined);
  assert.notEqual(vegapunk, undefined);
  assert.equal(card.id, seededCard.id);
  const printing = seedReconciled.printings.find((candidate) => candidate.card_id === card.id);
  assert.notEqual(printing, undefined);
  assert.equal(printing.id, seededPrinting.id);
  const vegapunkPrinting = seedReconciled.printings.find((candidate) => candidate.card_id === vegapunk.id);
  assert.notEqual(vegapunkPrinting, undefined);

  const searched = await runCli(["cards", "search", "--query", "and you may trash 2 cards", "--json"], cliEnvironment);
  assert.equal(searched.code, 0, searched.stderr);
  assert.equal(JSON.parse(searched.stdout).data[0].id, card.id);

  const luffy = seedReconciled.cards.find((candidate) => candidate.official_identity.value === "OP01-001");
  assert.notEqual(luffy, undefined);
  for (const query of ["uffy", "ＵＦＦＹ", "op01-001"]) {
    const result = await apiJson(runtime.url, `/v1/cards?q=${encodeURIComponent(query)}`, apiKey);
    assert.equal(
      result.data.some((candidate) => candidate.id === luffy.id),
      true,
    );
  }
  const oneCharacter = await apiJson(runtime.url, "/v1/cards?q=D", apiKey);
  assert.equal(
    oneCharacter.data.some((candidate) => candidate.id === luffy.id),
    true,
  );
  const punctuationMustRemainExact = await apiJson(
    runtime.url,
    `/v1/cards?q=${encodeURIComponent("DON cards")}`,
    apiKey,
  );
  assert.equal(
    punctuationMustRemainExact.data.some((candidate) => candidate.id === card.id),
    false,
  );
  const fieldsMustNotBeConcatenated = await apiJson(
    runtime.url,
    `/v1/cards?q=${encodeURIComponent("OP01-001 Monkey")}`,
    apiKey,
  );
  assert.equal(fieldsMustNotBeConcatenated.data.length, 0);
  const maximumQuery = await fetch(`${runtime.url}/v1/cards?q=${"x".repeat(500)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(maximumQuery.status, 200, await maximumQuery.text());
  const oversizedQuery = await fetch(`${runtime.url}/v1/cards?q=${"x".repeat(501)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(oversizedQuery.status, 400);
  assert.equal((await oversizedQuery.json()).code, "invalid_parameter");

  const cardResponse = await fetch(`${runtime.url}/v1/cards/${card.id}?include=printings`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (cardResponse.status !== 200) {
    assert.equal(cardResponse.status, 200, await cardResponse.text());
  }
  const cardRead = await cardResponse.json();
  assert.match(cardRead.data.effective_rules_text, /and you may trash 2 cards/);
  const cardIncluded = cardRead.included ?? [];
  assert.equal(
    cardIncluded.some((resource) => resource.type === "printing" && resource.id === printing.id),
    true,
  );
  assert.equal(Object.hasOwn(cardRead, "provenance"), false);
  assert.equal(Object.hasOwn(cardRead.data, "source_lineages"), false);
  assert.deepEqual(cardRead.data.lifecycle, seededCardRead.data.lifecycle);
  assert.equal(Object.hasOwn(cardRead, "disagreements"), false);
  const cardEtag = cardResponse.headers.get("etag");
  assert.notEqual(cardEtag, null);
  const conditionalCard = await fetch(`${runtime.url}/v1/cards/${card.id}?include=printings`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      "if-none-match": cardEtag,
    },
  });
  const conditionalCardBody = await conditionalCard.text();
  assert.equal(conditionalCard.status, 304, conditionalCardBody);
  assert.equal(conditionalCardBody, "");
  const invalidCardInclude = await fetch(`${runtime.url}/v1/cards/${card.id}?include=unknown`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const invalidCardIncludeBody = await invalidCardInclude.json();
  assert.equal(invalidCardInclude.status, 400);
  assert.equal(invalidCardIncludeBody.code, "invalid_parameter");
  const printingRead = await apiJson(runtime.url, `/v1/printings/${printing.id}`, apiKey);
  assert.match(printingRead.data.printed_rules_text, /and trash 2 cards/);
  assert.deepEqual(printingRead.data.lifecycle, seededPrintingRead.data.lifecycle);

  assert.equal(Object.hasOwn(printingRead.data, "locator_evidence"), false);

  assert.equal(Object.hasOwn(printingRead.data, "relationship_evidence"), false);

  assert.equal(Object.hasOwn(printingRead.data, "source_lineages"), false);
  assert.deepEqual(printingRead.included, seededPrintingRead.included);

  assert.equal(Object.hasOwn(printingRead, "provenance"), false);
  const manifest = await apiJson(runtime.url, `/v1/catalogue-exports/${revisionId}`, apiKey);
  assert.equal(manifest.meta.catalogue_revision_id, revisionId);
  assert.equal(Object.hasOwn(manifest.data, "source_freshness"), false);

  const [cardsBytes, printingsBytes, errataBytes, relationshipBytes] = await Promise.all([
    exportComponent(runtime.url, revisionId, "cards", apiKey),
    exportComponent(runtime.url, revisionId, "printings", apiKey),
    exportComponent(runtime.url, revisionId, "errata", apiKey),
    exportComponent(runtime.url, revisionId, "relationships", apiKey),
  ]);
  const exportedCard = cardsBytes
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((candidate) => candidate.id === card.id);
  const exportedErratum = errataBytes
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((candidate) => candidate.target_id === card.id);
  const exportedVegapunkErratum = errataBytes
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((candidate) => candidate.target_id === vegapunkPrinting.id);
  const exportedPrinting = printingsBytes
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((candidate) => candidate.id === printing.id);
  assert.equal(exportedCard.id, card.id);
  assert.match(exportedCard.effective_rules_text, /and you may trash 2 cards/);
  assert.deepEqual(exportedCard.lifecycle, seededExportedCard.lifecycle);

  assert.equal(Object.hasOwn(exportedCard, "source_lineages"), false);
  assert.equal(exportedErratum.target_id, card.id);
  assert.equal(exportedErratum.target_type, "card");
  assert.equal(exportedErratum.effective_from, null);
  assert.match(exportedErratum.official_wording, /^\*Also applies to parallel card version\.\nBefore: .+\nAfter: .+$/s);
  assert.match(exportedErratum.corrected_value, /and you may trash 2 cards/);
  assert.equal(exportedVegapunkErratum.target_type, "printing");
  assert.equal(exportedVegapunkErratum.target_id, vegapunkPrinting.id);
  assert.equal(exportedVegapunkErratum.effective_from, null);
  assert.match(exportedVegapunkErratum.corrected_value, /DON!! cards: Select up to 1 \{Egghead\} type card/);
  assert.equal(exportedPrinting.id, printing.id);
  assert.match(exportedPrinting.printed_rules_text, /and trash 2 cards/);
  assert.deepEqual(exportedPrinting.lifecycle, seededExportedPrinting.lifecycle);

  assert.equal(Object.hasOwn(exportedPrinting, "locator_evidence"), false);

  assert.equal(Object.hasOwn(exportedPrinting, "relationship_evidence"), false);

  assert.equal(Object.hasOwn(exportedPrinting, "source_lineages"), false);
  const erratumRelationship = relationshipBytes
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((candidate) => candidate.kind === "erratum-target" && candidate.from.id === exportedErratum.id);
  assert.equal(erratumRelationship.to.id, card.id);
  assert.equal(Object.hasOwn(erratumRelationship, "source_lineage"), false);
  assert.equal(Object.hasOwn(erratumRelationship, "source_observation_ids"), false);
  assert.doesNotMatch(cardsBytes + printingsBytes + errataBytes + relationshipBytes, /snapshot|raw_payload/i);

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
  const repeatedErratum = repeatedCandidate.errata.find((candidate) => candidate.id === exportedErratum.id);
  assert.notEqual(repeatedErratum, undefined);
  const accumulatedErrataEvidenceIds = repeatedErratum.provenance
    .map(({ source_observation_id }) => source_observation_id)
    .sort();
  assert.equal(accumulatedErrataEvidenceIds.length, 2);
  const repeatedPublication = await publishNativeCollection(
    repeatedCandidate,
    "approve-repeated-bandai-errata-html",
    cliEnvironment,
    runtime,
    20_000,
  );
  const repeatedRevision = repeatedPublication.resulting_revision_id;
  // Fresh private provenance preserves unchanged consumer facts and their revision.
  assert.equal(repeatedRevision, revisionId);
  const approvedCandidate = repeatedCandidate.candidates[0];
  const approvalReplay = await administrationFetch(cliEnvironment, `${runtime.url}/v1/publications`, {
    method: "POST",
    headers: { authorization: `Bearer ${administrationKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      candidate_id: approvedCandidate.id,
      manifest_digest: approvedCandidate.manifest_digest,
      expected_game_revision_id: approvedCandidate.expected_game_revision_id,
      generation: approvedCandidate.generation,
      idempotency_key: "approve-repeated-bandai-errata-html-one-piece",
    }),
  });
  assert.equal(approvalReplay.status, 202);
  const replayedPublication = await approvalReplay.json();
  assert.equal(replayedPublication.id, repeatedPublication.id);
  assert.equal(replayedPublication.deadline, approvedCandidate.deadline);
  const repeatedStatus = await apiJson(runtime.url, `/v1/publications/${replayedPublication.id}`, administrationKey);
  assert.equal(repeatedStatus.resulting_revision_id, repeatedRevision);
  assert.equal(repeatedStatus.backup_attempt_id, repeatedPublication.backup_attempt_id);
  assert.equal(await exportComponent(runtime.url, revisionId, "errata", apiKey), errataBytes);

  const refreshRun = await collectFixtureSource(
    {
      adapter: "fixture-one-piece-json@3",
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
  const refreshedErratum = refreshCandidate.errata.find((candidate) => candidate.id === exportedErratum.id);
  assert.notEqual(refreshedErratum, undefined);
  assert.deepEqual(
    refreshedErratum.provenance.map(({ source_observation_id }) => source_observation_id).sort(),
    accumulatedErrataEvidenceIds,
  );
  const refreshRevision = await approveCandidate(
    refreshRun.id,
    "approve-catalogue-refresh-after-repeated-errata",
    cliEnvironment,
    runtime,
  );
  assert.notEqual(refreshRevision, repeatedRevision);
  const refreshedCardRead = await apiJson(runtime.url, `/v1/cards/${card.id}`, apiKey);
  assert.match(refreshedCardRead.data.effective_rules_text, /and you may trash 2 cards/);
  assert.equal(Object.hasOwn(refreshedCardRead, "provenance"), false);
  const refreshedCardsBytes = await exportComponent(runtime.url, refreshRevision, "cards", apiKey);
  const refreshedRelationshipsBytes = await exportComponent(runtime.url, refreshRevision, "relationships", apiKey);
  const refreshedExportedCard = refreshedCardsBytes
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((candidate) => candidate.id === card.id);
  const refreshedErratumRelationship = refreshedRelationshipsBytes
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((candidate) => candidate.kind === "erratum-target" && candidate.from.id === exportedErratum.id);
  assert.equal(refreshedExportedCard.effective_rules_text, exportedCard.effective_rules_text);
  assert.equal(Object.hasOwn(refreshedErratumRelationship, "source_observation_ids"), false);

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
    omissionCandidate.warnings.some((warning) => warning.code === "erratum_not_observed"),
    true,
  );
  const omissionErratum = omissionCandidate.errata.find((candidate) => candidate.id === exportedErratum.id);
  assert.notEqual(omissionErratum, undefined);
  const omissionEvidenceIds = omissionErratum.provenance
    .map(({ source_observation_id }) => source_observation_id)
    .sort();
  assert.deepEqual(omissionEvidenceIds, accumulatedErrataEvidenceIds);
  const omissionRevision = await approveCandidate(
    omissionRun.id,
    "approve-errata-without-vegapunk",
    cliEnvironment,
    runtime,
  );
  const carriedCardRead = await apiJson(runtime.url, `/v1/cards/${card.id}`, apiKey);
  assert.match(carriedCardRead.data.effective_rules_text, /and you may trash 2 cards/);
  assert.equal(Object.hasOwn(carriedCardRead, "provenance"), false);
  const carriedCardsBytes = await exportComponent(runtime.url, omissionRevision, "cards", apiKey);
  const carriedExportedCard = carriedCardsBytes
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((candidate) => candidate.id === card.id);
  assert.equal(carriedExportedCard.effective_rules_text, exportedCard.effective_rules_text);

  assert.equal(Object.hasOwn(carriedExportedCard, "source_lineages"), false);
});
