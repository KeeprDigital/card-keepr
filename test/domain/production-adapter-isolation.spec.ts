import { expect, test } from "vitest";
import { installedSourceAdapterRegistrations, requiredSourceAdapter } from "../../src/catalogue/adapters";
import { validateEvidencePlan } from "../../src/catalogue/source-evidence/source-evidence-model";

test("the shipped registry rejects synthetic adapters and contains only Official Source registrations", () => {
  expect(() => requiredSourceAdapter("fixture-one-piece-json@3")).toThrow("not installed");
  expect(
    installedSourceAdapterRegistrations.every(
      (adapter) => adapter.origin === "production" && !adapter.adapterVersion.startsWith("fixture-"),
    ),
  ).toBe(true);
});

test("the shipped source-plan validator rejects synthetic adapters before creating a plan", async () => {
  await expect(
    validateEvidencePlan({
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "fixture-one-piece-json@3",
      idempotency_key: "production-fixture-bypass",
      requests: [{ id: "one-piece-en:discovery", url: "https://official-source.invalid/cards" }],
    }),
  ).rejects.toMatchObject({ status: 422, code: "adapter_not_supported" });
});
