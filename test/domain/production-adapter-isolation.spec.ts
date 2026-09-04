import { expect, test } from "vitest";
import { installedSourceAdapterRegistrations, requiredSourceAdapter } from "../../src/catalogue/adapters";

test("the shipped registry rejects synthetic adapters and contains only Official Source registrations", () => {
  expect(() => requiredSourceAdapter("fixture-one-piece-json@3")).toThrow("not installed");
  expect(
    installedSourceAdapterRegistrations.every(
      (adapter) => adapter.origin === "production" && !adapter.adapterVersion.startsWith("fixture-"),
    ),
  ).toBe(true);
});
