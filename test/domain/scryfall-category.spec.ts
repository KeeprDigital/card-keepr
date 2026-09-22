import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../src/catalogue/adapters";
import { AdapterParseFailure } from "../../src/catalogue/adapters/adapter-parse-failure";
import { parseSourceAdmissionEvidence } from "../../src/catalogue/reconciliation/source-admission-evidence";
import { gameProfileCardClassification } from "../../src/catalogue/shared";

const adapter = requiredSourceAdapter("scryfall-magic-en@1");
const bytes = readFileSync(
  new URL("../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/manifest-reminder.json", import.meta.url),
);
const original = JSON.parse(bytes.toString());

test("the bulk scope excludes a token-layout reminder as a non-card insert without changing its bytes", () => {
  const before = Buffer.from(bytes);
  expect(adapter.archiveExtraction!.record(bytes, "2026-09-14")).toEqual({
    sourceKey: "01104ab1-84e1-4c78-853d-637c6554bdf9",
    exclusion: "non_card_insert",
    observations: [],
    requests: [],
  });
  expect(bytes).toEqual(before);
});

test("the per-record pilot path keeps an excluded kind reviewable without changing its source claims", async () => {
  const [review] = (await adapter.parseBytes!(bytes, {
    url: original.uri,
    mediaType: "application/json",
  })) as unknown[];
  expect(parseSourceAdmissionEvidence(review, adapter)).toMatchObject({
    observation_type: "source_admission_evidence",
    locator: "01104ab1-84e1-4c78-853d-637c6554bdf9",
    declared_finishes: ["nonfoil", "foil"],
    issues: [{ code: "category_unresolved", source_paths: ["layout", "type_line"] }],
    source_sidecar: { source_record_json: JSON.stringify(original) },
    appearance_evidence: {
      images: [
        {
          role: "front",
          source_url: original.image_uris.normal,
          artwork_fingerprint: `scryfall:illustration:${original.illustration_id}`,
        },
      ],
    },
  });
  expect(review).not.toHaveProperty("card");
  expect(review).not.toHaveProperty("printing");
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

test("the retained 210-record cohort follows the owner's token-layout category ruling", () => {
  const directory = new URL("../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/", import.meta.url);
  const expected = JSON.parse(readFileSync(new URL("category-cohort.json", directory), "utf8")) as {
    records: { id: string; ruling: string }[];
  };
  const lines = gunzipSync(readFileSync(new URL("category-cohort.jsonl.gz", directory)))
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  expect(lines).toHaveLength(expected.records.length);
  const outcomes: Record<string, number> = {};
  for (const [index, line] of lines.entries()) {
    const { id, ruling } = expected.records[index]!;
    const source = JSON.parse(line) as { layout: string };
    const parsed = adapter.archiveExtraction!.record(new TextEncoder().encode(line), "2026-09-14");
    const values = parsed.observations.map(({ value }) => value as Record<string, unknown>);
    const review = values[0]?.observation_type === "source_admission_evidence";
    const outcome =
      parsed.exclusion ??
      (review
        ? (values[0]!.issues as { code: string }[]).map(({ code }) => code).join(",")
        : source.layout === "token" &&
            values.every((value) => (value.card as { category: string }).category === "gameplay")
          ? "gameplay"
          : "ordinary");
    expect({ id: parsed.sourceKey, outcome }).toEqual({ id, outcome: ruling });
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  expect(outcomes).toEqual({
    gameplay: 45,
    advertising: 8,
    non_card_insert: 145,
    logical_parts_unresolved: 3,
    ordinary: 9,
  });
});

test("a token-layout gameplay type is a gameplay Card while Token-typed records stay tokens", () => {
  expect(gameProfileCardClassification("magic@1", { layout: "token", type_line: "Creature — Minotaur" })).toEqual({
    category: "gameplay",
    gameplay_applicability: "applicable",
  });
  expect(gameProfileCardClassification("magic@1", { layout: "token", type_line: "Token Creature — Goblin" })).toEqual({
    category: "token",
    gameplay_applicability: "applicable",
  });
  expect(() =>
    gameProfileCardClassification("magic@1", { layout: "token", type_line: "Creature — Minotaur" }, "token"),
  ).toThrow("Card category conflicts with its Game Profile.");
});
