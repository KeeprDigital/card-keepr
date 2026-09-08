import { expect, test } from "vitest";
import { canonicalJson } from "../../src/catalogue/shared";
import { resolvedReconciliationEvidencePlan } from "../../src/catalogue/reconciliation/reconciliation-evidence";

for (const game of ["one-piece", "riftbound"] as const)
  test(`${game} complete evidence metadata can be retained without an identity restriction`, () => {
    const plan = resolvedReconciliationEvidencePlan({
      supported_game: game,
      source_lineage: `${game}-en`,
      game_profile_version: `${game}@1`,
      adapter_version: game === "one-piece" ? "one-piece-en@6" : "riftbound-en@1",
      requests: [],
    });
    expect(() => canonicalJson(plan)).not.toThrow();
    expect(plan).not.toHaveProperty("cardIdentities");
    expect(plan.printingAdmission).toBe(game === "riftbound" ? "owner_review" : "source_qualification");
  });

test("named evidence metadata retains its exact identity scope and admission policy", () => {
  const plan = resolvedReconciliationEvidencePlan({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    game_profile_version: "one-piece@1",
    adapter_version: "one-piece-en@6",
    requests: [],
    coverage: { locale: "en", area: "catalogue", subset: "p-001-catalogue" },
  });
  expect(JSON.parse(canonicalJson(plan)).cardIdentities).toEqual([{ kind: "card_number", value: "P-001" }]);
  expect(plan.printingAdmission).toBe("owner_review");
});
