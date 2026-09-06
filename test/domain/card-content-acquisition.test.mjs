import assert from "node:assert/strict";
import { test } from "vitest";
import { sourceAdapterRegistrations } from "../../src/catalogue/adapters/source-adapters.ts";

test("catalogue acquisition requires card content without tournament policy surfaces", () => {
  for (const adapter of sourceAdapterRegistrations) {
    assert.ok(
      (adapter.requiredSurfaces ?? []).every(
        (surface) => !/legality|restriction|block-policy|don-rules/u.test(surface),
      ),
      adapter.adapterVersion,
    );
  }
});
