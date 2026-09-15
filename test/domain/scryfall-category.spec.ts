import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../src/catalogue/adapters";
import { AdapterParseFailure } from "../../src/catalogue/adapters/adapter-parse-failure";
import { parseSourceAdmissionEvidence } from "../../src/catalogue/reconciliation/source-admission-evidence";

const adapter = requiredSourceAdapter("scryfall-magic-en@1");
const bytes = readFileSync(
  new URL("../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/manifest-reminder.json", import.meta.url),
);
const original = JSON.parse(bytes.toString());

test("a retained token-layout reminder keeps its category unresolved without changing its source claims", async () => {
  const before = Buffer.from(bytes);
  const parsed = adapter.archiveExtraction!.record(bytes, "2026-09-14");
  expect(parsed).toMatchObject({ sourceKey: "01104ab1-84e1-4c78-853d-637c6554bdf9", exclusion: null });
  expect(parsed.observations).toHaveLength(1);
  const review = parseSourceAdmissionEvidence(parsed.observations[0]!.value, adapter);
  expect(review).toMatchObject({
    observation_type: "source_admission_evidence",
    locator: "01104ab1-84e1-4c78-853d-637c6554bdf9",
    declared_finishes: ["nonfoil", "foil"],
    issues: [{ code: "category_unresolved", source_paths: ["layout", "type_line"] }],
    source_sidecar: { source_record_json: JSON.stringify(original) },
  });
  expect(review).not.toHaveProperty("card");
  expect(review).not.toHaveProperty("printing");
  expect(review).not.toHaveProperty("category");
  expect(review.appearance_evidence.images).toEqual([
    {
      role: "front",
      source_url: original.image_uris.normal,
      artwork_fingerprint: `scryfall:illustration:${original.illustration_id}`,
    },
  ]);
  expect(parsed.requests).toHaveLength(1);
  expect(await adapter.parseBytes!(bytes, { url: original.uri, mediaType: "application/json" })).toEqual([review]);
  expect(bytes).toEqual(before);
});

test.each([
  ["name", ""],
  ["name", 1],
  ["type_line", undefined],
  ["type_line", []],
  ["id", "invalid"],
  ["oracle_id", "invalid"],
  ["uri", "https://api.scryfall.com/cards/other"],
  ["released_at", "2026-02-30"],
  ["released_at", "2099-01-01"],
  ["lang", "fr"],
  ["digital", "false"],
  ["games", ["paper", 1]],
  ["set", ""],
  ["collector_number", ""],
  ["rarity", undefined],
  ["color_identity", undefined],
  ["color_identity", ["purple"]],
  ["color_identity", ["G", "G"]],
  ["colors", ["purple"]],
  ["colors", ["G", "G"]],
  ["finishes", []],
  ["finishes", ["foil", "foil"]],
  ["finishes", ["glitter"]],
  ["nonfoil", "true"],
  ["mana_cost", 2],
  ["oracle_text", {}],
  ["power", 2],
  ["toughness", 2],
  ["printed_text", {}],
  ["artist", 2],
  ["illustration_id", "invalid"],
  ["image_uris", { normal: "https://untrusted.invalid/image.jpg" }],
  ["card_faces", []],
  ["card_faces", [{}, {}]],
  ["face.object", "card"],
  ["face.name", ""],
  ["face.type_line", ""],
  ["face.colors", ["purple"]],
  ["face.mana_cost", 2],
  ["face.oracle_text", {}],
  ["face.illustration_id", "invalid"],
  ["face.image_uris", { normal: "https://untrusted.invalid/image.jpg" }],
] as const)("category review never hides malformed required claims: %s %j", async (path, value) => {
  const source = structuredClone(original);
  if (path.startsWith("face.")) {
    source.card_faces = [
      {
        object: "card_face",
        name: original.name,
        type_line: original.type_line,
        mana_cost: original.mana_cost,
        oracle_text: original.oracle_text,
        colors: original.colors,
        illustration_id: original.illustration_id,
        image_uris: original.image_uris,
        [path.slice(5)]: value,
      },
    ];
  } else source[path] = value;
  expect(() =>
    adapter.parseBytes!(new TextEncoder().encode(JSON.stringify(source)), {
      url: original.uri,
      mediaType: "application/json",
    }),
  ).toThrow(AdapterParseFailure);
});
