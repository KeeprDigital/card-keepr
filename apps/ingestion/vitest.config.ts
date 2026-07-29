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
