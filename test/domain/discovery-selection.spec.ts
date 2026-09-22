import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, test } from "vitest";
import tranche from "../../docs/examples/scryfall-magic-images-tranche-plan.json";
import facts from "../../docs/examples/scryfall-magic-facts-plan.json";
import { requiredSourceAdapter } from "../../src/catalogue/adapters";
import {
  partitionDiscoveredRequests,
  validatedDiscoverySelection,
} from "../../src/catalogue/source-evidence/discovery-selection";
import { validateEvidencePlan } from "../../src/catalogue/source-evidence/source-evidence-model";

const scryfall = requiredSourceAdapter("scryfall-magic-en@1");
const image = (id: string, selectionGroup: string | null) => ({ id, role: "image", selectionGroup });

test("a group selection admits only the listed groups and defers the rest explicitly", () => {
  const listing = { id: "listing", role: "listing", selectionGroup: null };
  const requests = [listing, image("a1", "neo"), image("b1", "dmu"), image("u1", null), image("a2", "neo")];
  expect(partitionDiscoveredRequests({ role: "image", groups: ["neo"] }, requests, new Set(), 0)).toEqual({
    selected: [listing, image("a1", "neo"), image("a2", "neo")],
    deferred: [image("b1", "dmu"), image("u1", null)],
  });
});

test("a maximum admits the first requests in discovery order and a replay reproduces the outcome", () => {
  const requests = [image("a", "x"), image("b", "x"), image("c", "x")];
  const first = partitionDiscoveredRequests({ role: "image", maximum_requests: 3 }, requests, new Set(["z"]), 1);
  expect(first).toEqual({ selected: [image("a", "x"), image("b", "x")], deferred: [image("c", "x")] });
  // The committed batch's own requests are held; they stay admitted without a slot.
  const replay = partitionDiscoveredRequests({ role: "image", maximum_requests: 3 }, requests, new Set(["a", "b"]), 3);
  expect(replay).toEqual(first);
  expect(partitionDiscoveredRequests(undefined, requests, new Set(), 0)).toEqual({ selected: requests, deferred: [] });
});

test("a selection is canonical and bounded by the scope that permits it", () => {
  const scope = {
    selectableDiscoveryRoles: ["image"] as const,
    requestCapacity: 10,
    discoverySelectionGroup: () => null,
  };
  expect(validatedDiscoverySelection(scope, { role: "image", groups: ["b", "a"], maximum_requests: 10 })).toEqual({
    role: "image",
    groups: ["a", "b"],
    maximum_requests: 10,
  });
  for (const [value, code] of [
    [{ role: "listing", maximum_requests: 1 }, "unsupported_discovery_selection"],
    [{ role: "image" }, "invalid_parameter"],
    [{ role: "image", maximum_requests: 11 }, "invalid_parameter"],
    [{ role: "image", groups: ["a", "a"] }, "invalid_parameter"],
    [{ role: "image", groups: ["NEO"] }, "invalid_parameter"],
    [{ role: "image", groups: [] }, "invalid_parameter"],
    [{ role: "image", maximum_requests: 1, after: "x" }, "invalid_parameter"],
  ] as const)
    expect(() => validatedDiscoverySelection(scope, value)).toThrowError(expect.objectContaining({ code }));
  expect(() =>
    validatedDiscoverySelection({ ...scope, discoverySelectionGroup: undefined }, { role: "image", groups: ["a"] }),
  ).toThrowError(expect.objectContaining({ code: "unsupported_discovery_selection" }));
});

test("the Scryfall image tranche plan selects JPEG images by set within a bounded maximum", async () => {
  const input = tranche.plans[0]!;
  const { plan, adapter } = await validateEvidencePlan({ ...input, idempotency_key: "scryfall-image-tranche-1" });
  expect(plan.coverage).toEqual({ locale: "en", area: "catalogue", subset: "image-tranche" });
  expect(plan.discovery_selection).toEqual({
    role: "image",
    groups: [...input.discovery_selection.groups].sort(),
    maximum_requests: 10_000,
  });
  expect(adapter.acquiredDiscoveryRoles).toEqual(["listing", "image"]);
  expect(adapter.selectableDiscoveryRoles).toEqual(["image"]);
  // Only the tranche scope may select: the facts-only and complete scopes do not.
  await expect(
    validateEvidencePlan({
      ...facts.plans[0]!,
      discovery_selection: { role: "image", maximum_requests: 1 },
      idempotency_key: "scryfall-facts-selection",
    }),
  ).rejects.toMatchObject({ code: "unsupported_discovery_selection" });
});

test("Scryfall groups an image request by its claiming record's set code", () => {
  const directory = new URL("../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/", import.meta.url);
  const groups = ["normal.json", "reversible-adventure.json"].map((name) => {
    const record = scryfall.archiveExtraction!.record(readFileSync(new URL(name, directory)), "2026-09-14");
    expect(record.requests.every(({ url }) => /^https:\/\/cards\.scryfall\.io\/normal\/.+\.jpg\?\d+$/u.test(url))).toBe(
      true,
    );
    return scryfall.discoverySelectionGroup!(JSON.parse(JSON.stringify(record.observations[0]!.value)));
  });
  // An assembled Printing and a reviewable record both name their set.
  expect(groups).toEqual(["blb", "tdm"]);
  expect(scryfall.discoverySelectionGroup!({})).toBeNull();
});
