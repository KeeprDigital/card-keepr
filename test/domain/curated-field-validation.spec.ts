import { expect, test } from "vitest";
import { exportedGameProfileSchema, sharedCuratableFieldSchemas, validCuratedField } from "../../src/catalogue/shared";

function cardField(profile: string, name: string) {
  const properties = exportedGameProfileSchema(profile).properties.card.properties as Record<
    string,
    Record<string, unknown>
  >;
  return properties[name]!;
}

test("compiled shared fields retain closed objects, required fields and calendar dates", () => {
  const rarity = sharedCuratableFieldSchemas["printing:/rarity"]!;
  expect(validCuratedField(rarity, { normalized: null, raw: "Champion" })).toBe(true);
  expect(validCuratedField(rarity, { normalized: null })).toBe(false);
  expect(validCuratedField(rarity, { normalized: null, raw: "Champion", invented: true })).toBe(false);
  const date = sharedCuratableFieldSchemas["erratum:/effective_from"]!;
  expect(validCuratedField(date, null)).toBe(true);
  expect(validCuratedField(date, "2024-02-29")).toBe(true);
  expect(validCuratedField(date, "2025-02-29")).toBe(false);
});

test("compiled publisher fields retain types, vocabulary and uniqueness", () => {
  for (const profile of ["one-piece@1", "fusion-world@1", "gundam@1"]) {
    const cost = cardField(profile, "cost");
    expect(validCuratedField(cost, 0)).toBe(true);
    expect(validCuratedField(cost, -1)).toBe(false);
    expect(validCuratedField(cost, "0")).toBe(false);
  }
  expect(validCuratedField(cardField("digimon@1", "level"), 3)).toBe(true);
  expect(validCuratedField(cardField("digimon@1", "level"), "3")).toBe(false);
  const tags = cardField("riftbound@1", "tags");
  expect(validCuratedField(tags, ["Ahri", "Ionia"])).toBe(true);
  expect(validCuratedField(tags, ["Ahri", "Ahri"])).toBe(false);
  expect(validCuratedField(tags, [1])).toBe(false);
  expect(validCuratedField(cardField("riftbound@1", "domains"), ["invented"])).toBe(false);
});

test("unregistered schemas fail closed without compiling code", () => {
  expect(validCuratedField({ type: "string", pattern: "unregistered" }, "unregistered")).toBe(false);
});
