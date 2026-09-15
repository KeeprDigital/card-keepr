import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters";
import { parseSourceAdmissionEvidence } from "../../src/catalogue/reconciliation/source-admission-evidence";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation";
import { AdapterParseFailure } from "../../src/catalogue/adapters/adapter-parse-failure";

const fixture = "acceptance/fixtures/real-sources/2026-09-14-riftbound-db/raw/";
const origin = "https://www.riftbound-db.com";

test("Riftbound DB retains real duplicate promo claims without allocating unqualified identities", async () => {
  const adapter = requiredSourceAdapter("riftbound-db-en@1");
  const promo = await adapter.parseBytes!(readFileSync(`${fixture}pr-page-1-size-3.json`), {
    url: `${origin}/api/cards?set=PR&page=1&pageSize=3`,
    mediaType: "application/json",
  });
  const search = await adapter.parseBytes!(readFileSync(`${fixture}bird-page-1-size-3.json`), {
    url: `${origin}/api/cards?q=Bird&page=1&pageSize=3`,
    mediaType: "application/json",
  });
  expect(promo).toHaveLength(3);
  for (const claim of promo) {
    expect(claim).toMatchObject({
      observation_type: "source_admission_evidence",
      game: "riftbound",
      source_lineage: "riftbound-db-en",
      target: { kind: "unresolved_record" },
    });
    expect(claim).not.toHaveProperty("card");
    expect(claim).not.toHaveProperty("printing");
  }
  const bird = "openrift-019e1fea-0113-7f38-b59d-23cab5997383";
  const claims = (values: readonly unknown[]) =>
    values as { locator: string; source_sidecar: { source_record_json: string } }[];
  expect(claims(search).find((claim) => claim.locator === bird)).toEqual(
    claims(promo).find((claim) => claim.locator === bird),
  );
  const raw = JSON.parse(claims(promo)[1]!.source_sidecar.source_record_json);
  expect(raw.raw.openrift).toMatchObject({ publicCode: "UNL-T02-P", finish: "foil", channelPath: ["Unleashed Vault"] });
  expect(adapter.printingAdmission).toBe("owner_review");
});

test("Riftbound DB bounds retained facets and pagination without claiming or following a full inventory", async () => {
  const adapter = requiredSourceAdapter("riftbound-db-en@1");
  const context = { url: `${origin}/api/facets`, mediaType: "application/json" };
  expect(await adapter.parseBytes!(readFileSync(`${fixture}facets.json`), context)).toEqual([]);
  expect(adapter.discoverRequests!(readFileSync(`${fixture}facets.json`), context)).toEqual([]);
  expect(adapter.requiredSurfaces).toContain("facets");
  const url = `${origin}/api/cards?set=PR&page=1&pageSize=3`;
  const source = JSON.parse(readFileSync(`${fixture}pr-page-1-size-3.json`, "utf8"));
  for (const malformed of [
    { ...source, pagination: { ...source.pagination, hasMore: false } },
    { ...source, cards: [source.cards[0], source.cards[0]] },
    { ...source, cards: source.cards.slice(0, 2) },
  ])
    expect(() =>
      adapter.parseBytes!(new TextEncoder().encode(JSON.stringify(malformed)), { url, mediaType: "application/json" }),
    ).toThrow(AdapterParseFailure);
  expect(() =>
    adapter.parseBytes!(readFileSync(`${fixture}pr-page-1-size-3.json`), {
      url: url.replace("page=1", "page=2"),
      mediaType: "application/json",
    }),
  ).toThrow(AdapterParseFailure);
});

test("Riftbound DB promo evidence satisfies the retained review contract without a partial Game Profile", async () => {
  const adapter = requiredSourceAdapter("riftbound-db-en@1");
  const values = await adapter.parseBytes!(readFileSync(`${fixture}pr-page-1-size-3.json`), {
    url: `${origin}/api/cards?set=PR&page=1&pageSize=3`,
    mediaType: "application/json",
  });
  for (const value of values) expect(parseSourceAdmissionEvidence(value, adapter)).toEqual(value);
});

test("Eclipse Herald maps its evidenced Riot overlap while original promo images stay private source-record evidence", async () => {
  const adapter = requiredSourceAdapter("riftbound-db-en@1");
  const context = { url: `${origin}/api/cards?q=Bird&page=1&pageSize=3`, mediaType: "application/json" };
  const values = await adapter.parseBytes!(readFileSync(`${fixture}bird-page-1-size-3.json`), context);
  const eclipse = values.find((value) => typeof value === "object" && value !== null && "card" in value);
  const parsed = parseReconciliationObservation("retained-eclipse", eclipse);
  expect(parsed).toMatchObject({
    kind: "card_printing",
    observedCardAndPrinting: {
      card: {
        name: "Eclipse Herald",
        category: "gameplay",
        official_identity: { kind: "publisher_name", value: "Eclipse Herald" },
        game_data: {
          profile: "riftbound@1",
          attributes: {
            card_types: ["unit"],
            supertypes: [],
            domains: ["calm"],
            energy: 7,
            power: 1,
            might: 7,
            might_bonus: null,
            tags: ["Bird", "Mount Targon"],
            effect_text: null,
          },
        },
      },
      printing: {
        printed_rules_text: null,
        game_data: { attributes: { public_code: "OGN-059/298", finish: null, reverse_face: null } },
      },
    },
  });
  const promo = await adapter.parseBytes!(readFileSync(`${fixture}pr-page-1-size-3.json`), {
    url: `${origin}/api/cards?set=PR&page=1&pageSize=3`,
    mediaType: "application/json",
  });
  for (const value of promo) {
    const review = parseSourceAdmissionEvidence(value, adapter);
    expect(review.appearance_evidence.images).toHaveLength(1);
    expect(review.appearance_evidence.images[0]).toMatchObject({ association: "source_record", role: "front" });
  }
  expect(adapter.discoverRequests!(readFileSync(`${fixture}bird-page-1-size-3.json`), context)).toHaveLength(2);
});

test("Riftbound DB rejects contradictory raw source identity before qualifying the overlap", () => {
  const adapter = requiredSourceAdapter("riftbound-db-en@1");
  const page = JSON.parse(readFileSync(`${fixture}bird-page-1-size-3.json`, "utf8"));
  page.cards[1].raw.id = "different-source-record";
  expect(() =>
    adapter.parseBytes!(new TextEncoder().encode(JSON.stringify(page)), {
      url: `${origin}/api/cards?q=Bird&page=1&pageSize=3`,
      mediaType: "application/json",
    }),
  ).toThrow(AdapterParseFailure);
});
