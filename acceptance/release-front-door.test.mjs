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
  const config = JSON.parse(await readFile("release-please.json", "utf8"));
  const root = config.packages["."];
  assert.equal(root["include-component-in-tag"], false);
  assert.equal(root["include-v-in-tag"], true);
  assert.match(root["pull-request-title-pattern"], /^chore: release \$\{version\}$/u);
  const types = new Set(root["changelog-sections"].map((section) => section.type));
  assert.deepEqual([...types].sort(), ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "test"]);
});
