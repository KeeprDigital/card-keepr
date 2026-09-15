import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../src/catalogue/adapters";
import { parseSourceAdmissionEvidence } from "../../src/catalogue/reconciliation/source-admission-evidence";

const fixture = new URL(
  "../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/reversible-adventure.json",
  import.meta.url,
);

test("an incomplete reversible Adventure retains one reviewable record with independent physical image roles", async () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const bytes = readFileSync(fixture);
  const observations = await adapter.parseBytes!(bytes, {
    url: "https://api.scryfall.com/cards/081f2de5-251a-41c9-a62f-11487f54d355",
    mediaType: "application/json",
  });
  expect(observations).toEqual([
    expect.objectContaining({
      observation_type: "source_admission_evidence",
      game: "magic",
      source_lineage: "scryfall-magic-en",
      locator: "081f2de5-251a-41c9-a62f-11487f54d355",
      declared_finishes: ["nonfoil", "foil"],
      issues: [
        {
          code: "logical_parts_unresolved",
          source_paths: ["card_faces.0.layout", "card_faces.1.layout"],
        },
      ],
      appearance_evidence: {
        images: [
          expect.objectContaining({
            role: "front",
            source_url:
              "https://cards.scryfall.io/normal/front/0/8/081f2de5-251a-41c9-a62f-11487f54d355.jpg?1783907226",
          }),
          expect.objectContaining({
            role: "back",
            source_url: "https://cards.scryfall.io/normal/back/0/8/081f2de5-251a-41c9-a62f-11487f54d355.jpg?1783907226",
          }),
        ],
      },
      source_sidecar: expect.objectContaining({ source_record_json: JSON.stringify(JSON.parse(bytes.toString())) }),
    }),
  ]);
  expect(observations[0]).not.toHaveProperty("card");
  expect(observations[0]).not.toHaveProperty("printing");
  expect(parseSourceAdmissionEvidence(observations[0], adapter)).toEqual(observations[0]);
});

test.each([
  { field: "locator", value: "not-a-uuid" },
  { field: "declared_finishes", value: [] },
  { field: "declared_finishes", value: ["foil", "foil"] },
  { field: "declared_finishes", value: ["glitter"] },
  { field: "issues", value: [{ code: "logical_parts_unresolved", source_paths: [] }] },
  { field: "issues", value: [{ code: "logical_parts_unresolved", source_paths: ["x".repeat(257)] }] },
  { field: "source_sidecar", value: { source_record_json: "" } },
  { field: "completeness", value: { structurally_complete: false } },
])("retained review evidence rejects malformed $field without changing the source value", async ({ field, value }) => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const [original] = await adapter.parseBytes!(readFileSync(fixture), {
    url: JSON.parse(readFileSync(fixture).toString()).uri,
    mediaType: "application/json",
  });
  const document = { ...(original as Record<string, unknown>), [field]: value };
  const before = JSON.stringify(document);
  expect(() => parseSourceAdmissionEvidence(document, adapter)).toThrow();
  expect(JSON.stringify(document)).toBe(before);
});

test.each(["set", "collector_number", "rarity", "color_identity"])(
  "a reversible record missing required %s is rejected before unresolved intake",
  (field) => {
    const source = JSON.parse(readFileSync(fixture).toString());
    delete source[field];
    const adapter = requiredSourceAdapter("scryfall-magic-en@1");
    expect(() =>
      adapter.parseBytes!(new TextEncoder().encode(JSON.stringify(source)), {
        url: source.uri,
        mediaType: "application/json",
      }),
    ).toThrow();
  },
);

test.each([
  { field: "color_identity", colours: ["purple"] },
  { field: "color_identity", colours: ["G", "G"] },
  { field: "face.colors", colours: ["purple"] },
  { field: "face.colors", colours: ["G", "G"] },
])("a reversible record rejects malformed $field $colours before unresolved intake", ({ field, colours }) => {
  const source = JSON.parse(readFileSync(fixture).toString());
  if (field === "color_identity") source.color_identity = colours;
  else source.card_faces[1].colors = colours;
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  expect(() =>
    adapter.parseBytes!(new TextEncoder().encode(JSON.stringify(source)), {
      url: source.uri,
      mediaType: "application/json",
    }),
  ).toThrow();
});
