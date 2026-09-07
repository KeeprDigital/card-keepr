import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { canonicalJson } from "../../src/catalogue/shared";
import { riftboundSourceAdapterRegistration } from "../../src/catalogue/adapters/riftbound-source-adapter";

const fixture = new URL("../../acceptance/fixtures/real-sources/2026-09-08-riftbound/raw/", import.meta.url);

test("Riot English pagination retains every returned record and literal token and treatment identifiers", async () => {
  const observations = [];
  for (let offset = 0; offset < 1200; offset += 200) {
    const bytes = readFileSync(new URL(`cards-${offset}.json`, fixture));
    const url = `https://content.publishing.riotgames.com/publishing-content/v2.0/public/channel/riftbound_website/list/riftbound_gallery_cards?locale=en_US&from=${offset}&limit=200`;
    observations.push(
      ...(await riftboundSourceAdapterRegistration.parseBytes!(bytes, { url, mediaType: "application/json" })),
    );
  }
  expect(() => canonicalJson(observations)).not.toThrow();
  const cards = observations.filter((o) => o.card);
  expect(cards).toHaveLength(1189);
  const byLocator = new Map(cards.map((o) => [o.identity_evidence.locator, o]));
  expect(byLocator.size).toBe(1189);
  expect(byLocator.get("unl-t04")?.card.official_identity).toEqual({ kind: "card_number", value: "UNL-T04" });
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
  ]) {
    const changed = structuredClone(source);
    mutate(changed);
    expect(() =>
      riftboundSourceAdapterRegistration.parseBytes(new TextEncoder().encode(JSON.stringify(changed)), context),
    ).toThrow();
  }
});
