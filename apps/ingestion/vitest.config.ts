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
    scenario === "gundam-cross-conflict" ||
    scenario === "gundam-card-conflict"
  ) {
    return {
      cards: [
        printingObservation({
          game: "gundam",
          profile: "gundam@1",
          cardNumber: "GD99-001",
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
                    scenario === "gundam-cross-asia"
                      ? "product_asia"
                      : "product_us",
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
  printedFieldsMarker?: string;
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
      rarity: { raw: "L", normalized: "leader" },
      printed_rules_text: "Official printed rules",
      game_data: {
        profile: input.profile,
        attributes: input.printingAttributes,
      },
    },
    identity_evidence: {
      locator: input.locator,
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
