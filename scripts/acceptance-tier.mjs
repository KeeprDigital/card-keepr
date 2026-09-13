import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { acceptanceTiers, selectAcceptanceFiles } from "../acceptance/helpers/test-tiers.mjs";

const [tier = "default", ...args] = process.argv.slice(2);
const shardArg = args.find((arg) => arg.startsWith("--shard="));
const scenario = args.find((arg) => !arg.startsWith("--"));
const investigation = tier === "extended" || tier === "benchmark";
const match = shardArg?.match(/^--shard=(\d+)\/(\d+)$/u);
if (
  !acceptanceTiers.includes(tier) ||
  args.some((arg) => arg !== "--list" && arg !== "--all" && arg !== shardArg && arg !== scenario) ||
  (scenario && args.filter((arg) => !arg.startsWith("--")).length !== 1) ||
  (scenario && args.includes("--all")) ||
  (!investigation && args.includes("--all")) ||
  (shardArg &&
    (!match ||
      !Number.isSafeInteger(Number(match[1])) ||
      !Number.isSafeInteger(Number(match[2])) ||
      Number(match[1]) < 1 ||
      Number(match[1]) > Number(match[2])))
) {
  console.error(
    "usage: node scripts/acceptance-tier.mjs [default|smoke|extended|benchmark] [scenario|--all] [--shard=1/3] [--list]",
  );
  process.exit(2);
}
const root = resolve(import.meta.dirname, "..");
let files = selectAcceptanceFiles(await readdir(resolve(root, "acceptance")), tier);
if (scenario) {
  const name = scenario.replace(/^acceptance\//u, "");
  const filename = name.endsWith(".test.mjs") ? name : `${name}.test.mjs`;
  if (!files.includes(filename)) {
    console.error(`Unknown ${tier} scenario: ${scenario}. Use --list to see available scenarios.`);
    process.exit(2);
  }
  files = [filename];
}
if (investigation && !scenario && !args.includes("--all") && !args.includes("--list")) {
  console.error(`Select one ${tier} scenario, or explicitly use --all. Use --list to inspect the choices.`);
  process.exit(2);
}

if (match) {
  if (Number(match[2]) > files.length) {
    console.error("The shard count cannot exceed the selected test file count.");
    process.exit(2);
  }
  // Balance boot/migration call sites, retaining the existing CI shard layout.
  const weighted = await Promise.all(
    files.map(async (name) => {
      const source = await readFile(resolve(root, "acceptance", name), "utf8");
      return { name, weight: 1 + (source.match(/\b(?:startWorker|applyMigrations)\(/gu) ?? []).length };
    }),
  );
  weighted.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  const shards = Array.from({ length: Number(match[2]) }, () => ({ weight: 0, files: [] }));
  for (const file of weighted) {
    const shard = shards.reduce((least, candidate) => (candidate.weight < least.weight ? candidate : least));
    shard.weight += file.weight;
    shard.files.push(file.name);
  }
  files = shards[Number(match[1]) - 1].files.sort();
}
if (args.includes("--list")) {
  console.log(files.join("\n"));
  process.exit(0);
}
if (files.length === 0) {
  console.error("No acceptance tests selected.");
  process.exit(1);
}
console.log(`${tier}${shardArg ? ` ${shardArg}` : ""}: ${files.length} files`);
const child = spawn(
  process.execPath,
  [
    "--test",
    // Bound the number of simultaneous Node/Workerd/CLI process trees. Large
    // opt-in journeys run alone and retain their own operation deadlines.
    `--test-concurrency=${investigation ? 1 : 2}`,
    ...(investigation ? [] : ["--test-timeout=120000"]),
    ...files.map((name) => `acceptance/${name}`),
  ],
  {
    cwd: root,
    stdio: "inherit",
  },
);
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
