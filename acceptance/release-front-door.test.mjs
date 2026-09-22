import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const conventional = [
  "feat: add Lorcana adapter",
  "fix(ingestion): settle late dispatches",
  "ci: add conventional PR title check and release-please",
  "refactor(238)!: drop the staging scope classifier",
  "chore: release 0.1.0",
];
const refused = [
  "Add Lorcana adapter",
  "feature: add Lorcana adapter",
  "fix:missing space",
  "fix: ",
  "Fix: capitalised type",
  "revert: undo release",
  "feat(Upper): scope case",
];

test("the required PR title check accepts exactly the conventional release-please types", async () => {
  const workflow = await readFile(".github/workflows/pr-title.yml", "utf8");
  const pattern = workflow.match(/^ {10}pattern='([^']+)'$/mu)?.[1];
  assert.ok(pattern);
  // Evaluate the workflow's own bash regex rather than a JavaScript translation of it.
  const matches = (title) =>
    execFileSync("bash", ["-c", 'if [[ "$TITLE" =~ $PATTERN ]]; then echo yes; else echo no; fi'], {
      env: { PATH: process.env.PATH, TITLE: title, PATTERN: pattern },
      encoding: "utf8",
    }).trim() === "yes";
  for (const title of conventional) assert.equal(matches(title), true, title);
  for (const title of refused) assert.equal(matches(title), false, title);
});

test("release-please only opens the release PR and tags; it holds no deployment authority", async () => {
  const workflow = await readFile(".github/workflows/release-please.yml", "utf8");
  assert.doesNotMatch(workflow, /secrets\.|environment:|id-token/u);
  // A created release records its tag commit's extended scenarios (#238), with only
  // the status write that workflow needs.
  const extended = workflow.split("\n  extended:\n")[1];
  assert.ok(extended);
  assert.match(extended, /^ {4}needs: release-please$/mu);
  assert.match(extended, /^ {4}if: needs\.release-please\.outputs\.release_created == 'true'$/mu);
  assert.match(extended, /^ {4}permissions:\n {6}contents: read\n {6}statuses: write\n {4}uses:/mu);
  assert.match(
    extended,
    /^ {4}uses: \.\/\.github\/workflows\/extended-scenarios\.yml\n {4}with:\n {6}sha: \$\{\{ needs\.release-please\.outputs\.sha \}\}$/mu,
  );
  assert.match(workflow, /^ {6}sha: \$\{\{ steps\.release\.outputs\.sha \}\}$/mu);
  const config = JSON.parse(await readFile("release-please.json", "utf8"));
  const root = config.packages["."];
  assert.equal(root["include-component-in-tag"], false);
  assert.equal(root["include-v-in-tag"], true);
  assert.match(root["pull-request-title-pattern"], /^chore: release \$\{version\}$/u);
  const types = new Set(root["changelog-sections"].map((section) => section.type));
  assert.deepEqual([...types].sort(), ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "test"]);
});
