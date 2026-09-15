import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { readWorkerConfig } from "../cli/lib/config.mjs";
import * as validators from "../test/support/http-response-validators.mjs";
import { reconciliationSourceDocument } from "../test/support/fake-publisher/reconciliation-documents.ts";
import {
  applyMigrations,
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
  waitForAdministrationDocument,
} from "./helpers/acceptance-runtime.mjs";
import { withNativeRequestPacing } from "./helpers/native-request-pacing.mjs";

const specification = JSON.parse(await readFile(new URL("../contracts/admin-openapi.json", import.meta.url), "utf8"));
function check(path, method, status, document, media = "application/json") {
  const validate = validators[validators.responseValidators[`admin ${method} ${path} ${status} ${media}`]];
  assert.equal(typeof validate, "function", `${method} ${path} ${status}`);
  assert.equal(validate(document), true, JSON.stringify(validate.errors));
}
const runPath = "/v1/ingestion-runs/{run}";
const reconciliationPath = `${runPath}/reconciliation`;

test("owner inspects and replays retained runs, then reconciles native evidence and reads its complete retained partitions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-retained-owner-"));
  let worker;
  t.after(async () => {
    try {
      if (worker) await stopWorker(worker);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  delete config.$schema;
  config.main = resolve("acceptance/fixtures/retained-owner-runtime.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  const configPath = join(directory, "ingestion.json"),
    statePath = join(directory, "state");
  await writeFile(configPath, JSON.stringify(config));
  const fixtureMigration = join(directory, "fixture-migration.mjs");
  await build({
    entryPoints: ["test/support/source-adapters/migration.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: fixtureMigration,
  });
  const { syntheticSourceAdapterMigration } = await import(pathToFileURL(fixtureMigration).href);
  await applyMigrations(statePath, configPath, [syntheticSourceAdapterMigration]);
  const key = crypto.randomUUID();
  const printedText = "Retained owner printed wording. ".repeat(1100);
  worker = await startWorker({
    config: configPath,
    statePath,
    vars: { ADMINISTRATION_KEY: key, SOURCE_HOST_PACING_MODE: "immediate" },
    outboundService: (request) => {
      assert.equal(new URL(request.url).hostname, "official-source.invalid");
      const source = reconciliationSourceDocument("base", "", request.url);
      source.cards[0].printing.printed_rules_text = printedText;
      return Response.json(source);
    },
  });
  await waitForHealth(`${worker.url}/health`, key, worker);
  const environment = {
    KEEPR_INGESTION_URL: worker.url,
    KEEPR_ADMINISTRATION_KEY: key,
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "2100",
  };
  const cli = async (args, codes = [0]) => {
    const result = await runCli([...args, "--json"], environment);
    assert.ok(codes.includes(result.code), `${args.join(" ")}: ${result.code}\n${result.stdout}${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const call = async (path, body, status = 200, schemaPath = path, authenticated = true) => {
    const method = body === undefined ? "get" : "post";
    const response = await withNativeRequestPacing(environment, () =>
      fetch(`${worker.url}${path}`, {
        method: method.toUpperCase(),
        headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${key}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const document = await response.json();
    assert.equal(response.status, status, JSON.stringify(document));
    if (path.startsWith("/v1/")) {
      check(schemaPath, method, status, document, response.headers.get("content-type").split(";")[0]);
      for (const [name, header] of Object.entries(
        specification.paths[schemaPath][method].responses[status].headers ?? {},
      ))
        if (header.required) assert.ok(response.headers.has(name), name);
    }
    return document;
  };
  const source = await call("/acceptance/retained-owner-source", { kind: "aggregate" });
  const shown = await cli(["run", "show", "--run-id", source.id]);
  check(runPath, "get", 200, shown);
  assert.equal(shown.state, "awaiting_approval");
  assert.ok(!Object.hasOwn(shown, "contract"));
  assert.ok(!Object.hasOwn(shown, "export_manifest_digest"));
  const inspection = await cli(["candidate", "inspect", "--run-id", source.id]);
  check(`${runPath}/candidate`, "get", 200, inspection);
  assert.equal(inspection.candidate_digest, source.candidate_digest);
  assert.equal((await cli(["run", "approve"], [2])).code, "run_approval_retired");
  await call(
    `/v1/ingestion-runs/${source.id}/approval`,
    {
      candidate_digest: source.candidate_digest,
      expected_current_revision_id: source.expected_current_revision_id,
      idempotency_key: "retired-owner-no-claim",
    },
    410,
    `${runPath}/approval`,
  );
  await call(`/v1/ingestion-runs/${source.id}`, undefined, 401, runPath, false);
  const rejectionArgs = [
    "run",
    "reject",
    "--run-id",
    source.id,
    "--candidate-digest",
    source.candidate_digest,
    "--idempotency-key",
    "owner-reject",
    "--yes",
  ];
  const rejected = await cli(rejectionArgs);
  check(`${runPath}/rejection`, "post", 200, rejected);
  const retryArgs = ["run", "retry", "--run-id", source.id, "--idempotency-key", "owner-retry"];
  const child = await cli(retryArgs);
  check(`${runPath}/retry`, "post", 201, child);
  assert.equal(child.linked_run_id, source.id);
  await cli([
    "run",
    "reject",
    "--run-id",
    child.id,
    "--candidate-digest",
    child.candidate_digest,
    "--idempotency-key",
    "owner-child-reject",
    "--yes",
  ]);
  assert.deepEqual(await cli(retryArgs), child);
  assert.deepEqual(await cli(rejectionArgs), rejected);

  const evidence = await call("/acceptance/retained-owner-source", { kind: "evidence" });
  const evidenceShown = await cli(["run", "show", "--run-id", evidence.id]);
  check(runPath, "get", 200, evidenceShown);
  assert.equal(evidenceShown.state, "parsing");
  assert.equal(evidenceShown.observation_sets.length, 1);
  const reconciliation = `/v1/ingestion-runs/${evidence.id}/reconciliation`;
  await call(
    `${reconciliation}/pause`,
    { generation: "01", idempotency_key: "invalid-generation" },
    422,
    `${reconciliationPath}/pause`,
  );
  const args = [
    "run",
    "reconcile",
    "--run-id",
    evidence.id,
    "--expected-current-revision",
    evidence.expected_current_revision_id,
    "--idempotency-key",
    "owner-reconcile",
    "--environment",
    "production",
    "--yes",
  ];
  const preview = await cli(args, [3]);
  assert.equal(preview.code, "confirmation_required");
  const confirmation = /--confirm '(.+)'/.exec(preview.detail)?.[1];
  assert.ok(confirmation, preview.detail);
  args.push("--confirm", confirmation);
  const started = await cli(args, [0, 10]);
  check(reconciliationPath, "post", started.status === "complete" ? 200 : 202, started);
  const status = await waitForAdministrationDocument(
    reconciliation,
    (value) => ["sealed", "failed"].includes(value.state),
    environment,
    worker,
  );
  check(reconciliationPath, "get", 200, status);
  assert.equal(status.state, "sealed");
  assert.equal(typeof status.definition_pins_json, "string");
  assert.equal(status.admission_selection_pinned, 1);
  const completed = await cli(args);
  check(reconciliationPath, "post", 200, completed);
  assert.equal(completed.workflow_instance_id, started.workflow_instance_id);
  assert.equal(completed.status, "complete");
  assert.equal(completed.output.publishable, true);
  for (const [list, detail, path] of [
    ["inputs", "input", "inputs"],
    ["partitions", "partition", "partitions"],
  ]) {
    let after = null,
      inspected = 0;
    const textRefs = new Map();
    do {
      const page = await cli([
        "reconciliation",
        list,
        "--run-id",
        evidence.id,
        ...(after === null ? [] : ["--after", after]),
      ]);
      check(`${reconciliationPath}/${path}`, "get", 200, page);
      for (const header of page.partitions) {
        const partition = await cli([
          "reconciliation",
          detail,
          "--run-id",
          evidence.id,
          "--ordinal",
          String(header.ordinal),
        ]);
        check(`${reconciliationPath}/${path}/{ordinal}`, "get", 200, partition);
        assert.equal(partition.sha256, header.sha256);
        assert.equal(partition.records.length, header.record_count);
        for (const reference of partition.text_parts.flat()) textRefs.set(reference.sha256, reference);
        inspected++;
      }
      after = page.next_cursor;
    } while (after !== null);
    assert.ok(inspected > 0);
    assert.ok(textRefs.size > 0);
    for (const reference of textRefs.values()) {
      let text = "";
      for (let ordinal = 0; ordinal < reference.chunks; ordinal++) {
        const chunk = await cli([
          "reconciliation",
          "text",
          "--run-id",
          evidence.id,
          "--digest",
          reference.sha256,
          "--ordinal",
          String(ordinal),
        ]);
        check(`${reconciliationPath}/text/{digest}/{ordinal}`, "get", 200, chunk);
        assert.equal(createHash("sha256").update(chunk.content).digest("hex"), chunk.sha256);
        text += chunk.content;
      }
      assert.equal(Buffer.byteLength(text), reference.byte_length);
      assert.equal(createHash("sha256").update(text).digest("hex"), reference.sha256);
      assert.equal(text, printedText);
    }
  }
  const finalCandidate = await cli(["candidate", "inspect", "--run-id", evidence.id]);
  check(`${runPath}/candidate`, "get", 200, finalCandidate);
  assert.equal(finalCandidate.candidate_digest, completed.output.candidate_digest);
});
