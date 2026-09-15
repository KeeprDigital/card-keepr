import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../src/catalogue/adapters";
import { parseSourceAdmissionEvidence } from "../../src/catalogue/reconciliation/source-admission-evidence";
import { tcgdexReviewEvidence } from "../../src/catalogue/adapters/tcgdex-review-evidence";
import type { SourceAdapterParent } from "../../src/catalogue/adapters/source-adapter-registration-types";

const directory = new URL("../../acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/", import.meta.url);
const captures = JSON.parse(readFileSync(new URL("manifest.json", directory), "utf8")).captures as {
  id: string;
  url: string;
  finishedAt: string;
  sha256: string;
  body: string;
}[];
function retained(id: string, role: string): SourceAdapterParent {
  const capture = captures.find((value) => value.id === id)!;
  return {
    requestId: `request-${id}`,
    snapshotId: `snapshot-${id}`,
    role,
    url: capture.url,
    mediaType: "application/json",
    retrievedAt: capture.finishedAt,
    contentSha256: capture.sha256,
    bytes: readFileSync(new URL(capture.body, directory)),
  };
}
function source(id = "tk-ex-latia-8", setId = "tk-ex-latia") {
  const card = retained(`card-${id}`, "detail");
  return {
    bytes: card.bytes,
    context: {
      url: card.url,
      mediaType: card.mediaType,
      parents: [
        retained(`set-${setId}`, "listing"),
        retained("pocket-series", "listing"),
        retained("english-sets", "surface"),
      ],
    },
  };
}
function changed(source: Uint8Array, change: (card: Record<string, unknown>) => void) {
  const card = JSON.parse(new TextDecoder().decode(source)) as Record<string, unknown>;
  change(card);
  return new TextEncoder().encode(JSON.stringify(card));
}

test("an evidenced image belongs to one unresolved source record while exact raw claims and the leading-zero membership survive", () => {
  const { bytes, context } = source("swsh9-053", "swsh9");
  const result = tcgdexReviewEvidence(bytes, context);
  expect(result).toMatchObject({
    locator: "swsh9-053",
    source_membership: { set_id: "swsh9", local_id: "053" },
    target: { kind: "unresolved_record" },
    source_sidecar: { source_record_json: new TextDecoder().decode(bytes) },
    appearance_evidence: {
      images: [
        {
          association: "source_record",
          role: "front",
          source_url: "https://assets.tcgdex.net/en/swsh/swsh9/053/high.png",
        },
      ],
    },
    completeness: {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 1,
      parsed_record_count: 1,
    },
  });
  expect(result).not.toHaveProperty("card");
  expect(result).not.toHaveProperty("printing");
  expect(result.appearance_evidence.images[0]).not.toHaveProperty("treatment_key");
  expect(result.appearance_evidence.images[0]?.artwork_fingerprint).toMatch(
    /^tcgdex-pokemon-en:source-record-image:[0-9a-f]{64}$/u,
  );
  const repriced = changed(bytes, (card) => {
    card.pricing = { unfamiliar: { price: 1.23 } };
  });
  expect(tcgdexReviewEvidence(repriced, context).appearance_evidence).toEqual(result.appearance_evidence);
});

test("unfamiliar categories, detailed treatment claims and optional source values remain inspectable without qualification", () => {
  const { bytes, context } = source("base3-62", "base3");
  const claims = changed(bytes, (card) => {
    card.category = "Collectible";
    card.additionalEvidence = { release: "unqualified" };
  });
  const result = tcgdexReviewEvidence(claims, context);
  expect(result.issues.map((issue) => issue.code)).toEqual([
    "card_identity_unresolved",
    "printing_treatment_unresolved",
    "category_unresolved",
  ]);
  expect(result.source_sidecar.source_record_json).toBe(new TextDecoder().decode(claims));
  expect(result.source_sidecar.source_record_json).toContain('"foil":"galaxy"');
  expect(result.target).toEqual({ kind: "unresolved_record" });
});

test("missing treatment inventory remains one unresolved record and a repeated variantId across Cards is never identity", () => {
  const first = source();
  const second = source("base4-126", "base4");
  const one = tcgdexReviewEvidence(first.bytes, first.context);
  const two = tcgdexReviewEvidence(second.bytes, second.context);
  expect(JSON.parse(one.source_sidecar.source_record_json).variants_detailed[0].variantId).toBe(
    JSON.parse(two.source_sidecar.source_record_json).variants_detailed[0].variantId,
  );
  expect(one.locator).not.toBe(two.locator);
  for (const inventory of [undefined, []]) {
    const result = tcgdexReviewEvidence(
      changed(first.bytes, (card) => {
        card.variants_detailed = inventory;
      }),
      first.context,
    );
    expect(result.target).toEqual({ kind: "unresolved_record" });
    expect(result.issues).toContainEqual({
      code: "printing_treatment_unresolved",
      source_paths: ["tcgdex_card.variants_detailed"],
    });
  }
});

test("required source claims stay terminal even when no canonical entity is being proposed", () => {
  const { bytes, context } = source();
  const malformed: ((card: Record<string, unknown>) => void)[] = [
    (card) => {
      card.category = null;
    },
    (card) => {
      card.name = "";
    },
    (card) => {
      delete card.effect;
    },
    (card) => {
      card.retreat = -1;
    },
    (card) => {
      card.variants_detailed = {};
    },
    (card) => {
      card.variants_detailed = [{ type: "normal", size: "standard" }];
    },
    (card) => {
      card.variants_detailed = [{ type: "normal", size: 1, variantId: "source-id" }];
    },
    (card) => {
      const variant = (card.variants_detailed as unknown[])[0];
      card.variants_detailed = [variant, variant];
    },
    (card) => {
      card.abilities = [{ name: "Claim", effect: 10 }];
    },
    (card) => {
      card.attacks = [{ name: "Claim", cost: "Fire" }];
    },
    (card) => {
      card.weaknesses = [{ type: "Fire", value: {} }];
    },
    (card) => {
      card.localId = "08";
    },
  ];
  for (const change of malformed) expect(() => tcgdexReviewEvidence(changed(bytes, change), context)).toThrow();
});

test("source image discovery rejects foreign, non-English and rewritten URLs", () => {
  const { bytes, context } = source();
  for (const image of [
    "https://example.com/en/tk/tk-ex-latia/8",
    "https://assets.tcgdex.net/fr/tk/tk-ex-latia/8",
    "https://assets.tcgdex.net/en/tk/tk-ex-latia/8?changed=yes",
    "https://assets.tcgdex.net/en/tk/../tk-ex-latia/8",
    "https://user@assets.tcgdex.net/en/tk/tk-ex-latia/8",
  ])
    expect(() =>
      tcgdexReviewEvidence(
        changed(bytes, (card) => {
          card.image = image;
        }),
        context,
      ),
    ).toThrow();
});

test("a review record still requires its own complete retained discovery chain", () => {
  const { bytes, context } = source();
  for (const parents of [
    [],
    context.parents.slice(0, 2),
    [retained("set-base4", "listing"), ...context.parents.slice(1)],
  ])
    expect(() => tcgdexReviewEvidence(bytes, { ...context, parents })).toThrow();
});

test("independent admission validation accepts only the closed Pokemon record branch with exact membership and source-image attribution", () => {
  const { bytes, context } = source("swsh9-053", "swsh9");
  const observation = tcgdexReviewEvidence(bytes, context);
  const adapter = requiredSourceAdapter("tcgdex-pokemon-en@1");
  expect(parseSourceAdmissionEvidence(observation, adapter)).toEqual(observation);
  for (const patch of [
    { declared_finishes: ["foil"] },
    { source_lineage: "scryfall-magic-en" },
    { target: { kind: "qualified_treatment", treatment: {} } },
    { target: { kind: "unresolved_treatments" } },
    { source_membership: { set_id: "swsh9", local_id: "53" } },
    { card: { game: "pokemon" } },
    { issues: [] },
    { issues: [{ code: "logical_parts_unresolved", source_paths: ["tcgdex_card.id"] }] },
    { issues: [{ code: "card_identity_unresolved", source_paths: [] }] },
    { completeness: { ...observation.completeness, parsed_record_count: 2 } },
    {
      appearance_evidence: {
        images: [observation.appearance_evidence.images[0], observation.appearance_evidence.images[0]],
      },
    },
    { appearance_evidence: { images: [{ ...observation.appearance_evidence.images[0], association: "printing" }] } },
    {
      appearance_evidence: {
        images: [{ ...observation.appearance_evidence.images[0], source_url: "https://example.com/foreign.png" }],
      },
    },
  ])
    expect(() => parseSourceAdmissionEvidence({ ...observation, ...patch }, adapter)).toThrow();
  expect(() => parseSourceAdmissionEvidence(observation, requiredSourceAdapter("scryfall-magic-en@1"))).toThrow();
});

test.each([
  ["base1-94", "base1"],
  ["base1-96", "base1"],
  ["base1-98", "base1"],
  ["base4-126", "base4"],
  ["tk-ex-latia-8", "tk-ex-latia"],
  ["swsh9-109", "swsh9"],
  ["swsh9-147", "swsh9"],
  ["base1-5", "base1"],
  ["swsh9-053", "swsh9"],
  ["base3-62", "base3"],
])(
  "retained %s claims remain one source-scoped proposal without merging designs or inventing treatments",
  (id, setId) => {
    const { bytes, context } = source(id, setId);
    const result = tcgdexReviewEvidence(bytes, context);
    expect(result.locator).toBe(id);
    expect(result.source_membership.set_id).toBe(setId);
    expect(result.source_sidecar.source_record_json).toBe(new TextDecoder().decode(bytes));
    expect(result.target).toEqual({ kind: "unresolved_record" });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "card_identity_unresolved",
      "printing_treatment_unresolved",
    ]);
    expect(result).not.toHaveProperty("card");
    expect(result).not.toHaveProperty("printing");
    expect(parseSourceAdmissionEvidence(result, requiredSourceAdapter("tcgdex-pokemon-en@1"))).toEqual(result);
  },
);
