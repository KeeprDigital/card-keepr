import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const since = args.find((arg) => arg.startsWith("--since="));
if (args.some((arg) => arg !== "--check" && arg !== since) || since === "--since=") {
  console.error("usage: node scripts/format.mjs [--check] [--since=REF]");
  process.exit(2);
}

const root = resolve(import.meta.dirname, "..");
const git = (...parameters) => execFileSync("git", parameters, { cwd: root, encoding: "utf8" });
const base = git("merge-base", "HEAD", since?.slice("--since=".length) ?? "main").trim();
// Biome's --changed selects committed changes only. Include working-tree edits
// and new files so the local command checks what the developer is about to commit.
const files = [
  ...new Set([
    ...git("diff", "--name-only", "--diff-filter=ACMR", "-z", base, "--").split("\0"),
    ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
  ]),
].filter(Boolean);

if (files.length === 0) {
  console.log("No changed files to format.");
  process.exit(0);
}

const child = spawnSync(
  resolve(root, "node_modules/.bin/biome"),
  [
    "format",
    "--no-errors-on-unmatched",
    ...(args.includes("--check") ? [] : ["--write"]),
    ...files.map((file) => resolve(root, file)),
  ],
  { cwd: root, stdio: "inherit" },
);
if (child.error) console.error(child.error.message);
process.exit(child.status ?? 1);
