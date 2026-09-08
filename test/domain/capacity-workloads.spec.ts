import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  capacityByteShare,
  capacityPrintingsPerPage,
  syntheticCapacityTiers,
} from "../support/fake-publisher/capacity-workloads";
import { reconciliationSourceDocument } from "../support/fake-publisher/reconciliation-documents";

test.each(syntheticCapacityTiers)(
  "$id generates exact census partitions with real digest-bound image bytes",
  (tier) => {
    const pages = tier.printings / capacityPrintingsPerPage;
    expect(
      Array.from({ length: tier.images }, (_, i) => capacityByteShare(tier.imageBytes, tier.images, i)).reduce(
        (a, b) => a + b,
        0,
      ),
    ).toBe(tier.imageBytes);
    expect(
      Array.from({ length: pages }, (_, i) => capacityByteShare(tier.structuredBytes, pages, i)).reduce(
        (a, b) => a + b,
        0,
      ),
    ).toBe(tier.structuredBytes);
    for (const page of [0, pages - 1]) {
      const document = reconciliationSourceDocument(
        `capacity-${tier.id}-page-${page}`,
        "cards",
        "https://official-source.invalid",
      ) as {
        cards: { appearance_evidence: { images: { content_base64?: string; content_sha256: string }[] } }[];
      };
      expect(document.cards).toHaveLength(capacityPrintingsPerPage);
      expect(Buffer.byteLength(JSON.stringify(document))).toBeLessThan(16 * 1024 ** 2);
      for (const [offset, card] of document.cards.entries()) {
        expect(card.appearance_evidence.images).toHaveLength(2);
        for (const [face, image] of card.appearance_evidence.images.entries()) {
          const bytes = Buffer.from(image.content_base64!, "base64");
          const index = (page * capacityPrintingsPerPage + offset) * 2 + face;
          expect(bytes.length).toBe(capacityByteShare(tier.imageBytes, tier.images, index));
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(image.content_sha256);
          delete image.content_base64;
        }
      }
      expect(Buffer.byteLength(JSON.stringify(document))).toBe(capacityByteShare(tier.structuredBytes, pages, page));
    }
  },
);
