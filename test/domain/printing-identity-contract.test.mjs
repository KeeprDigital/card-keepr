import { test } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validatePrintingIdentityContract,
} from "../../prototype/v1-game-profiles-source-adapters/contract.mjs";

test("the parsed Gundam contract keeps Product and variant provenance out of Printing identity", async () => {
  const text = await readFile(
    new URL(
      "../../prototype/v1-game-profiles-source-adapters/CONTRACT.md",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotThrow(() => validatePrintingIdentityContract(text));
  assert.throws(
    () =>
      validatePrintingIdentityContract(
        "Gundam records must additionally agree on variant and Product code.",
      ),
    /memberships out of identity/,
  );
});
