import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import test from "node:test";
import { benchmarkAcceptanceFiles, extendedAcceptanceFiles, selectAcceptanceFiles } from "./helpers/test-tiers.mjs";

const files = readdirSync(new URL("./", import.meta.url))
  .filter((file) => file.endsWith(".test.mjs"))
  .sort();
const list = (...args) =>
  execFileSync(process.execPath, ["scripts/acceptance-tier.mjs", ...args, "--list"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .trim()
    .split("\n")
    .filter(Boolean);

test("routine acceptance retains bounded restore and excludes full catalogue journeys", () => {
  const routine = list("default");
  assert.ok(routine.includes("riftbound-bounded-intake.test.mjs"));
  assert.ok(routine.includes("backup-sql-restore.test.mjs"));
  assert.ok(routine.includes("source-evidence-cli.test.mjs"));
  for (const file of [
    "one-piece-catalogue.test.mjs",
    "digimon-catalogue.test.mjs",
    "fusion-world-catalogue.test.mjs",
    "gundam-catalogue.test.mjs",
    "mixed-game-recovery.test.mjs",
  ])
    assert.ok(routine.includes(file));
  for (const file of [
    "riftbound-catalogue.test.mjs",
    "native-isolate-metrics.test.mjs",
    "native-sqlite-export.test.mjs",
    "reconciliation-capacity-probe.test.mjs",
  ]) {
    assert.ok(!routine.includes(file));
  }
  const extended = list("extended");
  assert.deepEqual(extended, [...extendedAcceptanceFiles].sort());
  const benchmarks = list("benchmark");
  assert.deepEqual(benchmarks, [...benchmarkAcceptanceFiles].sort());
  const all = [...routine, ...extended, ...benchmarks];
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(all.sort(), files);
});

test("CI shards run every routine file exactly once without reintroducing expensive journeys", () => {
  const sharded = [1, 2, 3].flatMap((index) => list("default", `--shard=${index}/3`));
  assert.equal(new Set(sharded).size, sharded.length);
  assert.deepEqual(sharded.sort(), list("default"));
});

test("smoke retains the two everyday paths within routine coverage and unknown tiers fail", () => {
  const smoke = selectAcceptanceFiles(files, "smoke");
  assert.deepEqual(smoke, ["riftbound-bounded-intake.test.mjs", "source-evidence-cli.test.mjs"]);
  const routine = selectAcceptanceFiles(files);
  assert.ok(smoke.every((file) => routine.includes(file)));
  assert.throws(() => selectAcceptanceFiles(files, "typo"), /Unknown acceptance tier/u);
  const invalid = ["--shard=0/3", "--shard=4/3", "--shard=1/0", "--shard=invalid", "--shard=1/1000000000"];
  for (const shard of invalid) {
    assert.throws(
      () => list("default", shard),
      (error) => error.status === 2,
    );
  }
});

test("expensive investigations require an explicit valid scenario and probes cannot silently skip", () => {
  assert.deepEqual(list("benchmark", "native-sqlite-export"), ["native-sqlite-export.test.mjs"]);
  assert.deepEqual(list("extended", "riftbound-catalogue.test.mjs"), ["riftbound-catalogue.test.mjs"]);
  for (const args of [
    ["extended"],
    ["benchmark"],
    ["benchmark", "typo"],
    ["extended", "../package.json"],
    ["benchmark", "native-sqlite-export", "--all"],
    ["default", "--all"],
    ["benchmark", "reconciliation-capacity-probe"],
  ]) {
    assert.throws(
      () =>
        execFileSync(process.execPath, ["scripts/acceptance-tier.mjs", ...args], {
          stdio: "pipe",
          env: { ...process.env, KEEPR_CAPACITY_OUTPUT_PREFIX: "" },
        }),
      (error) => error.status === 2,
    );
  }
});
