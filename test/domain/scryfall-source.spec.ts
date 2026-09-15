import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation";
import { profileFields } from "../../src/catalogue/read/http-contract";
import { requiredProfileContract } from "../../src/catalogue/shared";

const fixture = new URL("../../acceptance/fixtures/real-sources/2026-09-14-scryfall/raw/", import.meta.url);
const bulkFixture = new URL("../bulk/", fixture);

test("Magic discovery describes nullable logical-face colour arrays", () => {
  expect(profileFields(requiredProfileContract("magic@1").card)).toContainEqual({
    path: "faces.colours",
    type: "enum",
    nullable: true,
    multiple: true,
    values: ["W", "U", "B", "R", "G"],
  });
});

test("a reversible token keeps its token design category and both printed faces", async () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const bytes = readFileSync(new URL("reversible-token.json", bulkFixture));
  const source = JSON.parse(bytes.toString());
  const [value] = await adapter.parseBytes!(bytes, { url: source.uri, mediaType: "application/json" });
  const parsed = parseReconciliationObservation("reversible-token", value);
  if (parsed.kind !== "card_printing") throw new Error("Expected Card/Printing evidence");
  expect(parsed.observedCardAndPrinting.card!.category).toBe("token");
  expect(parsed.observedCardAndPrinting.card!.game_data.attributes.layout).toBe("token");
  expect(parsed.observedCardAndPrinting.printing!.game_data!.attributes.faces).toMatchObject([
    { role: "front" },
    { role: "back" },
  ]);
});

test.each(["unknown-illustration", "copy-token", "minigame"])(
  "retained %s keeps explicit source unknowns reviewable",
  async (file) => {
    const adapter = requiredSourceAdapter("scryfall-magic-en@1");
    const bytes = readFileSync(new URL(`${file}.json`, bulkFixture));
    const source = JSON.parse(bytes.toString());
    const [value] = await adapter.parseBytes!(bytes, { url: source.uri, mediaType: "application/json" });
    const parsed = parseReconciliationObservation(file, value);
    if (parsed.kind !== "card_printing") throw new Error("Expected Card/Printing evidence");
    if (file === "copy-token") expect(parsed.observedCardAndPrinting.card!.category).toBe("token");
    else {
      expect(parsed.artworkIdentityExplicit).toBe(false);
      expect(adapter.qualifiesPrintingIdentity?.(parsed)).toBe(false);
      expect(parsed.observedCardAndPrinting.printing!.game_data!.attributes.artists).toEqual([]);
    }
    if (file === "minigame")
      expect(parsed.observedCardAndPrinting.card!.game_data.attributes.faces).toMatchObject([
        { role: "front", type_line: "Card" },
        { role: "back", type_line: null },
      ]);
  },
);

test("etched source finish is preserved without claiming a finish-specific scan", async () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const bytes = readFileSync(new URL("etched.json", bulkFixture));
  const source = JSON.parse(bytes.toString());
  const values = await adapter.parseBytes!(bytes, { url: source.uri, mediaType: "application/json" });
  expect(values).toHaveLength(1);
  const parsed = parseReconciliationObservation("etched", values[0]);
  if (parsed.kind !== "card_printing") throw new Error("Expected Card/Printing evidence");
  expect(parsed.variantKey).toBe("etched");
  expect(parsed.observedCardAndPrinting.printing!.game_data!.attributes).toMatchObject({
    finish: "etched",
    finish_image: null,
  });
  expect(adapter.qualifiesPrintingIdentity?.(parsed)).toBe(true);
  expect(parsed.noveltyProofComplete).toBe(false);
});

test("retained missing images do not erase an art Card or invent physical proof", async () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const bytes = readFileSync(new URL("missing-image.json", bulkFixture));
  const source = JSON.parse(bytes.toString());
  const [value] = await adapter.parseBytes!(bytes, { url: source.uri, mediaType: "application/json" });
  const parsed = parseReconciliationObservation("missing-image", value);
  if (parsed.kind !== "card_printing") throw new Error("Expected Card/Printing evidence");
  expect(parsed.observedCardAndPrinting.card!.category).toBe("art");
  expect(parsed.observedCardAndPrinting.card!.gameplay_applicability).toBe("inapplicable");
  expect(parsed.noveltyProofComplete).toBe(false);
  expect(parsed.printingImages).toEqual([]);
  expect(adapter.discoverRequests!(bytes, { url: source.uri, mediaType: "application/json" })).toEqual([]);
});

test("reversible appearances with the same evidenced design retain one Oracle Card and both physical sides", async () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const observations = [];
  for (const file of ["reversible_card", "reversible-design"]) {
    const bytes = readFileSync(new URL(`${file}.json`, bulkFixture));
    const source = JSON.parse(bytes.toString());
    const [value] = await adapter.parseBytes!(bytes, { url: source.uri, mediaType: "application/json" });
    const parsed = parseReconciliationObservation(file, value);
    if (parsed.kind !== "card_printing") throw new Error("Expected Card/Printing evidence");
    observations.push(parsed);
  }
  expect(observations[0]!.cardDesignKey).toBe("oracle:61fbaaf2-4286-4e9a-b9cb-aa31262b596a");
  expect(observations[0]!.cardDesignKey).toBe(observations[1]!.cardDesignKey);
  expect(observations[0]!.observedCardAndPrinting.card).toEqual(observations[1]!.observedCardAndPrinting.card);
  expect(observations[0]!.observedCardAndPrinting.printing!.game_data!.attributes).toMatchObject({
    layout: "reversible_card",
    faces: [{ role: "front" }, { role: "back" }],
    reverse_face: "Jinnie Fay, Jetmir's Second",
  });
});

test.each([
  "normal",
  "token",
  "art_series",
  "transform",
  "saga",
  "adventure",
  "planar",
  "split",
  "modal_dfc",
  "emblem",
  "double_faced_token",
  "scheme",
  "mutate",
  "prepare",
  "class",
  "meld",
  "leveler",
  "flip",
  "prototype",
  "vanguard",
  "host",
  "case",
  "augment",
])("retained %s maps its physical sides independently of logical gameplay faces", async (layout) => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const bytes = readFileSync(new URL(`${layout}.json`, bulkFixture));
  const source = JSON.parse(bytes.toString());
  const values = await adapter.parseBytes!(bytes, { url: source.uri, mediaType: "application/json" });
  const parsed = parseReconciliationObservation(layout, values[0]);
  if (parsed.kind !== "card_printing") throw new Error("Expected Card/Printing evidence");
  const twoSided = ["transform", "modal_dfc", "art_series", "double_faced_token"].includes(layout);
  const requests = adapter.discoverRequests!(bytes, { url: source.uri, mediaType: "application/json" });
  expect(requests).toHaveLength(twoSided ? 2 : 1);
  expect(parsed.observedCardAndPrinting.printing!.game_data!.attributes).toMatchObject({
    layout,
    reverse_face: twoSided ? source.card_faces[1].name : null,
    finish_image: null,
  });
  if (layout === "art_series") {
    expect(parsed.observedCardAndPrinting.card!.game_data.attributes).toEqual({});
  } else {
    expect(parsed.observedCardAndPrinting.card!.game_data.attributes.faces).toHaveLength(
      source.card_faces?.length ?? 1,
    );
    expect(parsed.observedCardAndPrinting.card!.game_data.attributes.layout).toBe(layout);
  }
  if (layout === "double_faced_token") {
    expect(parsed.artworkIdentityExplicit).toBe(false);
    expect(adapter.qualifiesPrintingIdentity?.(parsed)).toBe(false);
    expect(parsed.noveltyProofComplete).toBe(false);
  }
});

test.each([
  { file: "split-three", names: ["Smelt", "Herd", "Saw"] },
  { file: "split-five", names: ["Who", "What", "When", "Where", "Why"] },
])("retained $file logical faces share one physical front image", async ({ file, names }) => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const bytes = readFileSync(new URL(`${file}.json`, bulkFixture));
  const source = JSON.parse(bytes.toString());
  const values = await adapter.parseBytes!(bytes, { url: source.uri, mediaType: "application/json" });
  const parsed = parseReconciliationObservation(file, values[0]);
  if (parsed.kind !== "card_printing") throw new Error("Expected Card/Printing evidence");
  expect(parsed.observedCardAndPrinting.card!.game_data.attributes.faces).toEqual(
    names.map((name) => expect.objectContaining({ name, role: "front", colours: null })),
  );
  expect(parsed.observedCardAndPrinting.printing!.game_data!.attributes.reverse_face).toBeNull();
  expect(parsed.observedCardAndPrinting.printing!.printed_rules_text).toBeNull();
  expect(adapter.discoverRequests!(bytes, { url: source.uri, mediaType: "application/json" })).toEqual([
    expect.objectContaining({ role: "image", url: source.image_uris.normal }),
  ]);
  expect(adapter.qualifiesCardDesignIdentity?.(parsed)).toBe(true);
});

test("retained English physical Scryfall designs expand finishes while keeping art and gameplay distinct", async () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const observations = [];
  for (const name of ["delver", "art-chillerpillar", "chillerpillar", "token"]) {
    const bytes = readFileSync(new URL(`${name}.json`, fixture));
    const card = JSON.parse(bytes.toString());
    for (const value of await adapter.parseBytes!(bytes, { url: card.uri, mediaType: "application/json" })) {
      const parsed = parseReconciliationObservation(name, value);
      if (parsed.kind !== "card_printing") throw new Error("Expected Card/Printing source evidence");
      observations.push(parsed);
    }
  }
  expect(observations).toHaveLength(7);
  const cards = observations.map((o) => o.observedCardAndPrinting.card!);
  expect(new Set(observations.map((o) => o.cardDesignKey)).size).toBe(4);
  expect(cards.map((c) => c.category)).toEqual([
    "gameplay",
    "gameplay",
    "art",
    "gameplay",
    "gameplay",
    "token",
    "token",
  ]);
  const delver = cards[0]!;
  expect(delver.official_identity).toEqual({ kind: "unknown", value: null });
  expect(observations[0]!.cardDesignKey).toBe("oracle:edd531b9-f615-4399-8c8c-1c5e18c4acbf");
  expect(delver.game_data.attributes.faces).toMatchObject([
    { role: "front", name: "Delver of Secrets", mana_cost: "{U}" },
    { role: "back", name: "Insectile Aberration", mana_cost: "" },
  ]);
  expect(cards[2]!.game_data.attributes).toEqual({});
  expect(cards[2]!.gameplay_applicability).toBe("inapplicable");
  expect(cards[2]!.effective_rules_text).toBeNull();
  expect(observations[2]!.cardRelationships).toEqual([
    {
      kind: "shared_artwork",
      target: {
        source_lineage: "scryfall-magic-en",
        locator: "7f57005c-414d-4c83-9b4f-cd26e547d54d",
        variant_key: "nonfoil",
      },
    },
  ]);
  expect(observations.map((o) => o.observedCardAndPrinting.printing!.game_data!.attributes.finish)).toEqual([
    "nonfoil",
    "foil",
    "nonfoil",
    "nonfoil",
    "foil",
    "nonfoil",
    "foil",
  ]);
  for (const observation of observations) {
    expect(observation.observedCardAndPrinting.printing!.printed_rules_text).toBeNull();
    expect(observation.errata).toEqual([]);
    expect(observation.noveltyProofComplete).toBe(false);
    expect(observation.observedCardAndPrinting.printing!.game_data!.attributes.finish_image).toBeNull();
  }
});

test("only the exact Scryfall parser qualifies its source design and finish identity; bytes remain required", async () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const bytes = readFileSync(new URL("delver.json", fixture));
  const source = JSON.parse(bytes.toString());
  const [raw] = await adapter.parseBytes!(bytes, { url: source.uri, mediaType: "application/json" });
  const observation = parseReconciliationObservation("delver", raw);
  if (observation.kind !== "card_printing") throw new Error("Expected Card/Printing evidence");
  expect(adapter.printingAdmission).toBe("source_qualification");
  expect(adapter.qualifiesCardDesignIdentity?.(observation)).toBe(true);
  expect(adapter.qualifiesPrintingIdentity?.(observation)).toBe(true);
  expect(observation.noveltyProofComplete).toBe(false);
  expect(adapter.qualifiesCardDesignIdentity?.({ ...observation, cardDesignKey: "unqualified:identity" })).toBe(false);
  expect(adapter.qualifiesPrintingIdentity?.({ ...observation, variantKey: "etched" })).toBe(false);
});

test("a source-declared image digest must match the retained bytes before it can prove a Printing", async () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const bytes = readFileSync(new URL("chillerpillar.json", fixture));
  const source = JSON.parse(bytes.toString());
  const values = await adapter.parseBytes!(bytes, { url: source.uri, mediaType: "application/json" });
  const raw = structuredClone(values[0]) as {
    appearance_evidence: { images: { source_url: string; content_sha256?: string }[] };
  };
  raw.appearance_evidence.images[0]!.content_sha256 = "a".repeat(64);
  const verified = new Map([
    [
      raw.appearance_evidence.images[0]!.source_url,
      {
        media_type: "image/jpeg" as const,
        width: 488,
        height: 680,
        content_byte_length: 86688,
        content_sha256: "b".repeat(64),
      },
    ],
  ]);
  const changed = parseReconciliationObservation("changed-image", raw, verified);
  if (changed.kind !== "card_printing") throw new Error("Expected Printing evidence");
  expect(changed.noveltyProofComplete).toBe(false);
  expect(changed.printingImages).toEqual([]);
  raw.appearance_evidence.images[0]!.content_sha256 = "b".repeat(64);
  const matching = parseReconciliationObservation("matching-image", raw, verified);
  if (matching.kind !== "card_printing") throw new Error("Expected Printing evidence");
  expect(matching.noveltyProofComplete).toBe(true);
});

test.each([
  { label: "digital-only", patch: { digital: true } },
  { label: "unreleased", patch: { released_at: "2026-12-01" } },
  { label: "invalid release date", patch: { released_at: "2026-02-31" } },
  { label: "foreign", patch: { lang: "ja" } },
  { label: "unsupported layout", patch: { layout: "unknown_future_layout" } },
  { label: "contradictory finishes", patch: { finishes: ["nonfoil"], foil: true } },
])("Scryfall rejects $label evidence rather than enlarging its qualified scope", async ({ patch }) => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const source = JSON.parse(readFileSync(new URL("delver.json", fixture)).toString());
  Object.assign(source, patch);
  expect(() =>
    adapter.parseBytes!(new TextEncoder().encode(JSON.stringify(source)), {
      url: source.uri,
      mediaType: "application/json",
    }),
  ).toThrow();
});

test("unfamiliar face fields retain actionable source warnings without entering Magic facts", async () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const source = JSON.parse(readFileSync(new URL("delver.json", fixture)).toString());
  source.card_faces[1].future_gameplay_property = "unrecognized source value";
  const [value] = await adapter.parseBytes!(new TextEncoder().encode(JSON.stringify(source)), {
    url: source.uri,
    mediaType: "application/json",
  });
  const parsed = parseReconciliationObservation("unfamiliar-face", value);
  if (parsed.kind !== "card_printing") throw new Error("Expected Card/Printing evidence");
  expect(parsed.sourceWarnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "unknown_source_field",
        path: "source_record.card_faces.1.future_gameplay_property",
        raw_value: '"unrecognized source value"',
      }),
    ]),
  );
});

test("Magic gameplay required fields cannot be omitted even with private design evidence", async () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const bytes = readFileSync(new URL("delver.json", fixture));
  const source = JSON.parse(bytes.toString());
  const [value] = await adapter.parseBytes!(bytes, { url: source.uri, mediaType: "application/json" });
  const raw = structuredClone(value) as { card: { game_data: { attributes: { faces?: unknown } } } };
  delete raw.card.game_data.attributes.faces;
  expect(() => parseReconciliationObservation("missing-faces", raw)).toThrow();
});
