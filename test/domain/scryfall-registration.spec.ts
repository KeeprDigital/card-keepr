import { expect, test } from "vitest";
import pilot from "../../docs/examples/scryfall-magic-pilot-plan.json";
import bulk from "../../docs/examples/scryfall-magic-bulk-plan.json";
import { requiredSourceAdapter } from "../../src/catalogue/adapters";
import { validateEvidencePlan } from "../../src/catalogue/source-evidence/source-evidence-model";

test("Scryfall keeps its registered identity with the selected dated request envelope", () => {
  expect(requiredSourceAdapter("scryfall-magic-en@1")).toMatchObject({
    adapterVersion: "scryfall-magic-en@1",
    sourceLineage: "scryfall-magic-en",
    supportedGame: "magic",
    gameProfileVersion: "magic@1",
    parserContract: "scryfall-magic-card-pilot@1",
    requestCapacity: 108_691,
  });
});

test("the complete Scryfall plan starts from one exact bulk metadata root", async () => {
  const { subset, ...input } = bulk.plans[0]!;
  expect(subset).toBe("complete");
  const { plan } = await validateEvidencePlan({
    ...input,
    idempotency_key: "scryfall-complete-root",
  });
  expect(plan.coverage).toEqual({ locale: "en", area: "catalogue", subset: "complete" });
  expect(plan.requests).toEqual([
    expect.objectContaining({
      id: "scryfall-magic-en:bulk-data",
      url: "https://api.scryfall.com/bulk-data",
      method: "GET",
    }),
  ]);
});

test("the named Scryfall pilot preserves its four card requests and identities", async () => {
  const input = pilot.plans[0]!;
  const { plan } = await validateEvidencePlan({ ...input, idempotency_key: "scryfall-pilot-preserved" });
  expect(plan.coverage).toEqual({ locale: "en", area: "catalogue", subset: "representative-english-paper" });
  expect(plan.adapter_version).toBe("scryfall-magic-en@1");
  expect(plan.requests.map(({ id, url, headers, method }) => ({ id, url, headers, method }))).toEqual(
    input.requests.map((request) => ({ ...request, method: "GET" })),
  );
  expect(plan.requests).toHaveLength(4);
});

test.each([
  [{ id: "scryfall-magic-en:discovery", url: "https://api.scryfall.com/bulk-data" }],
  [{ id: "scryfall-magic-en:bulk-data", url: "https://api.scryfall.com/bulk-data?format=json" }],
  pilot.plans[0]!.requests,
  [{ id: "scryfall-magic-en:bulk-data", url: "https://api.scryfall.com/bulk-data" }, pilot.plans[0]!.requests[0]!],
])("the complete Scryfall scope rejects a substituted or expanded root: %j", async (...requests) => {
  await expect(
    validateEvidencePlan({
      supported_game: "magic",
      source_lineage: "scryfall-magic-en",
      adapter_version: "scryfall-magic-en@1",
      idempotency_key: "scryfall-invalid-root",
      requests,
    }),
  ).rejects.toThrow();
});
