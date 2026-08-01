import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { resolve } from "node:path";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  timingSafeEqual,
} from "node:crypto";
import { defineConfig } from "vitest/config";
import {
  officialDiscoveryDefinitions,
  officialDiscoveryDocument,
  officialRawSurfacePayload,
} from "../../acceptance/fixtures/synthetic-official-source.mjs";
import {
  consumerProofMessage,
  credentialConsumerProofRequestHeader,
  type CredentialConsumerProofRequestClaims,
} from "../../src/credentials/consumer-proof";
import {
  contextualLegalityFixtureDocument,
  contextualLegalitySourceDocument,
  onePiecePolicySourceDocument,
} from "./test/contextual-legality-fixture";

const migrations = await readD1Migrations(
  resolve(import.meta.dirname, "../../migrations"),
);
const outboundRequestCounts = new Map<string, number>();
let digimonArtworkVariant:
  | "base"
  | "base-reencoded"
  | "no-artwork-id"
  | "alternate"
  | "alternate-two" = "base";
const ambiguousD1Tables = new Map<string, string>();
const unconfirmedD1Drops = new Set<string>();
const githubAppTestPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({
  type: "pkcs8",
  format: "pem",
}).toString();

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: resolve(import.meta.dirname, "wrangler.jsonc"),
      },
      miniflare: {
        d1Databases: ["LEGACY_DB"],
        serviceBindings: {
          API_CREDENTIAL_CONSUMER:
            apiCredentialConsumerTestResponse,
        },
        bindings: {
          ADMINISTRATION_KEY: "vitest-administration-key",
          ADMINISTRATION_KEY_REPLACEMENT:
            "vitest-administration-key-replacement-slot",
          ADMINISTRATION_CLOCK_MODE: "request",
          CREDENTIAL_BOUNDARY_ATTESTATION_KEY:
            "vitest-boundary-attestation-key",
          CREDENTIAL_CONSUMER_PROOF_KEY:
            "vitest-consumer-proof-key",
          CLOUDFLARE_OBSERVATION_TOKEN:
            "vitest-cloudflare-observation-token",
          GITHUB_APP_PRIVATE_KEY: githubAppTestPrivateKey,
          GITHUB_OBSERVATION_ACTOR: "keepr-rotation[bot]",
          D1_VERIFICATION_TOKEN:
            "vitest-d1-verification-token-active",
          D1_VERIFICATION_TOKEN_REPLACEMENT:
            "vitest-d1-verification-token-replacement",
          GITHUB_REPOSITORY_ID: "1313489088",
          GITHUB_APP_ID: "11111111",
          GITHUB_INSTALLATION_ID: "22222222",
          GITHUB_ENVIRONMENT_ID: "33333333",
          GITHUB_WORKFLOW_ID: "44444444",
          TEST_MIGRATIONS: migrations,
        },
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (
            url.hostname === "api.cloudflare.com" &&
            url.pathname.endsWith("/query")
          ) {
            const body = await request.clone().json<{
              sql?: string;
              params?: string[];
            }>();
            const table = /"(__keepr_probe_[0-9a-f]+)"/u.exec(
              body.sql ?? "",
            )?.[1];
            const owner = body.params?.[0];
            if (
              body.sql?.startsWith("CREATE TABLE") &&
              table !== undefined &&
              typeof owner === "string" &&
              ["8".repeat(64), "9".repeat(64)].includes(
                owner,
              )
            ) {
              ambiguousD1Tables.set(table, owner);
              if (owner === "9".repeat(64)) {
                throw new Error("CREATE response lost after apply");
              }
              return Response.json({
                success: true,
                result: [{ success: true }],
              });
            }
            if (
              body.sql?.startsWith("SELECT owner") &&
              table !== undefined &&
              ambiguousD1Tables.has(table)
            ) {
              return Response.json({
                success: true,
                result: [{
                  success: true,
                  results: [{
                    owner: ambiguousD1Tables.get(table),
                  }],
                }],
              });
            }
            if (
              body.sql?.startsWith("DROP TABLE") &&
              table !== undefined &&
              ambiguousD1Tables.has(table)
            ) {
              const storedOwner = ambiguousD1Tables.get(table);
              if (storedOwner === "8".repeat(64)) {
                ambiguousD1Tables.delete(table);
                unconfirmedD1Drops.add(table);
                throw new Error("DROP response lost after apply");
              }
              if (storedOwner !== "9".repeat(64)) {
                return Response.json(
                  { success: false, errors: [{ code: 9000 }] },
                  { status: 500 },
                );
              }
              ambiguousD1Tables.delete(table);
              return Response.json({
                success: true,
                result: [{ success: true }],
              });
            }
            if (
              body.sql?.startsWith(
                "SELECT name FROM sqlite_schema",
              )
            ) {
              const inspected = body.params?.[0] ?? "";
              if (unconfirmedD1Drops.delete(inspected)) {
                return Response.json(
                  { success: false, errors: [{ code: 9000 }] },
                  { status: 500 },
                );
              }
              return Response.json({
                success: true,
                result: [{
                  success: true,
                  results: ambiguousD1Tables.has(inspected)
                    ? [{ name: inspected }]
                    : [],
                }],
              });
            }
            if (body.sql?.startsWith("CREATE TABLE")) {
              if (table !== undefined && owner !== undefined) {
                ambiguousD1Tables.set(table, owner);
              }
              return Response.json({
                success: true,
                result: [{ success: true }],
              });
            }
            return Response.json(
              { success: false, errors: [{ code: 9000 }] },
              { status: 500 },
            );
          }
          if (url.hostname === "api.cloudflare.com") {
            const accountId =
              "0123456789abcdef0123456789abcdef";
            if (url.pathname.endsWith("/secrets")) {
              const expected = JSON.parse(
                request.headers.get(
                  "x-keepr-observation-expected-secrets",
                ) ?? "[]",
              ) as Array<{ name: string; status: string }>;
              return Response.json({
                success: true,
                result: expected
                  .filter((item) => item.status === "usable")
                  .map((item) => ({ name: item.name })),
              });
            }
            if (
              request.headers.get(
                "x-keepr-observation-expected-status",
              ) === "unusable"
            ) {
              return Response.json(
                { success: false, errors: [{ code: 1000 }] },
                { status: 404 },
              );
            }
            const issuerId = decodeURIComponent(
              url.pathname.split("/").at(-1) ?? "",
            );
            const permissions = request.headers.get(
              "x-keepr-observation-required-permissions",
            )?.split(",") ??
              [request.headers.get(
                "x-keepr-observation-required-permission",
              ) ?? ""];
            return Response.json({
              success: true,
              result: {
                id: issuerId,
                status: "active",
                policies: [{
                  effect: "allow",
                  permission_groups: permissions.map(
                    (name) => ({ name }),
                  ),
                  resources: {
                    [`com.cloudflare.api.account.${accountId}`]:
                      "*",
                  },
                }],
              },
            });
          }
          if (url.hostname === "api.github.com") {
            const permissions = {
              actions: "write",
              contents: "read",
              environments: "write",
              metadata: "read",
            };
            if (url.pathname === "/app/installations/22222222") {
              return Response.json({
                id: 22222222,
                repository_selection: "selected",
                permissions,
              });
            }
            if (url.pathname.endsWith("/access_tokens")) {
              return Response.json({
                token: "vitest-exact-installation-observation-token",
                permissions,
                repositories: [{ id: 1313489088 }],
              });
            }
            if (url.pathname === "/installation/repositories") {
              return Response.json({
                repository_selection: "selected",
                total_count: 1,
                repositories: [{ id: 1313489088 }],
              });
            }
            if (url.pathname === "/graphql") {
              return Response.json({
                data: {
                  viewer: { login: "keepr-rotation[bot]" },
                },
              });
            }
            if (url.pathname === "/repositories/1313489088") {
              return Response.json({ id: 1313489088 });
            }
            if (
              url.pathname ===
              "/repos/KeeprDigital/card-keepr/environments/production"
            ) {
              return Response.json({ id: 33333333 });
            }
            if (
              url.pathname ===
              "/repos/KeeprDigital/card-keepr/actions/workflows/44444444"
            ) {
              return Response.json({
                id: 44444444,
                path:
                  ".github/workflows/production-release.yml",
                state: "active",
              });
            }
            if (url.pathname.endsWith("/git/ref/heads/main")) {
              return Response.json({
                object: { sha: "d".repeat(40) },
              });
            }
            if (url.pathname.endsWith("/runs")) {
              const titles = JSON.parse(
                request.headers.get(
                  "x-keepr-observation-run-titles",
                ) ?? "[]",
              ) as string[];
              const startedAt =
                request.headers.get(
                  "x-keepr-observation-started-at",
                ) ?? "2026-07-29T00:00:00.000Z";
              return Response.json({
                workflow_runs: titles.map((displayTitle, index) => ({
                  id: index + 1,
                  workflow_id: 44444444,
                  event: "workflow_dispatch",
                  display_title: displayTitle,
                  head_sha: "d".repeat(40),
                  created_at: startedAt,
                  status: "completed",
                  conclusion: "success",
                  actor: { login: "keepr-rotation[bot]" },
                })),
              });
            }
            return new Response("unknown GitHub observation", {
              status: 404,
            });
          }
          if (
            url.hostname.endsWith("cardgame.com") ||
            url.hostname.endsWith("digimoncard.com") ||
            url.hostname.endsWith("gundam-gcg.com")
          ) {
            const artworkMarker = request.headers.get("user-agent");
            if (
              artworkMarker === "card-keepr-nonempty-legality-sidecar" &&
              url.hostname === "www.dbs-cardgame.com" &&
              url.pathname === "/fw/en/rules/banned-limited-cards/"
            ) {
              return new Response(
                `<html>
                  <title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
                  <article>FB30-001 is eligible for Standard play.</article>
                </html>`,
                {
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    etag: '"nonempty-legality-sidecar"',
                  },
                },
              );
            }
            if (
              (artworkMarker === "card-keepr-representable-legality-v3" ||
                artworkMarker === "card-keepr-unrepresentable-legality-v3") &&
              url.hostname === "www.dbs-cardgame.com" &&
              url.pathname === "/fw/en/rules/banned-limited-cards/"
            ) {
              const officialWording = artworkMarker ===
                  "card-keepr-representable-legality-v3"
                ? "FB01-001 is eligible for Standard tournament play."
                : "FB01-001 appears on opaque publication XQZ-17.";
              return new Response(
                `<html>
                  <title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
                  <main>
                    <p>1 record</p>
                    <article class="restriction-card">
                      <dl>
                        <dt>Rule Ref</dt><dd>fw_production_eligible</dd>
                        <dt>Notice</dt><dd>${officialWording}</dd>
                        <dt>Market</dt><dd>EN-OCEANIA</dd>
                        <dt>Play Format</dt><dd>standard</dd>
                        <dt>Tier</dt><dd>-</dd>
                        <dt>Active On</dt><dd>2026-01-01</dd>
                        <dt>Expires On</dt><dd>-</dd>
                        <dt>Cards</dt><dd>FB01-001</dd>
                        <dt>Directive</dt><dd>eligible</dd>
                      </dl>
                    </article>
                  </main>
                </html>`,
                {
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    etag: `"${artworkMarker}"`,
                  },
                },
              );
            }
            if (
              url.hostname === "www.dbs-cardgame.com" &&
              url.pathname === "/fw/en/products/" &&
              artworkMarker === "card-keepr-product-authority"
            ) {
              return new Response(
                `<html>
                  <title>BANDAI DRAGON BALL CARD PRODUCTS RELEASE</title>
                  <article class="booster">
                    <a data-product-code="FB-AUTHORITY"
                       href="/fw/en/products/booster/fb-authority/">
                      Conflicting Product Listing
                    </a>
                  </article>
                </html>`,
                {
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    etag: '"product-authority-listing"',
                  },
                },
              );
            }
            if (
              url.hostname === "www.dbs-cardgame.com" &&
              url.pathname === "/fw/en/products/" &&
              artworkMarker?.startsWith("card-keepr-product-identity-")
            ) {
              const state = artworkMarker.slice(
                "card-keepr-product-identity-".length,
              );
              const code = state === "codeless"
                ? ""
                : "FB-STABLE";
              return new Response(
                `<html>
                  <title>BANDAI DRAGON BALL CARD PRODUCTS RELEASE</title>
                  <article class="booster">
                    <a ${code === "" ? "" : `data-product-code="${code}"`}
                       href="/fw/en/products/booster/fb-stable-${state}/">
                      Stable Product Identity
                    </a>
                  </article>
                </html>`,
                {
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    etag: `"product-identity-${state}-listing"`,
                  },
                },
              );
            }
            if (
              url.hostname === "www.dbs-cardgame.com" &&
              url.pathname === "/fw/en/products/booster/fb-authority/"
            ) {
              return new Response(
                `<html>
                  <h1>Authoritative Product Detail</h1>
                  <dl>
                    <dt>Product Code</dt><dd>FB-AUTHORITY</dd>
                  </dl>
                </html>`,
                {
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    etag: '"product-authority-detail"',
                  },
                },
              );
            }
            if (
              url.hostname === "www.dbs-cardgame.com" &&
              url.pathname.startsWith(
                "/fw/en/products/booster/fb-stable-",
              )
            ) {
              const state = url.pathname.match(
                /fb-stable-(coded|codeless)/u,
              )?.[1];
              const code = state === "codeless"
                ? ""
                : "FB-STABLE";
              return new Response(
                `<html>
                  <h1>Stable Product Identity</h1>
                  ${
                    code === ""
                      ? ""
                      : `<dl><dt>Product Code</dt><dd>${code}</dd></dl>`
                  }
                </html>`,
                {
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    etag: `"product-identity-${state}-detail"`,
                  },
                },
              );
            }
            if (
              url.hostname === "world.digimoncard.com" &&
              url.pathname === "/cards/index.php" &&
              artworkMarker === "card-keepr-product-fuzzy-warning"
            ) {
              return new Response(
                `<html><title>BANDAI DIGIMON CARD publication</title>
                  <main><article>
                    <a href="/cards/detail.php?card=BT99-999">
                      Fuzzy Product Link Test
                    </a>
                  </article></main></html>`,
                {
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    etag: '"digimon-product-fuzzy-list"',
                  },
                },
              );
            }
            if (
              url.hostname === "world.digimoncard.com" &&
              url.pathname === "/cards/detail.php" &&
              url.searchParams.get("card") === "BT99-999"
            ) {
              return new Response(
                `<html data-card-id="BT99-999">
                  <h1>Fuzzy Product Link Test</h1>
                  <dl><dt>Card Number</dt><dd>BT99-999</dd></dl>
                  <dl><dt>Card Type</dt><dd>Digimon</dd></dl>
                  <dl><dt>Color</dt><dd>Blue</dd></dl>
                  <dl><dt>Level</dt><dd>4</dd></dl>
                  <dl><dt>Play Cost</dt><dd>5</dd></dl>
                  <dl><dt>DP</dt><dd>6,000</dd></dl>
                  <dl><dt>Effect</dt><dd>Fuzzy link test effect</dd></dl>
                  <dl><dt>Alternative Art</dt><dd>No</dd></dl>
                  <a class="product-link"
                     href="/products/possible-booster/">
                    Possible Booster Product
                  </a>
                  <img class="card-image"
                    src="https://images.digimoncard.com/cards/BT99-999-fuzzy.png">
                </html>`,
                {
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    etag: '"digimon-product-fuzzy-detail"',
                  },
                },
              );
            }
            if (
              url.hostname === "images.digimoncard.com" &&
              url.pathname === "/cards/BT99-999-fuzzy.png"
            ) {
              return new Response(
                new Uint8Array([
                  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
                  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
                  0x08, 0x06, 0x00, 0x00, 0x00,
                ]),
                {
                  headers: {
                    "content-type": "image/png",
                    etag: '"digimon-product-fuzzy-image"',
                  },
                },
              );
            }
            if (
              url.hostname === "world.digimoncard.com" &&
              url.pathname === "/cards/index.php" &&
              artworkMarker?.startsWith("card-keepr-artwork-digest-")
            ) {
              digimonArtworkVariant =
                artworkMarker.endsWith("base-reencoded")
                  ? "base-reencoded"
                  : artworkMarker.endsWith("no-artwork-id")
                    ? "no-artwork-id"
                    : artworkMarker.endsWith("alternate-two")
                      ? "alternate-two"
                      : artworkMarker.endsWith("alternate")
                        ? "alternate"
                        : "base";
              return new Response(
                `<html><title>BANDAI DIGIMON CARD publication</title>
                  <main><article>
                    <a href="/cards/detail.php?card=BT99-900">
                      Test Digimon detail
                    </a>
                  </article></main></html>`,
                {
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    etag: `"digimon-artwork-list-${digimonArtworkVariant}"`,
                  },
                },
              );
            }
            if (
              url.hostname === "world.digimoncard.com" &&
              url.pathname === "/cards/detail.php" &&
              url.searchParams.get("card") === "BT99-900"
            ) {
              const locator =
                digimonArtworkVariant === "alternate"
                  ? "BT99-900_alt"
                  : digimonArtworkVariant === "alternate-two"
                    ? "BT99-900_alt_two"
                    : digimonArtworkVariant === "no-artwork-id"
                      ? "BT99-900_locator"
                      : "BT99-900";
              const artworkId =
                digimonArtworkVariant === "alternate"
                    ? ' data-artwork-id="digimon-bt99-900-alt-one"'
                    : digimonArtworkVariant === "alternate-two"
                      ? ' data-artwork-id="digimon-bt99-900-alt-two"'
                      : "";
              return new Response(
                `<html data-card-id="${locator}"${artworkId}>
                  <h1>Digest Test Digimon</h1>
                  <dl><dt>Card Number</dt><dd>BT99-900</dd></dl>
                  <dl><dt>Card Type</dt><dd>Digimon</dd></dl>
                  <dl><dt>Color</dt><dd>Blue</dd></dl>
                  <dl><dt>Level</dt><dd>4</dd></dl>
                  <dl><dt>Play Cost</dt><dd>5</dd></dl>
                  <dl><dt>DP</dt><dd>6,000</dd></dl>
                  <dl><dt>Effect</dt><dd>Digest test effect</dd></dl>
                  <dl><dt>Alternative Art</dt><dd>${
                    digimonArtworkVariant === "alternate" ||
                      digimonArtworkVariant === "alternate-two"
                      ? "Yes"
                      : "No"
                  }</dd></dl>
                  <img class="card-image"
                    src="https://images.digimoncard.com/cards/BT99-900.png">
                </html>`,
                {
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    etag: `"digimon-artwork-detail-${digimonArtworkVariant}"`,
                  },
                },
              );
            }
            if (
              url.hostname === "images.digimoncard.com" &&
              url.pathname === "/cards/BT99-900.png"
            ) {
              const bytes = new Uint8Array([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
                0x00, 0x00, 0x00,
                digimonArtworkVariant === "base-reencoded" ? 0x02 : 0x01,
                0x00, 0x00, 0x00,
                digimonArtworkVariant === "base-reencoded" ? 0x02 : 0x01,
                digimonArtworkVariant === "alternate"
                  ? 0x02
                  : digimonArtworkVariant === "alternate-two"
                    ? 0x04
                    : digimonArtworkVariant === "no-artwork-id"
                      ? 0x03
                      : 0x01,
              ]);
              return new Response(bytes, {
                headers: {
                  "content-type": "image/png",
                  etag: `"digimon-artwork-image-${digimonArtworkVariant}"`,
                },
              });
            }
            return new Response(
              `<html><title>Official Bandai CARD PRODUCT RELEASE RULE ERRATA RESTRICTION publication</title><main>${
                url.pathname === "/fw/en/rules/banned-limited-cards/"
                  ? "<p>0 records</p>"
                  : ""
              }<article data-publication-empty="true">No published entries.</article></main></html>`,
              {
                headers: {
                  "content-type": "text/html; charset=utf-8",
                  etag: `"official-${url.pathname.replaceAll("/", "-")}"`,
                },
              },
            );
          }
          if (!url.hostname.endsWith("official-source.invalid")) {
            return new Response("unknown synthetic Official Source", {
              status: 404,
            });
          }
          if (url.pathname === "/cards") {
            return new Response(
              '{"cards":[{"card_number":"OP01-001","name":"Roronoa Zoro"}]}',
              {
                headers: {
                  "content-type": "application/json; charset=utf-8",
                  etag: '"cards-v1"',
                },
              },
            );
          }
          if (url.pathname === "/raw-one-piece-products") {
            return Response.json(
              officialDiscoveryDocument(
                officialDiscoveryDefinitions["/raw-one-piece-products"],
              ),
            );
          }
          const rawSurface = officialRawSurfacePayload(url.pathname);
          if (rawSurface !== null) {
            const surface = url.pathname.slice(
              url.pathname.lastIndexOf("/") + 1,
            );
            if (
              url.searchParams.get("failure") === "cap" &&
              surface === "card-list"
            ) {
              (
                rawSurface.page_info as Record<string, unknown>
              ).cap_signal = "Too many search results";
            }
            if (
              url.searchParams.get("failure") === "pagination" &&
              surface === "card-list"
            ) {
              const page =
                (
                  (rawSurface.page_info as Record<string, unknown>)
                    .partitions as Array<Record<string, unknown>>
                )[0]!;
              page.pages = 2;
              page.has_next = true;
            }
            const html = [
              "card-list",
              "card-search",
              "packages",
              "products",
            ].includes(surface);
            return new Response(
              html
                ? `<script type="application/json" data-keepr-official-payload>${
                  JSON.stringify(rawSurface)
                }</script>`
                : JSON.stringify(rawSurface),
              {
                headers: {
                  "content-type": html ? "text/html" : "application/json",
                },
              },
            );
          }
          if (
            url.pathname ===
            "/reconciliation/production-profile-fusion-world"
          ) {
            const document = officialDiscoveryDocument(
              officialDiscoveryDefinitions["/raw-fusion-world-products"],
            ) as { detail_pages: Array<Record<string, unknown>> };
            Object.assign(document.detail_pages[0]!, {
              printing: {
                rarity: "C",
                normalizedRarity: "common",
                attributes: {},
              },
              printed_rules: "Official printed rules",
              variant: "base",
              artwork_fingerprint: `sha256:${"a".repeat(64)}`,
              printed_fields_digest: `sha256:${"b".repeat(64)}`,
              image:
                "https://official-source.invalid/images/FB99-001.png",
            });
            return Response.json(
              document,
            );
          }
          const reconciliationAt =
            url.pathname.indexOf("/reconciliation/");
          if (reconciliationAt !== -1) {
            const scenario = url.pathname.slice(
              reconciliationAt + "/reconciliation/".length,
            );
            return Response.json(
              reconciliationSourceDocument(
                scenario,
                url.searchParams.get("surface") ?? "discovery",
                url.href,
              ),
            );
          }
          if (url.pathname === "/redirect") {
            return new Response(null, {
              status: 302,
              headers: {
                location: "https://official-source.invalid/cards",
              },
            });
          }
          if (url.pathname === "/unavailable") {
            return new Response("temporarily unavailable", {
              status: 503,
              headers: { "retry-after": "0" },
            });
          }
          if (url.pathname === "/conditional") {
            if (request.headers.get("if-none-match") === '"conditional-v1"') {
              return new Response(null, {
                status: 304,
                headers: { etag: '"conditional-v1"' },
              });
            }
            return new Response('{"cards":[{"card_number":"OP02-001"}]}', {
              headers: {
                "content-type": "application/json",
                etag: '"conditional-v1"',
                vary: "accept-language",
              },
            });
          }
          if (url.pathname === "/retry-after-long") {
            return new Response("temporarily unavailable", {
              status: 503,
              headers: { "retry-after": "120" },
            });
          }
          if (url.pathname === "/retry-once") {
            const key = `${url.hostname}${url.pathname}`;
            const count = (outboundRequestCounts.get(key) ?? 0) + 1;
            outboundRequestCounts.set(key, count);
            if (count === 1) {
              return new Response("temporarily unavailable", {
                status: 503,
                headers: { "retry-after": "2" },
              });
            }
            return new Response(
              '{"cards":[{"card_number":"OP01-002","name":"Retry Card"}]}',
              { headers: { "content-type": "application/json" } },
            );
          }
          if (url.pathname === "/large-json") {
            return new Response(
              JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
              { headers: { "content-type": "application/json" } },
            );
          }
          if (url.pathname === "/huge-json") {
            return new Response(
              JSON.stringify({
                padding: "x".repeat(33 * 1024 * 1024),
              }),
              {
                headers: { "content-type": "application/json" },
              },
            );
          }
          if (url.pathname === "/body-failure") {
            return new Response('{"cards":[]}', {
              headers: {
                "content-length": "invalid",
                "content-type": "application/json",
              },
            });
          }
          if (url.pathname.startsWith("/sequence/")) {
            return new Response(
              `{"cards":[{"sequence":"${url.hostname}${url.pathname}"}]}`,
              { headers: { "content-type": "application/json" } },
            );
          }
          if (url.pathname === "/invalid-json") {
            return new Response("<html>not JSON</html>", {
              headers: { "content-type": "text/html" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      },
    }),
  ],
  test: {
    include: ["apps/ingestion/test/**/*.spec.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});

function reconciliationSourceDocument(
  scenario: string,
  surface: string,
  requestUrl: string,
) {
  if (scenario === "contextual-legality-one-piece-policy") {
    return onePiecePolicySourceDocument(surface, requestUrl);
  }
  if (scenario === "contextual-legality-cross-game-envelope") {
    return contextualLegalitySourceDocument("EN-ASIA", surface, requestUrl);
  }
  if (scenario.startsWith("contextual-legality-representative-")) {
    return representativeRawSourceDocument(
      officialGame(requestUrl),
      surface,
      requestUrl,
    );
  }
  if (scenario === "contextual-legality-empty-oceania") {
    return emptyOfficialCatalogueDocument(
      "EN-OCEANIA",
      surface,
      requestUrl,
    );
  }
  if (scenario === "contextual-legality-empty-one-piece") {
    return emptyOfficialCatalogueDocument(
      "EN-OCEANIA",
      surface,
      requestUrl,
      "complete",
      "one-piece",
    );
  }
  if (scenario === "contextual-legality-empty-asia") {
    return emptyOfficialCatalogueDocument("EN-ASIA", surface, requestUrl);
  }
  if (scenario === "contextual-legality-empty-us") {
    return emptyOfficialCatalogueDocument("EN-US", surface, requestUrl);
  }
  if (scenario === "contextual-legality-missing-rules") {
    return emptyOfficialCatalogueDocument(
      "EN-ASIA",
      surface,
      requestUrl,
      "missing",
    );
  }
  if (scenario === "contextual-legality-false-empty-rules") {
    return emptyOfficialCatalogueDocument(
      "EN-ASIA",
      surface,
      requestUrl,
      "false-empty",
    );
  }
  if (scenario === "contextual-legality-incomplete-discovery") {
    return emptyOfficialCatalogueDocument(
      "EN-ASIA",
      surface,
      requestUrl,
      "complete",
      "gundam",
      undefined,
      "missing",
    );
  }
  if (
    scenario === "contextual-legality-unknown-rule-wording" ||
    scenario === "contextual-legality-ordering-fixture-wording" ||
    scenario === "contextual-legality-serialization-golden-wording" ||
    scenario === "contextual-legality-mismatched-rule-wording" ||
    scenario === "contextual-legality-foreign-image-authority"
  ) {
    const document = contextualLegalitySourceDocument(
      "EN-ASIA",
      surface,
      requestUrl,
    ) as {
      gundam: {
        results: Record<string, unknown>[];
      };
    };
    const first = document.gundam.results[0];
    if (
      first !== undefined &&
      surface === "legality_rules" &&
      scenario === "contextual-legality-unknown-rule-wording"
    ) {
      first.text = "Opaque publisher marker XQZ-30.";
    }
    if (
      first !== undefined &&
      surface === "legality_rules" &&
      scenario === "contextual-legality-ordering-fixture-wording"
    ) {
      first.text = "This is an ordering fixture.";
    }
    if (
      first !== undefined &&
      surface === "legality_rules" &&
      scenario === "contextual-legality-serialization-golden-wording"
    ) {
      first.text = "Café serialization golden.";
    }
    if (
      first !== undefined &&
      surface === "legality_rules" &&
      scenario === "contextual-legality-mismatched-rule-wording"
    ) {
      first.text = "This card is banned and may not be included.";
    }
    if (
      first !== undefined &&
      surface === "legality_card_details" &&
      scenario === "contextual-legality-foreign-image-authority"
    ) {
      first.image_url = "https://attacker.example/images/GD30-001.png";
    }
    return document;
  }
  if (scenario === "contextual-legality-asia") {
    return contextualLegalitySourceDocument(
      "EN-ASIA",
      surface,
      requestUrl,
    );
  }
  if (scenario === "contextual-legality-domain") {
    const rules = new URL(requestUrl).searchParams.get("rules");
    return contextualLegalityFixtureDocument(
      "EN-ASIA",
      rules === "omitted" || rules === "empty" ||
          rules === "omit-event-tier" ||
          rules === "omit-effective-until" ||
          rules === "resolved-card-order" ||
          rules === "operand-overlap"
        ? rules
        : "current",
    );
  }
  if (scenario === "contextual-legality-domain-us") {
    const rules = new URL(requestUrl).searchParams.get("rules");
    return contextualLegalityFixtureDocument(
      "EN-US",
      rules === "omitted" || rules === "empty" ? rules : "current",
    );
  }
  if (scenario === "contextual-legality-us") {
    return contextualLegalitySourceDocument(
      "EN-US",
      surface,
      requestUrl,
    );
  }
  if (scenario === "complete-empty-lineage") {
    return { cards: [] };
  }
  const searchRepairRetention =
    /^search-repair-retention-([1-5])$/.exec(scenario);
  if (searchRepairRetention !== null) {
    const sequence = searchRepairRetention[1]!;
    return {
      cards: [
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: `OP98-00${sequence}`,
          name: `Search Repair Retention ${sequence}`,
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
          locator: `/official/search-repair-retention/${sequence}`,
          lineageMarker: `search-repair-retention-${sequence}`,
        }),
      ],
    };
  }
  if (
    scenario === "errata-card-rules-text" ||
    scenario === "errata-card-rules-text-v2" ||
    scenario === "errata-card-rules-text-longitudinal" ||
    scenario === "errata-card-rules-text-longitudinal-v2"
  ) {
    const isLongitudinal = scenario.includes("longitudinal");
    const isSecondVersion = scenario.endsWith("-v2");
    const observation = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: isLongitudinal ? "OP29-006" : "OP29-001",
      name: isLongitudinal
        ? "Longitudinal Errata Rules Card"
        : "Errata Rules Card",
      cardAttributes: {
        ...onePieceLeaderAttributes(),
        effect_text: "[On Play] Draw 1 card.",
      },
      printingAttributes: { illustration_types: [] },
      locator: isLongitudinal
        ? "/official/errata/OP29-006"
        : "/official/errata/OP29-001",
      lineageMarker: isLongitudinal
        ? "errata-card-rules-text-longitudinal"
        : "errata-card-rules-text",
      printedRulesText: "[On Play] Draw 1 card.",
    });
    return {
      cards: [
        {
          ...observation,
          card: {
            ...observation.card,
            effective_rules_text: "[On Play] Draw 1 card.",
          },
          errata: [
            {
              authority: "official_errata",
              field: "effective_rules_text",
              target_type: "card",
              effective_from: "2026-07-01",
              official_wording:
                isSecondVersion
                  ? isLongitudinal
                    ? 'For the longitudinal Card, replace the corrected "discard 1 card" with "discard 2 cards".'
                    : 'Replace the corrected "discard 1 card" with "discard 2 cards".'
                  : isLongitudinal
                    ? 'For the longitudinal Card, replace "Draw 1 card" with "Draw 2 cards, then discard 1 card".'
                  : 'Replace "Draw 1 card" with "Draw 2 cards, then discard 1 card".',
              corrected_value:
                isSecondVersion
                  ? "[On Play] Draw 2 cards, then discard 2 cards."
                  : "[On Play] Draw 2 cards, then discard 1 card.",
              ...(isSecondVersion
                ? { effective_from: "2026-07-15" }
                : {}),
            },
          ],
        },
      ],
    };
  }
  if (
    scenario === "gundam-errata-cross-lineage-asia" ||
    scenario === "gundam-errata-cross-lineage-us"
  ) {
    const observation = printingObservation({
      game: "gundam",
      profile: "gundam@1",
      cardNumber: "GD29-001",
      name: "Cross-lineage Errata Card",
      cardAttributes: {
        card_type: "unit",
        colours: ["blue"],
        level: 4,
        cost: 3,
        block_icon: "1",
        effect_text: "Printed cross-lineage rules.",
        zone: "space",
        traits: ["Earth Federation"],
        link_condition: null,
        ap: 3,
        hp: 4,
        series_titles: ["Mobile Suit Gundam"],
      },
      printingAttributes: { alternate_art: false },
      locator: `/official/gundam/${scenario}`,
      variantKey: "base",
      lineageMarker: "gundam-errata-cross-lineage",
      printedRulesText: "Printed cross-lineage rules.",
      memberships: {
        products: ["product_gd29"],
        distribution_contexts: [],
        source_buckets: ["gundam-card-list"],
      },
    });
    return {
      cards: [{
        ...observation,
        card: {
          ...observation.card,
          effective_rules_text: "Printed cross-lineage rules.",
        },
        errata: [{
          authority: "official_errata",
          field: "effective_rules_text",
          target_type: "card",
          effective_from: "2026-07-01",
          official_wording: "Use corrected cross-lineage rules.",
          corrected_value: "Corrected cross-lineage rules.",
        }],
      }],
    };
  }
  if (
    scenario === "gundam-current-run-errata-asia" ||
    scenario === "gundam-current-run-errata-us"
  ) {
    const isUs = scenario.endsWith("-us");
    const observation = printingObservation({
      game: "gundam",
      profile: "gundam@1",
      cardNumber: "GD29-002",
      name: "Current-run Errata Authority Card",
      cardAttributes: {
        card_type: "unit",
        colours: ["blue"],
        level: 4,
        cost: 3,
        block_icon: "1",
        effect_text: "Observed source field stays stable.",
        zone: "space",
        traits: ["Earth Federation"],
        link_condition: null,
        ap: 3,
        hp: 4,
        series_titles: ["Mobile Suit Gundam"],
      },
      printingAttributes: { alternate_art: false },
      locator: `/official/gundam/${scenario}`,
      variantKey: "base",
      lineageMarker: "gundam-current-run-errata",
      printedRulesText: "Printed history stays stable.",
      memberships: {
        products: ["product_gd29_current"],
        distribution_contexts: [],
        source_buckets: ["gundam-card-list"],
      },
    });
    return {
      cards: [{
        ...observation,
        card: {
          ...observation.card,
          effective_rules_text: isUs
            ? "Superseded US source rules."
            : "Superseded Asia source rules.",
        },
        ...(isUs
          ? {
              errata: [{
                authority: "official_errata",
                field: "effective_rules_text",
                target_type: "card",
                effective_from: "2026-07-01",
                official_wording:
                  "Use the authoritative current Card wording.",
                corrected_value: "Authoritative current Card wording.",
              }],
            }
          : {}),
      }],
    };
  }
  if (scenario === "errata-future-boundary") {
    const observation = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: "OP29-007",
      name: "Future Errata Card",
      cardAttributes: onePieceLeaderAttributes(),
      printingAttributes: { illustration_types: [] },
      locator: "/official/errata/OP29-007",
      lineageMarker: "errata-future-boundary",
      printedRulesText: "Rules before the future Erratum.",
    });
    return {
      cards: [{
        ...observation,
        card: {
          ...observation.card,
          effective_rules_text: "Rules before the future Erratum.",
        },
        errata: [{
          authority: "official_errata",
          field: "effective_rules_text",
          target_type: "card",
          effective_from: "2026-08-01",
          official_wording: "Use rules after the future boundary.",
          corrected_value: "Rules after the future boundary.",
        }],
      }],
    };
  }
  if (scenario === "errata-effective-scope") {
    const observation = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: "OP29-002",
      name: "Errata Scope Card",
      cardAttributes: {
        ...onePieceLeaderAttributes(),
        effect_text: "Observed Card Rules Text.",
      },
      printingAttributes: { illustration_types: [] },
      locator: "/official/errata/OP29-002",
      lineageMarker: "errata-effective-scope",
      printedRulesText: "Physical Printing Rules Text.",
    });
    return {
      cards: [
        {
          ...observation,
          card: {
            ...observation.card,
            effective_rules_text: "Observed Card Rules Text.",
          },
          errata: [
            {
              authority: "official_errata",
              field: "effective_rules_text",
              target_type: "card",
              effective_from: "2099-01-01",
              official_wording: "Future correction.",
              corrected_value: "Future Card Rules Text.",
            },
            {
              authority: "official_errata",
              field: "effective_rules_text",
              target_type: "printing",
              effective_from: "2026-07-01",
              official_wording:
                "Correction applies to this Printing only.",
              corrected_value: "Printing-scoped corrected wording.",
            },
          ],
        },
      ],
    };
  }
  if (
    scenario === "errata-conflicting-effective-text" ||
    scenario === "errata-null-effective-text"
  ) {
    const observation = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber:
        scenario === "errata-null-effective-text"
          ? "OP29-004"
          : "OP29-005",
      name:
        scenario === "errata-null-effective-text"
          ? "Removed Rules Text Card"
          : "Conflicting Errata Card",
      cardAttributes: {
        ...onePieceLeaderAttributes(),
        effect_text: "Printed and observed rules text.",
      },
      printingAttributes: { illustration_types: [] },
      locator: `/official/errata/${scenario}`,
      lineageMarker: scenario,
      printedRulesText: "Printed and observed rules text.",
    });
    const baseErratum = {
      authority: "official_errata",
      field: "effective_rules_text",
      target_type: "card",
      effective_from: "2026-07-01",
    };
    return {
      cards: [
        {
          ...observation,
          card: {
            ...observation.card,
            effective_rules_text: "Printed and observed rules text.",
          },
          errata:
            scenario === "errata-null-effective-text"
              ? [
                  {
                    ...baseErratum,
                    official_wording:
                      "Remove the rules text from this Card.",
                    corrected_value: null,
                  },
                ]
              : [
                  {
                    ...baseErratum,
                    official_wording: "Use conflicting wording A.",
                    corrected_value: "Conflicting wording A.",
                  },
                  {
                    ...baseErratum,
                    official_wording: "Use conflicting wording B.",
                    corrected_value: "Conflicting wording B.",
                  },
                ],
        },
      ],
    };
  }
  if (scenario === "errata-unrepresentable") {
    const observation = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: "OP29-003",
      name: "Unrepresentable Errata Card",
      cardAttributes: onePieceLeaderAttributes(),
      printingAttributes: { illustration_types: [] },
      locator: "/official/errata/OP29-003",
      lineageMarker: "errata-unrepresentable",
    });
    return {
      cards: [
        {
          ...observation,
          errata: [
            {
              authority: "official_errata",
              field: "effective_rules_text",
              target_type: "card",
              effective_from: "2026-07-01",
              official_wording:
                "Apply the updated timing described in the accompanying diagram.",
              corrected_value: {
                timing: "after the unspecified diagram event",
              },
            },
          ],
        },
      ],
    };
  }
  if (scenario === "errata-extra-property") {
    const observation = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: "OP29-008",
      name: "Unexpected Errata Field Card",
      cardAttributes: onePieceLeaderAttributes(),
      printingAttributes: { illustration_types: [] },
      locator: "/official/errata/OP29-008",
      lineageMarker: "errata-extra-property",
    });
    return {
      cards: [{
        ...observation,
        errata: [{
          authority: "official_errata",
          field: "effective_rules_text",
          target_type: "card",
          effective_from: "2026-07-01",
          official_wording: "Use the exact corrected wording.",
          corrected_value: "Exact corrected wording.",
          editorial_note: "This undeclared field is not authoritative.",
        }],
      }],
    };
  }
  if (scenario === "scale-1001-cards") {
    return {
      cards: Array.from({ length: 1_001 }, (_, index) => ({
        card: {
          game: "one-piece",
          official_identity: {
            kind: "card_number",
            value: `OP20-${String(index + 1).padStart(4, "0")}`,
          },
          name: `S${index + 1}`,
          effective_rules_text: `Scale-search rules ${index + 1}`,
          game_data: {
            profile: "one-piece@1",
            attributes: {
              card_type: "leader",
              colours: [],
              cost: null,
              life: 0,
              battle_attributes: [],
              power: null,
              counter: null,
              traits: [],
              block_icons: [],
              effect_text: deterministicNoise(index + 1, 9_000),
              trigger_text: null,
            },
          },
        },
        completeness: completeEvidence(),
        memberships: {
          products: [],
          distribution_contexts: [],
          source_buckets: [],
        },
      })),
    };
  }
  if (scenario === "legality-relationship-over-budget") {
    const cardNumbers = Array.from(
      { length: 1_001 },
      (_, index) => `OP31-${String(index + 1).padStart(4, "0")}`,
    );
    return {
      cards: cardNumbers.map((cardNumber, index) => ({
        card: {
          game: "one-piece",
          official_identity: {
            kind: "card_number",
            value: cardNumber,
          },
          name: `Relationship scale ${index + 1}`,
          effective_rules_text: null,
          game_data: {
            profile: "one-piece@1",
            attributes: onePieceLeaderAttributes(),
          },
        },
        completeness: completeEvidence(),
        memberships: {
          products: [],
          distribution_contexts: [],
          source_buckets: [],
        },
      })),
      legality_completeness: completeEvidence(17),
      legality_rules: Array.from({ length: 17 }, (_, index) => ({
        id: `relationship-scale-${String(index + 1).padStart(2, "0")}`,
        game: "one-piece",
        region: "EN-OCEANIA",
        format: "standard",
        event_tier: null,
        effective_from: "2026-01-01",
        effective_until: null,
        card_numbers: cardNumbers,
        official_wording: `Relationship scale rule ${index + 1}.`,
        effect: { type: "ban" },
        representable: true,
      })),
    };
  }
  if (scenario === "export-component-over-budget") {
    return {
      cards: Array.from({ length: 26 }, (_, index) =>
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: `OP30-${String(index + 100).padStart(3, "0")}`,
          name: `Export budget card ${index}`,
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
          locator: `export-budget-${index}`,
          lineageMarker: `export-budget-${index}`,
          printedRulesText: deterministicNoise(index + 1, 490_000),
          memberships: {
            products: [],
            distribution_contexts: [],
            source_buckets: ["export-budget"],
          },
        })
      ),
    };
  }
  if (scenario === "scale-1001-products") {
    return {
      cards: Array.from({ length: 1_001 }, (_, index) => {
        const sequence = String(index + 1).padStart(4, "0");
        const productCode = `SC-${sequence}`;
        const reference = {
          kind: "official_code",
          value: productCode,
        };
        return {
          card: {
            game: "one-piece",
            official_identity: {
              kind: "card_number",
              value: `OP21-${sequence}`,
            },
            name: `Scale card ${sequence}`,
            effective_rules_text: "Scale export rule.",
            game_data: {
              profile: "one-piece@1",
              attributes: {
                card_type: "leader",
                colours: [],
                cost: null,
                life: 0,
                battle_attributes: [],
                power: null,
                counter: null,
                traits: [],
                block_icons: [],
                effect_text: null,
                trigger_text: null,
              },
            },
          },
          completeness: completeEvidence(),
          memberships: {
            products: [],
            distribution_contexts: [],
            source_buckets: [],
          },
          product_release_catalogue: {
            products: [
              {
                reference,
                official_code: productCode,
                name: `Scale Product ${sequence} ${deterministicNoise(index + 1, 3_800)}`,
                releases: [
                  {
                    region: "EN-OCEANIA",
                    date: { precision: "month", value: "2026-12" },
                    status: "announced",
                  },
                ],
              },
            ],
            distribution_contexts: [
              {
                key: `scale-context-${sequence}`,
                kind: "promotion",
                label: `Scale Context ${sequence} ${deterministicNoise(index + 2_000, 3_800)}`,
                product_reference: reference,
                evidence_category: "explicit",
              },
            ],
            relationships: [],
          },
        };
      }),
    };
  }
  if (
    scenario === "dedicated-printing-erratum" ||
    scenario === "dedicated-printing-erratum-ambiguous" ||
    scenario === "dedicated-printing-erratum-missing"
  ) {
    const locator = scenario === "dedicated-printing-erratum"
      ? "/official/dedicated-multi/base"
      : scenario === "dedicated-printing-erratum-ambiguous"
        ? "/official/multi/shared"
        : "/official/multi/missing";
    return {
      cards: [{
        kind: "official_erratum",
        game: "one-piece",
        target: {
          type: "printing",
          official_identity: {
            kind: "card_number",
            value: scenario === "dedicated-printing-erratum"
              ? "OP05-006"
              : "OP05-005",
          },
          locator,
        },
        published_on: "2026-07-31",
        effective_from: null,
        observed_printed_rules_text: "Official printed rules",
        corrected_rules_text: "Printing-scoped corrected rules",
        official_wording:
          "Before: Official printed rules\nAfter: Printing-scoped corrected rules",
        applies_to_parallel_printings: false,
        source: {
          fragment: "#errata_fixture_printing",
          display_name: scenario === "dedicated-printing-erratum"
            ? "OP05-006 Dedicated Printing Erratum Card"
            : "OP05-005 Multiple Printing Card",
          image_url:
            `https://en.onepiece-cardgame.com/images/rules/cards/${
              scenario === "dedicated-printing-erratum"
                ? "OP05-006"
                : "OP05-005"
            }.png`,
        },
        completeness: completeEvidence(),
      }],
    };
  }
  if (
    scenario === "dedicated-printing-erratum-seed" ||
    scenario === "multi-printing" ||
    scenario === "multi-printing-shared-locator"
  ) {
    const sharedLocator = scenario === "multi-printing-shared-locator";
    const dedicated = scenario === "dedicated-printing-erratum-seed";
    const base = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: dedicated ? "OP05-006" : "OP05-005",
      name: dedicated
        ? "Dedicated Printing Erratum Card"
        : "Multiple Printing Card",
      cardAttributes: onePieceLeaderAttributes(),
      printingAttributes: { illustration_types: [] },
      locator: sharedLocator
        ? "/official/multi/shared"
        : dedicated
          ? "/official/dedicated-multi/base"
          : "/official/multi/base",
      ...(sharedLocator ? { variantKey: "base" } : {}),
      lineageMarker: dedicated ? "dedicated-multi-base" : "multi-base",
    });
    return {
      cards: [
        base,
        {
          ...base,
          identity_evidence: {
            ...base.identity_evidence,
            locator: sharedLocator
              ? "/official/multi/shared"
              : dedicated
                ? "/official/dedicated-multi/alternate"
                : "/official/multi/alternate",
            ...(sharedLocator ? { variant_key: "alternate" } : {}),
            artwork_fingerprint: `sha256:${"d".repeat(64)}`,
            novelty_basis: {
              ...base.identity_evidence.novelty_basis,
              source_url:
                `https://official-source.invalid/images/${
                  dedicated ? "OP05-006" : "OP05-005"
                }-alt.png`,
              artwork_fingerprint: `sha256:${"d".repeat(64)}`,
            },
          },
          appearance_evidence: {
            images: [
              fixturePrintingImage(
                "front",
                "https://official-source.invalid/images/OP05-005-alt.png",
                `sha256:${"d".repeat(64)}`,
                "multi-printing-alternate",
              ),
            ],
          },
        },
      ],
    };
  }
  if (
    scenario === "product-lifecycle-first" ||
    scenario === "product-lifecycle-multiple"
  ) {
    const base = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber:
        scenario === "product-lifecycle-first"
          ? "OP11-011"
          : "OP12-012",
      name: "Product lifecycle Card",
      cardAttributes: onePieceLeaderAttributes(),
      printingAttributes: { illustration_types: [] },
      locator: `/official/${scenario}/base`,
      lineageMarker: scenario,
      memberships: {
        products: ["product_lifecycle_shared"],
        distribution_contexts: [],
        source_buckets: ["product-lifecycle"],
      },
    });
    if (scenario === "product-lifecycle-first") {
      return { cards: [base] };
    }
    return {
      cards: [
        base,
        {
          ...base,
          identity_evidence: {
            ...base.identity_evidence,
            locator: `/official/${scenario}/alternate`,
            artwork_fingerprint: `sha256:${"f".repeat(64)}`,
            novelty_basis: {
              ...base.identity_evidence.novelty_basis,
              source_url:
                "https://official-source.invalid/images/OP12-012-alt.png",
              artwork_fingerprint: `sha256:${"f".repeat(64)}`,
            },
          },
          appearance_evidence: {
            images: [
              fixturePrintingImage(
                "front",
                "https://official-source.invalid/images/OP12-012-alt.png",
                `sha256:${"f".repeat(64)}`,
                "product-lifecycle-alternate",
              ),
            ],
          },
        },
      ],
    };
  }
  if (
    scenario === "deterministic-forward" ||
    scenario === "deterministic-reverse"
  ) {
    const base = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: "OP10-010",
      name: "Deterministic Card",
      cardAttributes: onePieceLeaderAttributes(),
      printingAttributes: { illustration_types: [] },
      locator: "/official/deterministic/base",
      lineageMarker: "deterministic-base",
    });
    const alternate = {
      ...base,
      identity_evidence: {
        ...base.identity_evidence,
        locator: "/official/deterministic/alternate",
        artwork_fingerprint: `sha256:${"e".repeat(64)}`,
        novelty_basis: {
          ...base.identity_evidence.novelty_basis,
          source_url:
            "https://official-source.invalid/images/OP10-010-alt.png",
          artwork_fingerprint: `sha256:${"e".repeat(64)}`,
        },
      },
      appearance_evidence: {
        images: [
          fixturePrintingImage(
            "front",
            "https://official-source.invalid/images/OP10-010-alt.png",
            `sha256:${"e".repeat(64)}`,
            "deterministic-alternate",
          ),
        ],
      },
    };
    return {
      cards:
        scenario === "deterministic-forward"
          ? [base, alternate]
          : [alternate, base],
    };
  }
  if (
    scenario === "profile-fusion-world" ||
    scenario === "union-fusion-world" ||
    scenario === "profile-nested-unknown" ||
    scenario === "profile-invalid-number"
  ) {
    return {
      cards: [
        printingObservation({
          game: "fusion-world",
          profile: "fusion-world@1",
          cardNumber:
            scenario === "union-fusion-world" ? "FB99-999" : "FB01-001",
          name:
            scenario === "union-fusion-world"
              ? "Union Son Goku"
              : "Son Goku",
          cardAttributes: {
            card_type: "battle",
            colours: ["red"],
            cost: scenario === "profile-invalid-number" ? -1 : 1,
            specified_cost: [
              {
                colour: "red",
                count: 1,
                ...(scenario === "profile-nested-unknown"
                  ? { new_metric: "retained raw" }
                  : {}),
              },
            ],
            power: 10000,
            combo_power: 5000,
            traits: ["Saiyan"],
            skills: [
              {
                kind: "ordinary",
                text: "Official skill",
                ...(scenario === "profile-nested-unknown"
                  ? { new_label: "retained raw" }
                  : {}),
              },
            ],
          },
          printingAttributes: {},
          locator:
            scenario === "union-fusion-world"
              ? "/official/fusion-world/FB99-999"
              : "/official/fusion-world/FB01-001",
          lineageMarker: "fusion-world",
        }),
      ],
    };
  }
  if (scenario === "fusion-leader-images") {
    const observation = printingObservation({
      game: "fusion-world",
      profile: "fusion-world@1",
      cardNumber: "FB01-001",
      name: "Awakened Leader",
      cardAttributes: {
        card_type: "leader",
        colours: ["red"],
        cost: null,
        specified_cost: [],
        power: 15000,
        combo_power: null,
        traits: ["Saiyan"],
        skills: [{ kind: "ordinary", text: "Official leader skill" }],
        leader_faces: [
          {
            role: "front",
            name: "Leader",
            power: 15000,
            traits: ["Saiyan"],
            skills: "Official front skill",
          },
          {
            role: "back",
            name: "Awakened Leader",
            power: 20000,
            traits: ["Saiyan"],
            skills: "Official back skill",
          },
        ],
      },
      printingAttributes: {},
      locator: "/official/fusion-world/FB01-001/leader",
      lineageMarker: "fusion-leader-images",
    });
    return {
      cards: [{
        ...observation,
        appearance_evidence: {
          images: [
            {
              role: "front",
              source_url:
                "https://www.dbs-cardgame.com/fw/images/FB01-001-front.webp",
              artwork_fingerprint:
                observation.identity_evidence.artwork_fingerprint,
              media_type: "image/webp",
              width: 744,
              height: 1039,
              content_sha256:
                "46f3e4bfb8bc9956482a6491e9b968d82e6fd544da44f9f36d93b443b845f773",
              content_base64: "ZnVzaW9uLWZyb250LWltYWdl",
            },
            {
              role: "back",
              source_url:
                "https://www.dbs-cardgame.com/fw/images/FB01-001-back.webp",
              artwork_fingerprint:
                observation.identity_evidence.artwork_fingerprint,
              media_type: "image/webp",
              width: 744,
              height: 1039,
              content_sha256:
                "eed832d958fc4054fffb3027319dcd914448475c226ce55ae8053a442ed1b2cf",
              content_base64: "ZnVzaW9uLWJhY2staW1hZ2U=",
            },
          ],
        },
      }],
    };
  }
  if (scenario === "profile-digimon") {
    return {
      cards: [
        printingObservation({
          game: "digimon",
          profile: "digimon@1",
          cardNumber: "BT1-001",
          name: "Agumon",
          cardAttributes: {
            card_type: "digimon",
            colours: ["red"],
            level: 3,
            play_cost: 3,
            use_cost: null,
            dp: 2000,
            form: "Rookie",
            attribute: "Vaccine",
            traits: ["Reptile"],
            digivolution_requirements: [],
            text_sections: [{ kind: "effect", text: "Official effect" }],
          },
          printingAttributes: { alternative_art: false },
          locator: "/official/digimon/BT1-001",
          lineageMarker: "digimon",
        }),
      ],
    };
  }
  if (scenario === "profile-gundam") {
    return {
      cards: [
        printingObservation({
          game: "gundam",
          profile: "gundam@1",
          cardNumber: "GD01-001",
          name: "Gundam",
          cardAttributes: {
            card_type: "unit",
            colours: ["blue"],
            level: 4,
            cost: 3,
            block_icon: "1",
            effect_text: "Official effect",
            zone: "space",
            traits: ["Earth Federation"],
            link_condition: null,
            ap: 3,
            hp: 4,
            series_titles: ["Mobile Suit Gundam"],
          },
          printingAttributes: { alternate_art: false },
          locator: "/official/gundam/GD01-001",
          lineageMarker: "gundam",
        }),
      ],
    };
  }
  if (
    scenario === "gundam-cross-asia" ||
    scenario === "gundam-cross-us" ||
    scenario === "gundam-cross-us-empty" ||
    scenario === "gundam-mirror-asia" ||
    scenario === "gundam-mirror-us" ||
    scenario === "gundam-cross-product-conflict" ||
    scenario === "gundam-cross-variant-conflict" ||
    scenario === "gundam-cross-conflict" ||
    scenario === "gundam-card-conflict"
  ) {
    return {
      cards: [
        printingObservation({
          game: "gundam",
          profile: "gundam@1",
          cardNumber: scenario.startsWith("gundam-mirror-")
            ? "GD95-001"
            : "GD99-001",
          name:
            scenario === "gundam-card-conflict"
              ? "Contradictory US name"
              : "Cross-locale Gundam",
          cardAttributes: {
            card_type: "unit",
            colours: ["blue"],
            level: 4,
            cost: 3,
            block_icon: "1",
            effect_text: "Official effect",
            zone: "space",
            traits: ["Earth Federation"],
            link_condition: null,
            ap: 3,
            hp: 4,
            series_titles: ["Mobile Suit Gundam"],
          },
          printingAttributes: { alternate_art: false },
          locator: `/official/gundam/${scenario}`,
          variantKey:
            scenario === "gundam-cross-variant-conflict"
              ? "alternate"
              : "base",
          lineageMarker: "gundam-cross",
          memberships:
            scenario === "gundam-cross-us-empty"
              ? {
                  products: [],
                  distribution_contexts: [],
                  source_buckets: [],
                }
              : {
                  products: [
                    scenario === "gundam-cross-product-conflict"
                      ? "product_gd99_other"
                      : "product_gd99",
                  ],
                  distribution_contexts: [],
                  source_buckets: ["gundam-card-list"],
                },
          printedFieldsMarker:
            scenario === "gundam-cross-conflict"
              ? "conflicting"
              : "shared",
        }),
      ],
    };
  }
  if (scenario === "profile-don") {
    return {
      cards: [
        {
          card: {
            game: "one-piece",
            official_identity: {
              kind: "functional_designation",
              value: "DON!!",
            },
            name: "DON!!",
            effective_rules_text: "Your turn +1000 power.",
            game_data: {
              profile: "one-piece@1",
              attributes: {
                card_type: "don",
                colours: [],
                cost: null,
                life: null,
                battle_attributes: [],
                power: null,
                counter: null,
                traits: [],
                block_icons: [],
                effect_text: "Your turn +1000 power.",
                trigger_text: null,
              },
            },
          },
          completeness: completeEvidence(),
          memberships: {
            products: [],
            distribution_contexts: [],
            source_buckets: ["don-rules"],
          },
        },
      ],
    };
  }
  if (scenario === "profile-don-legality") {
    return {
      legality_completeness: completeEvidence(4),
      cards: [
        {
          card: {
            game: "one-piece",
            official_identity: {
              kind: "functional_designation",
              value: "DON!!",
            },
            name: "DON!!",
            effective_rules_text: "Your turn +1000 power.",
            game_data: {
              profile: "one-piece@1",
              attributes: {
                card_type: "don",
                colours: [],
                cost: null,
                life: null,
                battle_attributes: [],
                power: null,
                counter: null,
                traits: [],
                block_icons: [],
                effect_text: "Your turn +1000 power.",
                trigger_text: null,
              },
            },
          },
          completeness: completeEvidence(),
          memberships: {
            products: [],
            distribution_contexts: [],
            source_buckets: ["don-rules"],
          },
        },
        {
          card: {
            game: "one-piece",
            official_identity: {
              kind: "card_number",
              value: "OP30-001",
            },
            name: "DON!! combination companion",
            effective_rules_text: "Official effective rules.",
            game_data: {
              profile: "one-piece@1",
              attributes: onePieceLeaderAttributes(),
            },
          },
          completeness: completeEvidence(),
          memberships: {
            products: [],
            distribution_contexts: [],
            source_buckets: ["card-list"],
          },
        },
      ],
      legality_rules: [
        {
          id: "don-ban",
          game: "one-piece",
          region: "EN-OCEANIA",
          format: "standard",
          event_tier: null,
          effective_from: "2026-01-01",
          effective_until: null,
          card_numbers: ["DON!!"],
          official_wording: "DON!! may not be included in a deck.",
          effect: { type: "ban" },
          representable: true,
        },
        {
          id: "don-copy-limit",
          game: "one-piece",
          region: "EN-OCEANIA",
          format: "standard",
          event_tier: null,
          effective_from: "2026-01-01",
          effective_until: null,
          card_numbers: ["DON!!"],
          official_wording: "Decks may contain one copy of DON!!.",
          effect: { type: "copy_limit", maximum_copies: 1 },
          representable: true,
        },
        {
          id: "don-combination",
          game: "one-piece",
          region: "EN-OCEANIA",
          format: "standard",
          event_tier: null,
          effective_from: "2026-01-01",
          effective_until: null,
          card_numbers: ["DON!!"],
          official_wording:
            "DON!! and OP30-001 may not be included in the same deck.",
          effect: {
            type: "prohibited_combination",
            with_card_numbers: ["OP30-001"],
          },
          representable: true,
        },
        {
          id: "don-unresolved",
          game: "one-piece",
          region: "EN-OCEANIA",
          format: "standard",
          event_tier: null,
          effective_from: "2026-01-01",
          effective_until: null,
          card_numbers: ["DON!!"],
          official_wording: "The secondary DON!! scope is unresolved.",
          effect: {
            type: "unresolved",
            reason: "The notice omits the secondary event scope.",
          },
          representable: true,
        },
      ],
    };
  }
  if (scenario === "profile-don-printing") {
    const observation = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: "ignored-for-don",
      name: "DON!!",
      cardAttributes: {
        card_type: "don",
        colours: [],
        cost: null,
        life: null,
        battle_attributes: [],
        power: null,
        counter: null,
        traits: [],
        block_icons: [],
        effect_text: "Your turn +1000 power.",
        trigger_text: null,
      },
      printingAttributes: { illustration_types: ["original"] },
      locator: "/official/don/known-design",
      lineageMarker: "don-known",
    });
    return {
      cards: [
        {
          ...observation,
          card: {
            ...observation.card,
            official_identity: {
              kind: "functional_designation",
              value: "DON!!",
            },
          },
        },
      ],
    };
  }
  if (scenario === "profile-don-invalid-printing") {
    const observation = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: "ignored-for-invalid-don",
      name: "DON!!",
      cardAttributes: onePieceLeaderAttributes(),
      printingAttributes: { illustration_types: [] },
      locator: "/official/don/invalid-leader",
      lineageMarker: "don-invalid",
    });
    return {
      cards: [
        {
          ...observation,
          card: {
            ...observation.card,
            official_identity: {
              kind: "functional_designation",
              value: "DON!!",
            },
          },
        },
      ],
    };
  }
  if (scenario === "profile-numbered-don-invalid") {
    return {
      cards: [
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: "OP99-099",
          name: "Invalid numbered DON",
          cardAttributes: {
            card_type: "don",
            colours: [],
            cost: null,
            life: null,
            battle_attributes: [],
            power: null,
            counter: null,
            traits: [],
            block_icons: [],
            effect_text: "Your turn +1000 power.",
            trigger_text: null,
          },
          printingAttributes: { illustration_types: [] },
          locator: "/official/don/invalid-numbered",
          lineageMarker: "don-invalid-numbered",
        }),
      ],
    };
  }
  if (scenario === "card-without-printing") {
    return {
      cards: [
        {
          card: {
            game: "one-piece",
            official_identity: {
              kind: "card_number",
              value: "OP99-000",
            },
            name: "Card-only evidence",
            effective_rules_text: "Official rules without an appearance.",
            game_data: {
              profile: "one-piece@1",
              attributes: onePieceLeaderAttributes(),
            },
          },
          completeness: completeEvidence(),
          memberships: {
            products: [],
            distribution_contexts: [],
            source_buckets: ["card-list"],
          },
        },
      ],
    };
  }
  if (scenario === "product-only-surface") {
    return {
      product_surfaces: [
        {
          completeness: completeEvidence(),
          product_release_catalogue: {
            products: [
              {
                reference: {
                  kind: "official_code",
                  value: "ST-PRODUCT-ONLY",
                },
                official_code: "ST-PRODUCT-ONLY",
                name: "Product-only Official Source surface",
                releases: [
                  {
                    region: "EN-OCEANIA",
                    date: { precision: "quarter", value: "2027-Q1" },
                    status: "announced",
                  },
                ],
              },
            ],
            distribution_contexts: [
              {
                key: "product-only-announcement",
                kind: "promotion",
                label: "Product-only announcement",
                product_reference: {
                  kind: "official_code",
                  value: "ST-PRODUCT-ONLY",
                },
                evidence_category: "explicit",
              },
            ],
            relationships: [
              {
                kind: "distribution-context-product",
                context_key: "product-only-announcement",
                product_reference: {
                  kind: "official_code",
                  value: "ST-PRODUCT-ONLY",
                },
                evidence_category: "explicit",
                resolution: "explicit",
              },
            ],
          },
        },
      ],
    };
  }
  const conflict = scenario.startsWith("conflict");
  const newLocator = scenario === "new-locator";
  const unknownVocabulary = scenario === "unknown-vocabulary";
  const canonical = scenario.startsWith("canonical");
  const incompleteAppearance = scenario === "incomplete-appearance";
  const setCountMismatch = scenario === "set-count-mismatch";
  const productReleaseCatalogue =
    productReleaseCatalogueForScenario(scenario);
  if (
    scenario === "gundam-product-asia" ||
    scenario === "gundam-product-us" ||
    scenario === "gundam-product-asia-missing"
  ) {
    return {
      cards: [
        {
          ...printingObservation({
            game: "gundam",
            profile: "gundam@1",
            cardNumber: "GD90-001",
            name: "Cross-lineage Product Card",
            cardAttributes: {
              card_type: "unit",
              colours: ["blue"],
              level: 4,
              cost: 3,
              block_icon: "1",
              effect_text: "Official effect",
              zone: "space",
              traits: ["Earth Federation"],
              link_condition: null,
              ap: 3,
              hp: 4,
              series_titles: ["Mobile Suit Gundam"],
            },
            printingAttributes: { alternate_art: false },
            locator: `/official/gundam/${scenario}`,
            variantKey: "base",
            lineageMarker: "gundam-product",
          }),
          ...(productReleaseCatalogue === undefined
            ? {}
            : { product_release_catalogue: productReleaseCatalogue }),
        },
      ],
    };
  }
  if (scenario === "digimon-product-unknown-region") {
    return {
      cards: [
        {
          ...printingObservation({
            game: "digimon",
            profile: "digimon@1",
            cardNumber: "BT99-001",
            name: "Unknown-region Product Card",
            cardAttributes: {
              card_type: "digimon",
              colours: ["blue"],
              level: 4,
              play_cost: 5,
              use_cost: null,
              dp: 6_000,
              form: "Champion",
              attribute: "Data",
              traits: ["Test"],
              digivolution_requirements: [],
              text_sections: [],
              dual_colours: [],
              dual_cost: null,
              link_dp: null,
            },
            printingAttributes: { alternative_art: false },
            locator: "/official/digimon/product-unknown-region",
            lineageMarker: "digimon-product",
          }),
          ...(productReleaseCatalogue === undefined
            ? {}
            : { product_release_catalogue: productReleaseCatalogue }),
        },
      ],
    };
  }
  if (scenario === "withdrawal-conflict") {
    const observation = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: "OP02-002",
      name: "Conflict withdrawal card",
      cardAttributes: onePieceLeaderAttributes(),
      printingAttributes: { illustration_types: [] },
      locator: "/official/withdrawal-conflict",
      lineageMarker: "one-piece",
    });
    return {
      cards: [
        {
          ...observation,
          withdrawal: {
            entity: "printing",
            state: "withdrawn",
            effective_at: "2026-07-01T00:00:00.000Z",
            evidence: "Official withdrawal notice A",
          },
        },
        {
          ...observation,
          withdrawal: {
            entity: "printing",
            state: "withdrawn",
            effective_at: "2026-07-02T00:00:00.000Z",
            evidence: "Official withdrawal notice B",
          },
        },
      ],
    };
  }
  if (
    scenario === "withdrawn-longitudinal" ||
    scenario === "withdrawn-longitudinal-corroboration"
  ) {
    return {
      cards: [
        {
          ...printingObservation({
            game: "one-piece",
            profile: "one-piece@1",
            cardNumber: "OP03-003",
            name: "Longitudinal withdrawal card",
            cardAttributes: onePieceLeaderAttributes(),
            printingAttributes: { illustration_types: [] },
            locator: "/official/withdrawn-longitudinal",
            lineageMarker: "withdrawn-longitudinal",
          }),
          withdrawal: {
            entity: "printing",
            state: "withdrawn",
            effective_at: "2026-07-03T00:00:00.000Z",
            evidence:
              scenario === "withdrawn-longitudinal-corroboration"
                ? "Independent corroborating official notice"
                : "Official withdrawal notice",
          },
        },
      ],
    };
  }
  if (scenario === "withdrawn-conflicting-later") {
    return {
      cards: [
        {
          ...printingObservation({
            game: "one-piece",
            profile: "one-piece@1",
            cardNumber: "OP03-003",
            name: "Longitudinal withdrawal card",
            cardAttributes: onePieceLeaderAttributes(),
            printingAttributes: { illustration_types: [] },
            locator: "/official/withdrawn-longitudinal",
            lineageMarker: "withdrawn-longitudinal",
          }),
          withdrawal: {
            entity: "printing",
            state: "withdrawn",
            effective_at: "2026-07-04T00:00:00.000Z",
            evidence: "A contradictory later official notice",
          },
        },
      ],
    };
  }
  if (
    scenario === "identity-lower" ||
    scenario === "identity-upper" ||
    scenario === "identity-whitespace" ||
    scenario === "identity-malformed"
  ) {
    const identity =
      scenario === "identity-lower"
        ? "op06-006"
        : scenario === "identity-whitespace"
          ? " OP06-006 "
          : scenario === "identity-malformed"
            ? "OP 06-006"
            : "OP06-006";
    return {
      cards: [
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: identity,
          name: "Canonical identity",
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
          locator: `/official/identity/${scenario}`,
          lineageMarker: "identity-canonical",
        }),
      ],
    };
  }
  if (
    scenario === "semantic-evidence-base" ||
    scenario === "semantic-evidence-locator" ||
    scenario === "semantic-evidence-source-bucket"
  ) {
    return {
      cards: [
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: "OP10-001",
          name: "Evidence-only evolution",
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
          locator:
            scenario === "semantic-evidence-base"
              ? "/official/evidence/base"
              : "/official/evidence/relocated",
          lineageMarker: "semantic-evidence",
          memberships: {
            products: ["product_op10"],
            distribution_contexts: [],
            source_buckets: [
              scenario === "semantic-evidence-source-bucket"
                ? "secondary-card-list"
                : "primary-card-list",
            ],
          },
        }),
      ],
    };
  }
  if (scenario.startsWith("gundam-printing-")) {
    const formatting = scenario.includes("-format-");
    const usSurface = scenario.includes("-us-");
    const printingAuthorityConflict =
      scenario ===
      "gundam-printing-disappearance-us-printing-conflict";
    const substantiveConflict =
      (scenario.includes("-conflict-") && usSurface) ||
      printingAuthorityConflict ||
      scenario === "gundam-printing-disappearance-asia-conflict";
    const authorityAfterDisappearance =
      scenario === "gundam-printing-disappearance-us-conflict";
    const reverseAuthorityConflict =
      scenario === "gundam-printing-disappearance-asia-conflict";
    const cardNumber =
      authorityAfterDisappearance || printingAuthorityConflict
        ? "GD94-001"
        : reverseAuthorityConflict
          ? "GD91-001"
          : formatting
            ? scenario.endsWith("-asia-first") ||
              scenario.endsWith("-us-second")
              ? "GD94-001"
              : "GD93-001"
            : scenario.endsWith("-asia-first") ||
                scenario.endsWith("-us-second")
              ? "GD92-001"
              : "GD91-001";
    return {
      cards: [
        printingObservation({
          game: "gundam",
          profile: "gundam@1",
          cardNumber,
          name:
            authorityAfterDisappearance || reverseAuthorityConflict
              ? "Contradictory historical-authority Card"
              : formatting && usSurface
                ? "  Printing   authority  "
                : "Printing authority",
          cardAttributes: {
            card_type: "unit",
            colours: ["blue"],
            level: 4,
            cost: 3,
            block_icon: "1",
            effect_text:
              authorityAfterDisappearance || reverseAuthorityConflict
                ? "Substantively different Card effect"
                : formatting && usSurface
                  ? "  Official   effect  "
                  : "Official effect",
            zone: "space",
            traits: ["Earth Federation"],
            link_condition: null,
            ap: 3,
            hp: 4,
            series_titles: ["Mobile Suit Gundam"],
          },
          printingAttributes: {
            alternate_art: substantiveConflict,
          },
          printedRulesText: reverseAuthorityConflict
            ? "Different substantive Asia printed rules"
            : substantiveConflict
              ? "Substantively different printed rules"
              : formatting && usSurface
                ? "  Official   printed rules  "
                : "Official printed rules",
          rarityRaw: substantiveConflict
            ? "Leader Rare"
            : formatting && usSurface
              ? "  L  "
              : "L",
          locator: `/official/gundam/${scenario}`,
          variantKey: "base",
          lineageMarker: `gundam-printing-${cardNumber}`,
          memberships: {
            products: [`product_${cardNumber.slice(0, 4).toLowerCase()}`],
            distribution_contexts: [],
            source_buckets: ["gundam-card-list"],
          },
          printedFieldsMarker: "shared",
        }),
      ],
    };
  }
  if (/^query-hot-window-[1-4]$/.test(scenario)) {
    const generation = Number(scenario.at(-1));
    return {
      cards: [
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: "OP12-002",
          name: `Query hot window generation ${generation}`,
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
          locator: "/official/query-hot-window/stable",
          variantKey: "query-hot-window",
          lineageMarker: "locator-binding",
          memberships: {
            products: ["product_op12"],
            distribution_contexts: [],
            source_buckets: ["query-hot-window-list"],
          },
        }),
      ],
    };
  }
  if (
    scenario === "locator-binding-base" ||
    scenario === "locator-binding-compatible" ||
    scenario === "locator-binding-incompatible" ||
    scenario === "locator-variant-v1" ||
    scenario === "locator-variant-v2"
  ) {
    const variantScenario = scenario.startsWith("locator-variant-");
    return {
      cards: [
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: variantScenario ? "OP12-002" : "OP12-001",
          name: variantScenario
            ? "Historical locator variant"
            : "Historical locator binding",
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
          locator: variantScenario
            ? "/official/locator-variant/stable"
            : "/official/locator-binding/stable",
          variantKey:
            scenario === "locator-variant-v1"
              ? "suffix-a"
              : scenario === "locator-variant-v2"
                ? "suffix-b"
                : undefined,
          lineageMarker:
            scenario === "locator-binding-incompatible"
              ? "different"
              : "locator-binding",
          memberships: {
            products: ["product_op12"],
            distribution_contexts: [],
            source_buckets: ["locator-binding-list"],
          },
        }),
      ],
    };
  }
  if (
    scenario === "gundam-authority-us" ||
    scenario === "gundam-authority-asia" ||
    scenario === "gundam-authority-us-conflict" ||
    scenario === "gundam-conflict-us-first" ||
    scenario === "gundam-conflict-asia-second" ||
    scenario === "gundam-conflict-asia-first" ||
    scenario === "gundam-conflict-us-second"
  ) {
    const conflictPairOne =
      scenario === "gundam-conflict-us-first" ||
      scenario === "gundam-conflict-asia-second";
    const conflictPairTwo =
      scenario === "gundam-conflict-asia-first" ||
      scenario === "gundam-conflict-us-second";
    return {
      cards: [
        printingObservation({
          game: "gundam",
          profile: "gundam@1",
          cardNumber: conflictPairOne
            ? "GD97-001"
            : conflictPairTwo
              ? "GD96-001"
              : "GD98-001",
          name:
            scenario === "gundam-authority-asia"
              ? "Formatting equivalent name"
              : scenario === "gundam-authority-us-conflict"
                ? "Later contradictory US name"
                : scenario === "gundam-authority-us"
                  ? "  Formatting   equivalent name  "
                  : scenario === "gundam-conflict-asia-second" ||
                      scenario === "gundam-conflict-us-second"
                    ? "Substantive conflicting name"
                    : "Initial canonical name",
          cardAttributes: {
            card_type: "unit",
            colours: ["blue"],
            level: 4,
            cost: 3,
            block_icon: "1",
            effect_text: "Official effect",
            zone: "space",
            traits: ["Earth Federation"],
            link_condition: null,
            ap: 3,
            hp: 4,
            series_titles: ["Mobile Suit Gundam"],
          },
          printingAttributes: { alternate_art: false },
          locator: `/official/gundam/${scenario}`,
          variantKey: "base",
          lineageMarker: "gundam-authority",
          memberships: {
            products: [
              conflictPairOne
                ? "product_gd97"
                : conflictPairTwo
                  ? "product_gd96"
                  : "product_gd98",
            ],
            distribution_contexts: [],
            source_buckets: ["gundam-card-list"],
          },
          printedFieldsMarker: "shared",
        }),
      ],
    };
  }
  return {
    cards: [
      {
        ...printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: conflict
            ? "OP09-001"
            : canonical
              ? "OP07-007"
              : scenario === "repeatable"
                ? "OP04-004"
              : scenario === "not-demonstrably-novel" ||
                  incompleteAppearance
                ? "OP08-008"
                : "OP01-001",
          name:
            scenario === "canonical-name-conflict"
              ? "Unsupported replacement name"
              : conflict
                ? "Conflict Card"
                : canonical
                  ? "Canonical Card"
                  : "Monkey.D.Luffy",
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: {
            illustration_types: unknownVocabulary
              ? ["etched-future"]
              : [],
          },
          locator: conflict
            ? "/official/conflict"
            : canonical
              ? `/official/${scenario}`
              : newLocator
                ? "/official/renamed"
                : `/official/${scenario}`,
          lineageMarker:
            scenario === "not-demonstrably-novel" ||
            incompleteAppearance
              ? "different"
              : "one-piece",
          demonstrablyNovel:
            scenario !== "not-demonstrably-novel",
          includeAppearance: !incompleteAppearance,
          treatment:
            scenario === "conflict-changed"
              ? "parallel-foil"
              : "standard",
          memberships: newLocator
            ? {
                products: ["product_promotion"],
                distribution_contexts: ["context_event"],
                source_buckets: ["promotion-list"],
              }
            : scenario === "product-identity-inferred" ||
                scenario === "product-identity-typed"
              ? {
                  products: ["IDENTITY-INFERRED"],
                  distribution_contexts: [],
                  source_buckets: ["identity-product-list"],
                }
            : scenario === "product-release" ||
                scenario === "product-release-multiple-events"
              ? {
                  products: ["ST-15"],
                  distribution_contexts: ["championship-2026-pack"],
                  source_buckets: ["starter-deck-card-list"],
                }
            : scenario === "product-typed-relationships"
              ? {
                  products: ["CODE-X"],
                  distribution_contexts: ["typed-context"],
                  source_buckets: ["typed-source-bucket"],
                }
            : undefined,
        }),
        ...(productReleaseCatalogue === undefined
          ? {}
          : { product_release_catalogue: productReleaseCatalogue }),
        ...(unknownVocabulary
          ? { new_official_label: "Bandai-added-value" }
          : {}),
        ...(setCountMismatch
          ? {
              completeness: {
                ...completeEvidence(),
                declared_record_count: 2,
              },
            }
          : {}),
        ...(scenario === "withdrawn"
          ? {
              withdrawal: {
                entity: "printing",
                state: "withdrawn",
                effective_at: "2026-07-01T00:00:00.000Z",
                evidence: "Official withdrawal notice",
              },
            }
          : {}),
      },
    ],
  };
}

function productReleaseCatalogueForScenario(
  scenario: string,
): Record<string, unknown> | undefined {
  const officialReference = (value: string) => ({
    kind: "official_code",
    value,
  });
  if (
    scenario === "product-release" ||
    scenario === "product-release-multiple-events"
  ) {
    return {
      products: [
        {
          reference: officialReference("ST-15"),
          official_code: "ST-15",
          name: "Starter Deck RED Edward.Newgate",
          releases: [
            {
              event_key: "oceania-announcement",
              region: "EN-OCEANIA",
              date: { precision: "month", value: "2026-09" },
              status: "announced",
            },
            ...(scenario === "product-release-multiple-events"
              ? [{
                  event_key: "oceania-retail-release",
                  region: "EN-OCEANIA",
                  date: { precision: "day", value: "2026-09-18" },
                  status: "released",
                }]
              : []),
          ],
        },
      ],
      distribution_contexts: [
        {
          key: "championship-2026-pack",
          kind: "tournament_pack",
          label: "Championship 2026 Participation Pack",
          product_reference: officialReference("ST-15"),
          product_key: "ST-15",
          evidence_category: "derived",
        },
      ],
      relationships: [
        {
          kind: "printing-product",
          product_reference: officialReference("ST-15"),
          target_key: "ST-15",
          evidence_category: "explicit",
          resolution: "explicit",
        },
        {
          kind: "printing-distribution-context",
          context_key: "championship-2026-pack",
          target_key: "championship-2026-pack",
          evidence_category: "derived",
          resolution: "deterministic",
        },
        {
          kind: "printing-product",
          product_reference: {
            kind: "name",
            value: "ST-15 fuzzy label",
          },
          target_key: "ST-15 fuzzy label",
          evidence_category: "derived",
          resolution: "fuzzy",
        },
      ],
    };
  }
  if (scenario === "product-conflict-a" || scenario === "product-conflict-b") {
    const second = scenario.endsWith("-b");
    return {
      products: [
        {
          reference: officialReference("ST-CONFLICT"),
          official_code: "ST-CONFLICT",
          name: second ? "Conflicting Starter B" : "Conflicting Starter A",
          releases: [
            {
              region: "EN-OCEANIA",
              date: second
                ? { precision: "day", value: "2026-10-17" }
                : { precision: "month", value: "2026-10" },
              status: second ? "released" : "announced",
            },
          ],
        },
      ],
      distribution_contexts: [],
      relationships: [],
    };
  }
  if (
    scenario === "product-context-conflict-a" ||
    scenario === "product-context-conflict-b"
  ) {
    const second = scenario.endsWith("-b");
    return {
      products: [
        {
          reference: officialReference("ST-CONTEXT-CONFLICT"),
          official_code: "ST-CONTEXT-CONFLICT",
          name: "Context Conflict Product",
          releases: [],
        },
      ],
      distribution_contexts: [
        {
          key: "same-context-key",
          kind: second ? "tournament_pack" : "promotion",
          label: second
            ? "Conflicting Tournament Context"
            : "Conflicting Promotion Context",
          product_reference: officialReference("ST-CONTEXT-CONFLICT"),
          evidence_category: "explicit",
        },
      ],
      relationships: [],
    };
  }
  if (scenario === "product-typed-relationships") {
    return {
      products: [
        {
          reference: officialReference("CODE-X"),
          official_code: "CODE-X",
          name: "Official Code Product",
          releases: [],
        },
        {
          reference: { kind: "name", value: "CODE-X" },
          official_code: null,
          name: "CODE-X",
          releases: [],
        },
      ],
      distribution_contexts: [
        {
          key: "typed-context",
          kind: "promotion",
          label: "Typed relationship context",
          product_reference: officialReference("CODE-X"),
          evidence_category: "explicit",
        },
      ],
      relationships: [
        {
          kind: "printing-product",
          product_reference: officialReference("CODE-X"),
          evidence_category: "explicit",
          resolution: "explicit",
        },
        {
          kind: "printing-distribution-context",
          context_key: "typed-context",
          evidence_category: "derived",
          resolution: "deterministic",
        },
        {
          kind: "distribution-context-product",
          context_key: "typed-context",
          product_reference: officialReference("CODE-X"),
          evidence_category: "explicit",
          resolution: "explicit",
        },
        {
          kind: "product-card",
          product_reference: { kind: "name", value: "CODE-X" },
          card_reference: { kind: "current_card" },
          evidence_category: "derived",
          resolution: "deterministic",
        },
      ],
    };
  }
  if (
    scenario === "product-standalone-v1" ||
    scenario === "product-standalone-v2" ||
    scenario === "product-standalone-withdrawn"
  ) {
    return {
      products: [
        {
          reference: officialReference("ST-STANDALONE"),
          official_code: "ST-STANDALONE",
          name:
            scenario === "product-standalone-v1"
              ? "Standalone Product"
              : "Renamed Standalone Product",
          releases: [],
          ...(scenario === "product-standalone-withdrawn"
            ? {
                withdrawal: {
                  state: "withdrawn",
                  effective_at: "2026-11-01T00:00:00.000Z",
                  evidence: "Official Product withdrawal notice",
                },
              }
            : {}),
        },
      ],
      distribution_contexts: [],
      relationships: [],
    };
  }
  if (
    scenario === "product-identity-typed" ||
    scenario === "product-identity-name" ||
    scenario === "product-identity-coded" ||
    scenario === "product-identity-distinct-code-a" ||
    scenario === "product-identity-distinct-code-b" ||
    scenario === "product-identity-ambiguous-name" ||
    scenario === "product-identity-rename-v1" ||
    scenario === "product-identity-rename-v2"
  ) {
    const name =
      scenario === "product-identity-rename-v2"
        ? "Renamed Identity Product"
        : scenario.startsWith("product-identity-rename")
          ? "Original Identity Product"
          : scenario.startsWith("product-identity-distinct-code") ||
              scenario === "product-identity-ambiguous-name"
            ? "Same-name Distinct-code Product"
          : scenario === "product-identity-name" ||
              scenario === "product-identity-coded"
            ? "Name-to-code Identity Product"
            : "Inferred-to-typed Identity Product";
    const officialCode =
      scenario === "product-identity-name" ||
      scenario === "product-identity-ambiguous-name"
        ? null
        : scenario.startsWith("product-identity-rename")
          ? "IDENTITY-RENAME"
          : scenario === "product-identity-distinct-code-a"
            ? "IDENTITY-DISTINCT-A"
            : scenario === "product-identity-distinct-code-b"
              ? "IDENTITY-DISTINCT-B"
          : scenario === "product-identity-coded"
            ? "IDENTITY-NAME-CODE"
            : "IDENTITY-INFERRED";
    return {
      products: [
        {
          reference:
            officialCode === null
              ? { kind: "name", value: name }
              : officialReference(officialCode),
          official_code: officialCode,
          name,
          releases: [],
        },
      ],
      distribution_contexts: [],
      relationships: [
        {
          kind: "product-card",
          product_reference:
            officialCode === null
              ? { kind: "name", value: name }
              : officialReference(officialCode),
          card_reference: { kind: "current_card" },
          evidence_category: "explicit",
          resolution: "explicit",
        },
      ],
    };
  }
  if (scenario === "product-standalone-missing") {
    return {
      products: [],
      distribution_contexts: [],
      relationships: [],
    };
  }
  if (scenario === "product-invalid-resolution") {
    return {
      products: [
        {
          reference: officialReference("ST-INVALID"),
          official_code: "ST-INVALID",
          name: "Invalid Resolution Product",
          releases: [],
        },
      ],
      distribution_contexts: [],
      relationships: [
        {
          kind: "printing-product",
          product_reference: officialReference("ST-INVALID"),
          target_key: "ST-INVALID",
          evidence_category: "derived",
          resolution: "guessed",
        },
      ],
    };
  }
  if (
    scenario === "product-explicit-derived" ||
    scenario === "product-deterministic-explicit"
  ) {
    const explicitResolution = scenario === "product-explicit-derived";
    return {
      products: [
        {
          reference: officialReference("ST-COUPLING"),
          official_code: "ST-COUPLING",
          name: "Coupling Product",
          releases: [],
        },
      ],
      distribution_contexts: [],
      relationships: [
        {
          kind: "printing-product",
          product_reference: officialReference("ST-COUPLING"),
          evidence_category: explicitResolution ? "derived" : "explicit",
          resolution: explicitResolution ? "explicit" : "deterministic",
        },
      ],
    };
  }
  if (scenario === "gundam-product-asia-missing") {
    return {
      products: [],
      distribution_contexts: [],
      relationships: [],
    };
  }
  if (scenario === "gundam-product-asia" || scenario === "gundam-product-us") {
    const region =
      scenario === "gundam-product-asia" ? "EN-ASIA" : "EN-US";
    return {
      products: [
        {
          reference: officialReference("GD-CROSS"),
          official_code: "GD-CROSS",
          name: "Cross-lineage Product",
          releases: [
            {
              region,
              date: { precision: "day", value: "2026-12-01" },
              status: "released",
            },
          ],
        },
      ],
      distribution_contexts: [],
      relationships: [],
    };
  }
  if (scenario === "digimon-product-unknown-region") {
    return {
      products: [
        {
          reference: officialReference("BT-UNKNOWN"),
          official_code: "BT-UNKNOWN",
          name: "Unknown-region Product",
          releases: [
            {
              region: "unknown",
              date: { precision: "unknown", value: null },
              status: "announced",
            },
          ],
        },
      ],
      distribution_contexts: [],
      relationships: [],
    };
  }
  return undefined;
}

function emptyOfficialCatalogueDocument(
  partition: "EN-OCEANIA" | "EN-ASIA" | "EN-US",
  surface: string,
  requestUrl: string,
  legalityVariant: "complete" | "missing" | "false-empty" =
    "complete",
  game: "one-piece" | "fusion-world" | "digimon" | "gundam" =
    officialGame(requestUrl),
  omittedSurface?: string,
  discoveryVariant?: "missing",
) {
  if (
    (legalityVariant === "missing" && surface === "legality_rules") ||
    surface === omittedSurface
  ) {
    return rawOfficialEnvelope(
      game,
      partition,
      "not-a-required-surface",
      [],
    );
  }
  if (
    legalityVariant === "false-empty" &&
    surface === "legality_rules"
  ) {
    return rawOfficialEnvelope(game, partition, surface, [], 1);
  }
  const requiredSurfaces = [
    "discovery",
    "legality_card_details",
    "legality_rules",
    "legality_history",
    ...(game === "one-piece"
      ? ["block_policy", "release_timing", "don_rules"]
      : []),
  ];
  const records = officialSurfaceRecords({
    discoveryVariant,
    game,
    requestUrl,
    requiredSurfaces,
    surface,
  });
  return rawOfficialEnvelope(game, partition, surface, records);
}

function officialSurfaceRecords(input: {
  discoveryVariant?: "missing";
  game: "one-piece" | "fusion-world" | "digimon" | "gundam";
  requestUrl: string;
  requiredSurfaces: string[];
  surface: string;
}): unknown[] {
  if (input.surface === "discovery") {
    return input.requiredSurfaces
      .filter((name) => name !== "discovery")
      .filter(
        (name) =>
          input.discoveryVariant !== "missing" ||
            name !== "legality_history",
      )
      .map((name) => rawDiscoveryRecord(
        input.game,
        name,
        officialSurfaceUrl(input.requestUrl, name),
      ));
  }
  if (input.surface !== "legality_card_details" && input.surface !== "legality_rules") {
    return [emptyPartitionRawRule(input.game, input.surface, input.requestUrl)];
  }
  return [];
}

function officialGame(
  requestUrl: string,
): "one-piece" | "fusion-world" | "digimon" | "gundam" {
  const hostname = new URL(requestUrl).hostname;
  if (hostname === "en.onepiece-cardgame.com") return "one-piece";
  if (hostname === "www.dbs-cardgame.com") return "fusion-world";
  if (hostname === "world.digimoncard.com") return "digimon";
  return "gundam";
}

function rawDiscoveryRecord(
  game: "one-piece" | "fusion-world" | "digimon" | "gundam",
  surface: string,
  url: string,
): Record<string, unknown> {
  if (game === "one-piece") return { key: surface, area: surface, href: url };
  if (game === "fusion-world") {
    return { request: surface, section: surface, url };
  }
  if (game === "digimon") return { request_id: surface, feed: surface, link: url };
  return { request_key: surface, endpoint: surface, href: url };
}

function rawOfficialEnvelope(
  game: "one-piece" | "fusion-world" | "digimon" | "gundam",
  partition: "EN-OCEANIA" | "EN-ASIA" | "EN-US",
  surface: string,
  records: readonly unknown[],
  count = records.length,
): Record<string, unknown> {
  if (game === "one-piece") {
    return { one_piece: { area: surface, locale: partition, total: count, entries: records } };
  }
  if (game === "fusion-world") {
    return { fusion_world: { section: surface, territory: partition, result_count: count, items: records } };
  }
  if (game === "digimon") {
    return { digimon: { feed: surface, language: partition, count, rows: records } };
  }
  return { gundam: { endpoint: surface, locale: partition, hits: count, results: records } };
}

function representativeRawSourceDocument(
  game: "one-piece" | "fusion-world" | "digimon" | "gundam",
  surface: string,
  requestUrl: string,
): Record<string, unknown> {
  const partition = game === "gundam" ? "EN-ASIA" : "EN-OCEANIA";
  const requiredSurfaces = [
    "discovery",
    "legality_card_details",
    "legality_rules",
    "legality_history",
  ];
  const records = surface === "discovery"
    ? requiredSurfaces
        .filter((name) => name !== "discovery")
        .map((name) => rawDiscoveryRecord(
          game,
          name,
          officialSurfaceUrl(requestUrl, name),
        ))
    : surface === "legality_card_details"
      ? [representativeRawCard(game, requestUrl)]
      : surface === "legality_rules"
        ? [representativeRawNotice(game, requestUrl)]
        : [emptyPartitionRawRule(game, surface, requestUrl)];
  return rawOfficialEnvelope(game, partition, surface, records);
}

function representativeRawCard(
  game: "one-piece" | "fusion-world" | "digimon" | "gundam",
  requestUrl: string,
): Record<string, unknown> {
  const base = new URL(requestUrl);
  if (game === "fusion-world") {
    return {
      source_url: requestUrl,
      card_number: "FB30-001",
      name: "Representative Fusion Card",
      "Card Type": "Battle",
      Color: ["Red"],
      Cost: "1",
      "Specified Cost": ["red:1"],
      Power: "5000",
      "Combo Power": "10000",
      "Special Traits": ["Saiyan"],
      Skills: "Official Fusion World skill.",
      Rarity: "R",
      variant_suffix: null,
      image_urls: [`${base.origin}/fw/en/images/FB30-001.png`],
    };
  }
  if (game === "digimon") {
    return {
      popup_id: "BT30-001-base",
      source_url: requestUrl,
      card_number: "BT30-001",
      name: "Representative Digimon",
      cardcategory: "Digimon",
      Color: ["Red"],
      Lv: "3",
      "Play Cost": "3",
      "Use Cost": null,
      DP: "2000",
      Form: "Rookie",
      Attribute: "Vaccine",
      Type: ["Reptile"],
      "Digivolution Cost": "2",
      Effect: "Official Digimon effect.",
      "Inherited Effect": null,
      "Security Effect": null,
      "DUAL Color": [],
      "DUAL Cost": null,
      "Link DP": null,
      Rarity: "C",
      "Alternative Art": "no",
      image_url: `${base.origin}/images/BT30-001.png`,
    };
  }
  throw new Error(`No representative raw Card fixture for ${game}.`);
}

function representativeRawNotice(
  game: "one-piece" | "fusion-world" | "digimon" | "gundam",
  requestUrl: string,
): Record<string, unknown> {
  if (game === "fusion-world") {
    return {
      rule_ref: "fw_representative_eligible",
      canonical_url: requestUrl,
      notice: "FB30-001 is eligible for Standard tournament play.",
      market: "EN-OCEANIA",
      play_format: "standard",
      tier: null,
      active_on: "2026-01-01",
      expires_on: null,
      cards: ["FB30-001"],
      directive: "eligible",
      cap: null,
      paired_cards: [],
      filter_field: null,
      filter_values: [],
      blocks: [],
      tournament_legal_date: null,
      ambiguity: null,
    };
  }
  if (game === "digimon") {
    return {
      restriction_id: "digimon_representative_eligible",
      link: requestUrl,
      body: "BT30-001 is eligible for Standard tournament play.",
      language_scope: "EN-OCEANIA",
      ruleset: "standard",
      tournament_level: null,
      applies_from: "2026-01-01",
      applies_until: null,
      card_ids: ["BT30-001"],
      status_code: "eligible",
      deck_limit: null,
      prohibited_with: [],
      membership_field: null,
      membership_terms: [],
      permitted_blocks: [],
      sale_eligible_on: null,
      clarification: null,
    };
  }
  throw new Error(`No representative raw notice fixture for ${game}.`);
}

function emptyPartitionRawRule(
  game: "one-piece" | "fusion-world" | "digimon" | "gundam",
  surface: string,
  requestUrl: string,
): Record<string, unknown> {
  const id = `${game}_${surface}_representative`;
  const effect = surface === "block_policy"
    ? {
        code: "rotation",
        wording: "Only cards bearing Block 4 are eligible after rotation.",
        blocks: ["4"],
      }
    : surface === "release_timing"
      ? {
          code: "release",
          wording: "Cards become legal for tournament play on 1 August 2026.",
          legalFrom: "2026-08-01",
        }
      : surface === "don_rules"
        ? {
            code: "membership",
            wording: "Cards with the DON!! trait are eligible under this membership rule.",
            membershipAttribute: "traits",
            membershipValues: ["DON!!"],
          }
        : {
            code: "ban",
            wording: "The historical notice states these cards were banned from play.",
            effectiveUntil: "2025-06-01",
          };
  if (game === "one-piece") {
    return {
      notice_no: id,
      source_url: requestUrl,
      published_text: effect.wording,
      territory: "EN-OCEANIA",
      format_name: "standard",
      event_class: null,
      start_date: "2025-01-01",
      end_date: effect.effectiveUntil ?? null,
      card_numbers: [],
      restriction_code: effect.code,
      maximum_copies: null,
      related_cards: [],
      membership_attribute: effect.membershipAttribute ?? null,
      membership_values: effect.membershipValues ?? [],
      eligible_blocks: effect.blocks ?? [],
      legal_from: effect.legalFrom ?? null,
      unresolved_reason: null,
    };
  }
  if (game === "fusion-world") {
    return {
      rule_ref: id,
      canonical_url: requestUrl,
      notice: effect.wording,
      market: "EN-OCEANIA",
      play_format: "standard",
      tier: null,
      active_on: "2025-01-01",
      expires_on: effect.effectiveUntil ?? null,
      cards: [],
      directive: effect.code,
      cap: null,
      paired_cards: [],
      filter_field: effect.membershipAttribute ?? null,
      filter_values: effect.membershipValues ?? [],
      blocks: effect.blocks ?? [],
      tournament_legal_date: effect.legalFrom ?? null,
      ambiguity: null,
    };
  }
  if (game === "digimon") {
    return {
      restriction_id: id,
      link: requestUrl,
      body: effect.wording,
      language_scope: "EN-OCEANIA",
      ruleset: "standard",
      tournament_level: null,
      applies_from: "2025-01-01",
      applies_until: effect.effectiveUntil ?? null,
      card_ids: [],
      status_code: effect.code,
      deck_limit: null,
      prohibited_with: [],
      membership_field: effect.membershipAttribute ?? null,
      membership_terms: effect.membershipValues ?? [],
      permitted_blocks: effect.blocks ?? [],
      sale_eligible_on: effect.legalFrom ?? null,
      clarification: null,
    };
  }
  const region = new URL(requestUrl).pathname.startsWith("/en/")
    ? "EN-US"
    : "EN-ASIA";
  return {
    news_id: id,
    url: requestUrl,
    text: effect.wording,
    region,
    format: "standard",
    event_tier: null,
    effective_date: "2025-01-01",
    end_date: effect.effectiveUntil ?? null,
    card_numbers: [],
    ruling: effect.code,
    copy_limit: null,
    companion_cards: [],
    attribute: effect.membershipAttribute ?? null,
    values: effect.membershipValues ?? [],
    legal_blocks: effect.blocks ?? [],
    legal_from: effect.legalFrom ?? null,
    reason: null,
  };
}

function officialSurfaceUrl(requestUrl: string, surface: string): string {
  const url = new URL(requestUrl);
  url.searchParams.set("surface", surface);
  return url.href;
}

function printingObservation(input: {
  game: string;
  profile: string;
  cardNumber: string;
  name: string;
  cardAttributes: Record<string, unknown>;
  printingAttributes: Record<string, unknown>;
  locator: string;
  lineageMarker: string;
  demonstrablyNovel?: boolean;
  includeAppearance?: boolean;
  treatment?: string | null;
  variantKey?: string | null;
  printedFieldsMarker?: string;
  printedRulesText?: string;
  rarityRaw?: string;
  memberships?: {
    products: string[];
    distribution_contexts: string[];
    source_buckets: string[];
  };
}) {
  const artworkFingerprint = `sha256:${
    input.lineageMarker === "different" ? "c".repeat(64) : "a".repeat(64)
  }`;
  return {
    card: {
      game: input.game,
      official_identity: {
        kind: "card_number",
        value: input.cardNumber,
      },
      name: input.name,
      effective_rules_text: "Official effective rules",
      game_data: {
        profile: input.profile,
        attributes: input.cardAttributes,
      },
    },
    printing: {
      rarity: {
        raw: input.rarityRaw ?? "L",
        normalized: "leader",
      },
      printed_rules_text:
        input.printedRulesText ?? "Official printed rules",
      game_data: {
        profile: input.profile,
        attributes: input.printingAttributes,
      },
    },
    identity_evidence: {
      locator: input.locator,
      ...(input.variantKey === undefined && input.profile !== "gundam@1"
        ? {}
        : { variant_key: input.variantKey ?? "base" }),
      artwork_fingerprint: artworkFingerprint,
      printed_fields_digest: `sha256:${
        input.printedFieldsMarker === "conflicting"
          ? "d".repeat(64)
          : "b".repeat(64)
      }`,
      treatment: input.treatment ?? "standard",
      demonstrably_novel: input.demonstrablyNovel ?? true,
      novelty_basis: {
        kind: "official_printing_image",
        source_url: `https://official-source.invalid/images/${input.cardNumber}.png`,
        artwork_fingerprint: artworkFingerprint,
      },
    },
    appearance_evidence:
      input.includeAppearance === false
        ? { images: [] }
        : {
            images: [
              fixturePrintingImage(
                "front",
                `https://official-source.invalid/images/${input.cardNumber}.png`,
                artworkFingerprint,
                `${input.cardNumber}:${input.lineageMarker}`,
              ),
            ],
          },
    completeness: completeEvidence(),
    memberships:
      input.memberships ?? {
        products: ["product_op01"],
        distribution_contexts: [],
        source_buckets: ["main-list"],
      },
  };
}

function fixturePrintingImage(
  role: "front" | "back" | "other",
  sourceUrl: string,
  artworkFingerprint: string,
  marker: string,
) {
  const bytes = Buffer.from(`fixture-printing-image:${marker}`, "utf8");
  return {
    role,
    source_url: sourceUrl,
    artwork_fingerprint: artworkFingerprint,
    media_type: "image/png",
    width: 1,
    height: 1,
    content_sha256: createHash("sha256").update(bytes).digest("hex"),
    content_base64: bytes.toString("base64"),
  };
}

function completeEvidence(recordCount = 1) {
  return {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: recordCount,
    parsed_record_count: recordCount,
  };
}

function onePieceLeaderAttributes() {
  return {
    card_type: "leader",
    colours: ["red"],
    cost: null,
    life: 5,
    battle_attributes: ["strike"],
    power: 5000,
    counter: null,
    traits: ["Straw Hat Crew"],
    block_icons: ["1"],
    effect_text: "Official effective rules",
    trigger_text: null,
  };
}

function deterministicNoise(seed: number, length: number) {
  let state = seed >>> 0;
  let value = "";
  while (value.length < length) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    value += state.toString(36).padStart(7, "0");
  }
  return value.slice(0, length);
}

async function apiCredentialConsumerTestResponse(
  request: Request,
): Promise<Response> {
  const token = request.headers.get(
    credentialConsumerProofRequestHeader,
  );
  const match =
    /^v1\.([A-Za-z0-9_-]{32,4096})\.([0-9a-f]{64})$/.exec(
      token ?? "",
    );
  if (match === null) return new Response(null, { status: 401 });
  const expectedSignature = createHmac(
    "sha256",
    "vitest-consumer-proof-key",
  ).update(`request\0${match[1]!}`).digest();
  const suppliedSignature = Buffer.from(match[2]!, "hex");
  if (
    expectedSignature.byteLength !== suppliedSignature.byteLength ||
    !timingSafeEqual(expectedSignature, suppliedSignature)
  ) {
    return new Response(null, { status: 401 });
  }
  const claims = JSON.parse(
    Buffer.from(match[1]!, "base64url").toString("utf8"),
  ) as CredentialConsumerProofRequestClaims;
  if (
    claims.credential_class !== "api_bearer_key" ||
    claims.expected_status !== "usable"
  ) {
    return new Response(null, { status: 409 });
  }
  return Response.json({
    contract: "card-keepr-credential-consumer-proof@1",
    request_nonce: claims.request_nonce,
    credential_class: claims.credential_class,
    expected_fingerprint: claims.expected_fingerprint,
    challenge: claims.plan_digest,
    plan_nonce: claims.plan_nonce,
    execution_attempt: claims.execution_attempt,
    execution_expires_at: claims.execution_expires_at,
    slot: claims.slot,
    status: claims.expected_status,
    proof: createHmac(
      "sha256",
      "vitest-consumer-proof-key",
    ).update(consumerProofMessage(claims)).digest("hex"),
  });
}
