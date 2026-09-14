import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { stagingStateFixture } from "./helpers/staging-state.mjs";
import { stagingWorkflowFixture } from "./helpers/staging-workflow.mjs";
import { isolatedBindings } from "./helpers/isolated-bindings.mjs";
import { activeReleaseIdentity, countSuccessfulReleaseEvidence } from "./helpers/query-helpers/production-release.mjs";
import { environmentConfigurations } from "../scripts/dev-environment.mjs";
import { runStagingRelease } from "../scripts/staging-release.mjs";

// Real owner intent, signed identity, production/staging SQL, migration rehearsal,
// guarded executor and outcome. Only provider HTTP and external commands are controlled.
for (const scenario of ["success", "validation failure", "wrong active version"])
  test(`manual staging execution retains separate deployment and validation evidence: ${scenario}`, async (t) => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const production = await stagingStateFixture(t);
    const staging = await stagingStateFixture(t);
    const { token } = await stagingWorkflowFixture(t, head);
    const { handleStagingAuthorization } = await production.vite.ssrLoadModule(
      "/src/catalogue/ingestion/staging-authorization.ts",
    );
    const { handleStagingDeployment, handleStagingOutcome, showStagingDeployment } = await staging.vite.ssrLoadModule(
      "/src/catalogue/ingestion/staging-deployment.ts",
    );
    const choices = { ...production.choices, expected_head_sha: head };
    const now = new Date().toISOString();
    const preview = await production.resolveStagingRelease(
      production.database,
      production.bucket,
      { ...choices, prepare: true },
      production.target,
      now,
    );
    const owner = await production.resolveStagingRelease(
      production.database,
      production.bucket,
      { ...choices, confirmation: preview.confirmation },
      production.target,
      now,
    );
    const env = {
      KEEPR_ENVIRONMENT: "staging",
      CATALOGUE_DB: staging.database,
      CATALOGUE_EXPORTS: staging.bucket,
      CLOUDFLARE_ACCOUNT_ID: production.target.cloudflare_account_id,
      CATALOGUE_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000003",
      D1_VERIFICATION_TOKEN: "synthetic-verification",
    };
    const disposable = {
      name: "card-keepr-disposable-verification-staging",
      uuid: "00000000-0000-0000-0000-000000000004",
    };
    const configs = await environmentConfigurations("staging", {
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      catalogueId: env.CATALOGUE_D1_DATABASE_ID,
      disposableId: disposable.uuid,
    });
    for (const app of Object.keys(configs)) {
      const path = `apps/${app}/wrangler.staging.json`;
      const prior = await readFile(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      t.after(() => (prior === null ? rm(path, { force: true }) : writeFile(path, prior)));
    }
    const byName = Object.fromEntries(Object.values(configs).map((config) => [config.name, config]));
    const github = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(input);
      if (["api.github.com", "token.actions.githubusercontent.com"].includes(url.hostname))
        return github(input, options);
      if (url.hostname === "synthetic.actions.example") return Response.json({ value: await token() });
      if (url.hostname === "card.keepr.digital")
        return handleStagingAuthorization(new Request(input, options), {
          KEEPR_ENVIRONMENT: "production",
          CATALOGUE_DB: production.database,
        });
      if (url.hostname === "card-staging.keepr.digital") {
        if (url.pathname.endsWith("/outcome"))
          return handleStagingOutcome(new Request(input, options), env, owner.release_id);
        if (url.pathname.endsWith("/staging-deployments"))
          return handleStagingDeployment(new Request(input, options), env);
        const runtime = url.pathname.startsWith("/ingest/") ? "ingestion" : "api";
        if (
          url.pathname.endsWith("/health") &&
          (runtime === "ingestion" || options.headers.authorization !== "Bearer synthetic-traffic")
        )
          return Response.json({ code: "authentication_required" }, { status: 401 });
        return Response.json(
          url.pathname.endsWith("/v1/catalogue")
            ? { meta: { catalogue_revision_id: "catrev_spine_000" } }
            : { status: "ok", runtime, checks: {} },
          { headers: { "x-catalogue-revision": "catrev_spine_000" } },
        );
      }
      assert.equal(url.hostname, "api.cloudflare.com");
      requests.push(url.pathname);
      let result;
      if (url.pathname.includes("/workflows/")) return new Response(null, { status: 404 });
      if (url.pathname.endsWith("/query")) {
        const body = JSON.parse(options.body);
        result = body.sql
          .split(/;\s*/u)
          .filter((sql) => sql.trim())
          .map((sql) => {
            const statement = staging.sql.prepare(sql);
            const results = statement.columns().length ? statement.all() : (statement.run(), []);
            return { success: true, results };
          });
      } else if (url.pathname.endsWith("/d1/database")) result = [disposable];
      else if (url.pathname.includes("/d1/database/")) {
        const id = url.pathname.split("/").at(-1);
        result = { uuid: id, name: id === disposable.uuid ? disposable.name : "card-keepr-catalogue-staging" };
      } else if (url.pathname.endsWith("/zones"))
        result = [{ id: "synthetic-zone", name: "keepr.digital", account: { id: env.CLOUDFLARE_ACCOUNT_ID } }];
      else if (url.pathname.endsWith("/workers/routes"))
        result = Object.values(configs).flatMap((config) =>
          config.routes.map((route) => ({ pattern: route.pattern, script: config.name })),
        );
      else if (url.pathname.endsWith("/domains/managed"))
        result = { enabled: false, bucketId: "synthetic-bucket", domain: "private.r2.dev" };
      else if (url.pathname.endsWith("/domains/custom")) result = { domains: [] };
      else if (url.pathname.includes("/r2/buckets/")) result = { name: url.pathname.split("/").at(-1) };
      else {
        const worker = /\/workers\/scripts\/([^/]+)/u.exec(url.pathname)?.[1];
        const config = byName[worker];
        assert.ok(config, url.pathname);
        const version = `version-${worker}`;
        if (url.pathname.endsWith("/deployments"))
          result = {
            deployments: [
              {
                id: `deployment-${worker}`,
                versions: [{ version_id: scenario === "wrong active version" ? "older" : version, percentage: 100 }],
              },
            ],
          };
        else if (url.pathname.endsWith("/versions"))
          result = {
            items: [
              {
                id: version,
                annotations: {
                  "workers/tag": `release-${owner.release_id}-${worker === configs.api.name ? "api" : "ingestion"}`,
                },
              },
            ],
          };
        else if (url.pathname.includes("/versions/")) result = { resources: { bindings: isolatedBindings(config) } };
        else if (url.pathname.endsWith("/settings")) result = { bindings: isolatedBindings(config) };
        else assert.fail(url.pathname);
      }
      return Response.json({ success: true, result });
    };
    const commands = [];
    const executeCommand = async (command, args) => {
      if (command === "git") return { stdout: head };
      assert.ok(command.endsWith("/wrangler") || command === "bash");
      commands.push({ command, args });
      return { stdout: "" };
    };
    const runValidation = async (scenarios) => {
      assert.deepEqual(scenarios, owner.intent.extended_scenarios);
      if (scenario === "validation failure") throw new Error("synthetic retained-source failure");
      return { exit_code: 0 };
    };
    const input = {
      RELEASE_ENVIRONMENT: "staging",
      RELEASE_ID: owner.release_id,
      INTENT_DIGEST: owner.intent_digest,
      EXPECTED_HEAD_SHA: head,
      GH_TOKEN: "synthetic-github",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://synthetic.actions.example/oidc",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc",
      CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
      STAGING_CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
      STAGING_CATALOGUE_DATABASE_ID: env.CATALOGUE_D1_DATABASE_ID,
      CLOUDFLARE_API_TOKEN: "synthetic-provider",
      API_TRAFFIC_TOKEN: "synthetic-traffic",
    };
    if (scenario === "success")
      assert.equal((await runStagingRelease(input, executeCommand, runValidation)).state, "succeeded");
    else await assert.rejects(runStagingRelease(input, executeCommand, runValidation), /staging_release_failed/u);
    const retained = await showStagingDeployment(staging.database, owner.release_id);
    assert.equal(retained.outcome.state, scenario === "success" ? "succeeded" : "failed");
    assert.equal(retained.outcome.deployment.state, scenario === "wrong active version" ? "failed" : "succeeded");
    assert.equal(retained.outcome.migration.starting_level, owner.intent.production_start.migration_level);
    assert.equal(countSuccessfulReleaseEvidence(staging.sql).get().count, scenario === "wrong active version" ? 0 : 1);
    assert.equal(countSuccessfulReleaseEvidence(production.sql).get().count, 0);
    assert.equal(activeReleaseIdentity(production.sql).get().active_production_release_id, null);
    assert.ok(commands.some(({ args }) => args[0] === "versions" && args[1] === "upload" && args.includes("--strict")));
    assert.ok(requests.every((path) => !path.includes("/workers/scripts/card-keepr-api/")));
    for (const check of retained.outcome.checks.filter((check) => check.state !== "not_run")) {
      const bytes = await readFile(`.artifacts/staging-release/${check.name}.json`);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), check.evidence_sha256);
    }
    if (scenario === "success") {
      const altered = structuredClone(retained.outcome);
      altered.migration.ending_level++;
      const response = new Request(
        "https://card-staging.keepr.digital/ingest/v1/staging-deployments/staging-237/outcome",
        {
          method: "POST",
          headers: { authorization: `Bearer ${await token()}`, "x-github-token": "synthetic-github" },
          body: JSON.stringify({ intent_digest: owner.intent_digest, outcome: altered }),
        },
      );
      await assert.rejects(
        handleStagingOutcome(response, env, owner.release_id),
        (error) => error.code === "staging_migration_mismatch",
      );
    }
  });
