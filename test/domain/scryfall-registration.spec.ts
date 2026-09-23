import { expect, test } from "vitest";
import pilot from "../../docs/examples/scryfall-magic-pilot-plan.json";
import bulk from "../../docs/examples/scryfall-magic-bulk-plan.json";
import facts from "../../docs/examples/scryfall-magic-facts-plan.json";
import { installedSourceAdapterRegistrations, requiredSourceAdapter } from "../../src/catalogue/adapters";
import { sourceImageLinkUrl, sourceImageRepresentation } from "../../src/catalogue/shared";
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

test("only Scryfall opts into Source Image Links, and only for exact https URLs on its image host", () => {
  // Owner decision (#425): no other source may be hotlinked until its terms are clarified.
  expect(
    installedSourceAdapterRegistrations
      .filter(({ sourceImageLinks }) => sourceImageLinks !== undefined)
      .map(({ adapterVersion }) => adapterVersion),
  ).toEqual(["scryfall-magic-en@1"]);
  const policy = requiredSourceAdapter("scryfall-magic-en@1").sourceImageLinks!;
  const url = "https://cards.scryfall.io/normal/front/0/7/076ad38c-30ec-41a4-be18-c287f65d1d86.jpg?1783939390";
  expect(sourceImageLinkUrl(policy, url)).toBe(url);
  for (const rejected of [
    url.replace("https:", "http:"),
    url.replace("cards.scryfall.io", "cdn.piltoverarchive.com"),
    `${url}#fragment`,
    "not a url",
  ])
    expect(sourceImageLinkUrl(policy, rejected)).toBeNull();
  expect(sourceImageRepresentation({ source: "scryfall", url, retrieved_at: null }, 1)).toBeUndefined();
  expect(sourceImageRepresentation({ source: "tcgdex", url, retrieved_at: null }, 0)).toBeUndefined();
  expect(sourceImageRepresentation({ source: "scryfall", url, retrieved_at: null }, 0)).toMatchObject({
    url,
    verified: false,
    attribution: { policy_url: "https://company.wizards.com/en/legal/fancontentpolicy" },
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

test("the facts-only Scryfall plan reads the same bulk root and acquires only its archive listing", async () => {
  const input = facts.plans[0]!;
  const { plan, adapter } = await validateEvidencePlan({ ...input, idempotency_key: "scryfall-facts-only-root" });
  expect(plan.coverage).toEqual({ locale: "en", area: "catalogue", subset: "facts-only" });
  expect(plan.requests.map(({ id, url }) => ({ id, url }))).toEqual([
    { id: "scryfall-magic-en:bulk-data", url: "https://api.scryfall.com/bulk-data" },
  ]);
  expect(adapter.acquiredDiscoveryRoles).toEqual(["listing"]);
  expect(adapter.printingAdmission).toBe("source_qualification");
  expect(requiredSourceAdapter("scryfall-magic-en@1").acquiredDiscoveryRoles).toBeUndefined();
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
