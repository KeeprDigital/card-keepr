import { expect, test } from "vitest";
import { AdapterParseFailure } from "../../src/catalogue/adapters/adapter-parse-failure";
import {
  registeredLegalitySourceScope,
  sourceAdapterRegistrations,
} from "../../src/catalogue/adapters/source-adapters";

const adapters = sourceAdapterRegistrations.filter(
  (adapter) => adapter.origin === "production" && adapter.parseBytes !== undefined,
);

for (const adapter of adapters) {
  test(`${adapter.adapterVersion} classifies malformed retained bytes as a parse failure`, async () => {
    const surface = adapter.requiredSurfaces![0]!;
    const context = {
      mediaType: "text/html",
      url: adapter.requestUrlForSurface!(surface),
      requestId: `${adapter.sourceLineage}:${surface}`,
    };
    await expect(async () => adapter.parseBytes!(new Uint8Array([0xff]), context)).rejects.toBeInstanceOf(
      AdapterParseFailure,
    );
  });
}

test("a raw adapter classifies an invalid source URL as a parse failure", () => {
  const adapter = adapters.find((adapter) => adapter.reconciliationCapability === "catalogue")!;
  expect(() =>
    adapter.parseBytes!(new TextEncoder().encode("<html></html>"), { mediaType: "text/html", url: "not a URL" }),
  ).toThrow(AdapterParseFailure);
});

test("registration invariants remain distinct from malformed publisher bytes", () => {
  expect(() => registeredLegalitySourceScope("missing-lineage")).toThrow(
    expect.objectContaining({ category: "configuration" }),
  );
  const adapter = adapters.find((adapter) => adapter.reconciliationCapability === "catalogue")!;
  expect(() =>
    adapter.parseBytes!(new Uint8Array([0xff]), {
      mediaType: "text/html",
      url: adapter.requestUrlForSurface!(adapter.requiredSurfaces![0]!),
    }),
  ).toThrow(expect.objectContaining({ category: "source-contract" }));
});
