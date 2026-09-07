import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { riftboundAnnouncedProducts, riftboundProductsUrl } from "../../src/catalogue/adapters/riftbound-products";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation";

test("retained product announcements preserve date precision without inventing Printing faces", () => {
  const observations = riftboundAnnouncedProducts(
    readFileSync("acceptance/fixtures/real-sources/2026-09-06/raw/riftbound-products.body"),
    riftboundProductsUrl,
  );
  expect(observations).toHaveLength(9);
  const products = observations.flatMap((o) => o.product_release_catalogue.products);
  const byName = new Map(products.map((p) => [p.name, p]));
  expect(byName.get("Gift of the Rift Bundle")?.releases[0]?.date).toEqual({ precision: "day", value: "2026-12-04" });
  expect(byName.get("Radiance")?.official_code).toBe("RAD");
  expect(byName.get("Radiance")?.releases[0]?.date.value).toBe("2026-10-23");
  expect(byName.get("Proving Grounds, 2nd Edition")?.official_code).toBe("PG2");
  expect(byName.get("Set 8")?.releases[0]?.date).toEqual({ precision: "quarter", value: "2027-Q3" });
  expect(products.every((p) => p.releases[0]?.region === "unknown")).toBe(true);
  const secret = observations.find((o) => o.source_sidecar.heading === "Secret Garden")!;
  expect(secret.source_sidecar.announcement_text).toContain("5x Alt-Art Double Sided Tokens");
  expect(secret.product_release_catalogue.relationships).toEqual([]);
  expect(secret).not.toHaveProperty("printing");
  observations.forEach((observation, index) =>
    expect(parseReconciliationObservation(`product-${index}`, observation).kind).toBe("card_printing"),
  );
});
