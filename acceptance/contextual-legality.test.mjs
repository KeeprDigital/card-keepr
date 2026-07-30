import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(import.meta.dirname, "..");
const portBase = 20_000 + (process.pid % 1_000) * 3;
const ingestionPort = portBase;
const sourcePort = portBase + 1;
const apiPort = portBase + 2;
const apiSchema = JSON.parse(
  readFileSync(
    resolve(
      root,
      "prototype/formalize-implementation-contracts/schemas/api.schema.json",
    ),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(apiSchema);
const validateLegalityStatus = ajv.getSchema(
  `${apiSchema.$id}#/$defs/LegalityStatusDocument`,
);

test("Official Legality Rules flow from repository ingestion to contextual consumer results", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "card-keepr-contextual-legality-"),
  );
  const statePath = join(directory, "state");
  const administrationKey = crypto.randomUUID();
  const apiKey = crypto.randomUUID();
  const sourceServiceName =
    `card-keepr-contextual-legality-source-${process.pid}`;
  const sourceConfig = await localConfig(
    "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    directory,
    "source",
    { name: sourceServiceName },
  );
  const ingestionConfig = await localConfig(
    "apps/ingestion/wrangler.jsonc",
    directory,
    "ingestion",
    {
      services: [
        {
          binding: "OFFICIAL_SOURCE_TRANSPORT",
          service: sourceServiceName,
        },
      ],
    },
  );
  const apiConfig = await localConfig(
    "apps/api/wrangler.jsonc",
    directory,
    "api",
  );
  const ingestionEnv = join(directory, "ingestion.env");
  const apiEnv = join(directory, "api.env");
  await Promise.all([
    writeFile(
      ingestionEnv,
      `ADMINISTRATION_KEY=${administrationKey}\n`,
      { mode: 0o600 },
    ),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
  ]);

  const source = startWorker({
    config: sourceConfig,
    inspectorPort: portBase + 101,
    port: sourcePort,
    statePath: join(directory, "source-state"),
  });
  let ingestion = startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    inspectorPort: portBase + 102,
    migrate: true,
    port: ingestionPort,
    statePath,
  });
  let api = null;
  t.after(async () => {
    await Promise.all([
      stopWorker(source),
      stopWorker(ingestion),
      api === null ? Promise.resolve() : stopWorker(api),
    ]);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    waitForResponse(
      `http://127.0.0.1:${sourcePort}/contextual-legality-asia`,
      source,
      "synthetic Official Source",
    ),
    waitForResponse(
      `http://127.0.0.1:${ingestionPort}/health`,
      ingestion,
      "ingestion Worker",
      { authorization: `Bearer ${administrationKey}` },
    ),
  ]);
  const administrationEnvironment = {
    KEEPR_ADMINISTRATION_KEY: administrationKey,
    KEEPR_INGESTION_URL: `http://127.0.0.1:${ingestionPort}`,
  };
  const restartIngestion = async () => {
    await stopWorker(ingestion);
    ingestion = startWorker({
      config: ingestionConfig,
      envFile: ingestionEnv,
      inspectorPort: portBase + 102,
      port: ingestionPort,
      statePath,
    });
    await waitForResponse(
      `http://127.0.0.1:${ingestionPort}/health`,
      ingestion,
      "restarted ingestion Worker",
      { authorization: `Bearer ${administrationKey}` },
    );
  };

  const asia = await ingestAndReconcile({
    adapter: "gundam-en-asia@2",
    idempotencyKey: "acceptance-contextual-legality-asia",
    lineage: "gundam-en-asia",
    sourcePath: "/contextual-legality-asia",
    environment: administrationEnvironment,
    ingestion,
  });
  const cards = new Map(
    asia.cards.map((card) => [
      card.official_identity.value,
      card.id,
    ]),
  );
  const asiaRuleId = (officialId) =>
    canonicalRuleId("gundam-en-asia", officialId);
  const usRuleId = (officialId) =>
    canonicalRuleId("gundam-en-us", officialId);
  assert.equal(asia.legality_rules.length, 15);
  const asiaPublication = await approve(
    asia,
    "approve-acceptance-contextual-legality-asia",
    administrationEnvironment,
  );
  assert.equal(asiaPublication.state, "published");
  const asiaRevisionId = asiaPublication.resulting_revision_id;
  assert.match(asiaRevisionId, /^catrev_/);

  const us = await ingestAndReconcile({
    adapter: "gundam-en-us@2",
    idempotencyKey: "acceptance-contextual-legality-us",
    lineage: "gundam-en-us",
    sourcePath: "/contextual-legality-us",
    environment: administrationEnvironment,
    ingestion,
  });
  assert.equal(us.cards[0].id, cards.get("GD30-001"));
  const usPublication = await approve(
    us,
    "approve-acceptance-contextual-legality-us",
    administrationEnvironment,
  );
  const revisionId = usPublication.resulting_revision_id;
  assert.match(revisionId, /^catrev_/);
  await restartIngestion();

  const asiaRefresh = await ingestAndReconcile({
    adapter: "gundam-en-asia@2",
    idempotencyKey: "acceptance-contextual-legality-asia-refresh",
    lineage: "gundam-en-asia",
    sourcePath: "/contextual-legality-asia?refresh=asia",
    environment: administrationEnvironment,
    ingestion,
  });
  const asiaRefreshPublication = await approve(
    asiaRefresh,
    "approve-acceptance-contextual-legality-asia-refresh",
    administrationEnvironment,
  );
  const usRefresh = await ingestAndReconcile({
    adapter: "gundam-en-us@2",
    idempotencyKey: "acceptance-contextual-legality-us-refresh",
    lineage: "gundam-en-us",
    sourcePath: "/contextual-legality-us?refresh=us",
    environment: administrationEnvironment,
    ingestion,
  });
  const usRefreshPublication = await approve(
    usRefresh,
    "approve-acceptance-contextual-legality-us-refresh",
    administrationEnvironment,
  );
  await t.test(
    "unchanged regional refreshes preserve one revision and rule lifecycle",
    () => {
      assert.equal(
        asiaRefreshPublication.publication_outcome,
        "no_change",
      );
      assert.equal(
        asiaRefreshPublication.resulting_revision_id,
        revisionId,
      );
      assert.equal(
        usRefreshPublication.publication_outcome,
        "no_change",
      );
      assert.equal(
        usRefreshPublication.resulting_revision_id,
        revisionId,
      );
    },
  );
  await restartIngestion();

  for (const membershipVariant of [
    "unknown-attribute",
    "unknown-enum-value",
  ]) {
    const invalidMembership = await ingestAndReconcile({
      adapter: "gundam-en-asia@2",
      expectedStatus: null,
      idempotencyKey:
        `acceptance-contextual-legality-${membershipVariant}`,
      lineage: "gundam-en-asia",
      sourcePath:
        `/contextual-legality-asia?membership=${membershipVariant}`,
      environment: administrationEnvironment,
      ingestion,
    });
    await t.test(
      `membership operand ${membershipVariant} blocks before approval`,
      () => {
        assert.equal(invalidMembership.http_status, 409);
        assert.equal(invalidMembership.publishable, false);
        assert.equal(invalidMembership.state, "failed");
        assert.match(
          invalidMembership.diagnostics[0].detail,
          membershipVariant === "unknown-attribute"
            ? /traitz/
            : /bluue/,
        );
      },
    );
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
    adapter: "gundam-en-asia@2",
    expectedStatus: 409,
    idempotencyKey: "acceptance-contextual-legality-unrepresentable",
    lineage: "gundam-en-asia",
    sourcePath: "/contextual-legality-asia?representable=false",
    environment: administrationEnvironment,
    ingestion,
  });
  assert.equal(blocked.publishable, false);
  assert.equal(blocked.state, "failed");
  assert.match(
    blocked.diagnostics[0].detail,
    /cannot be represented without invented precision/,
  );

  await stopWorker(ingestion);
  api = startWorker({
    config: apiConfig,
    envFile: apiEnv,
    inspectorPort: portBase + 103,
    port: apiPort,
    statePath,
  });
  await waitForResponse(
    `http://127.0.0.1:${apiPort}/health`,
    api,
    "API Worker",
    { authorization: `Bearer ${apiKey}` },
  );
  const apiEnvironment = {
    KEEPR_API_KEY: apiKey,
    KEEPR_API_URL: `http://127.0.0.1:${apiPort}`,
  };
  const cases = [
    ["GD30-001", "legal"],
    ["GD30-002", "restricted"],
    ["GD30-003", "not_legal"],
    ["GD30-004", "indeterminate"],
  ];
  for (const [number, expected] of cases) {
    const document = await legalityStatus(
      cards.get(number),
      ["--region", "EN-ASIA"],
      apiEnvironment,
    );
    assert.equal(
      validateLegalityStatus(document),
      true,
      JSON.stringify(validateLegalityStatus.errors),
    );
    assert.equal(document.data[0].status, expected);
    assert.ok(document.data[0].rule_ids.length > 0);
    assert.match(
      document.data[0].derivation,
      /legality_rule_[a-f0-9]{64}/,
    );
  }

  const nullableMembership = await legalityStatus(
    cards.get("GD30-005"),
    ["--region", "EN-ASIA"],
    apiEnvironment,
  );
  await t.test(
    "a valid membership rule with a nullable canonical attribute is indeterminate",
    () => {
      assert.equal(nullableMembership.data[0].status, "indeterminate");
      assert.ok(
        nullableMembership.data[0].rule_ids.includes(
          asiaRuleId("legality_rule_asia_nullable_membership"),
        ),
      );
      assert.match(
        nullableMembership.data[0].derivation,
        new RegExp(
          `${asiaRuleId("legality_rule_asia_nullable_membership")} \\(membership\\) evaluated indeterminate`,
        ),
      );
    },
  );

  const beforeRelease = await legalityStatus(
    cards.get("GD30-001"),
    ["--on", "2025-12-31", "--region", "EN-ASIA"],
    apiEnvironment,
  );
  assert.equal(beforeRelease.data[0].status, "not_legal");
  assert.deepEqual(beforeRelease.data[0].rule_ids, [
    asiaRuleId("legality_rule_asia_release_timing"),
  ]);

  const regional = await legalityStatus(
    cards.get("GD30-001"),
    [],
    apiEnvironment,
  );
  assert.deepEqual(
    regional.data.map((result) => result.region),
    ["EN-ASIA", "EN-US"],
  );
  assert.equal(regional.data[0].status, "legal");
  assert.equal(regional.data[1].status, "legal");

  const withoutEventTier = await runCli(
    [
      "legality",
      "status",
      "--card-id",
      cards.get("GD30-001"),
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
  assert.equal(JSON.parse(withoutEventTier.stdout).data[0].status, "legal");

  const oceania = await runCli(
    legalityArguments(cards.get("GD30-001"), [
      "--region",
      "EN-OCEANIA",
    ]),
    apiEnvironment,
  );
  assert.equal(oceania.code, 8);
  assert.equal(JSON.parse(oceania.stdout).code, "invalid_legality_region");

  for (const invalidCardId of [
    "card id with spaces",
    `card_${"x".repeat(196)}`,
  ]) {
    const invalidCardResponse = await fetch(
      `http://127.0.0.1:${apiPort}/v1/legality-status?card_id=${encodeURIComponent(invalidCardId)}&on=2026-07-30&format=standard&region=EN-ASIA`,
      { headers: { authorization: `Bearer ${apiKey}` } },
    );
    const invalidCardDocument = await invalidCardResponse.json();
    await t.test(
      `card_id rejects ${
        invalidCardId.includes(" ") ? "invalid characters" : "overlength"
      } before lookup`,
      () => {
        assert.equal(invalidCardResponse.status, 400);
        assert.equal(invalidCardDocument.code, "invalid_parameter");
      },
    );
  }

  const manifestResponse = await fetch(
    `http://127.0.0.1:${apiPort}/v1/catalogue-exports/${revisionId}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(manifestResponse.status, 200);
  const manifestDocument = await manifestResponse.json();

  const exportResponse = await fetch(
    `http://127.0.0.1:${apiPort}/v1/catalogue-exports/${revisionId}/components/legality-rules`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(exportResponse.status, 200);
  const decompressed = exportResponse.body.pipeThrough(
    new DecompressionStream("gzip"),
  );
  const exportedRules = (await new Response(decompressed).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(exportedRules.length, 16);
  await t.test(
    "Legality Rule exports use schema v2 and retain exact effects",
    () => {
      assert.equal(manifestDocument.data.export_schema_major, 2);
      assert.equal(
        manifestDocument.data.components.find(
          (component) => component.name === "legality-rules",
        ).record_schema,
        "https://card-keepr.invalid/schemas/catalogue-export-record@2#/$defs/LegalityRuleRecord",
      );
    },
  );
  await t.test("copy-limit export retains its operand", () => {
    assert.deepEqual(
      exportedRules.find(
        (rule) =>
          rule.official_id === "legality_rule_asia_copy_limit",
      ),
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
        kind: "restricted",
        effect: { type: "copy_limit", maximum_copies: 1 },
        card_ids: [cards.get("GD30-002")],
        official_wording:
          "For Championship events, decks may contain no more than one copy of GD30-002.",
      },
    );
  });
  await t.test("canonical rule IDs use UTF-8 byte ordering", () => {
    const exportedIds = exportedRules.map((rule) => rule.id);
    assert.deepEqual(
      exportedIds,
      [...exportedIds].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
    );
  });
  await t.test("membership export retains its predicate", () => {
    assert.deepEqual(
      exportedRules.find(
        (rule) =>
          rule.official_id === "legality_rule_asia_membership",
      ),
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
        kind: "conditional",
        effect: {
          type: "membership",
          attribute: "traits",
          includes_any: ["Earth Federation"],
        },
        card_ids: [cards.get("GD30-001")],
        official_wording:
          "Cards with the Earth Federation trait are eligible for this event.",
      },
    );
  });
  await t.test("release-timing export matches temporal API semantics", () => {
    assert.deepEqual(
      exportedRules.find(
        (rule) =>
          rule.official_id === "legality_rule_asia_release_timing",
      ),
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
        kind: "release",
        effect: {
          type: "release_timing",
          legal_from: "2026-01-01",
        },
        card_ids: [cards.get("GD30-001")],
        official_wording:
          "GD30-001 becomes legal for tournament play on 1 January 2026.",
      },
    );
  });
  await t.test("unresolved export matches indeterminate API semantics", () => {
    assert.deepEqual(
      exportedRules.find(
        (rule) =>
          rule.official_id === "legality_rule_asia_unresolved_scope",
      ),
      {
        type: "legality_rule",
        id: asiaRuleId("legality_rule_asia_unresolved_scope"),
        official_id: "legality_rule_asia_unresolved_scope",
        game: "gundam",
        region: "EN-ASIA",
        format: "standard",
        event_tier: null,
        effective_from: "2026-01-01",
        effective_until: null,
        kind: "indeterminate",
        effect: {
          type: "unresolved",
          reason: "The event-tier scope is absent from the official notice.",
        },
        card_ids: [cards.get("GD30-004")],
        official_wording:
          "The official notice does not identify whether GD30-004 applies to Championship side events.",
      },
    );
  });

  const relationshipsResponse = await fetch(
    `http://127.0.0.1:${apiPort}/v1/catalogue-exports/${revisionId}/components/relationships`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(relationshipsResponse.status, 200);
  const relationshipsStream = relationshipsResponse.body.pipeThrough(
    new DecompressionStream("gzip"),
  );
  const exportedRelationships = (
    await new Response(relationshipsStream).text()
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const asiaRelationship = exportedRelationships.find(
    (relationship) =>
      relationship.kind === "legality-rule-card" &&
      relationship.from.id ===
        asiaRuleId("legality_rule_asia_membership"),
  );
  const usRelationship = exportedRelationships.find(
    (relationship) =>
      relationship.kind === "legality-rule-card" &&
      relationship.from.id ===
        usRuleId("legality_rule_us_eligible"),
  );
  assert.equal(
    asiaRelationship.lifecycle.first_revision_id,
    asiaRevisionId,
  );
  assert.equal(
    usRelationship.lifecycle.first_revision_id,
    revisionId,
  );
  assert.equal(asiaRelationship.source_lineage, "gundam-en-asia");
  assert.equal(usRelationship.source_lineage, "gundam-en-us");
});

async function ingestAndReconcile({
  adapter,
  environment,
  expectedStatus = 200,
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
      "gundam",
      "--lineage",
      lineage,
      "--adapter",
      adapter,
      "--request-id",
      idempotencyKey,
      "--url",
      `https://synthetic-source.invalid${sourcePath}`,
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
  const resumed = await runCli(
    ["source", "resume", "--run-id", run.id, "--json"],
    environment,
  );
  if (resumed.code !== 0) {
    const shown = await runCli(
      ["source", "show", "--run-id", run.id, "--json"],
      environment,
    );
    const state =
      shown.code === 0 ? JSON.parse(shown.stdout).state : null;
    if (state !== "parsing") {
      throw new Error(
        `source resume exited ${resumed.code} in state ${state}\n${resumed.stdout}\n${resumed.stderr}`,
      );
    }
  }
  await waitForRunState(run.id, "parsing", environment, ingestion);
  const response = await fetch(
    `${environment.KEEPR_INGESTION_URL}/v1/ingestion-runs/${run.id}/reconciliation`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${environment.KEEPR_ADMINISTRATION_KEY}`,
        "content-type": "application/json",
      },
      body: "{}",
    },
  );
  const document = await response.json();
  if (expectedStatus !== null) {
    assert.equal(
      response.status,
      expectedStatus,
      `${JSON.stringify(document)}\n${ingestion.getOutput()}`,
    );
  }
  return { ...document, http_status: response.status };
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
  const result = await runCli(
    legalityArguments(cardId, extraArguments),
    environment,
  );
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function legalityArguments(cardId, extraArguments) {
  const onIndex = extraArguments.indexOf("--on");
  const on =
    onIndex === -1 ? "2026-07-30" : extraArguments[onIndex + 1];
  const filtered =
    onIndex === -1
      ? extraArguments
      : extraArguments.filter(
          (_argument, index) => index !== onIndex && index !== onIndex + 1,
        );
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

async function waitForRunState(runId, expected, environment, worker) {
  const deadline = Date.now() + 40_000;
  let lastShown = "";
  while (Date.now() < deadline) {
    const shown = await runCli(
      ["source", "show", "--run-id", runId, "--json"],
      environment,
    );
    if (shown.code === 0) {
      lastShown = shown.stdout;
      const document = JSON.parse(shown.stdout);
      if (document.state === expected) return;
      if (document.state === "failed") {
        throw new Error(`${shown.stdout}\n${worker.getOutput()}`);
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(
    `run ${runId} did not reach ${expected}\n${lastShown}\n${worker.getOutput()}`,
  );
}

async function localConfig(source, directory, name, overrides = {}) {
  const config = JSON.parse(readFileSync(resolve(root, source), "utf8"));
  delete config.$schema;
  config.main = resolve(
    root,
    source.split("/").slice(0, -1).join("/"),
    config.main,
  );
  if (Array.isArray(config.d1_databases)) {
    config.d1_databases[0].migrations_dir = resolve(root, "migrations");
  }
  Object.assign(config, overrides);
  const path = join(directory, `${name}.wrangler.json`);
  await writeFile(path, JSON.stringify(config));
  return path;
}

function startWorker({
  config,
  envFile,
  inspectorPort,
  migrate = false,
  port,
  statePath,
}) {
  if (migrate) applyMigrations(config, statePath);
  let output = "";
  const child = spawn(
    resolve(root, "node_modules/.bin/wrangler"),
    [
      "dev",
      "--config",
      config,
      ...(envFile === undefined ? [] : ["--env-file", envFile]),
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
        ...process.env,
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
        ...process.env,
        CI: "1",
        WRANGLER_LOG_PATH: join(statePath, "logs"),
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

async function waitForResponse(url, worker, name, headers = {}) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (worker.process.exitCode !== null) {
      throw new Error(
        `${name} exited with ${worker.process.exitCode}\n${worker.getOutput()}`,
      );
    }
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
    } catch {
      // Wrangler has not started accepting requests.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${name} did not become ready\n${worker.getOutput()}`);
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
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [resolve(root, "cli/keepr.mjs"), ...arguments_],
      {
        cwd: root,
        env: { ...process.env, ...environment },
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
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}
