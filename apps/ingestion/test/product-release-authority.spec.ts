import { describe, expect, it } from "vitest";
import {
  reconcileProductReleaseCatalogue,
  type ProductReleaseEvidenceInput,
} from "../../../src/catalogue/product-release-catalogue";
import { canonicalJson } from "../../../src/catalogue/serialization";

const catalogue = (name: string) => ({
  products: [{
    reference: { kind: "official_code", value: "P-001" },
    official_code: "P-001",
    name,
    releases: [],
    withdrawal: null,
  }],
  distribution_contexts: [],
  relationships: [],
});

const input = (
  id: string,
  sourceSurface: string,
  name: string,
): ProductReleaseEvidenceInput => ({
  value: catalogue(name),
  sourceObservationId: id,
  sourceObservationSetId: `set_${id}`,
  sourceSnapshotId: `snapshot_${id}`,
  sourceLineage: "one-piece-en",
  sourceSurface,
  requestRole:
    sourceSurface === "product-detail" ? "product_detail" : "surface",
  capturedAt: "2026-01-01T00:00:00.000Z",
  currentCardId: null,
  currentPrintingId: null,
});

describe("Product evidence authority", () => {
  it("resolves lower-authority conflicts to the exact Product detail", async () => {
    const result = await reconcileProductReleaseCatalogue(
      null,
      [
        input("srcobs_listing", "products", "Listing name"),
        input("srcobs_detail", "product-detail", "Detail name"),
      ],
      "one-piece",
    );

    expect(result.products[0]?.name).toBe("Detail name");
    expect(
      result.products[0]?.disagreements.find(
        ({ path }) => path === "/data/name",
      )?.status,
    ).toBe("resolved_by_authority");
  });

  it("keeps a same-authority contradiction unresolved", async () => {
    await expect(
      reconcileProductReleaseCatalogue(
        null,
        [
          input("srcobs_detail_a", "product-detail", "Detail A"),
          input("srcobs_detail_b", "product-detail", "Detail B"),
        ],
        "one-piece",
      ),
    ).rejects.toThrow(/Same-authority Product evidence conflicts/u);
  });

  it("omits unavailable fixture-only evidence metadata from canonical JSON", async () => {
    const fixtureInput: ProductReleaseEvidenceInput = {
      ...input("srcobs_fixture", "products", "Fixture product"),
      sourceSurface: undefined,
      requestRole: undefined,
    };
    const result = await reconcileProductReleaseCatalogue(
      null,
      [fixtureInput],
      "one-piece",
    );
    const evidence = result.products[0]?.included[0];

    expect(evidence).not.toHaveProperty("surface");
    expect(evidence).not.toHaveProperty("request_role");
    expect(() => canonicalJson(result.products)).not.toThrow();
  });
});
