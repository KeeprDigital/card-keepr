import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { resolve } from "node:path";
import {
  createHmac,
  generateKeyPairSync,
  timingSafeEqual,
} from "node:crypto";
import { defineConfig } from "vitest/config";
import {
  consumerProofMessage,
  credentialConsumerProofRequestHeader,
  type CredentialConsumerProofRequestClaims,
} from "../../src/credentials/consumer-proof";

const migrations = await readD1Migrations(
  resolve(import.meta.dirname, "../../migrations"),
);
const outboundRequestCounts = new Map<string, number>();
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
    testTimeout: 15_000,
  },
});

function reconciliationSourceDocument(scenario: string) {
  if (scenario === "complete-empty-lineage") {
    return { cards: [] };
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
          effective_rules_text: deterministicNoise(index + 1, 9_000),
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
      })),
    };
  }
  if (scenario === "multi-printing") {
    const base = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: "OP05-005",
      name: "Multiple Printing Card",
      cardAttributes: onePieceLeaderAttributes(),
      printingAttributes: { illustration_types: [] },
      locator: "/official/multi/base",
      lineageMarker: "multi-base",
    });
    return {
      cards: [
        base,
        {
          ...base,
          identity_evidence: {
            ...base.identity_evidence,
            locator: "/official/multi/alternate",
            artwork_fingerprint: `sha256:${"d".repeat(64)}`,
            novelty_basis: {
              ...base.identity_evidence.novelty_basis,
              source_url:
                "https://official-source.invalid/images/OP05-005-alt.png",
              artwork_fingerprint: `sha256:${"d".repeat(64)}`,
            },
          },
          appearance_evidence: {
            images: [
              {
                role: "front",
                source_url:
                  "https://official-source.invalid/images/OP05-005-alt.png",
                artwork_fingerprint: `sha256:${"d".repeat(64)}`,
              },
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
              {
                role: "front",
                source_url:
                  "https://official-source.invalid/images/OP12-012-alt.png",
                artwork_fingerprint: `sha256:${"f".repeat(64)}`,
              },
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
          {
            role: "front",
            source_url:
              "https://official-source.invalid/images/OP10-010-alt.png",
            artwork_fingerprint: `sha256:${"e".repeat(64)}`,
          },
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
  const conflict = scenario.startsWith("conflict");
  const newLocator = scenario === "new-locator";
  const unknownVocabulary = scenario === "unknown-vocabulary";
  const canonical = scenario.startsWith("canonical");
  const incompleteAppearance = scenario === "incomplete-appearance";
  const setCountMismatch = scenario === "set-count-mismatch";
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
            : undefined,
        }),
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
              {
                role: "front",
                source_url: `https://official-source.invalid/images/${input.cardNumber}.png`,
                artwork_fingerprint: artworkFingerprint,
              },
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

function completeEvidence() {
  return {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: 1,
    parsed_record_count: 1,
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
