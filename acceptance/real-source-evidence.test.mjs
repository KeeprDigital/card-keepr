import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const pack = resolve(root, "acceptance/fixtures/real-sources/2026-09-06");
function replay(directory = pack) {
  return spawnSync(process.execPath, ["scripts/source-evidence/replay.mjs", directory], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1" },
  });
}

test("owner can replay retained source facts and bounded evidence gates offline", () => {
  const result = replay();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.census.bandaiRecordIds, [
    "P-001",
    "P-001_p1",
    "P-001_p2",
    "P-001_p3",
    "P-001_p4",
    "P-001_p5",
    "P-001_p6",
  ]);
  assert.equal(report.census.limitlessPrintEntries, 8);
  assert.equal(report.census.riftboundRecords, 1189);
  assert.deepEqual(report.census.riftboundBySet, { OGN: 352, OGS: 24, SFD: 288, UNL: 288, VEN: 237 });
  assert.equal(report.gates.samePrinting.status, "verified");
  assert.equal(report.gates.supplementalOnlyPrinting.status, "verified-within-declared-scope");
  assert.equal(report.gates.fullGameCoverage.status, "not-established");
});

test("replay exposes publisher-specific identifiers and corrected text as retained source facts", () => {
  const result = replay();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.facts.riftbound["ogn-066a-298"].publicCode, "OGN-066a/298");
  assert.equal(report.facts.riftbound["sfd-227-star-221"].publicCode, "SFD-227*/221");
  assert.equal(report.facts.riftbound["ogn-141-298"].name, "Kinkou Monk");
  assert.equal(
    report.facts.articles["riftbound-errata"].kinkouNewText,
    "When you play me, buff up to two other friendly units.",
  );
  assert.equal(
    report.facts.articles["riftbound-errata"].kinkouOldText,
    "When you play me, buff two other friendly units.",
  );
  assert.equal(report.syntheticAdmission.classification, "synthetic-admission-scenarios");
});

async function alteredPack(t, mutate) {
  const directory = await mkdtemp(resolve(tmpdir(), "keepr-evidence-fault-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(pack, directory, { recursive: true });
  await mutate(directory);
  return directory;
}

test("injected omission cannot claim complete Limitless coverage after its variant response is removed", async (t) => {
  const directory = await alteredPack(t, async (path) => {
    const file = resolve(path, "manifest.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.captures = manifest.captures.filter((capture) => capture.id !== "limitless-p001-v1");
    await writeFile(file, JSON.stringify(manifest));
  });
  const result = replay(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required variant missing/);
});

test("injected image corruption fails integrity replay without changing real retained evidence", async (t) => {
  const directory = await alteredPack(t, async (path) => {
    const file = resolve(path, "raw/limitless-p001-image-4.webp");
    const bytes = await readFile(file);
    bytes[100] ^= 1;
    await writeFile(file, bytes);
  });
  const result = replay(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /limitless-p001-image-4: body digest/);
});

test("injected header corruption fails integrity replay", async (t) => {
  const directory = await alteredPack(t, async (path) => {
    await writeFile(resolve(path, "raw/riftbound-errata.headers"), "Date: invented\n");
  });
  const result = replay(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /riftbound-errata: headers digest/);
});
