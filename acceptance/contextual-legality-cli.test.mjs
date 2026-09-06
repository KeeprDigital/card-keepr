import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "./helpers/acceptance-runtime.mjs";

test("the consumer CLI no longer offers tournament eligibility", async () => {
  const result = await runCli(["legality", "status", "--json"], {});
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /Usage:.*\| legality status/);
});
