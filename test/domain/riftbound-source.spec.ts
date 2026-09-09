import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { sourceAdapterForCoverage, requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters";
import { canonicalJson } from "../../src/catalogue/shared";
import { riftboundSourceAdapterRegistration } from "../../src/catalogue/adapters/riftbound-source-adapter";
import { AdapterParseFailure } from "../../src/catalogue/adapters/adapter-parse-failure";

const fixture = new URL("../../acceptance/fixtures/real-sources/2026-09-08-riftbound/raw/", import.meta.url);

test("malformed Riot bytes and image URLs remain source-contract failures", () => {
  const context = {
    url: "https://content.publishing.riotgames.com/publishing-content/v2.0/public/channel/riftbound_website/list/riftbound_gallery_cards?locale=en_US&from=0&limit=200",
    mediaType: "application/json",
  };
  for (const bytes of [new Uint8Array([0xff]), new TextEncoder().encode("{")])
    expect(() => riftboundSourceAdapterRegistration.parseBytes(bytes, context)).toThrow(AdapterParseFailure);
  const source = JSON.parse(readFileSync(new URL("cards-0.json", fixture), "utf8"));
  source.data[0].cardImage.url = "not a URL";
  expect(() =>
    riftboundSourceAdapterRegistration.parseBytes(new TextEncoder().encode(JSON.stringify(source)), context),
  ).toThrow(AdapterParseFailure);
});

test("Riot English pagination retains every returned record and literal token and treatment identifiers", async () => {
  const observations: ReturnType<typeof riftboundSourceAdapterRegistration.parseBytes>[number][] = [];
  for (let offset = 0; offset < 1200; offset += 200) {
    const bytes = readFileSync(new URL(`cards-${offset}.json`, fixture));
    const url = `https://content.publishing.riotgames.com/publishing-content/v2.0/public/channel/riftbound_website/list/riftbound_gallery_cards?locale=en_US&from=${offset}&limit=200`;
    observations.push(
      ...(await riftboundSourceAdapterRegistration.parseBytes!(bytes, { url, mediaType: "application/json" })),
    );
  }
  expect(() => canonicalJson(observations)).not.toThrow();
  const cards = observations.filter((o) => "card" in o);
  expect(cards).toHaveLength(1189);
  const byLocator = new Map(cards.map((o) => [o.identity_evidence.locator, o]));
  expect(byLocator.size).toBe(1189);
  expect(byLocator.get("unl-t04")?.card.official_identity).toEqual({ kind: "publisher_name", value: "Buff" });
  expect(byLocator.get("unl-t04")?.printing.game_data.attributes.public_code).toBe("UNL-T04");
  expect(byLocator.get("ogn-066a-298")?.card.official_identity).toEqual(
    byLocator.get("ogn-066-298")?.card.official_identity,
  );
  expect(byLocator.get("unl-t04")?.card.game_data.attributes.card_types).toEqual([]);
  expect(byLocator.get("unl-t04")?.card.game_data.attributes.supertypes).toEqual(["token"]);
  expect(byLocator.get("sfd-227-star-221")?.printing.game_data.attributes.public_code).toBe("SFD-227*/221");
  expect(byLocator.get("ogn-066a-298")?.printing.game_data.attributes.public_code).toBe("OGN-066a/298");
  expect(byLocator.get("unl-205-219")?.printing.game_data.attributes.orientation).toBe("landscape");
  expect(byLocator.get("unl-205-219")?.printing.game_data.attributes.reverse_face).toBeNull();
  expect(byLocator.get("ogn-141-298")?.printing.printed_rules_text).toBeNull();
  expect(byLocator.get("ogn-141-298")?.card.effective_rules_text).toContain("buff up to two other friendly units");
});

test("Riot rejects changed locale, missing pagination links and duplicate publisher IDs", () => {
  const source = JSON.parse(readFileSync(new URL("cards-0.json", fixture), "utf8"));
  const context = {
    url: "https://content.publishing.riotgames.com/publishing-content/v2.0/public/channel/riftbound_website/list/riftbound_gallery_cards?locale=en_US&from=0&limit=200",
    mediaType: "application/json",
  };
  for (const mutate of [
    (d: typeof source) => {
      d.metadata.locale = "zh-tw";
    },
    (d: typeof source) => {
      delete d.linkdata.next;
    },
    (d: typeof source) => {
      d.data[1] = d.data[0];
    },
    (d: typeof source) => {
      d.data[0].cardImage.url =
        "https://user:password@cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/image.png";
    },
  ]) {
    const changed = structuredClone(source);
    mutate(changed);
    expect(() =>
      riftboundSourceAdapterRegistration.parseBytes(new TextEncoder().encode(JSON.stringify(changed)), context),
    ).toThrow();
  }
});

test("unmapped publisher fields remain inspectable even with fractional raw metadata", () => {
  const source = JSON.parse(readFileSync(new URL("cards-0.json", fixture), "utf8"));
  source.data[0].newPublisherField = { fractional: 0.5 };
  const observations = riftboundSourceAdapterRegistration.parseBytes(new TextEncoder().encode(JSON.stringify(source)), {
    url: "https://content.publishing.riotgames.com/publishing-content/v2.0/public/channel/riftbound_website/list/riftbound_gallery_cards?locale=en_US&from=0&limit=200",
    mediaType: "application/json",
  });
  const first = observations.find((o) => "card" in o)!;
  expect(first.source_sidecar.unmapped_optional_fields).toContainEqual({
    path: "publisher_record.newPublisherField",
    value: '{"fractional":0.5}',
  });
  expect(() => canonicalJson(observations)).not.toThrow();
});

test("Riot scopes explicitly require owner Printing review while ordinary source qualification stays default", () => {
  for (const subset of ["complete", "public-english-inventory", "origins-errata", "announced-products-2027"])
    expect(sourceAdapterForCoverage(riftboundSourceAdapterRegistration, subset).printingAdmission).toBe("owner_review");
  expect(sourceAdapterForCoverage(riftboundSourceAdapterRegistration, "origins-errata").reconciliationCapability).toBe(
    "errata",
  );
  expect(requiredSourceAdapter("one-piece-en@6").printingAdmission ?? "source_qualification").toBe(
    "source_qualification",
  );
  expect(sourceAdapterForCoverage(requiredSourceAdapter("one-piece-en@6"), "p-001-catalogue").printingAdmission).toBe(
    "owner_review",
  );
});
