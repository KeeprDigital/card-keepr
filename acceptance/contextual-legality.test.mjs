import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  administrationPollInterval,
  runCli,
  startWorker,
  stopWorker,
  waitForResponse,
  waitForRunState,
} from "./helpers/acceptance-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const apiSchema = JSON.parse(
  readFileSync(resolve(root, "prototype/formalize-implementation-contracts/schemas/api.schema.json"), "utf8"),
);
const exportManifestSchemaV5 = JSON.parse(
  readFileSync(
    resolve(root, "prototype/formalize-implementation-contracts/schemas/catalogue-export-manifest-v5.schema.json"),
    "utf8",
  ),
);
const exportRecordSchemaV5 = JSON.parse(
  readFileSync(
    resolve(root, "prototype/formalize-implementation-contracts/schemas/catalogue-export-record-v5.schema.json"),
    "utf8",
  ),
);
const gzipGolden = JSON.parse(
  readFileSync(resolve(root, "acceptance/fixtures/catalogue-export-gzip-golden.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(exportManifestSchemaV5);
ajv.addSchema(apiSchema);
ajv.addSchema(exportRecordSchemaV5);
const validateLegalityStatus = ajv.getSchema(`${apiSchema.$id}#/$defs/LegalityStatusDocument`);
const validateProblem = ajv.getSchema(`${apiSchema.$id}#/$defs/Problem`);
const validateLegalityRuleExport = ajv.getSchema(`${exportRecordSchemaV5.$id}#/$defs/LegalityRuleRecord`);
const validateCatalogueExportDocument = ajv.getSchema(`${apiSchema.$id}#/$defs/CatalogueExportDocument`);

test("the public CLI fails closed for incomplete production source plans", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-contextual-legality-fail-closed-"));
  const administrationKey = crypto.randomUUID();
  const ingestionConfig = await localConfig("apps/ingestion/wrangler.jsonc", directory, "fail-closed-ingestion");
  const ingestionEnv = join(directory, "fail-closed-ingestion.env");
  await writeFile(ingestionEnv, `ADMINISTRATION_KEY=${administrationKey}\n`, { mode: 0o600 });
  const ingestion = await startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    migrate: true,
    statePath: join(directory, "state"),
  });
  t.after(async () => {
    await stopWorker(ingestion);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForResponse(`${ingestion.url}/health`, ingestion, "fail-closed ingestion Worker", {
    authorization: `Bearer ${administrationKey}`,
  });
  const result = await runCli(
    [
      "source",
      "collect",
      "--game",
      "gundam",
      "--lineage",
      "gundam-en-asia",
      "--adapter",
      "gundam-en-asia@7",
      "--request-id",
      "discovery",
      "--url",
      "https://www.gundam-gcg.com/asia-en/contextual-legality",
      "--idempotency-key",
      "acceptance-undemonstrated-json",
      "--json",
    ],
    {
      KEEPR_ADMINISTRATION_KEY: administrationKey,
      KEEPR_INGESTION_URL: ingestion.url,
    },
  );
  assert.equal(result.code, 8, result.stderr);
  assert.equal(JSON.parse(result.stdout).code, "incomplete_source_plan");
});

test("Legality Rules flow from test-owned domain evidence to contextual consumer results", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-contextual-legality-"));
  const statePath = join(directory, "state");
  const administrationKey = crypto.randomUUID();
  const apiKey = crypto.randomUUID();
  const sourceServiceName = `card-keepr-contextual-legality-source-${process.pid}`;
  const sourceConfig = await localConfig(
    "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    directory,
    "source",
    { name: sourceServiceName },
  );
  const ingestionConfig = await localConfig("apps/ingestion/wrangler.jsonc", directory, "ingestion", {
    main: resolve(root, "acceptance/fixtures/contextual-legality-ingestion-harness.ts"),
    services: [
      {
        binding: "OFFICIAL_SOURCE_TRANSPORT",
        service: sourceServiceName,
      },
    ],
  });
  const apiConfig = await localConfig("apps/api/wrangler.jsonc", directory, "api");
  const ingestionEnv = join(directory, "ingestion.env");
  const apiEnv = join(directory, "api.env");
  await Promise.all([
    writeFile(ingestionEnv, `ADMINISTRATION_KEY=${administrationKey}\n`, { mode: 0o600 }),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
  ]);

  const source = await startWorker({
    config: sourceConfig,
    statePath: join(directory, "source-state"),
  });
  let ingestion = await startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    migrate: true,
    statePath,
  });
  let api = null;
  // The API Worker is booted and stopped repeatedly against one published
  // state; every boot after the first reuses the ports of the boot it
  // replaces.
  let apiPort;
  let apiInspectorPort;
  t.after(async () => {
    await Promise.all([stopWorker(source), stopWorker(ingestion), api === null ? Promise.resolve() : stopWorker(api)]);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    waitForResponse(`${source.url}/contextual-legality-domain-asia`, source, "test-owned domain source"),
    waitForResponse(`${ingestion.url}/health`, ingestion, "ingestion Worker", {
      authorization: `Bearer ${administrationKey}`,
    }),
  ]);
  const administrationEnvironment = {
    KEEPR_ADMINISTRATION_KEY: administrationKey,
    KEEPR_INGESTION_URL: ingestion.url,
  };
  const restartIngestion = async () => {
    const { inspectorPort, port } = ingestion;
    await stopWorker(ingestion);
    ingestion = await startWorker({
      config: ingestionConfig,
      envFile: ingestionEnv,
      inspectorPort,
      port,
      statePath,
    });
    await waitForResponse(`${ingestion.url}/health`, ingestion, "restarted ingestion Worker", {
      authorization: `Bearer ${administrationKey}`,
    });
  };
  const startApi = async (description) => {
    api = await startWorker({
      config: apiConfig,
      envFile: apiEnv,
      inspectorPort: apiInspectorPort,
      port: apiPort,
      statePath,
    });
    apiPort = api.port;
    apiInspectorPort = api.inspectorPort;
    await waitForResponse(`${api.url}/health`, api, description, {
      authorization: `Bearer ${apiKey}`,
    });
  };

  const asia = await ingestAndReconcile({
    adapter: "fixture-gundam-en-asia-json@2",
    idempotencyKey: "acceptance-contextual-legality-asia",
    lineage: "gundam-en-asia",
    sourcePath: "/contextual-legality-domain-asia",
    environment: administrationEnvironment,
    ingestion,
  });
  const cards = new Map(asia.cards.map((card) => [card.official_identity.value, card.id]));
  const asiaRuleId = (officialId) => canonicalRuleId("gundam-en-asia", officialId);
  const usRuleId = (officialId) => canonicalRuleId("gundam-en-us", officialId);
  assert.equal(asia.legality_rules.length, 16);
  const asiaPublication = await approve(asia, "approve-acceptance-contextual-legality-asia", administrationEnvironment);
  assert.equal(asiaPublication.state, "published");
  const asiaRevisionId = asiaPublication.resulting_revision_id;
  assert.match(asiaRevisionId, /^catrev_/);

  const reorderedAsia = await ingestAndReconcile({
    adapter: "fixture-gundam-en-asia-json@2",
    idempotencyKey: "acceptance-contextual-legality-asia-reordered",
    lineage: "gundam-en-asia",
    sourcePath: "/contextual-legality-domain-asia?order=reversed",
    environment: administrationEnvironment,
    ingestion,
  });
  const originalEligibleRule = asia.legality_rules.find((rule) => rule.official_id === "legality_rule_asia_eligible");
  const reorderedEligibleRule = reorderedAsia.legality_rules.find(
    (rule) => rule.official_id === "legality_rule_asia_eligible",
  );
  const reorderedAsiaPublication = await approve(
    reorderedAsia,
    "approve-acceptance-contextual-legality-asia-reordered",
    administrationEnvironment,
  );
  await t.test("reordered identical rules refresh approval evidence without minting a revision", () => {
    assert.notEqual(reorderedEligibleRule.source_observation_pointer, originalEligibleRule.source_observation_pointer);
    assert.notEqual(reorderedAsia.candidate_digest, asia.candidate_digest);
    assert.equal(reorderedAsiaPublication.publication_outcome, "no_change");
    assert.equal(reorderedAsiaPublication.resulting_revision_id, asiaRevisionId);
  });

  const us = await ingestAndReconcile({
    adapter: "fixture-gundam-en-us-json@2",
    idempotencyKey: "acceptance-contextual-legality-us",
    lineage: "gundam-en-us",
    sourcePath: "/contextual-legality-domain-us",
    environment: administrationEnvironment,
    ingestion,
  });
  assert.equal(us.cards[0].id, cards.get("GD30-001"));
  const usPublication = await approve(us, "approve-acceptance-contextual-legality-us", administrationEnvironment);
  const usRevisionId = usPublication.resulting_revision_id;
  assert.match(usRevisionId, /^catrev_/);
  const usExpanded = await ingestAndReconcile({
    adapter: "fixture-gundam-en-us-json@2",
    idempotencyKey: "acceptance-contextual-legality-us-expanded",
    lineage: "gundam-en-us",
    sourcePath: "/contextual-legality-domain-us?rules=expanded",
    environment: administrationEnvironment,
    ingestion,
  });
  const addedUsRuleIds = usExpanded.legality_rules
    .filter((rule) => !us.legality_rules.some((prior) => prior.id === rule.id))
    .map((rule) => rule.id)
    .sort();
  const inspectedUsExpandedResult = await runCli(
    ["candidate", "inspect", "--run-id", usExpanded.run_id, "--json"],
    administrationEnvironment,
  );
  assert.equal(
    inspectedUsExpandedResult.code,
    0,
    `${inspectedUsExpandedResult.stdout}\n${inspectedUsExpandedResult.stderr}`,
  );
  const inspectedUsExpanded = JSON.parse(inspectedUsExpandedResult.stdout);
  await t.test("a legality-only candidate reports its rule additions before approval", () => {
    assert.ok(addedUsRuleIds.length > 0);
    assert.deepEqual(inspectedUsExpanded.diff.cards.added, []);
    assert.deepEqual(inspectedUsExpanded.diff.cards.changed, []);
    assert.deepEqual(inspectedUsExpanded.diff.printings.added, []);
    assert.deepEqual(inspectedUsExpanded.diff.printings.changed, []);
    assert.deepEqual(inspectedUsExpanded.diff.legality_rules.added, addedUsRuleIds);
    assert.deepEqual(inspectedUsExpanded.diff.legality_rules.changed, []);
    assert.deepEqual(
      inspectedUsExpanded.diff.legality_rules.lifecycle.current,
      usExpanded.legality_rules.map((rule) => rule.id).sort(),
    );
    assert.deepEqual(inspectedUsExpanded.diff.legality_rules.lifecycle.non_current, []);
    assert.equal(inspectedUsExpanded.diff.summary.legality_rules_added, addedUsRuleIds.length);
    assert.equal(inspectedUsExpanded.diff.summary.legality_rules_changed, 0);
  });
  const usExpandedPublication = await approve(
    usExpanded,
    "approve-acceptance-contextual-legality-us-expanded",
    administrationEnvironment,
  );
  const usExpandedRevisionId = usExpandedPublication.resulting_revision_id;
  assert.equal(usExpandedPublication.publication_outcome, "revision");
  assert.match(usExpandedRevisionId, /^catrev_/);
  assert.notEqual(usExpandedRevisionId, usRevisionId);
  let revisionId = usExpandedRevisionId;

  await stopWorker(ingestion);
  await startApi("API Worker after unrelated-lineage publication");
  const carriedAsiaStatus = await legalityStatus(cards.get("GD30-001"), ["--region", "EN-ASIA"], {
    KEEPR_API_KEY: apiKey,
    KEEPR_API_URL: api.url,
  });
  assert.equal(carriedAsiaStatus.data[0].status, "legal");
  const expandedRelationshipsResponse = await fetch(
    `${api.url}/v1/catalogue-exports/${usExpandedRevisionId}/components/relationships`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(expandedRelationshipsResponse.status, 200);
  const expandedRelationshipsStream = expandedRelationshipsResponse.body.pipeThrough(new DecompressionStream("gzip"));
  const expandedRelationships = (await new Response(expandedRelationshipsStream).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const carriedAsiaRelationship = expandedRelationships.find(
    (relationship) =>
      relationship.kind === "legality-rule-card" &&
      relationship.from.id === asiaRuleId("legality_rule_asia_membership"),
  );
  await t.test("an unrelated regional publication preserves carried rule observation provenance", () => {
    assert.equal(carriedAsiaRelationship.source_lineage, "gundam-en-asia");
    assert.equal(carriedAsiaRelationship.lifecycle.current, true);
    assert.equal(carriedAsiaRelationship.lifecycle.last_observed_revision_id, asiaRevisionId);
  });
  await stopWorker(api);
  api = null;
  await restartIngestion();

  const asiaRefresh = await ingestAndReconcile({
    adapter: "fixture-gundam-en-asia-json@2",
    idempotencyKey: "acceptance-contextual-legality-asia-refresh",
    lineage: "gundam-en-asia",
    sourcePath: "/contextual-legality-domain-asia?refresh=asia",
    environment: administrationEnvironment,
    ingestion,
  });
  const asiaRefreshPublication = await approve(
    asiaRefresh,
    "approve-acceptance-contextual-legality-asia-refresh",
    administrationEnvironment,
  );
  const usRefresh = await ingestAndReconcile({
    adapter: "fixture-gundam-en-us-json@2",
    idempotencyKey: "acceptance-contextual-legality-us-refresh",
    lineage: "gundam-en-us",
    sourcePath: "/contextual-legality-domain-us?refresh=us&rules=expanded",
    environment: administrationEnvironment,
    ingestion,
  });
  const usRefreshPublication = await approve(
    usRefresh,
    "approve-acceptance-contextual-legality-us-refresh",
    administrationEnvironment,
  );
  await t.test("unchanged regional refreshes preserve one revision and rule lifecycle", () => {
    assert.equal(asiaRefreshPublication.publication_outcome, "no_change");
    assert.equal(asiaRefreshPublication.resulting_revision_id, usExpandedRevisionId);
    assert.equal(usRefreshPublication.publication_outcome, "no_change");
    assert.equal(usRefreshPublication.resulting_revision_id, usExpandedRevisionId);
  });
  await restartIngestion();

  const changedIdentity = await ingestAndReconcile({
    adapter: "fixture-gundam-en-asia-json@2",
    expectedStatus: null,
    idempotencyKey: "acceptance-contextual-legality-changed-official-identity",
    lineage: "gundam-en-asia",
    sourcePath: "/contextual-legality-domain-asia?semantics=changed",
    environment: administrationEnvironment,
    ingestion,
  });
  await t.test("changed semantics under one official rule identity block before approval", () => {
    assert.equal(changedIdentity.http_status, 409);
    assert.equal(changedIdentity.publishable, false);
    assert.equal(changedIdentity.state, "failed");
    assert.match(changedIdentity.diagnostics[0].detail, /official identity.*changed semantics|new official identity/i);
  });
  if (changedIdentity.state === "awaiting_approval") {
    await reject(
      changedIdentity,
      "reject-acceptance-contextual-legality-changed-official-identity",
      administrationEnvironment,
    );
  }
  await restartIngestion();

  const invalidCopyLimit = await ingestAndReconcile({
    adapter: "fixture-gundam-en-asia-json@2",
    expectedStatus: 409,
    idempotencyKey: "acceptance-contextual-legality-invalid-copy-limit",
    lineage: "gundam-en-asia",
    sourcePath: "/contextual-legality-domain-asia?copy-limit=zero",
    environment: administrationEnvironment,
    ingestion,
  });
  await t.test("an invalid copy-limit operand blocks before approval", () => {
    assert.equal(invalidCopyLimit.state, "failed");
    assert.equal(invalidCopyLimit.publishable, false);
    assert.match(invalidCopyLimit.diagnostics[0].detail, /copy-limit rule requires a positive integer/i);
  });
  if (invalidCopyLimit.state === "awaiting_approval") {
    await reject(
      invalidCopyLimit,
      "reject-acceptance-contextual-legality-invalid-copy-limit",
      administrationEnvironment,
    );
  }
  await restartIngestion();

  const missing = await ingestAndReconcile({
    adapter: "fixture-gundam-en-asia-json@2",
    idempotencyKey: "acceptance-contextual-legality-missing",
    lineage: "gundam-en-asia",
    sourcePath: "/contextual-legality-domain-asia?rules=empty",
    environment: administrationEnvironment,
    ingestion,
  });
  const missingPublication = await approve(
    missing,
    "approve-acceptance-contextual-legality-missing",
    administrationEnvironment,
  );
  const missingRevisionId = missingPublication.resulting_revision_id;
  await t.test("a complete missing rule observation publishes a new lifecycle revision", () => {
    assert.equal(missingPublication.publication_outcome, "revision");
    assert.match(missingRevisionId, /^catrev_/);
    assert.notEqual(missingRevisionId, usRevisionId);
  });

  await stopWorker(ingestion);
  await startApi("API Worker at missing-rule revision");
  const missingRuleResponse = await fetch(
    `${api.url}/v1/legality-status?card_id=${cards.get("GD30-001")}&on=2026-07-30&format=standard&event_tier=championship&region=EN-ASIA`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  const missingRuleDocument = await missingRuleResponse.json();
  const missingRegionalDocument = await legalityStatus(cards.get("GD30-001"), [], {
    KEEPR_API_KEY: apiKey,
    KEEPR_API_URL: api.url,
  });
  const missingRulesResponse = await fetch(
    `${api.url}/v1/catalogue-exports/${missingRevisionId}/components/legality-rules`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(missingRulesResponse.status, 200);
  const missingRulesText = await new Response(
    missingRulesResponse.body.pipeThrough(new DecompressionStream("gzip")),
  ).text();
  const missingExportedRules = missingRulesText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const missingGlobalRule = missingExportedRules.find((rule) => rule.id === asiaRuleId("legality_rule_asia_eligible"));
  const effectiveHistoricalRuleIds = [
    "legality_rule_asia_eligible",
    "legality_rule_asia_membership",
    "legality_rule_asia_release_timing",
    "legality_rule_asia_rotation",
  ]
    .map(asiaRuleId)
    .sort();
  await t.test("a global-scope exported rule carries provenance and non-current lifecycle", () => {
    assert.equal(missingGlobalRule.source_lineage, "gundam-en-asia");
    assert.equal(missingGlobalRule.source_observation_ids.length, 1);
    assert.match(missingGlobalRule.source_observation_ids[0], /^srcobs_/);
    assert.equal(missingGlobalRule.lifecycle.current, false);
    assert.equal(missingGlobalRule.lifecycle.last_missing_revision_id, missingRevisionId);
    assert.deepEqual(
      missingExportedRules
        .filter((rule) => rule.source_lineage === "gundam-en-asia" && rule.lifecycle.current === false)
        .map((rule) => rule.id)
        .filter((id) => effectiveHistoricalRuleIds.includes(id))
        .sort(),
      effectiveHistoricalRuleIds,
    );
  });
  await t.test(
    "a complete omission removes historical rules from the current authenticated status while retaining audit history",
    () => {
      assert.equal(missingRuleResponse.status, 200);
      assert.equal(missingRuleDocument.data[0].status, "indeterminate");
      assert.deepEqual(missingRuleDocument.data[0].rule_ids, []);
      assert.match(missingRuleDocument.data[0].derivation, /no effective published Legality Rule/i);
    },
  );
  await t.test("omitting region does not carry non-current historical rules into any current regional status", () => {
    assert.deepEqual(
      missingRegionalDocument.data.map((result) => result.region),
      ["EN-ASIA", "EN-US"],
    );
    const asiaResult = missingRegionalDocument.data.find((result) => result.region === "EN-ASIA");
    assert.equal(asiaResult.card_id, cards.get("GD30-001"));
    assert.equal(asiaResult.on, "2026-07-30");
    assert.equal(asiaResult.format, "standard");
    assert.equal(asiaResult.event_tier, "championship");
    assert.equal(asiaResult.status, "indeterminate");
    assert.deepEqual(asiaResult.rule_ids, []);
    assert.match(asiaResult.derivation, /no effective published Legality Rule/i);
  });
  await stopWorker(api);
  api = null;
  await restartIngestion();

  const reappeared = await ingestAndReconcile({
    adapter: "fixture-gundam-en-asia-json@2",
    idempotencyKey: "acceptance-contextual-legality-reappeared",
    lineage: "gundam-en-asia",
    sourcePath: "/contextual-legality-domain-asia?rules=current",
    environment: administrationEnvironment,
    ingestion,
  });
  const reappearedPublication = await approve(
    reappeared,
    "approve-acceptance-contextual-legality-reappeared",
    administrationEnvironment,
  );
  revisionId = reappearedPublication.resulting_revision_id;
  const expectedAsiaRuleAudit = (officialId) => {
    const observed = asia.legality_rules.find((rule) => rule.official_id === officialId);
    assert.ok(observed, `missing canonical rule ${officialId}`);
    return {
      source_lineage: "gundam-en-asia",
      source_observation_ids: [observed.source_observation_id],
      source_observation_pointer: observed.source_observation_pointer,
      source_field_pointers: observed.source_field_pointers,
      lifecycle: {
        first_revision_id: asiaRevisionId,
        last_observed_revision_id: revisionId,
        current: true,
        last_missing_revision_id: missingRevisionId,
      },
    };
  };
  await t.test("the same unchanged official identities reappear in a new revision", () => {
    assert.equal(reappearedPublication.publication_outcome, "revision");
    assert.match(revisionId, /^catrev_/);
    assert.notEqual(revisionId, missingRevisionId);
  });
  await restartIngestion();

  for (const membershipVariant of ["unknown-attribute", "unknown-enum-value"]) {
    const invalidMembership = await ingestAndReconcile({
      adapter: "fixture-gundam-en-asia-json@2",
      expectedStatus: null,
      idempotencyKey: `acceptance-contextual-legality-${membershipVariant}`,
      lineage: "gundam-en-asia",
      sourcePath: `/contextual-legality-domain-asia?membership=${membershipVariant}`,
      environment: administrationEnvironment,
      ingestion,
    });
    await t.test(`membership operand ${membershipVariant} blocks before approval`, () => {
      assert.equal(invalidMembership.http_status, 409);
      assert.equal(invalidMembership.publishable, false);
      assert.equal(invalidMembership.state, "failed");
      assert.match(
        invalidMembership.diagnostics[0].detail,
        membershipVariant === "unknown-attribute" ? /traitz/ : /bluue/,
      );
    });
    if (invalidMembership.state === "awaiting_approval") {
      await reject(
        invalidMembership,
        `reject-acceptance-contextual-legality-${membershipVariant}`,
        administrationEnvironment,
      );
    }
  }
  await restartIngestion();

  const blocked = await ingestAndReconcile({
    adapter: "fixture-gundam-en-asia-json@2",
    expectedStatus: 409,
    idempotencyKey: "acceptance-contextual-legality-unrepresentable",
    lineage: "gundam-en-asia",
    sourcePath: "/contextual-legality-domain-asia?representable=false",
    environment: administrationEnvironment,
    ingestion,
  });
  assert.equal(blocked.state, "failed");
  assert.equal(blocked.publishable, false);
  assert.match(blocked.diagnostics[0].detail, /cannot be represented without invented precision/i);

  await stopWorker(ingestion);
  await startApi("API Worker");
  const apiEnvironment = {
    KEEPR_API_KEY: apiKey,
    KEEPR_API_URL: api.url,
  };
  const scopedStatusUrl =
    `${api.url}/v1/legality-status` +
    `?card_id=${cards.get("GD30-001")}` +
    "&on=2026-07-30&format=standard" +
    "&event_tier=championship&region=EN-ASIA";
  const scopedResponse = await fetch(scopedStatusUrl, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      origin: "http://localhost:3000",
    },
  });
  const scopedDocument = await scopedResponse.json();
  await t.test("the authenticated scoped response is revision-bound, cacheable, and CORS-readable", () => {
    assert.equal(scopedResponse.status, 200);
    assert.equal(validateLegalityStatus(scopedDocument), true, JSON.stringify(validateLegalityStatus.errors));
    assert.equal(scopedDocument.data.length, 1);
    assert.equal(scopedDocument.data[0].region, "EN-ASIA");
    assert.equal(scopedDocument.meta.catalogue_revision_id, revisionId);
    assert.equal(scopedResponse.headers.get("x-catalogue-revision"), revisionId);
    assert.match(scopedResponse.headers.get("etag") ?? "", /^"[a-f0-9]{64}"$/);
    assert.equal(scopedResponse.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal(scopedResponse.headers.get("access-control-expose-headers"), "ETag, X-Catalogue-Revision");
  });
  const conditionalResponse = await fetch(scopedStatusUrl, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      "if-none-match": scopedResponse.headers.get("etag"),
      origin: "http://localhost:3000",
    },
  });
  await t.test("the scoped response honors its exact ETag", async () => {
    assert.equal(conditionalResponse.status, 304);
    assert.equal(await conditionalResponse.text(), "");
    assert.equal(conditionalResponse.headers.get("x-catalogue-revision"), revisionId);
    assert.equal(conditionalResponse.headers.get("access-control-allow-origin"), "http://localhost:3000");
  });
  const unauthenticatedResponse = await fetch(scopedStatusUrl, {
    headers: { origin: "http://localhost:3000" },
  });
  const unauthenticatedProblem = await unauthenticatedResponse.json();
  await t.test("the Legality Status authentication failure is a CORS-shaped Problem", () => {
    assert.equal(unauthenticatedResponse.status, 401);
    assert.equal(validateProblem(unauthenticatedProblem), true, JSON.stringify(validateProblem.errors));
    assert.equal(unauthenticatedProblem.code, "authentication_required");
    assert.equal(unauthenticatedResponse.headers.get("access-control-allow-origin"), "http://localhost:3000");
  });
  const cases = [
    ["GD30-001", "legal"],
    ["GD30-002", "restricted"],
    ["GD30-003", "not_legal"],
    ["GD30-004", "indeterminate"],
  ];
  for (const [number, expected] of cases) {
    const document = await legalityStatus(cards.get(number), ["--region", "EN-ASIA"], apiEnvironment);
    assert.equal(validateLegalityStatus(document), true, JSON.stringify(validateLegalityStatus.errors));
    assert.equal(document.data[0].status, expected);
    if (number === "GD30-004") {
      assert.ok(document.data[0].rule_ids.length > 0);
      assert.deepEqual(document.data[0].unresolved_scope_rule_ids, [asiaRuleId("legality_rule_asia_unresolved_scope")]);
    } else {
      assert.ok(document.data[0].rule_ids.length > 0);
      assert.deepEqual(document.data[0].unresolved_scope_rule_ids, []);
    }
    assert.match(document.data[0].derivation, /legality_rule_[a-f0-9]{64}/);
  }

  await t.test("an unresolved target scope answers every overlapping query explicitly indeterminate", async () => {
    const targetScopeStatus = async (number) => {
      const response = await fetch(
        `${api.url}/v1/legality-status` +
          `?card_id=${cards.get(number)}` +
          "&on=2026-07-30&format=gunpla-battle&region=EN-ASIA",
        { headers: { authorization: `Bearer ${apiKey}` } },
      );
      assert.equal(response.status, 200);
      return response.json();
    };
    // GD30-001 is outside the enumerated matches, but the open predicate
    // covers future printings, so the query overlaps the uncertainty.
    const open = await targetScopeStatus("GD30-001");
    assert.equal(validateLegalityStatus(open), true, JSON.stringify(validateLegalityStatus.errors));
    assert.equal(open.data[0].status, "indeterminate");
    assert.deepEqual(open.data[0].rule_ids, []);
    assert.deepEqual(open.data[0].unresolved_scope_rule_ids, [asiaRuleId("legality_rule_asia_open_predicate")]);
    assert.match(open.data[0].derivation, /unresolved scope/);
    // An enumerated match answers the same explicit uncertainty once.
    const enumerated = await targetScopeStatus("GD30-002");
    assert.equal(enumerated.data[0].status, "indeterminate");
    assert.deepEqual(enumerated.data[0].unresolved_scope_rule_ids, [asiaRuleId("legality_rule_asia_open_predicate")]);
    // The Standard-format cases above keep answering normally: the
    // target-scope rule never leaks outside its own format context.
  });

  const nullableMembership = await legalityStatus(cards.get("GD30-005"), ["--region", "EN-ASIA"], apiEnvironment);
  await t.test("a valid membership rule with a nullable canonical attribute is indeterminate", () => {
    assert.equal(nullableMembership.data[0].status, "indeterminate");
    assert.ok(nullableMembership.data[0].rule_ids.includes(asiaRuleId("legality_rule_asia_nullable_membership")));
    assert.match(
      nullableMembership.data[0].derivation,
      new RegExp(`${asiaRuleId("legality_rule_asia_nullable_membership")} \\(membership\\) evaluated indeterminate`),
    );
  });

  const beforeRelease = await legalityStatus(
    cards.get("GD30-001"),
    ["--on", "2025-12-31", "--region", "EN-ASIA"],
    apiEnvironment,
  );
  assert.equal(beforeRelease.data[0].status, "not_legal");
  assert.deepEqual(beforeRelease.data[0].rule_ids, [asiaRuleId("legality_rule_asia_release_timing")]);

  const regional = await legalityStatus(cards.get("GD30-001"), [], apiEnvironment);
  assert.deepEqual(
    regional.data.map((result) => result.region),
    ["EN-ASIA", "EN-US"],
  );
  assert.equal(regional.data[0].status, "legal");
  assert.equal(regional.data[1].status, "legal");

  const championshipTier = await legalityStatus(cards.get("GD30-002"), ["--region", "EN-ASIA"], apiEnvironment);
  const withoutEventTier = await runCli(
    [
      "legality",
      "status",
      "--card-id",
      cards.get("GD30-002"),
      "--on",
      "2026-07-30",
      "--format",
      "standard",
      "--region",
      "EN-ASIA",
      "--json",
    ],
    apiEnvironment,
  );
  assert.equal(withoutEventTier.code, 0, withoutEventTier.stderr);
  const withoutEventTierDocument = JSON.parse(withoutEventTier.stdout);
  assert.deepEqual(
    championshipTier.data[0].rule_ids,
    [
      asiaRuleId("legality_rule_asia_eligible"),
      asiaRuleId("legality_rule_asia_copy_limit"),
      asiaRuleId("legality_rule_asia_combination"),
    ].sort(),
  );
  assert.deepEqual(
    withoutEventTierDocument.data[0].rule_ids,
    [asiaRuleId("legality_rule_asia_eligible"), asiaRuleId("legality_rule_asia_combination")].sort(),
  );

  const oceania = await runCli(legalityArguments(cards.get("GD30-001"), ["--region", "EN-OCEANIA"]), apiEnvironment);
  assert.equal(oceania.code, 8);
  const oceaniaProblem = JSON.parse(oceania.stdout);
  assert.deepEqual(oceaniaProblem, {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "invalid_legality_region",
    detail: "Gundam Legality Status is available only for EN-ASIA and EN-US; EN-OCEANIA is not synthesized.",
  });

  for (const invalidCardId of ["card id with spaces", `card_${"x".repeat(196)}`]) {
    const invalidCardResponse = await fetch(
      `${api.url}/v1/legality-status?card_id=${encodeURIComponent(invalidCardId)}&on=2026-07-30&format=standard&region=EN-ASIA`,
      { headers: { authorization: `Bearer ${apiKey}` } },
    );
    const invalidCardDocument = await invalidCardResponse.json();
    await t.test(
      `card_id rejects ${invalidCardId.includes(" ") ? "invalid characters" : "overlength"} before lookup`,
      () => {
        assert.equal(invalidCardResponse.status, 400);
        assert.equal(validateProblem(invalidCardDocument), true, JSON.stringify(validateProblem.errors));
        assert.equal(invalidCardDocument.code, "invalid_parameter");
        assert.deepEqual(invalidCardDocument.invalid_params, [
          {
            name: "card_id",
            reason: "card_id must be an opaque identity of at most 200 characters.",
          },
        ]);
      },
    );
  }

  const manifestResponse = await fetch(`${api.url}/v1/catalogue-exports/${revisionId}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(manifestResponse.status, 200);
  const manifestDocument = await manifestResponse.json();
  assert.equal(
    validateCatalogueExportDocument(manifestDocument),
    true,
    JSON.stringify(validateCatalogueExportDocument.errors),
  );

  const exportResponse = await fetch(`${api.url}/v1/catalogue-exports/${revisionId}/components/legality-rules`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(exportResponse.status, 200);
  const exportBytes = new Uint8Array(await exportResponse.arrayBuffer());
  const repeatedExportResponse = await fetch(
    `${api.url}/v1/catalogue-exports/${revisionId}/components/legality-rules`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(repeatedExportResponse.status, 200);
  const repeatedExportBytes = new Uint8Array(await repeatedExportResponse.arrayBuffer());
  const exportComponent = manifestDocument.data.components.find((component) => component.name === "legality-rules");
  const emptyComponent = manifestDocument.data.components.find((component) => component.records === 0);
  assert.ok(emptyComponent);
  const emptyComponentResponse = await fetch(
    `${api.url}/v1/catalogue-exports/${revisionId}/components/${emptyComponent.name}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(emptyComponentResponse.status, 200);
  const emptyComponentBytes = new Uint8Array(await emptyComponentResponse.arrayBuffer());
  const emptyComponentText = await new Response(
    new Response(emptyComponentBytes).body.pipeThrough(new DecompressionStream("gzip")),
  ).text();
  const decompressed = new Response(exportBytes).body.pipeThrough(new DecompressionStream("gzip"));
  const exportedRulesText = await new Response(decompressed).text();
  await t.test("authenticated randomized export bytes are revision-addressed and repeatable", () => {
    assert.equal(gzipGolden.profile, "card-keepr-ndjson-gzip@1");
    assert.equal(gzipGolden.compressor, "pako@3.0.1");
    assert.deepEqual(gzipGolden.cases.empty.coverage, ["empty"]);
    assert.equal(emptyComponentText, "");
    assertGoldenComponent(emptyComponentBytes, emptyComponent, {
      ...gzipGolden.cases.empty,
      component: emptyComponent.name,
    });
    assert.deepEqual(Array.from(exportBytes.subarray(0, 4)), [0x1f, 0x8b, 0x08, 0x00]);
    assert.deepEqual(Array.from(exportBytes.subarray(4, 8)), [0x00, 0x00, 0x00, 0x00]);
    assert.equal(exportBytes[8], 0x02);
    assert.equal(exportBytes[9], 0xff);
    assert.equal((exportBytes[10] >> 1) & 0x03, 0x01);
    assert.ok(fixedDeflateBlockCount(exportBytes) > 1);
    assert.equal(createHash("sha256").update(exportBytes).digest("hex"), exportComponent.compressed_sha256);
    assert.equal(createHash("sha256").update(exportedRulesText).digest("hex"), exportComponent.content_sha256);
    assert.deepEqual(repeatedExportBytes, exportBytes);
  });
  assert.match(exportedRulesText, /"event_tier":null/);
  const exportedRules = exportedRulesText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(exportedRules.length, 19);
  assert.ok(
    exportedRules.some((rule) =>
      rule.official_wording.startsWith(
        "Café cards satisfying the published Standard eligibility rules are eligible for play. ",
      ),
    ),
  );
  assert.equal(
    exportedRules.some((rule) =>
      rule.official_wording.startsWith(
        "Cafe\u0301 cards satisfying the published Standard eligibility rules are eligible for play. ",
      ),
    ),
    false,
  );
  for (const exportedRule of exportedRules) {
    assert.equal(typeof exportedRule.source_lineage, "string");
    assert.equal(exportedRule.source_observation_ids.length, 1);
    assert.match(exportedRule.source_observation_pointer, /^\/observations\/\d+\/value\/legality_rules\/\d+$/);
    for (const field of [
      "official_wording",
      "effective_from",
      "effective_until",
      "unresolved_scope",
      "region",
      "format",
      "event_tier",
      "card_numbers",
      "effect",
    ]) {
      assert.equal(exportedRule.source_field_pointers[field], `${exportedRule.source_observation_pointer}/${field}`);
    }
    assert.equal(typeof exportedRule.lifecycle.current, "boolean");
    assert.match(exportedRule.lifecycle.first_revision_id, /^catrev_/);
    assert.match(exportedRule.lifecycle.last_observed_revision_id, /^catrev_/);
    assert.equal(validateLegalityRuleExport(exportedRule), true, JSON.stringify(validateLegalityRuleExport.errors));
  }
  await t.test("Legality Rule exports use the current schema and retain exact effects", () => {
    assert.equal(manifestDocument.data.export_schema_major, 5);
    assert.equal(
      manifestDocument.data.components.find((component) => component.name === "legality-rules").record_schema,
      "https://card-keepr.invalid/schemas/catalogue-export-record@5#/$defs/LegalityRuleRecord",
    );
  });
  await t.test("copy-limit export retains its operand", () => {
    assert.deepEqual(
      exportedRules.find((rule) => rule.official_id === "legality_rule_asia_copy_limit"),
      {
        type: "legality_rule",
        id: asiaRuleId("legality_rule_asia_copy_limit"),
        official_id: "legality_rule_asia_copy_limit",
        game: "gundam",
        region: "EN-ASIA",
        format: "standard",
        event_tier: "championship",
        effective_from: "2026-01-01",
        effective_until: null,
        unresolved_scope: null,
        kind: "restricted",
        effect: { type: "copy_limit", maximum_copies: 1 },
        card_ids: [cards.get("GD30-002")],
        official_wording: "For Championship events, decks may contain no more than one copy of GD30-002.",
        ...expectedAsiaRuleAudit("legality_rule_asia_copy_limit"),
      },
    );
  });
  await t.test("canonical rule IDs use UTF-8 byte ordering", () => {
    const exportedIds = exportedRules.map((rule) => rule.id);
    assert.deepEqual(
      exportedIds,
      [...exportedIds].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
    );
  });
  await t.test("membership export retains its predicate", () => {
    assert.deepEqual(
      exportedRules.find((rule) => rule.official_id === "legality_rule_asia_membership"),
      {
        type: "legality_rule",
        id: asiaRuleId("legality_rule_asia_membership"),
        official_id: "legality_rule_asia_membership",
        game: "gundam",
        region: "EN-ASIA",
        format: "standard",
        event_tier: null,
        effective_from: "2026-01-01",
        effective_until: null,
        unresolved_scope: null,
        kind: "conditional",
        effect: {
          type: "membership",
          attribute: "traits",
          includes_any: ["Earth Federation"],
        },
        card_ids: [cards.get("GD30-001")],
        official_wording: "Cards with the Earth Federation trait are eligible for this event.",
        ...expectedAsiaRuleAudit("legality_rule_asia_membership"),
      },
    );
  });
  await t.test("release-timing export matches temporal API semantics", () => {
    assert.deepEqual(
      exportedRules.find((rule) => rule.official_id === "legality_rule_asia_release_timing"),
      {
        type: "legality_rule",
        id: asiaRuleId("legality_rule_asia_release_timing"),
        official_id: "legality_rule_asia_release_timing",
        game: "gundam",
        region: "EN-ASIA",
        format: "standard",
        event_tier: null,
        effective_from: "2025-01-01",
        effective_until: null,
        unresolved_scope: null,
        kind: "release",
        effect: {
          type: "release_timing",
          legal_from: "2026-01-01",
        },
        card_ids: [cards.get("GD30-001")],
        official_wording: "GD30-001 becomes legal for tournament play on 1 January 2026.",
        ...expectedAsiaRuleAudit("legality_rule_asia_release_timing"),
      },
    );
  });
  await t.test("unresolved export matches indeterminate API semantics", () => {
    assert.deepEqual(
      exportedRules.find((rule) => rule.official_id === "legality_rule_asia_unresolved_scope"),
      {
        type: "legality_rule",
        id: asiaRuleId("legality_rule_asia_unresolved_scope"),
        official_id: "legality_rule_asia_unresolved_scope",
        game: "gundam",
        region: "EN-ASIA",
        format: "standard",
        event_tier: null,
        effective_from: null,
        effective_until: null,
        unresolved_scope: {
          dimensions: ["effective_interval", "event_tier"],
        },
        kind: "indeterminate",
        effect: {
          type: "unresolved",
          reason: "The event-tier scope is absent from the official notice.",
        },
        card_ids: [cards.get("GD30-004")],
        official_wording: "The official notice does not identify whether GD30-004 applies to Championship side events.",
        ...expectedAsiaRuleAudit("legality_rule_asia_unresolved_scope"),
      },
    );
  });

  const relationshipsResponse = await fetch(`${api.url}/v1/catalogue-exports/${revisionId}/components/relationships`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(relationshipsResponse.status, 200);
  const relationshipsStream = relationshipsResponse.body.pipeThrough(new DecompressionStream("gzip"));
  const exportedRelationships = (await new Response(relationshipsStream).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const asiaRelationship = exportedRelationships.find(
    (relationship) =>
      relationship.kind === "legality-rule-card" &&
      relationship.from.id === asiaRuleId("legality_rule_asia_membership"),
  );
  const usRelationship = exportedRelationships.find(
    (relationship) =>
      relationship.kind === "legality-rule-card" && relationship.from.id === usRuleId("legality_rule_us_eligible"),
  );
  assert.equal(asiaRelationship.lifecycle.first_revision_id, asiaRevisionId);
  assert.equal(usRelationship.lifecycle.first_revision_id, usRevisionId);
  assert.equal(asiaRelationship.source_lineage, "gundam-en-asia");
  assert.equal(usRelationship.source_lineage, "gundam-en-us");
  assert.equal(asiaRelationship.lifecycle.current, true);
  assert.equal(asiaRelationship.lifecycle.last_observed_revision_id, revisionId);
  assert.equal(asiaRelationship.lifecycle.last_missing_revision_id, missingRevisionId);

  await stopWorker(api);
  api = null;
  await restartIngestion();
  const missingAgain = await ingestAndReconcile({
    adapter: "fixture-gundam-en-asia-json@2",
    idempotencyKey: "acceptance-contextual-legality-missing-again",
    lineage: "gundam-en-asia",
    sourcePath: "/contextual-legality-domain-asia?rules=empty",
    environment: administrationEnvironment,
    ingestion,
  });
  const missingAgainPublication = await approve(
    missingAgain,
    "approve-acceptance-contextual-legality-missing-again",
    administrationEnvironment,
  );
  const latestMissingRevisionId = missingAgainPublication.resulting_revision_id;
  await stopWorker(ingestion);
  await startApi("API Worker at repeated-missing revision");
  const latestRulesResponse = await fetch(
    `${api.url}/v1/catalogue-exports/${latestMissingRevisionId}/components/legality-rules`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(latestRulesResponse.status, 200);
  const latestRulesText = await new Response(
    latestRulesResponse.body.pipeThrough(new DecompressionStream("gzip")),
  ).text();
  const latestGlobalRule = latestRulesText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((rule) => rule.id === asiaRuleId("legality_rule_asia_eligible"));
  await t.test("a repeated disappearance records the latest missing revision", () => {
    assert.equal(missingAgainPublication.publication_outcome, "revision");
    assert.notEqual(latestMissingRevisionId, missingRevisionId);
    assert.equal(latestGlobalRule.lifecycle.current, false);
    assert.equal(latestGlobalRule.lifecycle.last_missing_revision_id, latestMissingRevisionId);
  });
});

test("fixture-backed DON!! ingestion reaches the authenticated consumer boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-don-legality-"));
  const statePath = join(directory, "state");
  const administrationKey = crypto.randomUUID();
  const apiKey = crypto.randomUUID();
  const sourceServiceName = `card-keepr-don-source-${process.pid}`;
  const sourceConfig = await localConfig(
    "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    directory,
    "don-source",
    { name: sourceServiceName },
  );
  const ingestionConfig = await localConfig("apps/ingestion/wrangler.jsonc", directory, "don-ingestion", {
    main: resolve(root, "acceptance/fixtures/contextual-legality-ingestion-harness.ts"),
    services: [
      {
        binding: "OFFICIAL_SOURCE_TRANSPORT",
        service: sourceServiceName,
      },
    ],
  });
  const apiConfig = await localConfig("apps/api/wrangler.jsonc", directory, "don-api");
  const ingestionEnv = join(directory, "don-ingestion.env");
  const apiEnv = join(directory, "don-api.env");
  await Promise.all([
    writeFile(ingestionEnv, `ADMINISTRATION_KEY=${administrationKey}\n`, { mode: 0o600 }),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
  ]);
  const source = await startWorker({
    config: sourceConfig,
    statePath: join(directory, "source-state"),
  });
  const ingestion = await startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    migrate: true,
    statePath,
  });
  let api = null;
  t.after(async () => {
    await Promise.all([stopWorker(source), stopWorker(ingestion), api === null ? Promise.resolve() : stopWorker(api)]);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    waitForResponse(`${source.url}/don-legality`, source, "test-owned DON source"),
    waitForResponse(`${ingestion.url}/health`, ingestion, "DON ingestion Worker", {
      authorization: `Bearer ${administrationKey}`,
    }),
  ]);
  const administrationEnvironment = {
    KEEPR_ADMINISTRATION_KEY: administrationKey,
    KEEPR_INGESTION_URL: ingestion.url,
  };
  const reconciled = await ingestAndReconcile({
    adapter: "fixture-one-piece-json@3",
    game: "one-piece",
    idempotencyKey: "acceptance-don-legality",
    lineage: "one-piece-en",
    sourcePath: "/don-legality",
    environment: administrationEnvironment,
    ingestion,
  });
  const don = reconciled.cards.find(
    (card) => card.official_identity.kind === "functional_designation" && card.official_identity.value === "DON!!",
  );
  assert.ok(don, "fixture ingestion omitted the functional DON!! Card");
  const publication = await approve(reconciled, "approve-acceptance-don-legality", administrationEnvironment);
  assert.equal(publication.publication_outcome, "revision");

  await stopWorker(ingestion);
  api = await startWorker({
    config: apiConfig,
    envFile: apiEnv,
    statePath,
  });
  await waitForResponse(`${api.url}/health`, api, "DON API Worker", { authorization: `Bearer ${apiKey}` });
  const response = await fetch(
    `${api.url}/v1/legality-status?card_id=${don.id}&on=2026-07-30&format=standard&region=EN-OCEANIA`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  const document = await response.json();
  assert.equal(response.status, 200);
  assert.equal(document.data[0].card_id, don.id);
  assert.equal(document.data[0].status, "not_legal");
  assert.equal(document.data[0].rule_ids.length, 4);
  const unresolvedRuleId = canonicalRuleId("one-piece-en", "don-unresolved");
  assert.ok(document.data[0].rule_ids.includes(unresolvedRuleId));
  assert.match(document.data[0].derivation, new RegExp(`${unresolvedRuleId} \\(unresolved\\) evaluated indeterminate`));
});

test("authenticated publication serves repeatable contextual legality export bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-contextual-legality-golden-"));
  const statePath = join(directory, "state");
  const administrationKey = crypto.randomUUID();
  const apiKey = crypto.randomUUID();
  const sourceServiceName = `card-keepr-contextual-legality-golden-source-${process.pid}`;
  const sourceConfig = await localConfig(
    "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    directory,
    "golden-source",
    { name: sourceServiceName },
  );
  const ingestionConfig = await localConfig("apps/ingestion/wrangler.jsonc", directory, "golden-ingestion", {
    main: resolve(root, "acceptance/fixtures/contextual-legality-ingestion-harness.ts"),
    services: [
      {
        binding: "OFFICIAL_SOURCE_TRANSPORT",
        service: sourceServiceName,
      },
    ],
  });
  const apiConfig = await localConfig("apps/api/wrangler.jsonc", directory, "golden-api");
  const ingestionEnv = join(directory, "ingestion.env");
  const apiEnv = join(directory, "api.env");
  await Promise.all([
    writeFile(ingestionEnv, `ADMINISTRATION_KEY=${administrationKey}\n`, { mode: 0o600 }),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
  ]);

  const source = await startWorker({
    config: sourceConfig,
    statePath: join(directory, "source-state"),
  });
  const ingestion = await startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    migrate: true,
    statePath,
  });
  let api = null;
  t.after(async () => {
    await Promise.all([stopWorker(source), stopWorker(ingestion), api === null ? Promise.resolve() : stopWorker(api)]);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    waitForResponse(`${source.url}/contextual-legality-domain-asia`, source, "deterministic test-owned domain source"),
    waitForResponse(`${ingestion.url}/health`, ingestion, "deterministic ingestion Worker", {
      authorization: `Bearer ${administrationKey}`,
    }),
  ]);
  const administrationEnvironment = {
    KEEPR_ADMINISTRATION_KEY: administrationKey,
    KEEPR_INGESTION_URL: ingestion.url,
  };
  const reconciled = await ingestAndReconcile({
    adapter: "fixture-gundam-en-asia-json@2",
    idempotencyKey: "acceptance-contextual-legality-golden",
    lineage: "gundam-en-asia",
    sourcePath: "/contextual-legality-domain-asia",
    environment: administrationEnvironment,
    ingestion,
  });
  assert.equal(reconciled.run_id, "run_f6614991e80764f7d9d7e27f3624ebba573757cbdc6becad131e48f4a94936cc");
  const publication = await approve(
    reconciled,
    "approve-acceptance-contextual-legality-golden",
    administrationEnvironment,
  );
  assert.equal(publication.state, "published");
  const revisionId = publication.resulting_revision_id;
  assert.match(revisionId, /^catrev_/);

  await stopWorker(ingestion);
  api = await startWorker({
    config: apiConfig,
    envFile: apiEnv,
    statePath,
  });
  await waitForResponse(`${api.url}/health`, api, "deterministic API Worker", { authorization: `Bearer ${apiKey}` });
  const exportUrl = api.url;
  const authenticatedHeaders = { authorization: `Bearer ${apiKey}` };
  const manifestResponse = await fetch(`${exportUrl}/v1/catalogue-exports/${revisionId}`, {
    headers: authenticatedHeaders,
  });
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  const component = manifest.data.components.find((candidate) => candidate.name === "legality-rules");
  const componentResponse = await fetch(`${exportUrl}/v1/catalogue-exports/${revisionId}/components/legality-rules`, {
    headers: authenticatedHeaders,
  });
  assert.equal(componentResponse.status, 200);
  const bytes = new Uint8Array(await componentResponse.arrayBuffer());
  const repeatedResponse = await fetch(`${exportUrl}/v1/catalogue-exports/${revisionId}/components/legality-rules`, {
    headers: authenticatedHeaders,
  });
  assert.equal(repeatedResponse.status, 200);
  const repeatedBytes = new Uint8Array(await repeatedResponse.arrayBuffer());
  const text = await new Response(new Response(bytes).body.pipeThrough(new DecompressionStream("gzip"))).text();
  const rules = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(component.name, "legality-rules");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), component.compressed_sha256);
  assert.equal(createHash("sha256").update(text).digest("hex"), component.content_sha256);
  assert.deepEqual(repeatedBytes, bytes);
  assert.ok(fixedDeflateBlockCount(bytes) > 1);
  assert.equal(rules.length, 16);
  assert.ok(rules.every((rule) => rule.lifecycle.current === true));
  assert.ok(rules.every((rule) => rule.source_observation_ids.length === 1));
  assert.equal(new Set(rules.map((rule) => rule.source_observation_pointer)).size, rules.length);
  for (const rule of rules) {
    assert.equal(rule.source_field_pointers.official_wording, `${rule.source_observation_pointer}/official_wording`);
    assert.equal(rule.source_field_pointers.effect, `${rule.source_observation_pointer}/effect`);
  }
  assert.deepEqual([...new Set(rules.flatMap((rule) => rule.source_observation_ids))].sort(), [
    "srcobs_43dde4d5a225defce9b4b3aeb4df709381fca63d5d8259d2804a4cfa9a771920_6",
  ]);
  assert.equal(
    rules.find((rule) => rule.effective_until !== null)?.source_observation_ids[0],
    "srcobs_43dde4d5a225defce9b4b3aeb4df709381fca63d5d8259d2804a4cfa9a771920_6",
  );
  assert.ok(
    rules.every(
      (rule) =>
        rule.lifecycle.first_revision_id === revisionId &&
        rule.lifecycle.last_observed_revision_id === revisionId &&
        rule.lifecycle.last_missing_revision_id === null,
    ),
  );
  assert.ok(
    rules.some((rule) =>
      rule.official_wording.startsWith(
        "Café cards satisfying the published Standard eligibility rules are eligible for play. ",
      ),
    ),
  );
  assert.ok(rules.some((rule) => rule.event_tier === null));
});

async function ingestAndReconcile({
  adapter,
  environment,
  expectedRunState = "parsing",
  expectedStatus = 200,
  game = "gundam",
  idempotencyKey,
  ingestion,
  lineage,
  sourcePath,
}) {
  const collected = await runCli(
    [
      "source",
      "collect",
      "--game",
      game,
      "--lineage",
      lineage,
      "--adapter",
      adapter,
      "--request-id",
      "discovery",
      "--url",
      `https://official-source.invalid${sourcePath}`,
      "--idempotency-key",
      idempotencyKey,
      "--json",
    ],
    environment,
  );
  if (collected.code !== 0) {
    throw new Error(
      `source collect exited ${collected.code}\n${collected.stdout}\n${collected.stderr}\n${ingestion.getOutput()}`,
    );
  }
  const run = JSON.parse(collected.stdout);
  const resumed = await runCli(["source", "resume", "--run-id", run.id, "--json"], environment);
  if (resumed.code !== 0) {
    const shown = await runCli(["source", "show", "--run-id", run.id, "--json"], environment);
    const state = shown.code === 0 ? JSON.parse(shown.stdout).state : null;
    if (state !== "parsing") {
      throw new Error(`source resume exited ${resumed.code} in state ${state}\n${resumed.stdout}\n${resumed.stderr}`);
    }
  }
  const reached = await waitForRunState(
    run.id,
    expectedRunState,
    environment,
    ingestion,
    // Poll below the administration-rate budget instead of manufacturing a
    // hot client.
    { deadlineMs: 90_000 },
  );
  if (expectedRunState === "failed") return reached;
  const reconciliationUrl = `${environment.KEEPR_INGESTION_URL}/v1/ingestion-runs/${run.id}/reconciliation`;
  const reconciliationBody = JSON.stringify({
    expected_current_revision_id: reached.expected_current_revision_id,
    idempotency_key: `${idempotencyKey}-reconcile`,
  });
  const deadline = Date.now() + 15_000;
  let pollCount = 0;
  while (Date.now() < deadline) {
    pollCount += 1;
    const response = await fetch(reconciliationUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${environment.KEEPR_ADMINISTRATION_KEY}`,
        "content-type": "application/json",
      },
      body: reconciliationBody,
    });
    if (response.status === 429) {
      throw new Error(`ADMINISTRATION_RATE_LIMIT returned HTTP 429 on poll ${pollCount} while reconciling ${run.id}.`);
    }
    const observed = await response.json();
    if (response.status !== 200 && response.status !== 202) {
      if (expectedStatus !== null) {
        assert.equal(response.status, expectedStatus, JSON.stringify(observed));
      }
      return { ...observed, http_status: response.status };
    }
    if (observed.status === "complete" && observed.output !== null) {
      const candidateStatus = observed.output.publishable === true ? 200 : 409;
      if (expectedStatus !== null) {
        assert.equal(candidateStatus, expectedStatus, `${JSON.stringify(observed.output)}\n${ingestion.getOutput()}`);
      }
      return { ...observed.output, http_status: candidateStatus };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, administrationPollInterval(ingestion)));
  }
  throw new Error(`reconciliation Workflow ${run.id} did not complete`);
}

async function approve(document, idempotencyKey, environment) {
  const result = await runCli(
    [
      "run",
      "approve",
      "--run-id",
      document.run_id,
      "--candidate-digest",
      document.candidate_digest,
      "--expected-current-revision",
      document.expected_current_revision_id,
      "--idempotency-key",
      idempotencyKey,
      "--yes",
      "--json",
    ],
    environment,
  );
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function reject(document, idempotencyKey, environment) {
  const result = await runCli(
    [
      "run",
      "reject",
      "--run-id",
      document.run_id,
      "--candidate-digest",
      document.candidate_digest,
      "--idempotency-key",
      idempotencyKey,
      "--yes",
      "--json",
    ],
    environment,
  );
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function legalityStatus(cardId, extraArguments, environment) {
  const result = await runCli(legalityArguments(cardId, extraArguments), environment);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function legalityArguments(cardId, extraArguments) {
  const onIndex = extraArguments.indexOf("--on");
  const on = onIndex === -1 ? "2026-07-30" : extraArguments[onIndex + 1];
  const filtered =
    onIndex === -1
      ? extraArguments
      : extraArguments.filter((_argument, index) => index !== onIndex && index !== onIndex + 1);
  return [
    "legality",
    "status",
    "--card-id",
    cardId,
    "--on",
    on,
    "--format",
    "standard",
    "--event-tier",
    "championship",
    ...filtered,
    "--json",
  ];
}

function assertGoldenComponent(bytes, component, golden) {
  assert.equal(component.name, golden.component);
  assert.equal(component.content_sha256, golden.content_sha256);
  assert.equal(component.compressed_sha256, golden.compressed_sha256);
  assert.equal(Buffer.from(bytes).toString("base64"), golden.gzip_base64);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), golden.compressed_sha256);
}

function fixedDeflateBlockCount(gzipBytes) {
  const reader = new DeflateBitReader(gzipBytes.subarray(10, gzipBytes.length - 8));
  const literalTable = fixedLiteralTable();
  const distanceTable = canonicalDecodeTable(Array.from({ length: 32 }, () => 5));
  const lengthExtraBits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const distanceExtraBits = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
  ];
  let blocks = 0;
  while (true) {
    const final = reader.readBits(1);
    assert.equal(reader.readBits(2), 1, "golden DEFLATE contains a non-fixed block");
    blocks += 1;
    while (true) {
      const symbol = decodeSymbol(reader, literalTable, 9);
      if (symbol < 256) continue;
      if (symbol === 256) break;
      assert.ok(symbol >= 257 && symbol <= 285);
      reader.readBits(lengthExtraBits[symbol - 257]);
      const distance = decodeSymbol(reader, distanceTable, 5);
      assert.ok(distance <= 29);
      reader.readBits(distanceExtraBits[distance]);
    }
    if (final === 1) return blocks;
  }
}

class DeflateBitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  readBits(count) {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = this.bytes[this.offset >> 3];
      assert.notEqual(byte, undefined, "truncated golden DEFLATE");
      value |= ((byte >> (this.offset & 7)) & 1) << index;
      this.offset += 1;
    }
    return value;
  }
}

function fixedLiteralTable() {
  const lengths = Array.from({ length: 288 }, (_, symbol) =>
    symbol <= 143 ? 8 : symbol <= 255 ? 9 : symbol <= 279 ? 7 : 8,
  );
  return canonicalDecodeTable(lengths);
}

function canonicalDecodeTable(lengths) {
  const counts = [];
  for (const length of lengths) {
    counts[length] = (counts[length] ?? 0) + 1;
  }
  const nextCode = [];
  let code = 0;
  for (let bits = 1; bits <= Math.max(...lengths); bits += 1) {
    code = (code + (counts[bits - 1] ?? 0)) << 1;
    nextCode[bits] = code;
  }
  const table = new Map();
  for (const [symbol, length] of lengths.entries()) {
    const canonical = nextCode[length]++;
    table.set(`${length}:${reverseBits(canonical, length)}`, symbol);
  }
  return table;
}

function decodeSymbol(reader, table, maximumBits) {
  let code = 0;
  for (let length = 1; length <= maximumBits; length += 1) {
    code |= reader.readBits(1) << (length - 1);
    const symbol = table.get(`${length}:${code}`);
    if (symbol !== undefined) return symbol;
  }
  assert.fail("golden DEFLATE contains an invalid fixed-Huffman code");
}

function reverseBits(value, length) {
  let reversed = 0;
  for (let index = 0; index < length; index += 1) {
    reversed = (reversed << 1) | ((value >> index) & 1);
  }
  return reversed;
}

function canonicalRuleId(sourceLineage, officialId) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        official_id: officialId,
        source_lineage: sourceLineage,
      }),
    )
    .digest("hex");
  return `legality_rule_${digest}`;
}

async function localConfig(source, directory, name, overrides = {}) {
  const config = JSON.parse(readFileSync(resolve(root, source), "utf8"));
  delete config.$schema;
  config.main = resolve(root, source.split("/").slice(0, -1).join("/"), config.main);
  if (Array.isArray(config.d1_databases)) {
    config.d1_databases[0].migrations_dir = resolve(root, "migrations");
  }
  // Immediate source pacing compresses this scenario's administration calls
  // into a window far shorter than the production budget assumes.
  const administrationRateLimit = config.ratelimits?.find(({ name }) => name === "ADMINISTRATION_RATE_LIMIT");
  if (administrationRateLimit !== undefined) {
    administrationRateLimit.simple.limit = 300;
  }
  Object.assign(config, overrides);
  const path = join(directory, `${name}.wrangler.json`);
  await writeFile(path, JSON.stringify(config));
  return path;
}
