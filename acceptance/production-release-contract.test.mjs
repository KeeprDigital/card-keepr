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
  // Issue #148: a remote `d1 execute --file` runs through the D1 import API
  // and returns no statement rows, so every release state read and write goes
  // through the query-endpoint runner with the generated file; only the
  // migrations still run through wrangler.
  assert.doesNotMatch(release, /d1 execute/u);
  assert.doesNotMatch(failure, /d1 execute/u);
  assert.match(
    release,
    /production-release-d1\.mjs execute --config apps\/ingestion\/wrangler\.jsonc --file \/tmp\/production-release\/live-preflight\.sql/u,
  );
  assert.match(
    release,
    /production-release-d1\.mjs execute --config apps\/ingestion\/wrangler\.jsonc --file \/tmp\/production-release\/claim\.sql/u,
  );
  assert.match(
    failure,
    /production-release-d1\.mjs execute --config "\$\{config\}" --file "\$\{release_directory\}\/cleanup\.sql"/u,
  );
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
  assert.match(
    release,
    /RELEASE_WORKER=card-keepr-ingestion [^\n]*\$\{INGESTION_RELEASE_CONFIG\}[^\n]*verify-version/u,
  );
  // Issue #123: zone routes are script-level triggers that `versions deploy`
  // never applies, so both workers' routes are deployed after activation and
  // before the binding observation and smoke checks read the public mounts.
  assert.match(
    release,
    /versions deploy[\s\S]*Deploy the route triggers[\s\S]*triggers deploy --config "\$\{API_RELEASE_CONFIG\}"[\s\S]*triggers deploy --config "\$\{INGESTION_RELEASE_CONFIG\}"[\s\S]*Observe the binding while recovery remains blocked[\s\S]*production-smoke\.mjs/u,
  );
  assert.doesNotMatch(release, /triggers deploy[\s\S]*versions deploy/u);
  // GitHub rejects a workflow with more than 25 workflow_dispatch inputs and
  // records a failed run on every push instead; the file carried 26 until #120.
  const inputs =
    release
      .split("\n    inputs:\n")[1]
      .split(/\n  [a-z]/u)[0]
      .match(/^      [a-z_]+:$/gmu) ?? [];
  assert.ok(inputs.length >= 1 && inputs.length <= 25, `workflow_dispatch declares ${inputs.length} inputs`);
  assert.match(release, /live-preflight\.sql[\s\S]*claim\.sql[\s\S]*d1 migrations apply[\s\S]*materialize\.sql/u);
  assert.match(release, /migration-started\.sql[\s\S]*d1 migrations apply/u);
  assert.match(release, /replacement-handoff\.sql[\s\S]*replacement-seed[\s\S]*seeded[\s\S]*RELEASE_STATE_CONFIG/u);
  assert.equal(
    (
      release.match(
        /--config "\$\{RELEASE_STATE_CONFIG\}" --file \/tmp\/production-release\/(?:deploying|binding|smoke)\.sql/gu,
      ) ?? []
    ).length,
    4,
  );
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
  // A pull request's refs/pull/N/merge only matches the eventual merge when
  // the PR was current with main, so main is also tested on push; the
  // concurrency group cancels superseded main runs.
  assert.match(ci, /^\s*push:\n\s*branches: \[main\]/mu);
  assert.match(ci, /workflow_dispatch:/u);
  assert.doesNotMatch(
    ci,
    /CLOUDFLARE_API_TOKEN|environment:\s*production|--remote|wrangler (?:deploy|versions deploy)/u,
  );
});

test("the release SHA is resolved through the GitHub API before checkout and ci stays in step with it", () => {
  // Issue #75: expected_head_sha is verified before any other step with the
  // workflow's own read-only token: full commit id, contained in main, and a
  // successful latest ci check run for every ci.yml job (resolved through
  // the merged pull request when the SHA is a merge commit on main).
  const release = readFileSync(".github/workflows/production-release.yml", "utf8");
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const steps = release
    .split(/\n      - name: /u)
    .slice(1)
    .map((step) => ({ name: step.split("\n")[0], body: step }));
  assert.equal(steps[0].name, "Verify the release SHA is contained in main and passed ci");
  assert.equal(steps[1].name, "Check out the exact guarded release");
  const gate = steps[0].body;
  assert.match(gate, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(gate, /grep -Eq '\^\[0-9a-f\]\{40\}\$'/u);
  assert.match(gate, /compare\/main\.\.\.\$\{EXPECTED_HEAD_SHA\}/u);
  assert.match(gate, /identical\|behind\) ;;/u);
  assert.match(
    gate,
    /commits\/\$\{EXPECTED_HEAD_SHA\}\/pulls[^\n]*merged_at != null[^\n]*base\.ref == \\"main\\"[^\n]*merge_commit_sha == \\"\$\{EXPECTED_HEAD_SHA\}\\"/u,
  );
  assert.match(gate, /commits\/\$\{ci_sha\}\/check-runs\?filter=latest/u);
  assert.match(gate, /app\.slug == "github-actions"/u);
  assert.match(gate, /status != "completed" or \.conclusion != "success"/u);
  assert.doesNotMatch(gate, /secrets\./u);
  // The workflow token reads checks and pull requests and writes nothing.
  assert.match(release, /permissions:\n      contents: read\n      checks: read\n      pull-requests: read\n/u);
  assert.doesNotMatch(release, /:\s*write\b/u);
  // Every ci.yml job is a required check of the release gate, and nothing
  // else is: adding or renaming a ci job updates REQUIRED_CI_JOBS.
  const required = gate
    .match(/REQUIRED_CI_JOBS: ([^\n]+)/u)[1]
    .trim()
    .split(/\s+/u)
    .sort();
  const ciJobs = (ci.split("\njobs:\n")[1].match(/^  [\w-]+:$/gmu) ?? [])
    .map((line) => line.trim().slice(0, -1))
    .sort();
  assert.deepEqual(required, ciJobs);
  assert.ok(ciJobs.includes("lint"));
  // ci cancels a superseded run of the same pull request.
  assert.match(
    ci,
    /concurrency:\n  group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n  cancel-in-progress: true/u,
  );
});

test("workflow hygiene: pinned actions, no secret written to GITHUB_ENV, no misleading job name, stress failures reported", () => {
  // Issue #75.
  const workflows = ["cache-warm", "ci", "production-preflight", "production-release", "stress"].map((name) => [
    name,
    readFileSync(`.github/workflows/${name}.yml`, "utf8"),
  ]);
  for (const [name, text] of workflows) {
    for (const uses of text.match(/^\s*(?:- )?uses: .+$/gmu) ?? []) {
      assert.match(uses, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u, `${name}: ${uses.trim()}`);
    }
    // A secret interpolated into a GITHUB_ENV or GITHUB_OUTPUT write would
    // need the heredoc-delimiter form; the workflows write only file paths.
    for (const line of text.split("\n").filter((candidate) => /GITHUB_ENV|GITHUB_OUTPUT/u.test(candidate))) {
      assert.doesNotMatch(line, /secrets\.|TOKEN|KEY/u, `${name}: ${line.trim()}`);
    }
  }
  const release = workflows.find(([name]) => name === "production-release")[1];
  assert.doesNotMatch(release, /deploy-production/u);
  const stress = workflows.find(([name]) => name === "stress")[1];
  assert.match(stress, /60 days/u);
  assert.match(stress, /docs\/runbooks\/scheduled-stress\.md/u);
  assert.match(stress, /report-failure:\n    needs: stress\n    if: failure\(\)/u);
  assert.match(stress, /permissions:\n      contents: read\n      issues: write/u);
  assert.match(stress, /gh issue create[^\n]*--label bug/u);
  assert.match(stress, /gh issue comment/u);
  // The stress job itself keeps the workflow's read-only token.
  assert.doesNotMatch(stress.split("\n  report-failure:")[0], /issues: write/u);
  assert.match(
    readFileSync("docs/runbooks/scheduled-stress.md", "utf8"),
    /60 days[\s\S]*gh workflow enable stress\.yml/u,
  );
});

test("the Bootstrap Mode branch keeps every data-independent gate, runs no data-dependent smoke, and rolls nothing back", () => {
  // Issue #141: before the first published Catalogue Revision the guarded
  // Production Release runs in Bootstrap Mode, selected by one workflow input
  // that the validator checks against the prepared plan.
  const release = readFileSync(".github/workflows/production-release.yml", "utf8");
  const failure = readFileSync("scripts/production-release-failure.sh", "utf8");
  assert.match(
    release,
    /^      bootstrap:\n        required: false\n        default: "false"\n        type: string$/mu,
  );
  assert.match(release, /BOOTSTRAP: \$\{\{ inputs\.bootstrap \}\}/u);
  const steps = release
    .split(/\n      - name: /u)
    .slice(1)
    .map((step) => ({ name: step.split("\n")[0], body: step }));
  const bootstrapOnly = steps.filter((step) => /if: inputs\.bootstrap == 'true'/u.test(step.body));
  const populatedOnly = steps.filter((step) => /if: inputs\.bootstrap != 'true'/u.test(step.body));
  const shared = steps.filter((step) => !/inputs\.bootstrap/u.test(step.body));
  assert.deepEqual(
    bootstrapOnly.map((step) => step.name),
    [
      "Transfer the pre-migration fence to the Production Release lease in Bootstrap Mode",
      "Run reduced Bootstrap Mode smoke checks",
    ],
  );
  assert.deepEqual(
    populatedOnly.map((step) => step.name),
    ["Transfer the pre-migration fence to the durable Production Release", "Run black-box production smoke checks"],
  );
  // Every other gate stays: exact dispatch, target and secret inventory,
  // live recheck, fence, migrations, version bindings, activation, routes.
  for (const required of [
    /validate-dispatch/u,
    /verify-target/u,
    /live-preflight\.sql/u,
    /claim\.sql/u,
    /migrations apply/u,
    /versions upload/u,
    /verify-version/u,
    /versions deploy/u,
    /triggers deploy/u,
    /observe-bindings/u,
    /production-release-failure\.sh/u,
  ]) {
    assert.ok(
      shared.some((step) => required.test(step.body)),
      String(required),
    );
  }
  const smoke = bootstrapOnly[1].body;
  assert.match(smoke, /production-smoke\.mjs bootstrap/u);
  assert.match(smoke, /evidence-sql smoke/u);
  assert.doesNotMatch(
    smoke,
    /SMOKE_TARGETS_JSON|RETAINED_REVISION_EVIDENCE_JSON|RECOVERY_BOOKMARK|RECOVERY_BACKUP_ATTEMPT_ID|legality|printing|cards|exports|stale/u,
  );
  assert.doesNotMatch(release, /rollback|versions rollback|restore|recovery accept/iu);
  // The bootstrap branch writes no failed.sql (no production_releases row can
  // exist without a backup); the handler only records the ledger failure and
  // releases the fence.
  assert.match(failure, /test -f "\$\{release_directory\}\/failed\.sql"/u);
  assert.match(failure, /failure-evidence\.sql[\s\S]*cleanup\.sql/u);
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
  assert.doesNotMatch(
    preflight,
    /versions upload|versions deploy|wrangler deploy|migrations apply|d1 execute|secret put|triggers deploy/u,
  );
  // Issue #148: the rehearsal proves the release state query path against
  // the live database with a read-only statement.
  assert.match(
    preflight,
    /production-release-d1\.mjs execute --config apps\/ingestion\/wrangler\.jsonc --file [^\n]*ready\.sql/u,
  );
  assert.match(preflight, /SELECT 1 AS ready/u);
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
  const domain = readFileSync("src/catalogue/ingestion/production-release.ts", "utf8");
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
