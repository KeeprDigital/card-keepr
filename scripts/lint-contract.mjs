// This runner parses/lints probe files. It never imports or executes them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ESLint } from "eslint";
const eslint = new ESLint({ ignore: false });
const results = await eslint.lintFiles(["eslint/fixtures"]);
const expected = {
  "worker.ts": {
    local: "@typescript-eslint/no-floating-promises",
    imported: "@typescript-eslint/no-floating-promises",
    d1: "@typescript-eslint/no-floating-promises",
    "r2-put": "@typescript-eslint/no-floating-promises",
    "r2-delete": "@typescript-eslint/no-floating-promises",
    "bare-void": "@typescript-eslint/no-floating-promises",
    callback: "@typescript-eslint/no-misused-promises",
    condition: "@typescript-eslint/no-misused-promises",
    "await-number": "@typescript-eslint/await-thenable",
    union: "@typescript-eslint/switch-exhaustiveness-check",
    "unsafe-assignment": "@typescript-eslint/no-unsafe-assignment",
    "unsafe-return": "@typescript-eslint/no-unsafe-return",
    "return-await": "@typescript-eslint/return-await",
  },
  "assertions.spec.ts": {
    focus: "vitest/no-focused-tests",
    "unawaited-expect": "vitest/valid-expect",
    "invalid-expect": "vitest/valid-expect",
  },
  "assertions.test.mjs": {
    "node-unawaited": "@typescript-eslint/no-floating-promises",
    "node-imported": "@typescript-eslint/no-floating-promises",
  },
  "plugins.mjs": {
    "unresolved-import": "import-x/no-unresolved",
    "ignored-return": "sonarjs/no-ignored-return",
    "fetch-body": "unicorn/no-invalid-fetch-options",
    regex: "regexp/no-useless-assertions",
    "node-promise": "@typescript-eslint/no-floating-promises",
  },
};
for (const [file, probes] of Object.entries(expected)) {
  const lines = readFileSync(`eslint/fixtures/${file}`, "utf8").split("\n");
  const result = results.find((result) => result.filePath.endsWith(`/fixtures/${file}`));
  assert.ok(result, `Missing lint result: ${file}`);
  assert.equal(result.fatalErrorCount, 0, `Parse failure: ${file}`);
  for (const [probe, rule] of Object.entries(probes)) {
    const line = lines.findIndex((line) => line.endsWith(`// probe:${probe}`)) + 1;
    assert.ok(line > 0, `Missing marker: ${probe}`);
    assert.ok(
      result.messages.some((message) => message.line === line && message.ruleId === rule),
      `${file}:${line}: missing ${rule}`,
    );
  }
}
for (const file of ["valid.ts", "valid.jsonc", "service.ts"]) {
  assert.deepEqual(
    results.find((result) => result.filePath.endsWith(`/fixtures/${file}`))?.messages,
    [],
    `Valid control: ${file}`,
  );
}
for (const file of ["duplicate.json", "duplicate.jsonc"]) {
  assert.ok(
    results
      .find((result) => result.filePath.endsWith(`/fixtures/${file}`))
      ?.messages.some((message) => message.ruleId === "json/no-duplicate-keys"),
  );
}
// The test framework owns registrations, but not discarded assertions in their bodies.
assert.deepEqual(
  results.find((result) => result.filePath.endsWith("/fixtures/assertions.test.mjs"))?.messages.map(({ line }) => line),
  [5, 9],
);
// Awaited/returned/combined assertions and the optional message are valid.
// Line 11 deliberately uses a non-Promise .resolves input: a recorded lint gap.
assert.deepEqual(
  results.find((result) => result.filePath.endsWith("/fixtures/assertions.spec.ts"))?.messages.map(({ line }) => line),
  [2, 5, 5, 8],
);
console.log("25 invalid-case rule assertions and valid controls passed; probes were never executed.");

// Adjacent declarations must not displace these JavaScript implementations.
for (const filePath of [
  "src/catalogue/shared/release-input-shapes.mjs",
  "src/catalogue/shared/spine-revision.mjs",
  "src/http/administration-presentation.mjs",
  "src/http/diagnostic-display.mjs",
  "src/http/production-target.mjs",
  "src/runtime-capabilities.mjs",
]) {
  const [result] = await eslint.lintText(
    '/** @param {R2Bucket} bucket */\nexport function discarded(bucket) { bucket.put("diagnostic-only", "value"); }',
    { filePath },
  );
  assert.equal(result.fatalErrorCount, 0, filePath);
  assert.ok(
    result.messages.some(({ ruleId }) => ruleId === "@typescript-eslint/no-floating-promises"),
    filePath,
  );
}

// Exercise the effective runtime and unsafe-input configurations on maintained paths.
const [nodeGlobal] = await eslint.lintText("export const value = self; console.log(process.version);", {
  filePath: "cli/lib/http-client.mjs",
});
assert.ok(nodeGlobal.messages.some(({ ruleId }) => ruleId === "no-undef"));
const [workerGlobal] = await eslint.lintText("export const value = self;", {
  filePath: "src/runtime-capabilities.mjs",
});
assert.equal(workerGlobal.fatalErrorCount, 0);
assert.ok(!workerGlobal.messages.some(({ ruleId }) => ruleId === "no-undef"));
const [unsafeBoundary] = await eslint.lintText(
  "export function parse(text: string) { const value = JSON.parse(text); return value.name; }",
  { filePath: "src/http/bounded-json.ts" },
);
assert.ok(unsafeBoundary.messages.some(({ ruleId }) => ruleId === "@typescript-eslint/no-unsafe-assignment"));
assert.ok(unsafeBoundary.messages.some(({ ruleId }) => ruleId === "@typescript-eslint/no-unsafe-member-access"));
console.log("Implementation ownership, runtime globals and maintained unsafe-input boundary passed.");
