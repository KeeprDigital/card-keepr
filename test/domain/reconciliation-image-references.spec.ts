import { expect, test } from "vitest";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation";
import { capacityPageDocument, syntheticCapacityTier } from "../support/fake-publisher/capacity-workloads";

test("verified retained Printing Image references complete observations without source-supplied byte claims", () => {
  const source = capacityPageDocument(syntheticCapacityTier("128-images"), 0).cards[0]!;
  const url = source.appearance_evidence.images[0]!.source_url;
  const metadata = {
    media_type: "image/png" as const,
    width: 1,
    height: 1,
    content_sha256: "a".repeat(64),
    content_byte_length: 102400,
  };
  Object.assign(source.appearance_evidence.images[0]!, metadata, { content_object_key: "forged-source-key" });
  const unverified = parseReconciliationObservation("source-unverified", source);
  expect(unverified.kind).toBe("card_printing");
  if (unverified.kind !== "card_printing") throw new Error("unexpected observation");
  expect(unverified.printingImages).toEqual([]);
  expect(unverified.noveltyProofComplete).toBe(false);
  const verified = parseReconciliationObservation(
    "source-verified",
    source,
    new Map([[url, { ...metadata, content_object_key: "verified-evidence-key" }]]),
  );
  expect(verified.kind).toBe("card_printing");
  if (verified.kind !== "card_printing") throw new Error("unexpected observation");
  expect(verified.noveltyProofComplete).toBe(true);
  expect(verified.printingImages).toEqual([{ ...metadata, source_url: url, role: "front" }]);
  expect(JSON.stringify(verified.printingImages)).not.toMatch(/content_base64|content_object_key/);
});

test.each([0, -1, 1.5])("invalid retained image dimension %s cannot establish a Printing's novelty", (width) => {
  const source = capacityPageDocument(syntheticCapacityTier("128-images"), 0).cards[0]!;
  const url = source.appearance_evidence.images[0]!.source_url;
  const verified = parseReconciliationObservation(
    "source-invalid-dimensions",
    source,
    new Map([
      [
        url,
        {
          media_type: "image/png",
          width,
          height: 1,
          content_sha256: "a".repeat(64),
          content_byte_length: 102400,
        },
      ],
    ]),
  );
  expect(verified.kind).toBe("card_printing");
  if (verified.kind !== "card_printing") throw new Error("unexpected observation");
  expect(verified.noveltyProofComplete).toBe(false);
  expect(verified.printingImages).toEqual([]);
});
