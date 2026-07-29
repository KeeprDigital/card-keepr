import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(
  resolve(import.meta.dirname, "../../migrations"),
);
const outboundRequestCounts = new Map<string, number>();

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: resolve(import.meta.dirname, "wrangler.jsonc"),
      },
      miniflare: {
        d1Databases: ["LEGACY_DB"],
        bindings: {
          ADMINISTRATION_KEY: "vitest-administration-key",
          ADMINISTRATION_CLOCK_MODE: "request",
          TEST_MIGRATIONS: migrations,
        },
        outboundService: async (request) => {
          const url = new URL(request.url);
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
          if (url.pathname.startsWith("/reconciliation/")) {
            const scenario = url.pathname.slice("/reconciliation/".length);
            return Response.json(reconciliationSourceDocument(scenario));
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
  },
});

function reconciliationSourceDocument(scenario: string) {
  const conflict = scenario.startsWith("conflict");
  const newLocator = scenario === "new-locator";
  const unknownVocabulary = scenario === "unknown-vocabulary";
  return {
    cards: [
      {
        card: {
          game: "one-piece",
          official_identity: {
            kind: "card_number",
            value: conflict
              ? "OP09-001"
              : scenario === "not-demonstrably-novel"
                ? "OP08-008"
                : "OP01-001",
          },
          name: conflict ? "Conflict Card" : "Monkey.D.Luffy",
          effective_rules_text: "Official effective rules",
          game_data: {
            profile: "one-piece@1",
            attributes: {
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
            },
          },
        },
        printing: {
          rarity: { raw: "L", normalized: "leader" },
          printed_rules_text: "Official printed rules",
          game_data: {
            profile: "one-piece@1",
            attributes: { illustration_types: [] },
          },
        },
        identity_evidence: {
          locator: conflict
            ? "/official/conflict"
            : newLocator
              ? "/official/renamed"
              : `/official/${scenario}`,
          artwork_fingerprint: `sha256:${
            scenario === "not-demonstrably-novel"
              ? "c".repeat(64)
              : "a".repeat(64)
          }`,
          printed_fields_digest: `sha256:${"b".repeat(64)}`,
          treatment:
            scenario === "conflict-changed" ? "parallel-foil" : "standard",
          demonstrably_novel:
            scenario !== "not-demonstrably-novel",
          novelty_basis: "Officially distinguished artwork record",
        },
        memberships: newLocator
          ? {
              products: ["product_promotion"],
              distribution_contexts: ["context_event"],
              source_buckets: ["promotion-list"],
            }
          : {
              products: ["product_op01"],
              distribution_contexts: [],
              source_buckets: ["main-list"],
            },
        optional_vocabulary: unknownVocabulary
          ? [
              {
                profile: "one-piece@1",
                path: "printing.illustration_types",
                raw_value: "etched-future",
              },
            ]
          : [],
        ...(scenario === "withdrawn"
          ? {
              withdrawal: {
                entity: "printing",
                evidence: "Official withdrawal notice",
              },
            }
          : {}),
      },
    ],
  };
}
