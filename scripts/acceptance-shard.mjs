// Run one shard of the acceptance suite: `--shard=<index>/<total>` (1-based).
// Local Worker boots dominate acceptance time, so each file is weighted by
// its boot and migration call sites and assigned, heaviest first, to the
// shard with the least weight so far. Each shard runs files serially: a file
// owns the host while its real Worker and restore runtimes are active.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const match = /^--shard=(\d+)\/(\d+)$/.exec(process.argv[2] ?? "");
if (match === null) {
  console.error("usage: node scripts/acceptance-shard.mjs --shard=<index>/<total>");
  process.exit(2);
}
const index = Number(match[1]);
const total = Number(match[2]);
if (total < 1 || index < 1 || index > total) {
  console.error(`invalid shard ${index}/${total}`);
  process.exit(2);
}

const directory = resolve(root, "acceptance");
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => ({ name, weight: weightOf(resolve(directory, name)) }))
  .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));

const shards = Array.from({ length: total }, () => ({ weight: 0, files: [] }));
for (const file of files) {
  const shard = shards.reduce((least, candidate) => (candidate.weight < least.weight ? candidate : least));
  shard.weight += file.weight;
  shard.files.push(file.name);
}

const selected = shards[index - 1].files.sort();
if (selected.length === 0) {
  console.log(`shard ${index}/${total}: no files`);
  process.exit(0);
}
console.log(`shard ${index}/${total}: ${selected.join(" ")}`);
const child = spawn(
  process.execPath,
  ["--test", "--test-concurrency=1", ...selected.map((name) => `acceptance/${name}`)],
  { cwd: root, stdio: "inherit" },
);
child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

function weightOf(path) {
  const source = readFileSync(path, "utf8");
  const boots = source.match(/\b(?:startWorker|applyMigrations)\(/g) ?? [];
  return 1 + boots.length;
}
