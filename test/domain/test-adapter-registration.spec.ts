import { expect, test } from "vitest";
import { requiredActiveSourceAdapter } from "../../src/catalogue/adapters";
import { registerSourceAdapters } from "../../src/catalogue/adapters/source-adapters";
import { registerSyntheticSourceAdapters, syntheticAdapterRegistrations } from "../support/source-adapters";

test("test composition explicitly installs synthetic adapters through the registry", () => {
  registerSyntheticSourceAdapters();
  for (const adapter of syntheticAdapterRegistrations) {
    expect(requiredActiveSourceAdapter(adapter.adapterVersion)).toEqual(adapter);
  }
  expect(() => registerSyntheticSourceAdapters()).toThrow("already registered");
});

test("registration rejects duplicate input before changing the registry", () => {
  const adapter = { ...syntheticAdapterRegistrations[0]!, adapterVersion: "test-duplicate-adapter@1" };
  expect(() => registerSourceAdapters([adapter, adapter])).toThrow("already registered");
  expect(() => requiredActiveSourceAdapter(adapter.adapterVersion)).toThrow("not active");
});
