import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters";

const adapter = requiredSourceAdapter("fusion-world-en@9");
const capture = JSON.parse(
  readFileSync(
    new URL(
      "../../acceptance/fixtures/retained-official-source/history/2026-09-09/fusion-world-products-dot-release.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const bytes = Buffer.from(capture.body_base64, "base64");
const context = { url: capture.source_url, mediaType: capture.content_type, requestId: "fusion-world-en:products" };

test("retained September Fusion products preserve a dot Release as unknown and retain its raw evidence", () => {
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(capture.body_sha256);
  expect(bytes.length).toBe(capture.full_body_size);
  const observations = adapter.parseBytes(bytes, context);
  const products = observations.flatMap((observation) => observation.product_release_catalogue?.products ?? []);
  expect(products.find((product) => product.name === "Premium Card Collection 03")?.releases[0]).toMatchObject({
    region: "unknown",
    date: { precision: "unknown", value: null },
    status: "announced",
  });
  expect(observations[0].source_sidecar.unmapped_optional_fields).toContainEqual({
    path: "source_sidecar.raw.official_surfaces[0].document.label_values.RELEASE",
    value: ".",
  });
});

test("Fusion product pagination stays in Product discovery through bounded page extraction", async () => {
  const { extractBoundedAdapterPage } = await import("../../src/catalogue/adapters/bounded-page-extraction");
  for (const slug of ["fusion-world-en-products-page2", "fusion-world-en-products-starter-tag"]) {
    const fixture = JSON.parse(
      readFileSync(new URL(`../../acceptance/fixtures/retained-official-source/${slug}.json`, import.meta.url), "utf8"),
    );
    const body = Buffer.from(fixture.body_base64, "base64");
    const extraction = await extractBoundedAdapterPage(
      adapter,
      async function* () {
        yield body.toString("utf8");
      },
      {
        url: fixture.source_url,
        mediaType: fixture.content_type,
        requestId: `fusion-world-en:listing:${"0".repeat(64)}`,
      },
    );
    const requests = [];
    for await (const request of extraction.requests) requests.push(request);
    expect(extraction.count).toBeGreaterThan(0);
    expect(
      requests.some(
        ({ role, url }) =>
          role === "product_detail" && url === "https://www.dbs-cardgame.com/fw/en/products/01_477.html",
      ),
    ).toBe(true);
    expect(requests.some(({ role, url }) => role === "listing" && new URL(url).pathname === "/fw/en/products/")).toBe(
      true,
    );
    expect(requests.some(({ url }) => new URL(url).pathname.startsWith("/fw/en/cardlist/"))).toBe(false);
  }
});

test("Fusion Release placeholders remain fail-closed beyond the exact retained dot vocabulary", () => {
  for (const value of ["..", "?"]) {
    const changed = bytes
      .toString("utf8")
      .replaceAll('<dd class="cardInfoTxt">.</dd>', `<dd class="cardInfoTxt">${value}</dd>`);
    expect(() => adapter.parseBytes(Buffer.from(changed), context)).toThrow("Unrecognized official Release date");
  }
});

test("an explicit Fusion Card search role cannot turn a Product page into Card discovery", () => {
  expect(() => adapter.discoverRequests(bytes, { ...context, requestId: "fusion-world-en:card-search" })).toThrow(
    "category discovery is unavailable",
  );
});

test("Fusion's retained playmat and Card set remains a Card-bearing Product in both listing and detail", () => {
  const title = "OFFICIAL PLAYMAT & CARD SET Limited Edition 02";
  const products = adapter
    .parseBytes(bytes, context)
    .flatMap((observation) => observation.product_release_catalogue?.products ?? []);
  expect(products.find((product) => product.name === title)?.releases[0]).toMatchObject({
    date: { precision: "unknown", value: null },
    status: "announced",
  });
  expect(products.some((product) => product.name.includes("SLEEVE"))).toBe(false);
  const detail = JSON.parse(
    readFileSync(
      new URL(
        "../../acceptance/fixtures/retained-official-source/history/2026-09-09/fusion-world-playmat-card-set.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const body = Buffer.from(detail.body_base64, "base64");
  expect(createHash("sha256").update(body).digest("hex")).toBe(detail.body_sha256);
  expect(body.toString("utf8")).toContain("<li>Card x 1</li>");
  const observations = adapter.parseBytes(body, {
    url: detail.source_url,
    mediaType: detail.content_type,
    requestId: `fusion-world-en:product_detail:${"0".repeat(64)}`,
  });
  expect(observations.flatMap((observation) => observation.product_release_catalogue?.products ?? [])).toContainEqual(
    expect.objectContaining({ name: title }),
  );
  const firstEdition = JSON.parse(
    readFileSync(
      new URL(
        "../../acceptance/fixtures/retained-official-source/history/2026-09-09/fusion-world-playmat-card-set-01.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const firstBytes = Buffer.from(firstEdition.body_base64, "base64");
  expect(createHash("sha256").update(firstBytes).digest("hex")).toBe(firstEdition.body_sha256);
  expect(firstBytes.toString("utf8")).toContain("<li>Card x 1</li>");
  expect(
    adapter
      .parseBytes(firstBytes, {
        url: firstEdition.source_url,
        mediaType: firstEdition.content_type,
        requestId: `fusion-world-en:product_detail:${"0".repeat(64)}`,
      })
      .flatMap((observation) => observation.product_release_catalogue?.products ?? []),
  ).toContainEqual(expect.objectContaining({ name: "OFFICIAL PLAYMAT & CARD SET Limited Edition 01" }));
});
