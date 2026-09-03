import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("production release is manual, serialized, versioned, and owns all production mutation", () => {
  const release = readFileSync(".github/workflows/production-release.yml", "utf8");
  const failure = readFileSync("scripts/production-release-failure.sh", "utf8");
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(release, /workflow_dispatch:/u);
  assert.match(release, /group: production-release/u);
  assert.match(release, /environment: production/u);
  assert.match(release, /versions upload/u);
  assert.match(release, /versions deploy/u);
  assert.match(release, /production-smoke\.mjs/u);
  assert.match(release, /replacement_database_id/u);
  assert.match(release, /retained_database_id/u);
  assert.match(failure, /failed\.sql/u);
  assert.match(failure, /set \+e[\s\S]*failed_command_status[\s\S]*cleanup_result/u);
  assert.match(release, /guarded-release:\s*\n\s*if: inputs\.operation == 'production_release'/u);
  assert.match(release, /Observe the binding while recovery remains blocked/u);
  assert.doesNotMatch(release, /\/acceptance|ADMINISTRATION_TOKEN/u);
  assert.doesNotMatch(release, /curl|Authorization:\s*Bearer|--header|-H\s/u);
  assert.doesNotMatch(release, /d1 execute[^\n]*--command/u);
  // The guarded release is the workflow's only job (ADR 0005 removed the
  // credential-probe job), and it is selected by the operation input alone.
  assert.equal((release.split("\njobs:\n")[1].match(/^  [\w-]+:$/gmu) ?? []).length, 1);
  assert.match(release, /options: \[production_release\]/u);
  assert.match(release, /validate-dispatch \/tmp\/production-release/u);
  assert.match(release, /production-release-provider\.mjs verify-target/u);
  assert.match(release, /production-release-provider\.mjs observe-bindings/u);
  // Issue #122: vars and bindings are verified on the uploaded version, after
  // upload and before activation, so config changes ship through the guard.
  assert.match(release, /versions upload[\s\S]*production-release-provider\.mjs verify-version[\s\S]*versions deploy/u);
  assert.match(release, /RELEASE_WORKER=card-keepr-api [^\n]*\$\{API_RELEASE_CONFIG\}[^\n]*verify-version/u);
  assert.match(release, /RELEASE_WORKER=card-keepr-ingestion [^\n]*\$\{INGESTION_RELEASE_CONFIG\}[^\n]*verify-version/u);
  // Issue #123: zone routes are script-level triggers that `versions deploy`
  // never applies, so both workers' routes are deployed after activation and
  // before the binding observation and smoke checks read the public mounts.
  assert.match(release, /versions deploy[\s\S]*Deploy the route triggers[\s\S]*triggers deploy --config "\$\{API_RELEASE_CONFIG\}"[\s\S]*triggers deploy --config "\$\{INGESTION_RELEASE_CONFIG\}"[\s\S]*Observe the binding while recovery remains blocked[\s\S]*production-smoke\.mjs/u);
  assert.doesNotMatch(release, /triggers deploy[\s\S]*versions deploy/u);
  // GitHub rejects a workflow with more than 25 workflow_dispatch inputs and
  // records a failed run on every push instead; the file carried 26 until #120.
  const inputs = release.split("\n    inputs:\n")[1].split(/\n  [a-z]/u)[0].match(/^      [a-z_]+:$/gmu) ?? [];
  assert.ok(inputs.length >= 1 && inputs.length <= 25, `workflow_dispatch declares ${inputs.length} inputs`);
  assert.match(release, /live-preflight\.sql[\s\S]*claim\.sql[\s\S]*d1 migrations apply[\s\S]*materialize\.sql/u);
  assert.match(release, /migration-started\.sql[\s\S]*d1 migrations apply/u);
  assert.match(release, /replacement-handoff\.sql[\s\S]*replacement-seed[\s\S]*seeded[\s\S]*RELEASE_STATE_CONFIG/u);
  assert.equal((release.match(/--config "\$\{RELEASE_STATE_CONFIG\}" --file \/tmp\/production-release\/(?:deploying|binding|smoke)\.sql/gu) ?? []).length, 3);
  assert.ok(release.indexOf("seeded' <<<") < release.indexOf("versions upload"));
  assert.match(failure, /RELEASE_STATE_CONFIG:-apps\/ingestion\/wrangler\.jsonc/u);
  assert.doesNotMatch(release, /recovery accept|acceptCatalogueRecovery|\/acceptance/u);
  assert.match(release, /trap release_migration_exit EXIT[\s\S]*migration-started\.sql[\s\S]*d1 migrations apply/u);
  assert.match(release, /original_status=\$\?[\s\S]*exit "\$\{original_status\}"/u);
  assert.match(release, /production-release-failure\.sh/u);
  assert.doesNotMatch(release, /touch .*migrat|test -f .*migrated/u);
  assert.match(release, /changed_rows[\s\S]*transition_rows[\s\S]*changed_rows/u);
  assert.doesNotMatch(release, /d1 delete|databases\/\$\{RETAINED_DATABASE_ID\}/u);
  assert.match(ci, /pull_request:/u);
  // Pull requests already test refs/pull/N/merge; a push-to-main run repeats it.
  assert.match(ci, /workflow_dispatch:/u);
  assert.doesNotMatch(ci, /^\s*push:/mu);
  assert.doesNotMatch(ci, /CLOUDFLARE_API_TOKEN|environment:\s*production|--remote|wrangler (?:deploy|versions deploy)/u);
});

test("each worker owns one public base and the zone routes that mount it", () => {
  // Issue #123 / ADR 0007: one host, two path mounts, no router worker.
  for (const [config, mount] of [
    ["apps/api/wrangler.jsonc", "api"],
    ["apps/ingestion/wrangler.jsonc", "ingest"],
  ]) {
    const parsed = JSON.parse(readFileSync(config, "utf8"));
    assert.equal(parsed.vars.PUBLIC_BASE_URL, `https://card.keepr.digital/${mount}`);
    assert.deepEqual(parsed.routes, [
      { pattern: `card.keepr.digital/${mount}`, zone_name: "keepr.digital" },
      { pattern: `card.keepr.digital/${mount}/*`, zone_name: "keepr.digital" },
    ]);
    assert.equal(parsed.custom_domain, undefined);
    assert.equal(parsed.workers_dev, undefined);
  }
});

test("the production preflight rehearsal is read-only", () => {
  const preflight = readFileSync(".github/workflows/production-preflight.yml", "utf8");
  assert.match(preflight, /workflow_dispatch:/u);
  assert.match(preflight, /environment: production/u);
  assert.match(preflight, /production-release-provider\.mjs verify-target/u);
  assert.doesNotMatch(preflight, /versions upload|versions deploy|wrangler deploy|migrations apply|d1 execute|secret put|triggers deploy/u);
});

test("provider credentials stay in fetch headers and out of process arguments", () => {
  const provider = readFileSync("scripts/production-release-provider.mjs", "utf8");
  assert.match(provider, /headers:\s*\{ authorization: `Bearer \$\{token\}` \}/u);
  assert.doesNotMatch(provider, /spawn|exec|process\.argv\[[^\]]+\].*(?:TOKEN|token)|(?:TOKEN|token).*process\.argv/u);
});

test("only the guarded CLI provider can select release mode", () => {
  const cli = readFileSync("cli/production-release.mjs", "utf8");
  const provider = readFileSync("cli/provider-github-release.mjs", "utf8");
  assert.match(cli, /operation: "production_release"/u);
  assert.doesNotMatch(cli, /operation:(?!\s*"production_release")/u);
  assert.match(provider, /inputs\?\.operation !== "production_release"/u);
  assert.equal((provider.match(/export async function dispatchProductionRelease/gu) ?? []).length, 1);
});

test("owner preparation is durable before dispatch and post-migration failure is retained", () => {
  const route = readFileSync("apps/ingestion/src/index.ts", "utf8");
  const domain = readFileSync("src/catalogue/production-release.ts", "utf8");
  const script = readFileSync("scripts/production-release.mjs", "utf8");
  assert.match(route, /POST" && url\.pathname === "\/v1\/production-releases"/u);
  assert.match(domain, /prepare_production_release/u);
  assert.match(domain, /administration_idempotency/u);
  assert.match(script, /claim_production_release/u);
  assert.match(script, /INSERT OR IGNORE INTO production_releases[\s\S]*'failed'/u);
  assert.match(script, /roll_forward_required/u);
});

test("the guarded Production Release schema retains immutable state and legal transitions", () => {
  const sql = readFileSync("migrations/0001_baseline.sql", "utf8");
  assert.match(sql, /CREATE TABLE production_releases/u);
  assert.match(sql, /requested.*preflight.*migrating.*deploying.*smoke_testing.*succeeded.*failed/su);
  assert.match(sql, /one_active_production_release/u);
  assert.match(sql, /production_release_request_immutable/u);
  assert.match(sql, /illegal production release transition/u);
  assert.match(sql, /replacement_database_id/u);
  assert.match(sql, /retained_database_id/u);
  assert.match(sql, /roll_forward_required/u);
});
