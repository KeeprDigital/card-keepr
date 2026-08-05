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
  assert.match(release, /roll_forward_required/u);
  assert.match(release, /deploy-production:\s*\n\s*if: inputs\.operation == 'credential_probe'/u);
  assert.match(release, /guarded-release:\s*\n\s*if: inputs\.operation == 'production_release'/u);
  assert.match(release, /Observe bound replacement before recovery acceptance/u);
  assert.doesNotMatch(release, /d1 delete|databases\/\$\{RETAINED_DATABASE_ID\}/u);
  assert.match(ci, /pull_request:/u);
  assert.match(ci, /push:/u);
  assert.doesNotMatch(ci, /CLOUDFLARE_API_TOKEN|environment:\s*production|--remote|wrangler (?:deploy|versions deploy)/u);
});

test("only the guarded CLI provider can select release mode", () => {
  const cli = readFileSync("cli/production-release.mjs", "utf8");
  const provider = readFileSync("cli/provider-github-release.mjs", "utf8");
  assert.match(cli, /operation: "production_release"/u);
  assert.doesNotMatch(cli, /secret_slot|credential_probe/u);
  assert.match(provider, /inputs\?\.operation !== "production_release"/u);
  assert.equal((provider.match(/export async function dispatchProductionRelease/gu) ?? []).length, 1);
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
