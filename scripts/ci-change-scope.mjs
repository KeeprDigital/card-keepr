// Classifies a CI run's changed paths (issue #401). The heavy ci.yml jobs skip
// only when every changed path is on this conservative allow-list; any other
// path, an empty or unreadable diff, and every event other than pull_request
// and merge_group run the full suite. A push to main always runs it because
// the exact-commit release gates need successful, not skipped, checks.
//
// Usage in CI: EVENT_NAME=... BASE_SHA=... node scripts/ci-change-scope.mjs
// It appends `full=true|false` to $GITHUB_OUTPUT. Any error exits non-zero;
// the heavy jobs then treat the missing output as "run everything".
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const filteredEvents = Object.freeze(["pull_request", "merge_group"]);

// Documentation read by tests is not documentation-only. Test trees own their
// fixtures, including Markdown ones, and the named files are read by suites.
const testTrees = /^(?:acceptance|test|apps\/[^/]+\/test)\//u;
export const testConsumedDocuments = Object.freeze(["docs/runbooks/scheduled-stress.md"]);

export const allowList = Object.freeze([
  { name: "Markdown outside test trees", matches: (path) => path.endsWith(".md") && !testTrees.test(path) },
  { name: "issue templates", matches: (path) => path.startsWith(".github/ISSUE_TEMPLATE/") },
  { name: "ignored local artifacts", matches: (path) => path.startsWith(".artifacts/") },
  {
    name: "license and ownership metadata",
    matches: (path) => /^(?:LICEN[CS]E|COPYING|NOTICE)(?:\.[\w-]+)?$|^(?:\.github\/|docs\/)?CODEOWNERS$/u.test(path),
  },
]);

/** @param {string} path */
export function isAllowListed(path) {
  if (testConsumedDocuments.includes(path)) return false;
  return allowList.some((rule) => rule.matches(path));
}

/**
 * @param {string} event GitHub event name
 * @param {readonly string[]} paths changed paths; ignored outside filtered events
 */
export function requiresFullSuite(event, paths) {
  if (!filteredEvents.includes(event)) return true;
  return paths.length === 0 || !paths.every((path) => isAllowListed(path));
}

function main() {
  const event = process.env.EVENT_NAME ?? "";
  let paths = [];
  if (filteredEvents.includes(event)) {
    const base = process.env.BASE_SHA ?? "";
    const head = process.env.GITHUB_SHA ?? "HEAD";
    if (!/^[0-9a-f]{40}$/u.test(base)) throw new Error(`BASE_SHA is not a commit id: ${base}`);
    // Tree diff of the tested commit against its base; --no-renames reports
    // both sides of a move, so moving code into docs/ is not docs-only.
    paths = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, head], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  }
  const full = requiresFullSuite(event, paths);
  const outside = paths.filter((path) => !isAllowListed(path));
  console.log(`${event}: ${paths.length} changed path(s); full suite: ${full}`);
  for (const path of outside.slice(0, 20)) console.log(`  not allow-listed: ${path}`);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `full=${full}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
