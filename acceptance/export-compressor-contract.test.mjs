import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const packageLock = JSON.parse(
  await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const exportSource = await readFile(
  new URL("../src/catalogue/export.ts", import.meta.url),
  "utf8",
);
const serializationSource = await readFile(
  new URL("../src/catalogue/serialization.ts", import.meta.url),
  "utf8",
);

test("the deterministic export compressor is locked to an exact checked-in runtime", () => {
  assert.equal(packageJson.dependencies?.pako, "3.0.1");
  assert.equal(packageLock.packages?.[""]?.dependencies?.pako, "3.0.1");
  assert.equal(packageLock.packages?.["node_modules/pako"]?.version, "3.0.1");
});

test("catalogue serialization does not delegate canonical gzip bytes to the host zlib", () => {
  for (const [path, source] of [
    ["src/catalogue/export.ts", exportSource],
    ["src/catalogue/serialization.ts", serializationSource],
  ]) {
    assert.doesNotMatch(
      source,
      /from\s+["']node:zlib["']/u,
      `${path} must use the lockfile-pinned compressor`,
    );
  }
});
