import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("production release is manual, serialized, versioned, and owns all production mutation", () => {
  const release = readFileSync(".github/workflows/production-release.yml", "utf8");
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(release, /workflow_dispatch:/u);
  assert.match(release, /group: production-release/u);
  assert.match(release, /environment: production/u);
  assert.match(release, /versions upload/u);
  assert.match(release, /versions deploy/u);
  assert.match(release, /production-smoke\.mjs/u);
  assert.match(release, /replacement_database_id/u);
  assert.match(release, /retained_database_id/u);
  assert.match(release, /failed\.sql/u);
  assert.match(release, /deploy-production:\s*\n\s*if: inputs\.operation == 'credential_probe'/u);
  assert.match(release, /guarded-release:\s*\n\s*if: inputs\.operation == 'production_release'/u);
  assert.match(release, /Observe the binding while recovery remains blocked/u);
  assert.doesNotMatch(release, /\/acceptance|ADMINISTRATION_TOKEN/u);
  assert.doesNotMatch(release, /curl|Authorization:\s*Bearer|--header|-H\s/u);
  assert.doesNotMatch(release, /d1 execute[^\n]*--command/u);
  const credentialJob = release.split("  guarded-release:")[0];
  assert.match(credentialJob, /production-release-provider\.mjs credential-proof/u);
  assert.doesNotMatch(credentialJob, /d1 execute|d1 migrations|wrangler deploy|versions (?:upload|deploy)/u);
  assert.match(release, /validate-dispatch \/tmp\/production-release/u);
  assert.match(release, /production-release-provider\.mjs credential-proof/u);
  assert.match(release, /production-release-provider\.mjs verify-target/u);
  assert.match(release, /production-release-provider\.mjs observe-bindings/u);
  assert.match(release, /live-preflight\.sql[\s\S]*claim\.sql[\s\S]*d1 migrations apply[\s\S]*materialize\.sql/u);
  assert.match(release, /changed_rows[\s\S]*transition_rows[\s\S]*changed_rows/u);
  assert.doesNotMatch(release, /d1 delete|databases\/\$\{RETAINED_DATABASE_ID\}/u);
  assert.match(ci, /pull_request:/u);
  assert.match(ci, /push:/u);
  assert.doesNotMatch(ci, /CLOUDFLARE_API_TOKEN|environment:\s*production|--remote|wrangler (?:deploy|versions deploy)/u);
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
  assert.doesNotMatch(cli, /secret_slot|credential_probe/u);
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

test("guarded release migration retains immutable state and legal transitions", () => {
  const sql = readFileSync("migrations/0019_guarded_production_release.sql", "utf8");
  assert.match(sql, /CREATE TABLE production_releases/u);
  assert.match(sql, /requested.*preflight.*migrating.*deploying.*smoke_testing.*succeeded.*failed/su);
  assert.match(sql, /one_active_production_release/u);
  assert.match(sql, /production_release_request_immutable/u);
  assert.match(sql, /illegal production release transition/u);
  assert.match(sql, /replacement_database_id/u);
  assert.match(sql, /retained_database_id/u);
  assert.match(sql, /roll_forward_required/u);
});
