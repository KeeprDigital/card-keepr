import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { expect, test } from "vitest";
import fullScope from "../../docs/examples/one-piece-limitless-full-scope-plan.json";
import composed from "../../docs/examples/one-piece-full-scope-plan.json";
import { requiredSourceAdapter } from "../../src/catalogue/adapters";
import { limitlessOnePieceSourceAdapterRegistration as adapter } from "../../src/catalogue/adapters/limitless-one-piece-source-adapter";
import { validateEvidencePlan } from "../../src/catalogue/source-evidence/source-evidence-model";

const fixtures = new URL("../../acceptance/fixtures/real-sources/", import.meta.url);
const indexPack = new URL("2026-09-15-limitless-index/", fixtures);
const bucketPack = new URL("2026-09-21-limitless-buckets/", fixtures);
const pilotPack = new URL("2026-09-15-limitless/raw/", fixtures);
const origin = "https://onepiece.limitlesstcg.com";
const html = { accept: "text/html" };

type Capture = { id: string; url: string; body: string; sha256: string; bytes: number; contentType: string };
function verifiedCaptures(pack: URL): { capture: Capture; bytes: Buffer }[] {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", pack), "utf8")) as { captures: Capture[] };
  return manifest.captures.map((capture) => {
    const bytes = readFileSync(new URL(capture.body, pack));
    expect(bytes.length).toBe(capture.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(capture.sha256);
    return { capture, bytes };
  });
}
const context = (url: string) => ({ url, mediaType: "text/html" });
const roots = verifiedCaptures(indexPack);
const census = JSON.parse(readFileSync(new URL("census.json", bucketPack), "utf8")) as {
  per_bucket: { id: string; url: string; grid_links: number; unique_grid_links: number }[];
};

test("the complete Limitless scope starts from the two retained index roots and keeps the named contracts", () => {
  expect(adapter.requiredSurfaces).toEqual(["products-index", "promos-index"]);
  expect(adapter.requiredSurfaces!.map((surface) => adapter.requestUrlForSurface!(surface))).toEqual([
    `${origin}/cards`,
    `${origin}/cards/promos`,
  ]);
  expect(() => adapter.requestUrlForSurface!("discovery")).toThrow("Unknown Limitless coverage surface");
  expect(Object.keys(adapter.coverageContracts!).sort()).toEqual(["five-card-pilot", "p-001-catalogue"]);
  expect(adapter.coverageContracts!["p-001-catalogue"]!.requestUrlForSurface("p-001-catalogue")).toBe(
    `${origin}/cards/en/P-001`,
  );
});

test("the example full-scope plan validates as the complete Limitless coverage of both index roots", async () => {
  expect(fullScope.plans).toHaveLength(1);
  const { plan } = await validateEvidencePlan({ ...fullScope.plans[0]!, idempotency_key: "limitless-complete-root" });
  expect(plan.coverage).toEqual({ locale: "en", area: "catalogue", subset: "complete" });
  expect(plan.participation).toBe("required");
  expect(plan.requests.map(({ id, url }) => ({ id, url }))).toEqual([
    { id: "limitless-one-piece-en:products-index", url: `${origin}/cards` },
    { id: "limitless-one-piece-en:promos-index", url: `${origin}/cards/promos` },
  ]);
});

test("the composed One Piece plan pairs Bandai's complete discovery with the complete Limitless roots", async () => {
  expect(composed.plans.map((plan) => [plan.source_lineage, plan.subset, plan.participation])).toEqual([
    ["one-piece-en", "complete", "required"],
    ["limitless-one-piece-en", "complete", "required"],
  ]);
  const bandai = requiredSourceAdapter("one-piece-en@6");
  const { plan: official } = await validateEvidencePlan({ ...composed.plans[0]!, idempotency_key: "composed-bandai" });
  expect(official.requests.map(({ id, url }) => ({ id, url }))).toEqual([
    { id: "one-piece-en:discovery", url: bandai.requestUrlForDiscovery!() },
  ]);
  expect(official.coverage).toEqual({ locale: "en", area: "catalogue", subset: "complete" });
  const { plan: limitless } = await validateEvidencePlan({
    ...composed.plans[1]!,
    idempotency_key: "composed-limitless",
  });
  expect(limitless.requests.map(({ id, url }) => ({ id, url }))).toEqual(
    fullScope.plans[0]!.requests.map(({ id, url }) => ({ id, url })),
  );
  expect(limitless.coverage).toEqual({ locale: "en", area: "catalogue", subset: "complete" });
});

test("each index root is a discovery role: no observations, one listing request per bucket row", async () => {
  const discovered = new Map<string, string[]>();
  for (const { capture, bytes } of roots) {
    const requestContext = { ...context(capture.url), requestId: `limitless-one-piece-en:${capture.id}` };
    expect(await adapter.parseBytes!(bytes, requestContext)).toEqual([]);
    const requests = adapter.discoverRequests!(bytes, requestContext);
    expect(requests.every((request) => request.role === "listing" && request.headers.accept === "text/html")).toBe(
      true,
    );
    discovered.set(
      capture.id,
      requests.map((request) => request.url),
    );
  }
  expect(discovered.get("limitless-products-index")).toHaveLength(58);
  expect(discovered.get("limitless-promos-index")).toHaveLength(85);
  const buckets = [...discovered.values()].flat();
  expect(new Set(buckets).size).toBe(143);
  expect([...new Set(buckets)].sort()).toEqual(census.per_bucket.map((bucket) => bucket.url).sort());
  // The Products root's own link to the Promos root is a sibling root, never a bucket.
  expect(buckets).not.toContain(`${origin}/cards/promos`);
});

test("each bucket is a discovery role yielding one detail request per grid link and no image", async () => {
  const captures = [
    ...verifiedCaptures(bucketPack),
    ...["st01-straw-hat-crew", "op16-the-time-of-battle"].map((slug) => {
      const bytes = readFileSync(new URL(`limitless-${slug.split("-")[0]}-list.body`, pilotPack));
      return { capture: { id: slug, url: `${origin}/cards/${slug}` } as Capture, bytes };
    }),
  ];
  expect(captures).toHaveLength(143);
  const details = new Set<string>();
  for (const { capture, bytes } of captures) {
    const requestContext = { ...context(capture.url), requestId: `limitless-one-piece-en:listing:${capture.id}` };
    expect(await adapter.parseBytes!(bytes, requestContext)).toEqual([]);
    const requests = adapter.discoverRequests!(bytes, requestContext);
    const expected = census.per_bucket.find((bucket) => bucket.url === capture.url);
    if (expected) expect(requests, capture.url).toHaveLength(expected.unique_grid_links);
    for (const request of requests) {
      expect(request).toMatchObject({ role: "detail", headers: html });
      expect(request.url).toMatch(
        /^https:\/\/onepiece\.limitlesstcg\.com\/cards\/[A-Z0-9]+-[0-9]+(?:\?v=[1-9][0-9]*)?$/u,
      );
      details.add(request.url);
    }
  }
  // The Flame-Flame Fruit Coliseum bucket serves an empty grid: it discovers nothing and fails nothing.
  expect(
    adapter.discoverRequests!(
      captures.find(({ capture }) => capture.id === "bucket-058")!.bytes,
      context(`${origin}/cards/premium-card-collection-flame-flame-fruit-coliseum`),
    ),
  ).toEqual([]);
  expect(details.size).toBe(4_707);
});

test("the discovered graph fits the registered envelope with the twenty Japanese-only fronts left unrequested", () => {
  const grids = verifiedCaptures(bucketPack).map(({ bytes }) => bytes.toString("utf8"));
  grids.push(
    readFileSync(new URL("limitless-st01-list.body", pilotPack), "utf8"),
    readFileSync(new URL("limitless-op16-list.body", pilotPack), "utf8"),
  );
  const fronts = new Set<string>();
  for (const grid of grids)
    for (const [, url] of grid.matchAll(/src="(https:\/\/limitlesstcg\.nyc3\.cdn\.digitaloceanspaces\.com\/[^"]+)"/gu))
      fronts.add(url!);
  const english = [...fronts].filter((url) => url.endsWith("_EN.webp"));
  expect(fronts.size).toBe(4_707);
  expect(fronts.size - english.length).toBe(20);
  expect(2 + 143 + 4_707 + english.length).toBeLessThanOrEqual(adapter.requestCapacity);
});

test("a bucket-linked detail page parses identically to the named pilot page", async () => {
  const bytes = readFileSync(new URL("limitless-op16-002.body", pilotPack));
  const fromBucket = { ...context(`${origin}/cards/OP16-002`), requestId: "limitless-one-piece-en:detail:abc" };
  const fromPilot = { ...context(`${origin}/cards/OP16-002`), requestId: "limitless-one-piece-en:op16-002-catalogue" };
  expect(await adapter.parseBytes!(bytes, fromBucket)).toEqual(await adapter.parseBytes!(bytes, fromPilot));
  expect(adapter.discoverRequests!(bytes, fromBucket)).toEqual([
    {
      role: "image",
      url: "https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/one-piece/OP16/OP16-002_EN.webp",
      headers: { accept: "image/webp" },
    },
  ]);
});

test("any English card number parses through the same selectors, not a named allow-list", async () => {
  const original = readFileSync(new URL("limitless-op16-002.body", pilotPack), "utf8");
  const renumbered = original.replaceAll("OP16-002", "OP16-099");
  expect(renumbered).not.toBe(original);
  const observations = await adapter.parseBytes!(
    new TextEncoder().encode(renumbered),
    context(`${origin}/cards/OP16-099`),
  );
  expect(observations).toEqual([
    expect.objectContaining({
      card: expect.objectContaining({ official_identity: { kind: "card_number", value: "OP16-099" } }),
      identity_evidence: expect.objectContaining({ locator: `${origin}/cards/en/OP16-099` }),
    }),
  ]);
  await expect(
    Promise.resolve().then(() =>
      adapter.parseBytes!(new TextEncoder().encode(original), context(`${origin}/cards/OP16-099`)),
    ),
  ).rejects.toThrow("Limitless page and card identifier disagree");
});

test("multi-colour and multi-attribute cards keep every listed value", async () => {
  const original = readFileSync(new URL("limitless-op16-002.body", pilotPack), "utf8");
  const dual = original
    .replace('<span data-tooltip="Color">Red</span>', '<span data-tooltip="Color">Red/Green</span>')
    .replace('<span data-tooltip="Attribute">Ranged</span>', '<span data-tooltip="Attribute">Ranged/Slash</span>');
  expect(dual).not.toBe(original);
  const [observation] = await adapter.parseBytes!(new TextEncoder().encode(dual), context(`${origin}/cards/OP16-002`));
  expect(observation).toEqual(
    expect.objectContaining({
      card: expect.objectContaining({
        game_data: expect.objectContaining({
          attributes: expect.objectContaining({ colours: ["red", "green"], battle_attributes: ["ranged", "slash"] }),
        }),
      }),
    }),
  );
});

test("an absent block icon and an empty effect are retained as absent, not invented or fatal", async () => {
  const original = readFileSync(new URL("limitless-op16-002.body", pilotPack), "utf8");
  const stripped = original
    .replace(/<div class="regulation-mark">\s*Block 5<\/div>/u, "")
    .replace(
      /<div class="card-text-section">\s*\[On Play\][^<]*<\/div>/u,
      '<div class="card-text-section">\n    </div>',
    );
  expect(stripped).not.toBe(original);
  const [observation] = await adapter.parseBytes!(
    new TextEncoder().encode(stripped),
    context(`${origin}/cards/OP16-002`),
  );
  expect(observation).toEqual(
    expect.objectContaining({
      card: expect.objectContaining({
        game_data: expect.objectContaining({
          attributes: expect.objectContaining({ block_icons: [], effect_text: null, trigger_text: null }),
        }),
      }),
    }),
  );
});

test("a Japanese-only front is retained as evidence without an English Printing Image request", async () => {
  const original = readFileSync(new URL("limitless-op16-021-v1.body", pilotPack), "utf8");
  const japanese = original.replaceAll("OP16-021_p1_EN.webp", "OP16-021_p1_JP.webp");
  expect(japanese).not.toBe(original);
  const bytes = new TextEncoder().encode(japanese);
  const requestContext = context(`${origin}/cards/OP16-021?v=1`);
  const [observation] = (await adapter.parseBytes!(bytes, requestContext)) as [
    { appearance_evidence: { images: unknown[] }; source_sidecar: { unmapped_optional_fields: { value: unknown }[] } },
  ];
  expect(observation.appearance_evidence.images).toEqual([]);
  expect(observation.source_sidecar.unmapped_optional_fields.map((field) => field.value)).toContainEqual({
    label: "Front image language",
    value: "jp",
    url: "https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/one-piece/OP16/OP16-021_p1_JP.webp",
  });
  // A variant page never re-discovers its already requested base; without an
  // English front there is nothing else to request.
  expect(adapter.discoverRequests!(bytes, requestContext)).toEqual([]);
  const elsewhere = original.replaceAll("OP16-021_p1_EN.webp", "OP16-021_p1_FR.webp");
  await expect(
    Promise.resolve().then(() => adapter.parseBytes!(new TextEncoder().encode(elsewhere), requestContext)),
  ).rejects.toThrow("Limitless image is outside the declared source image authority");
});

test("a page whose active language is not English fails closed", async () => {
  const original = readFileSync(new URL("limitless-op16-002.body", pilotPack), "utf8");
  const japaneseActive = original
    .replace('<a class="active" href=/cards/en/OP16-002>English</a>', '<a class="" href=/cards/en/OP16-002>English</a>')
    .replace(
      '<a class="" href=/cards/jp/OP16-002>Japanese</a>',
      '<a class="active" href=/cards/jp/OP16-002>Japanese</a>',
    );
  expect(japaneseActive).not.toBe(original);
  await expect(
    Promise.resolve().then(() =>
      adapter.parseBytes!(new TextEncoder().encode(japaneseActive), context(`${origin}/cards/OP16-002`)),
    ),
  ).rejects.toThrow("Limitless page is not the English edition");
});

test("a bucket slug that is neither a card number nor a retained index root is still outside a card page", async () => {
  const bytes = readFileSync(new URL("limitless-op16-002.body", pilotPack));
  await expect(
    Promise.resolve().then(() => adapter.parseBytes!(bytes, context(`${origin}/cards/jp/OP16-002`))),
  ).rejects.toThrow("Limitless page is outside the declared source coverage");
  await expect(
    Promise.resolve().then(() => adapter.parseBytes!(bytes, context(`${origin}/cards/OP16-002/decklists`))),
  ).rejects.toThrow("Limitless page is outside the declared source coverage");
});
