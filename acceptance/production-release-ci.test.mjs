import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const mergeSha = "a".repeat(40);
const prSha = "b".repeat(40);
const expectedChecks = [
  "lint",
  "checks",
  "domain-tests",
  "ingestion-tests (1)",
  "ingestion-tests (2)",
  "ingestion-tests (3)",
  "acceptance (1)",
  "acceptance (2)",
  "acceptance (3)",
];
const green = (sha) =>
  expectedChecks.map((name) => ({
    name,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    app: { slug: "github-actions" },
  }));

// Synthetic GitHub responses and injected failures, not remote CI evidence.
// Execute the actual pre-checkout gate: the CLI dispatch cannot observe the
// workflow's later GitHub decision through an emulated administration Worker.
function gate(t, checks, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "keepr-ci-gate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workflow = readFileSync(".github/workflows/production-release.yml", "utf8");
  const step = workflow
    .split("      - name: Verify the release SHA is contained in main and passed ci\n")[1]
    .split("      - name:")[0];
  const script = step.split("        run: |\n")[1].replace(/^ {10}/gmu, "");
  const required = step.match(/REQUIRED_CI_CHECKS: '([^\n]+)'/u)?.[1];
  writeFileSync(join(directory, "fixture.json"), JSON.stringify({ checks, ...options }));
  writeFileSync(
    join(directory, "gh"),
    `#!${process.execPath}
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const fixture = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const args = process.argv.slice(2);
const route = args[1];
let data;
if (fixture.apiFailure) process.exit(1);
if (route.includes("/compare/")) data = { status: fixture.compare ?? "identical" };
else if (route.endsWith("/pulls")) data = [{ merged_at: "2026-09-06", base: { ref: "main" }, merge_commit_sha: "${mergeSha}", head: { sha: "${prSha}" } }];
else if (route.includes("/check-runs?")) {
  const checks = route.includes("/${prSha}/") ? ${JSON.stringify(green(prSha))} : fixture.checks;
  const pages = fixture.pages ?? [{ check_runs: checks }];
  data = args.includes("--slurp") ? (args.includes("--paginate") ? pages : pages.slice(0, 1)) : pages[0];
} else throw new Error("Unexpected API route: " + route);
const query = args.indexOf("--jq");
if (query !== -1) {
  const result = spawnSync("jq", ["-c", "-r", args[query + 1]], { input: JSON.stringify(data), encoding: "utf8" });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status);
}
process.stdout.write(JSON.stringify(data));
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      FIXTURE: join(directory, "fixture.json"),
      EXPECTED_HEAD_SHA: options.sha ?? mergeSha,
      GITHUB_REPOSITORY: "KeeprDigital/card-keepr",
      REQUIRED_CI_CHECKS: required,
    },
  });
  assert.ifError(result.error);
  return result;
}

test("a green PR head cannot authorize its red merge commit", (t) => {
  const checks = green(mergeSha);
  checks[0].conclusion = "failure";
  const result = gate(t, checks);
  assert.notEqual(result.status, 0, result.stdout);
});

test("every expected shard must be present", (t) => {
  const result = gate(
    t,
    green(mergeSha).filter((check) => check.name !== "acceptance (2)"),
  );
  assert.notEqual(result.status, 0, result.stdout);
});

for (const name of expectedChecks) {
  for (const state of ["missing", "pending", "failure", "cancelled", "skipped", "timed_out"]) {
    test(`${name}: ${state} blocks the exact commit`, (t) => {
      const checks = green(mergeSha);
      const check = checks.find((entry) => entry.name === name);
      if (state === "missing") checks.splice(checks.indexOf(check), 1);
      else if (state === "pending") Object.assign(check, { status: "in_progress", conclusion: null });
      else check.conclusion = state;
      const result = gate(t, checks);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stdout, /ci job/u);
    });
  }
}

test("complete exact-SHA success authorizes the selected commit even after main advances", (t) => {
  const result = gate(t, green(mergeSha), { compare: "behind" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`passed ci on ${mergeSha}`, "u"));
});

test("required checks on later API pages are included", (t) => {
  const checks = green(mergeSha);
  const result = gate(t, checks, { pages: [{ check_runs: checks.slice(0, 4) }, { check_runs: checks.slice(4) }] });
  assert.equal(result.status, 0, result.stderr);
});

for (const scenario of [
  "wrong SHA",
  "wrong app",
  "duplicate check",
  "empty checks",
  "API unavailable",
  "outside main",
  "invalid SHA",
]) {
  test(`${scenario} cannot authorize release`, (t) => {
    const checks = green(mergeSha);
    const options = {};
    if (scenario === "wrong SHA") checks[0].head_sha = prSha;
    if (scenario === "wrong app") checks[0].app.slug = "another-app";
    if (scenario === "duplicate check") checks.push({ ...checks[0] });
    if (scenario === "empty checks") checks.length = 0;
    if (scenario === "API unavailable") options.apiFailure = true;
    if (scenario === "outside main") options.compare = "ahead";
    if (scenario === "invalid SHA") options.sha = "main";
    const result = gate(t, checks, options);
    assert.notEqual(result.status, 0, result.stdout);
  });
}
