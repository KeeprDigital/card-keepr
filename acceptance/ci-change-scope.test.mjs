import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { filteredEvents, isAllowListed, requiresFullSuite } from "../scripts/ci-change-scope.mjs";

// Issue #401: heavy CI skips only when every changed path is allow-listed.
test("the change classifier allow-lists only documentation and repository metadata", () => {
  for (const path of [
    "README.md",
    "AGENTS.md",
    "docs/testing.md",
    "docs/runbooks/repository-rules.md",
    "contracts/HTTP.md",
    "src/catalogue/README.md",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/pull_request_template.md",
    ".artifacts/401/notes.txt",
    "LICENSE",
    "LICENSE.md",
    ".github/CODEOWNERS",
  ]) {
    assert.ok(isAllowListed(path), path);
  }
  for (const path of [
    "src/catalogue/index.ts",
    "apps/api/src/index.ts",
    "apps/ingestion/test/fixtures/source-discovery-admission.md",
    "acceptance/fixtures/card-model-predecessor.md",
    "test/domain/example.spec.ts",
    "cli/lib/config.mjs",
    "contracts/read-openapi.json",
    "scripts/ci-change-scope.mjs",
    "docs/examples/pokemon-card-product-plan.json",
    "docs/runbooks/scheduled-stress.md",
    "package.json",
    "apps/api/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "patches/README.patch",
    ".github/workflows/ci.yml",
    ".github/workflows/docs.md.yml",
    ".github/actions/setup-toolchain/action.yml",
    ".gitignore",
    ".prettierignore",
    ".node-version",
    "release-please.json",
    "docs/README.MD",
  ]) {
    assert.ok(!isAllowListed(path), path);
  }
});

test("only pull requests and merge-queue candidates may skip; push to main always runs everything", () => {
  assert.deepEqual([...filteredEvents], ["pull_request", "merge_group"]);
  const docsOnly = ["docs/testing.md", "README.md"];
  assert.equal(requiresFullSuite("pull_request", docsOnly), false);
  assert.equal(requiresFullSuite("merge_group", docsOnly), false);
  for (const event of ["push", "workflow_dispatch", "schedule", ""]) {
    assert.equal(requiresFullSuite(event, docsOnly), true, event);
  }
  assert.equal(requiresFullSuite("pull_request", [...docsOnly, "pnpm-lock.yaml"]), true);
  assert.equal(requiresFullSuite("merge_group", [...docsOnly, ".github/workflows/ci.yml"]), true);
  assert.equal(requiresFullSuite("pull_request", []), true);
});

test("no allow-listed repository file is read by code or tests", () => {
  // A documentation file that a suite reads is not documentation-only; the
  // classifier must name it in testConsumedDocuments or a denied tree.
  const tracked = new Set(execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0"));
  const sources = [...tracked].filter(
    (path) => /\.(?:[cm]?js|ts|sh|ya?ml)$/u.test(path) && !path.startsWith("docs/") && !path.endsWith(".d.ts"),
  );
  const consumed = new Set();
  for (const source of sources) {
    for (const [, literal] of readFileSync(source, "utf8").matchAll(/["'`]\.?\/?([\w./-]+\.\w+)["'`]/gu)) {
      if (tracked.has(literal) && isAllowListed(literal)) consumed.add(`${source}: ${literal}`);
    }
  }
  assert.deepEqual([...consumed], []);
});

test("ci gates heavy jobs on the classifier without losing required matrix check names", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const jobs = Object.fromEntries(
    [...ci.split("\njobs:\n")[1].matchAll(/^ {2}([\w-]+):\n([\s\S]*?)(?=^ {2}[\w-]+:|(?![\s\S]))/gmu)].map(
      ([, name, body]) => [name, body],
    ),
  );
  assert.match(jobs.changes, /run: node scripts\/ci-change-scope\.mjs/u);
  assert.match(
    jobs.changes,
    /BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \|\| github\.event\.pull_request\.base\.sha \}\}/u,
  );
  // lint and checks stay unconditional.
  for (const name of ["lint", "checks"]) assert.doesNotMatch(jobs[name], /needs:|^ {4}if:/mu, name);
  // A failed or missing classification must run the suite (!= 'false'), and
  // a failed changes job must not skip dependents into green (!cancelled()).
  assert.match(
    jobs["domain-tests"],
    /needs: changes\n {4}if: \$\{\{ !cancelled\(\) && needs\.changes\.outputs\.full != 'false' \}\}/u,
  );
  for (const name of ["ingestion-tests", "acceptance"]) {
    const body = jobs[name];
    // A job-level skip of a matrix job reports one unsuffixed check, so the
    // classification must gate steps and leave the job-level if alone.
    assert.match(
      body,
      /needs: changes\n {4}if: \$\{\{ !cancelled\(\) && \(github\.event_name != 'pull_request' \|\| !github\.event\.pull_request\.draft\) \}\}/u,
    );
    assert.doesNotMatch(body.match(/^ {4}if: .*$/mu)[0], /changes/u, name);
    assert.match(body, /FULL_SUITE: \$\{\{ needs\.changes\.outputs\.full != 'false' \}\}/u);
    const steps = body.split("\n    steps:\n")[1].split(/\n {6}- /u);
    assert.match(steps[0], /^ {6}- if: env\.FULL_SUITE != 'true'\n {8}run: echo /u, name);
    for (const step of steps.slice(1)) assert.match(step, /env\.FULL_SUITE == 'true'/u, `${name}: ${step}`);
  }
});
