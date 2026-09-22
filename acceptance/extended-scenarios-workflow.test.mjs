import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { extendedAcceptanceFiles } from "./helpers/test-tiers.mjs";

// Split a workflow's `jobs:` block into its top-level job bodies by id.
function jobs(workflow) {
  const body = workflow.slice(workflow.indexOf("\njobs:\n"));
  return Object.fromEntries(
    body
      .split(/\n(?= {2}[a-z][a-z-]*:\n)/u)
      .slice(1)
      .map((block) => [block.trim().split(":")[0], block]),
  );
}

test("the per-commit extended record runs every extended journey and holds its write token apart from selected code", async () => {
  const workflow = await readFile(".github/workflows/extended-scenarios.yml", "utf8");
  const matrix = workflow.match(/^ {8}scenario: \[([^\]]+)\]$/mu)?.[1].split(", ");
  assert.deepEqual(
    matrix,
    extendedAcceptanceFiles.map((file) => file.replace(/\.test\.mjs$/u, "")),
  );
  const { select, pending, scenario, record } = jobs(workflow);
  assert.ok(select && pending && scenario && record);
  // Only the selected-commit job checks code out, and it cannot write statuses.
  assert.match(scenario, /ref: \$\{\{ needs\.select\.outputs\.sha \}\}/u);
  assert.doesNotMatch(scenario, /statuses: write|secrets\.|id-token/u);
  for (const trusted of [select, pending, record]) assert.doesNotMatch(trusted, /actions\/checkout/u);
  for (const writer of [pending, record]) assert.match(writer, /context=extended-scenarios/u);
  assert.match(record, /if: always\(\) && needs\.select\.outputs\.run == 'true'/u);
  assert.match(select, /select\(\.context == "extended-scenarios"\)/u);
  assert.match(select, /"success github-actions\[bot\]"/u);
});

test("staging no longer replays retained-source scenarios at release time", async () => {
  const workflow = await readFile(".github/workflows/staging-deploy.yml", "utf8");
  assert.doesNotMatch(workflow, /test:acceptance:extended/u);
  const timeout = Number(workflow.match(/^ {4}timeout-minutes: (\d+)$/mu)?.[1]);
  assert.ok(timeout > 0 && timeout <= 45, `staging job timeout ${timeout}`);
  const runner = await readFile("scripts/staging-release.mjs", "utf8");
  assert.doesNotMatch(runner, /test:acceptance:extended|retained-source-rehearsal/u);
});
