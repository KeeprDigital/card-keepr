import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { provisionDev } from "../scripts/provision-dev.mjs";
import { requiredCiChecks } from "../src/http/dev-workflow-identity.mjs";

test("provisioned deny-only Workers use Wrangler so strict first upload accepts their provenance", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-dev-provision-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const app of ["api", "ingestion"]) {
    const path = `apps/${app}/wrangler.dev.json`;
    const previous = await readFile(path, "utf8").catch(() => null);
    t.after(() => (previous === null ? rm(path, { force: true }) : writeFile(path, previous)));
  }
  const head = "a".repeat(40);
  const account = "b".repeat(32);
  const apiSecrets = {
    API_BEARER_KEY: "synthetic-primary-api-key",
    API_BEARER_KEY_REPLACEMENT: "synthetic-replacement-api-key",
  };
  const ingestionSecrets = {
    ADMINISTRATION_KEY: "synthetic-primary-administration-key",
    ADMINISTRATION_KEY_REPLACEMENT: "synthetic-replacement-administration-key",
    D1_EXPORT_TOKEN: "synthetic-export-token",
    D1_VERIFICATION_TOKEN: "synthetic-verification-token",
  };
  for (const [name, value] of [
    ["api", apiSecrets],
    ["ingestion", ingestionSecrets],
  ])
    await writeFile(join(directory, `${name}.json`), JSON.stringify(value));
  const workers = [];
  const commands = [];
  const shells = [];
  t.mock.method(childProcess, "execFileSync", (command, args) => {
    if (command === "git") return head;
    commands.push({ command, args });
    if (args[0] === "deploy") {
      const path = args[args.indexOf("--config") + 1];
      const config = JSON.parse(readFileSync(path, "utf8"));
      shells.push({
        config,
        source: readFileSync(join(dirname(path), config.main), "utf8"),
        secrets: JSON.parse(readFileSync(args[args.indexOf("--secrets-file") + 1], "utf8")),
      });
    }
    return "";
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = new URL(input);
    let result;
    if (url.hostname === "api.github.com") {
      if (url.pathname.endsWith("/actions/runs/123"))
        return Response.json({
          repository: { id: 1313489088 },
          path: ".github/workflows/ci.yml",
          event: "push",
          head_branch: "main",
          head_sha: head,
          status: "completed",
          conclusion: "success",
          check_suite_id: 777,
        });
      if (url.pathname.includes("/compare/")) return Response.json({ status: "identical" });
      if (url.pathname.endsWith("/check-runs"))
        return Response.json({
          total_count: requiredCiChecks.length,
          check_runs: requiredCiChecks.map((name) => ({
            name,
            app: { slug: "github-actions" },
            check_suite: { id: 777 },
            head_sha: head,
            status: "completed",
            conclusion: "success",
          })),
        });
      assert.fail(`Unexpected GitHub observation: ${url.pathname}`);
    }
    assert.equal(url.hostname, "api.cloudflare.com");
    if (url.pathname.includes("/workflows/")) return new Response(null, { status: 404 });
    if (url.pathname.endsWith("/d1/database")) {
      if (options.method === "POST") {
        const name = JSON.parse(options.body).name;
        result = {
          name,
          uuid: name.includes("disposable")
            ? "00000000-0000-0000-0000-000000000002"
            : "00000000-0000-0000-0000-000000000001",
        };
      } else result = [];
    } else if (url.pathname.endsWith("/workers/scripts")) result = [];
    else if (url.pathname.endsWith("/r2/buckets")) result = { buckets: [] };
    else if (options.method === "PUT" && url.pathname.includes("/workers/scripts/")) {
      workers.push({ name: url.pathname.split("/").at(-1), last_deployed_from: "api" });
      result = {};
    } else if (url.pathname.endsWith("/subdomain")) result = {};
    else assert.fail(`Unexpected Cloudflare operation: ${url.pathname}`);
    return Response.json({ success: true, result });
  });
  await provisionDev(
    {
      DEV_CLOUDFLARE_ACCOUNT_ID: account,
      CLOUDFLARE_API_TOKEN: "synthetic-provider-token",
      GH_TOKEN: "synthetic-github-token",
      EXPECTED_HEAD_SHA: head,
      CI_RUN_ID: "123",
      DEV_PROVISION_RECEIPT: join(directory, "receipt.json"),
      DEV_API_SECRETS_FILE: join(directory, "api.json"),
      DEV_INGESTION_SECRETS_FILE: join(directory, "ingestion.json"),
    },
    {
      account_id: account,
      observed_at: new Date().toISOString(),
      workers_plan: "paid",
      plan_evidence: "synthetic owner confirmation",
    },
    true,
  );
  assert.deepEqual(workers, [], "Script API provenance makes the guarded first versions upload fail");
  assert.equal(commands.filter(({ args }) => args[0] === "deploy").length, 2);
  assert.deepEqual(
    shells.map(({ config }) => config.name),
    ["card-keepr-api-dev", "card-keepr-ingestion-dev"],
  );
  assert.deepEqual(
    shells.map(({ secrets }) => secrets),
    [apiSecrets, ingestionSecrets],
  );
  for (const { config, source } of shells) {
    assert.equal(config.account_id, account);
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.deepEqual(config.routes, []);
    for (const field of ["vars", "d1_databases", "r2_buckets", "services", "workflows"])
      assert.equal(config[field], undefined);
    const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;
    for (const method of ["GET", "POST"])
      assert.equal((await worker.fetch(new Request("https://dev.invalid/", { method }))).status, 503);
  }
});
