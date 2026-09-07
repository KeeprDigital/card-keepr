import { createHash } from "node:crypto";

// Synthetic reconciliation source documents served from
// https://<scenario>-official-source.invalid/reconciliation/<scenario>. Every
// document is a pure function of the scenario, surface, and request URL.
export function reconciliationSourceDocument(scenario: string, surface: string, requestUrl: string) {
  if (scenario === "dedicated-errata-work-units") {
    return {
      cards: Array.from({ length: 32 }, (_, index) => ({
        kind: "official_erratum",
        game: "one-piece",
        target: {
          type: "card",
          official_identity: { kind: "card_number", value: `OP96-${String(index + 1).padStart(3, "0")}` },
        },
        published_on: "2026-07-31",
        effective_from: null,
        observed_printed_rules_text: "Official printed rules",
        corrected_rules_text: `Corrected rules for Card ${index}`,
        official_wording: `The corrected rules for Card ${index} apply to all Printings.`,
        applies_to_parallel_printings: true,
        source: {
          fragment: `#errata_work_unit_${index}`,
          display_name: `OP96-${String(index + 1).padStart(3, "0")} Synthetic reviewed Card ${index}`,
          image_url: `https://en.onepiece-cardgame.com/images/rules/cards/OP96-${String(index + 1).padStart(3, "0")}.png`,
        },
        completeness: completeEvidence(),
      })),
    };
  }
  if (scenario === "card-only-work-units" || scenario === "card-only-work-units-changed") {
    return {
      cards: Array.from({ length: 32 }, (_, offset) => {
        const index = offset + (scenario.endsWith("changed") ? 8 : 0);
        return {
          card: {
            game: "one-piece",
            official_identity: { kind: "card_number", value: `OP92-${String(index + 1).padStart(3, "0")}` },
            name: `Synthetic Card without Printing ${index}`,
            effective_rules_text: "Official rules without an appearance.",
            game_data: { profile: "one-piece@1", attributes: onePieceLeaderAttributes() },
          },
          completeness: completeEvidence(),
          memberships: { products: [], distribution_contexts: [], source_buckets: [] },
          product_release_catalogue: {
            products: [
              {
                reference: { kind: "official_code", value: `WU-${index}` },
                official_code: `WU-${index}`,
                name: `Synthetic Product ${index} ${"Source product text. ".repeat(200)}`,
                releases: [
                  { region: "EN-OCEANIA", date: { precision: "month", value: "2026-12" }, status: "announced" },
                ],
              },
            ],
            distribution_contexts: [
              {
                key: `work-unit-context-${index}`,
                kind: "promotion",
                label: `Synthetic Context ${index} ${"Source context text. ".repeat(200)}`,
                product_reference: { kind: "official_code", value: `WU-${index}` },
                evidence_category: "explicit",
              },
            ],
            relationships: [],
          },
        };
      }),
    };
  }
  if (scenario === "metadata-request-pages") {
    const index = Number(new URL(requestUrl).searchParams.get("request"));
    return {
      cards: [
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: `OP93-${String(index + 1).padStart(3, "0")}`,
          name: `Synthetic metadata page ${index}`,
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
          locator: `/official/metadata-page/${index}`,
          lineageMarker: `metadata-page-${index}`,
        }),
      ],
    };
  }
  if (scenario === "erratum-target-large-text") {
    return {
      cards: [
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: "OP01-001",
          name: "Synthetic Erratum target",
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
          locator: "/official/erratum-target",
          lineageMarker: "erratum-target",
        }),
        ...Array.from({ length: 2 }, (_, index) => ({
          kind: "official_erratum",
          game: "one-piece",
          target: { type: "card", official_identity: { kind: "card_number", value: "OP01-001" } },
          published_on: "2026-07-31",
          effective_from: null,
          observed_printed_rules_text: "Official printed rules",
          corrected_rules_text: "Official effective rules",
          official_wording: "Synthetic wording. ".repeat(35000),
          applies_to_parallel_printings: true,
          source: {
            fragment: `#large_erratum_${index}`,
            display_name: "OP01-001 Synthetic Erratum target",
            image_url: "https://en.onepiece-cardgame.com/images/rules/cards/OP01-001.png",
          },
          completeness: completeEvidence(),
        })),
      ],
    };
  }
  if (scenario.startsWith("identity-correction-")) {
    return {
      cards: [
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: scenario.startsWith("identity-correction-renumbered") ? "OP94-002" : "OP94-001",
          name: "Synthetic corrected identity",
          locator:
            scenario === "identity-correction-discovered" ? "/official/correction/new" : "/official/correction/stable",
          lineageMarker:
            scenario === "identity-correction-discovered" || scenario.endsWith("contradictory") ? "different" : "same",
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
        }),
      ],
    };
  }
  if (scenario === "identity-many-mappings") {
    return {
      cards: Array.from({ length: 101 }, (_, index) =>
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: "OP95-001",
          name: "Synthetic mapping pagination",
          locator: `/official/mapping/${index}`,
          lineageMarker: "mapping-pagination",
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
        }),
      ),
    };
  }
  if (scenario.startsWith("identity-missing-number")) {
    const observation = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: "OP97-001",
      locator: scenario.endsWith("distinct")
        ? "/official/other-unnumbered-card"
        : scenario.endsWith("moved")
          ? "/official/moved-unnumbered-real-card"
          : "/official/unnumbered-real-card",
      lineageMarker:
        scenario.endsWith("distinct") || scenario.endsWith("changed") ? "different" : "unnumbered-real-card",
      name: "Synthetic unnumbered Card",
      cardAttributes: onePieceLeaderAttributes(),
      printingAttributes: { illustration_types: [] },
    });
    if (scenario.includes("tabular")) {
      const { card, ...evidence } = observation;
      return { rows: [{ cells: [null, card.name, card.effective_rules_text, card.game_data.attributes], evidence }] };
    }
    return {
      cards: [{ ...observation, card: { ...observation.card, official_identity: { kind: "unknown", value: null } } }],
    };
  }
  if (scenario.startsWith("canonical-tabular")) {
    const source = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      locator: "/supplemental/independent-id",
      lineageMarker: "canonical-cross-source",
      cardNumber: "OP96-001",
      name: "Synthetic exact cross-source Card",
      cardAttributes: onePieceLeaderAttributes(),
      printingAttributes: { illustration_types: [] },
    });
    if (!scenario.endsWith("ambiguous") && !scenario.endsWith("unresolved"))
      source.identity_evidence.artwork_fingerprint =
        'official-artwork:{"official_card_identity":"OP96-001","roles":["front"],"artwork_id":"publisher-appearance-1"}';
    source.appearance_evidence.images.forEach((image) => {
      image.artwork_fingerprint = source.identity_evidence.artwork_fingerprint;
    });
    if (scenario.endsWith("unresolved")) source.identity_evidence.demonstrably_novel = false;
    if (scenario.endsWith("unrelated")) source.printing.game_data.attributes.illustration_types = ["original"];
    const { card, ...evidence } = source;
    return {
      rows: [
        {
          cells: [
            scenario.endsWith("missing-number") ? null : card.official_identity.value,
            card.name,
            card.effective_rules_text,
            card.game_data.attributes,
          ],
          evidence,
        },
      ],
    };
  }
  if (scenario.startsWith("canonical-official")) {
    const source = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      locator: "/official/unrelated-id",
      lineageMarker: "canonical-cross-source",
      cardNumber: "OP96-001",
      name: "Synthetic exact cross-source Card",
      cardAttributes: onePieceLeaderAttributes(),
      printingAttributes: { illustration_types: [] },
    });
    if (!scenario.endsWith("ambiguous"))
      source.identity_evidence.artwork_fingerprint =
        'official-artwork:{"official_card_identity":"OP96-001","roles":["front"],"artwork_id":"publisher-appearance-1"}';
    source.appearance_evidence.images.forEach((image) => {
      image.artwork_fingerprint = source.identity_evidence.artwork_fingerprint;
    });
    return { cards: [source] };
  }
  if (scenario === "source-refresh-supplemental") {
    return {
      cards: [
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: "OP02-002",
          name: "Synthetic supplemental Card",
          locator: "/supplemental/independent-card",
          lineageMarker: "different",
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
        }),
      ],
    };
  }
  if (scenario === "source-refresh-empty-errata") return { cards: [] };
  if (scenario === "game-scoped-warning")
    return {
      cards: [
        {
          ...printingObservation({
            game: "one-piece",
            profile: "one-piece@1",
            cardNumber: "OP94-997",
            name: "Game scoped warning",
            locator: "game-scoped-warning",
            lineageMarker: "game-scoped-warning",
            cardAttributes: onePieceLeaderAttributes(),
            printingAttributes: { illustration_types: [] },
          }),
          unknown_game_field: "Synthetic game-specific source warning",
        },
      ],
    };
  if (
    scenario === "curated-conflict-fanout-base" ||
    scenario === "curated-conflict-fanout-changed" ||
    scenario === "prior-state-text-pages" ||
    scenario === "prior-state-carry-forward" ||
    scenario === "withdrawal-work-units"
  ) {
    return {
      cards: Array.from({ length: 32 }, (_, offset) => {
        const index = offset + (scenario === "prior-state-carry-forward" ? 8 : 0);
        return {
          ...printingObservation({
            game: "one-piece",
            profile: "one-piece@1",
            cardNumber: `OP96-${String(index + 1).padStart(3, "0")}`,
            name: `Synthetic ${scenario.endsWith("changed") ? "changed" : "reviewed"} Card ${index}`,
            cardAttributes: onePieceLeaderAttributes(),
            printingAttributes: { illustration_types: [] },
            locator: `/curated-conflict-fanout/${index}`,
            lineageMarker: `curated-conflict-fanout-${index}`,
            ...(scenario === "prior-state-text-pages" ? { printedRulesText: "Prior printed text. ".repeat(1000) } : {}),
          }),
          ...(scenario === "withdrawal-work-units"
            ? {
                withdrawal: {
                  entity: "printing",
                  state: "withdrawn",
                  effective_at: "2026-07-01T00:00:00.000Z",
                  evidence: "Official withdrawal notice",
                },
              }
            : {}),
        };
      }),
    };
  }
  if (scenario === "curated-draft-source-changed") {
    const observation = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: "OP01-001",
      name: "Changed Official Card name",
      cardAttributes: onePieceLeaderAttributes(),
      printingAttributes: { illustration_types: [] },
      locator: "/official/base",
      lineageMarker: "one-piece",
    });
    observation.card.effective_rules_text = "Changed Official effective rules";
    return { cards: [observation] };
  }
  if (scenario === "product-group-large-text") {
    return {
      cards: Array.from({ length: 2 }, (_, index) => ({
        ...printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: "OP97-001",
          name: "Synthetic Product evidence Card",
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
          locator: `/product-group-large-text/${index}`,
          lineageMarker: "product-group-large-text",
        }),
        product_release_catalogue: {
          products: [
            {
              reference: { kind: "official_code", value: "GROUP-1" },
              official_code: "GROUP-1",
              name: "Synthetic name. ".repeat(40000),
              releases: [],
              withdrawal: null,
            },
          ],
          distribution_contexts: [],
          relationships: [],
        },
      })),
    };
  }
  if (scenario === "prior-candidate-stream") {
    return {
      cards: Array.from({ length: 64 }, (_, index) =>
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: `OP98-${String(index + 1).padStart(3, "0")}`,
          name: `Synthetic prior Card ${index}`,
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
          locator: `/prior-candidate-stream/${index}`,
          lineageMarker: `prior-candidate-stream-${index}`,
          printedRulesText: "Synthetic printed text. ".repeat(1000),
        }),
      ),
    };
  }
  if (/^bounded-evidence-volume-[0-8]$/u.test(scenario)) {
    const index = Number(scenario.at(-1));
    return {
      cards: [
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: `OP97-${String(index + 1).padStart(3, "0")}`,
          name: `Synthetic bounded evidence Card ${index}`,
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
          locator: `/${scenario}`,
          lineageMarker: scenario,
          printedRulesText: "Synthetic source text. ".repeat(180_000),
        }),
      ],
    };
  }
  if (scenario === "large-card-content") {
    return {
      cards: [
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: "OP98-999",
          name: "Synthetic large card content",
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
          locator: "/large-card-content",
          lineageMarker: "large-card-content",
          printedRulesText: "Synthetic printed text. ".repeat(60_000),
        }),
      ],
    };
  }
  if (scenario === "profile-don-card") {
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
    };
  }
  if (/^observation-count-(?:100|124|149)$/u.test(scenario)) {
    const count = Number(scenario.slice("observation-count-".length));
    return {
      cards: Array.from({ length: count }, (_, index) =>
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: `OP98-${String(index + 1).padStart(3, "0")}`,
          name: `Observation count sentinel ${index + 1}`,
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
          locator: `/official/count-sentinel-${index + 1}`,
          lineageMarker: `count-sentinel-${index + 1}`,
        }),
      ),
    };
  }
  if (scenario === "complete-empty-lineage") {
    return { cards: [] };
  }
  const searchRepairRetention = /^search-repair-retention-([1-5])$/.exec(scenario);
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
      name: isLongitudinal ? "Longitudinal Errata Rules Card" : "Errata Rules Card",
      cardAttributes: {
        ...onePieceLeaderAttributes(),
        effect_text: "[On Play] Draw 1 card.",
      },
      printingAttributes: { illustration_types: [] },
      locator: isLongitudinal ? "/official/errata/OP29-006" : "/official/errata/OP29-001",
      lineageMarker: isLongitudinal ? "errata-card-rules-text-longitudinal" : "errata-card-rules-text",
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
              official_wording: isSecondVersion
                ? isLongitudinal
                  ? 'For the longitudinal Card, replace the corrected "discard 1 card" with "discard 2 cards".'
                  : 'Replace the corrected "discard 1 card" with "discard 2 cards".'
                : isLongitudinal
                  ? 'For the longitudinal Card, replace "Draw 1 card" with "Draw 2 cards, then discard 1 card".'
                  : 'Replace "Draw 1 card" with "Draw 2 cards, then discard 1 card".',
              corrected_value: isSecondVersion
                ? "[On Play] Draw 2 cards, then discard 2 cards."
                : "[On Play] Draw 2 cards, then discard 1 card.",
              ...(isSecondVersion ? { effective_from: "2026-07-15" } : {}),
            },
          ],
        },
      ],
    };
  }
  if (scenario === "gundam-errata-cross-lineage-asia" || scenario === "gundam-errata-cross-lineage-us") {
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
      cards: [
        {
          ...observation,
          card: {
            ...observation.card,
            effective_rules_text: "Printed cross-lineage rules.",
          },
          errata: [
            {
              authority: "official_errata",
              field: "effective_rules_text",
              target_type: "card",
              effective_from: "2026-07-01",
              official_wording: "Use corrected cross-lineage rules.",
              corrected_value: "Corrected cross-lineage rules.",
            },
          ],
        },
      ],
    };
  }
  if (scenario === "gundam-current-run-errata-asia" || scenario === "gundam-current-run-errata-us") {
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
      cards: [
        {
          ...observation,
          card: {
            ...observation.card,
            effective_rules_text: isUs ? "Superseded US source rules." : "Superseded Asia source rules.",
          },
          ...(isUs
            ? {
                errata: [
                  {
                    authority: "official_errata",
                    field: "effective_rules_text",
                    target_type: "card",
                    effective_from: "2026-07-01",
                    official_wording: "Use the authoritative current Card wording.",
                    corrected_value: "Authoritative current Card wording.",
                  },
                ],
              }
            : {}),
        },
      ],
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
      cards: [
        {
          ...observation,
          card: {
            ...observation.card,
            effective_rules_text: "Rules before the future Erratum.",
          },
          errata: [
            {
              authority: "official_errata",
              field: "effective_rules_text",
              target_type: "card",
              effective_from: "2026-08-01",
              official_wording: "Use rules after the future boundary.",
              corrected_value: "Rules after the future boundary.",
            },
          ],
        },
      ],
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
              official_wording: "Correction applies to this Printing only.",
              corrected_value: "Printing-scoped corrected wording.",
            },
          ],
        },
      ],
    };
  }
  if (scenario === "errata-conflicting-effective-text" || scenario === "errata-null-effective-text") {
    const observation = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: scenario === "errata-null-effective-text" ? "OP29-004" : "OP29-005",
      name: scenario === "errata-null-effective-text" ? "Removed Rules Text Card" : "Conflicting Errata Card",
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
                    official_wording: "Remove the rules text from this Card.",
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
              official_wording: "Apply the updated timing described in the accompanying diagram.",
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
      cards: [
        {
          ...observation,
          errata: [
            {
              authority: "official_errata",
              field: "effective_rules_text",
              target_type: "card",
              effective_from: "2026-07-01",
              official_wording: "Use the exact corrected wording.",
              corrected_value: "Exact corrected wording.",
              editorial_note: "This undeclared field is not authoritative.",
            },
          ],
        },
      ],
    };
  }
  if (scenario === "capacity-single-observation") {
    return {
      cards: [
        {
          ...printingObservation({
            game: "one-piece",
            profile: "one-piece@1",
            cardNumber: "OP94-999",
            name: "Synthetic indivisible capacity failure",
            locator: "capacity-record",
            lineageMarker: "capacity-record",
            cardAttributes: onePieceLeaderAttributes(),
            printingAttributes: { illustration_types: [] },
          }),
          [`unrecognized_${"x".repeat(600000)}`]: "Synthetic oversized field identity",
        },
      ],
    };
  }
  if (scenario === "capacity-high-degree-observation") {
    return {
      cards: [
        printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: "OP94-998",
          name: "Synthetic high degree record",
          locator: "capacity-high-degree",
          lineageMarker: "capacity-high-degree",
          cardAttributes: {
            ...onePieceLeaderAttributes(),
            traits: Array.from({ length: 40000 }, (_, index) => `Synthetic trait ${String(index).padStart(8, "0")}`),
          },
          printingAttributes: { illustration_types: [] },
        }),
      ],
    };
  }
  if (scenario === "single-card-warning-work-units") {
    return {
      cards: [
        {
          ...printingObservation({
            game: "one-piece",
            profile: "one-piece@1",
            cardNumber: "OP93-001",
            name: "Synthetic Card with many source warnings",
            locator: "many-warnings",
            lineageMarker: "many-warnings",
            cardAttributes: onePieceLeaderAttributes(),
            printingAttributes: { illustration_types: [] },
          }),
          ...Object.fromEntries(
            Array.from({ length: 64 }, (_, index) => [
              `unrecognized_${index}_${"x".repeat(100)}`,
              "Synthetic undeclared source field",
            ]),
          ),
        },
      ],
    };
  }
  if (scenario === "scale-warning-partitions") {
    return {
      cards: Array.from({ length: 64 }, (_, index) => ({
        ...printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: `OP94-${String(index + 1).padStart(3, "0")}`,
          name: `Synthetic warning Card ${index}`,
          locator: `warning-${index}`,
          lineageMarker: `warning-${index}`,
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
        }),
        [`unrecognized_${index}_${"x".repeat(9000)}`]: "Synthetic undeclared source field",
      })),
    };
  }
  if (scenario.startsWith("scale-128-images-")) {
    return {
      cards: Array.from({ length: 8 }, (_, offset) => {
        const index = Number(scenario.slice("scale-128-images-".length)) * 8 + offset;
        const observation = printingObservation({
          game: "one-piece",
          profile: "one-piece@1",
          cardNumber: `OP95-${String(index + 1).padStart(3, "0")}`,
          name: `Synthetic image capacity Card ${index + 1}`,
          locator: `image-capacity-${index}`,
          lineageMarker: `image-capacity-${index}`,
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
        });
        const bytes = Buffer.from(deterministicNoise(index + 1, 100 * 1024));
        observation.appearance_evidence.images[0]!.content_base64 = bytes.toString("base64");
        observation.appearance_evidence.images[0]!.content_sha256 = createHash("sha256").update(bytes).digest("hex");
        return observation;
      }),
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
        }),
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
    scenario === "dedicated-printing-erratum-missing" ||
    scenario === "dedicated-card-nonparallel-erratum"
  ) {
    const nonParallelCard = scenario === "dedicated-card-nonparallel-erratum";
    const locator =
      scenario === "dedicated-printing-erratum"
        ? "/official/dedicated-multi/base"
        : scenario === "dedicated-printing-erratum-ambiguous"
          ? "/official/multi/shared"
          : "/official/multi/missing";
    return {
      cards: [
        {
          kind: "official_erratum",
          game: "one-piece",
          target: nonParallelCard
            ? {
                type: "card",
                official_identity: {
                  kind: "card_number",
                  value: "OP05-006",
                },
              }
            : {
                type: "printing",
                official_identity: {
                  kind: "card_number",
                  value: scenario === "dedicated-printing-erratum" ? "OP05-006" : "OP05-005",
                },
                locator,
              },
          published_on: "2026-07-31",
          effective_from: null,
          observed_printed_rules_text: "Official printed rules",
          corrected_rules_text: "Printing-scoped corrected rules",
          official_wording: "Before: Official printed rules\nAfter: Printing-scoped corrected rules",
          applies_to_parallel_printings: false,
          source: {
            fragment: "#errata_fixture_printing",
            display_name:
              scenario === "dedicated-printing-erratum" || nonParallelCard
                ? "OP05-006 Dedicated Printing Erratum Card"
                : "OP05-005 Multiple Printing Card",
            image_url: `https://en.onepiece-cardgame.com/images/rules/cards/${
              scenario === "dedicated-printing-erratum" || nonParallelCard ? "OP05-006" : "OP05-005"
            }.png`,
          },
          completeness: completeEvidence(),
        },
      ],
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
      name: dedicated ? "Dedicated Printing Erratum Card" : "Multiple Printing Card",
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
              source_url: `https://official-source.invalid/images/${dedicated ? "OP05-006" : "OP05-005"}-alt.png`,
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
  if (scenario === "product-lifecycle-first" || scenario === "product-lifecycle-multiple") {
    const base = printingObservation({
      game: "one-piece",
      profile: "one-piece@1",
      cardNumber: scenario === "product-lifecycle-first" ? "OP11-011" : "OP12-012",
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
              source_url: "https://official-source.invalid/images/OP12-012-alt.png",
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
  if (scenario === "deterministic-forward" || scenario === "deterministic-reverse") {
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
          source_url: "https://official-source.invalid/images/OP10-010-alt.png",
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
      cards: scenario === "deterministic-forward" ? [base, alternate] : [alternate, base],
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
          cardNumber: scenario === "union-fusion-world" ? "FB99-999" : "FB01-001",
          name: scenario === "union-fusion-world" ? "Union Son Goku" : "Son Goku",
          cardAttributes: {
            card_type: "battle",
            colours: ["red"],
            cost: scenario === "profile-invalid-number" ? -1 : 1,
            specified_cost: [
              {
                colour: "red",
                count: 1,
                ...(scenario === "profile-nested-unknown" ? { new_metric: "retained raw" } : {}),
              },
            ],
            power: 10000,
            combo_power: 5000,
            traits: ["Saiyan"],
            skills: [
              {
                kind: "ordinary",
                text: "Official skill",
                ...(scenario === "profile-nested-unknown" ? { new_label: "retained raw" } : {}),
              },
            ],
          },
          printingAttributes: {},
          locator:
            scenario === "union-fusion-world" ? "/official/fusion-world/FB99-999" : "/official/fusion-world/FB01-001",
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
      cards: [
        {
          ...observation,
          appearance_evidence: {
            images: [
              {
                role: "front",
                source_url: "https://www.dbs-cardgame.com/fw/images/FB01-001-front.webp",
                artwork_fingerprint: observation.identity_evidence.artwork_fingerprint,
                media_type: "image/webp",
                width: 744,
                height: 1039,
                content_sha256: "46f3e4bfb8bc9956482a6491e9b968d82e6fd544da44f9f36d93b443b845f773",
                content_base64: "ZnVzaW9uLWZyb250LWltYWdl",
              },
              {
                role: "back",
                source_url: "https://www.dbs-cardgame.com/fw/images/FB01-001-back.webp",
                artwork_fingerprint: observation.identity_evidence.artwork_fingerprint,
                media_type: "image/webp",
                width: 744,
                height: 1039,
                content_sha256: "eed832d958fc4054fffb3027319dcd914448475c226ce55ae8053a442ed1b2cf",
                content_base64: "ZnVzaW9uLWJhY2staW1hZ2U=",
              },
            ],
          },
        },
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
          cardNumber: scenario.startsWith("gundam-mirror-") ? "GD95-001" : "GD99-001",
          name: scenario === "gundam-card-conflict" ? "Contradictory US name" : "Cross-locale Gundam",
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
          variantKey: scenario === "gundam-cross-variant-conflict" ? "alternate" : "base",
          lineageMarker: "gundam-cross",
          memberships:
            scenario === "gundam-cross-us-empty"
              ? {
                  products: [],
                  distribution_contexts: [],
                  source_buckets: [],
                }
              : {
                  products: [scenario === "gundam-cross-product-conflict" ? "product_gd99_other" : "product_gd99"],
                  distribution_contexts: [],
                  source_buckets: ["gundam-card-list"],
                },
          printedFieldsMarker: scenario === "gundam-cross-conflict" ? "conflicting" : "shared",
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
  const productReleaseCatalogue = productReleaseCatalogueForScenario(scenario);
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
          ...(productReleaseCatalogue === undefined ? {} : { product_release_catalogue: productReleaseCatalogue }),
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
          ...(productReleaseCatalogue === undefined ? {} : { product_release_catalogue: productReleaseCatalogue }),
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
  if (scenario === "withdrawn-longitudinal" || scenario === "withdrawn-longitudinal-corroboration") {
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
          locator: scenario === "semantic-evidence-base" ? "/official/evidence/base" : "/official/evidence/relocated",
          lineageMarker: "semantic-evidence",
          memberships: {
            products: ["product_op10"],
            distribution_contexts: [],
            source_buckets: [
              scenario === "semantic-evidence-source-bucket" ? "secondary-card-list" : "primary-card-list",
            ],
          },
        }),
      ],
    };
  }
  if (scenario.startsWith("gundam-printing-")) {
    const formatting = scenario.includes("-format-");
    const usSurface = scenario.includes("-us-");
    const historicalProductConflict = scenario.endsWith("-disappearance-us-product-conflict");
    const printingAuthorityConflict = scenario.endsWith("-disappearance-us-printing-conflict");
    const substantiveConflict =
      (scenario.includes("-conflict-") && usSurface) ||
      printingAuthorityConflict ||
      scenario.endsWith("-disappearance-asia-conflict");
    const authorityAfterDisappearance = scenario.endsWith("-disappearance-us-conflict");
    const reverseAuthorityConflict = scenario.endsWith("-disappearance-asia-conflict");
    const cardNumber = scenario.includes("-lifecycle-primary-")
      ? "GD90-001"
      : scenario.includes("-lifecycle-reverse-")
        ? "GD89-001"
        : authorityAfterDisappearance || printingAuthorityConflict || historicalProductConflict
          ? "GD94-001"
          : reverseAuthorityConflict
            ? "GD91-001"
            : formatting
              ? scenario.endsWith("-asia-first") || scenario.endsWith("-us-second")
                ? "GD94-001"
                : "GD93-001"
              : scenario.endsWith("-asia-first") || scenario.endsWith("-us-second")
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
          rarityRaw: substantiveConflict ? "Leader Rare" : formatting && usSurface ? "  L  " : "L",
          locator: `/official/gundam/${scenario}`,
          variantKey: "base",
          lineageMarker: `gundam-printing-${cardNumber}`,
          memberships: {
            products: [
              historicalProductConflict
                ? `product_${cardNumber.slice(0, 4).toLowerCase()}_other`
                : `product_${cardNumber.slice(0, 4).toLowerCase()}`,
            ],
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
          name: variantScenario ? "Historical locator variant" : "Historical locator binding",
          cardAttributes: onePieceLeaderAttributes(),
          printingAttributes: { illustration_types: [] },
          locator: variantScenario ? "/official/locator-variant/stable" : "/official/locator-binding/stable",
          variantKey:
            scenario === "locator-variant-v1" ? "suffix-a" : scenario === "locator-variant-v2" ? "suffix-b" : undefined,
          lineageMarker: scenario === "locator-binding-incompatible" ? "different" : "locator-binding",
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
    const conflictPairOne = scenario === "gundam-conflict-us-first" || scenario === "gundam-conflict-asia-second";
    const conflictPairTwo = scenario === "gundam-conflict-asia-first" || scenario === "gundam-conflict-us-second";
    return {
      cards: [
        printingObservation({
          game: "gundam",
          profile: "gundam@1",
          cardNumber: conflictPairOne ? "GD97-001" : conflictPairTwo ? "GD96-001" : "GD98-001",
          name:
            scenario === "gundam-authority-asia"
              ? "Formatting equivalent name"
              : scenario === "gundam-authority-us-conflict"
                ? "Later contradictory US name"
                : scenario === "gundam-authority-us"
                  ? "  Formatting   equivalent name  "
                  : scenario === "gundam-conflict-asia-second" || scenario === "gundam-conflict-us-second"
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
            products: [conflictPairOne ? "product_gd97" : conflictPairTwo ? "product_gd96" : "product_gd98"],
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
                : scenario === "not-demonstrably-novel" || incompleteAppearance
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
            illustration_types: unknownVocabulary ? ["etched-future"] : [],
          },
          locator: conflict
            ? "/official/conflict"
            : canonical
              ? `/official/${scenario}`
              : newLocator
                ? "/official/renamed"
                : `/official/${scenario}`,
          lineageMarker: scenario === "not-demonstrably-novel" || incompleteAppearance ? "different" : "one-piece",
          demonstrablyNovel: scenario !== "not-demonstrably-novel",
          includeAppearance: !incompleteAppearance,
          treatment: scenario === "conflict-changed" ? "parallel-foil" : "standard",
          memberships: newLocator
            ? {
                products: ["product_promotion"],
                distribution_contexts: ["context_event"],
                source_buckets: ["promotion-list"],
              }
            : scenario === "product-identity-inferred" || scenario === "product-identity-typed"
              ? {
                  products: ["IDENTITY-INFERRED"],
                  distribution_contexts: [],
                  source_buckets: ["identity-product-list"],
                }
              : scenario === "product-release" || scenario === "product-release-multiple-events"
                ? {
                    products: ["ST-15"],
                    distribution_contexts: ["championship-2026-pack"],
                    source_buckets: ["starter-deck-card-list"],
                  }
                : scenario === "product-typed-relationships" || scenario === "product-typed-relationships-changed"
                  ? {
                      products: ["CODE-X"],
                      distribution_contexts: ["typed-context"],
                      source_buckets: ["typed-source-bucket"],
                    }
                  : undefined,
        }),
        ...(productReleaseCatalogue === undefined ? {} : { product_release_catalogue: productReleaseCatalogue }),
        ...(unknownVocabulary ? { new_official_label: "Bandai-added-value" } : {}),
        ...(setCountMismatch
          ? {
              completeness: {
                ...completeEvidence(),
                declared_record_count: 2,
              },
            }
          : {}),
        ...(["withdrawn", "reinstated"].includes(scenario)
          ? {
              withdrawal: {
                entity: "printing",
                state: scenario === "reinstated" ? "reinstated" : "withdrawn",
                effective_at: scenario === "reinstated" ? "2026-08-01T00:00:00.000Z" : "2026-07-01T00:00:00.000Z",
                evidence:
                  scenario === "reinstated" ? "Explicit publisher reinstatement notice" : "Official withdrawal notice",
              },
            }
          : {}),
      },
    ],
  };
}

function productReleaseCatalogueForScenario(scenario: string): Record<string, unknown> | undefined {
  const officialReference = (value: string) => ({
    kind: "official_code",
    value,
  });
  if (scenario === "product-release" || scenario === "product-release-multiple-events") {
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
              ? [
                  {
                    event_key: "oceania-retail-release",
                    region: "EN-OCEANIA",
                    date: { precision: "day", value: "2026-09-18" },
                    status: "released",
                  },
                ]
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
              date: second ? { precision: "day", value: "2026-10-17" } : { precision: "month", value: "2026-10" },
              status: second ? "released" : "announced",
            },
          ],
        },
      ],
      distribution_contexts: [],
      relationships: [],
    };
  }
  if (scenario === "product-context-conflict-a" || scenario === "product-context-conflict-b") {
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
          label: second ? "Conflicting Tournament Context" : "Conflicting Promotion Context",
          product_reference: officialReference("ST-CONTEXT-CONFLICT"),
          evidence_category: "explicit",
        },
      ],
      relationships: [],
    };
  }
  if (scenario === "product-typed-relationships" || scenario === "product-typed-relationships-changed") {
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
        ...(scenario === "product-typed-relationships-changed"
          ? []
          : [
              {
                kind: "product-card",
                product_reference: { kind: "name", value: "CODE-X" },
                card_reference: { kind: "current_card" },
                evidence_category: "derived",
                resolution: "deterministic",
              },
            ]),
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
          name: scenario === "product-standalone-v1" ? "Standalone Product" : "Renamed Standalone Product",
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
          : scenario.startsWith("product-identity-distinct-code") || scenario === "product-identity-ambiguous-name"
            ? "Same-name Distinct-code Product"
            : scenario === "product-identity-name" || scenario === "product-identity-coded"
              ? "Name-to-code Identity Product"
              : "Inferred-to-typed Identity Product";
    const officialCode =
      scenario === "product-identity-name" || scenario === "product-identity-ambiguous-name"
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
          reference: officialCode === null ? { kind: "name", value: name } : officialReference(officialCode),
          official_code: officialCode,
          name,
          releases: [],
        },
      ],
      distribution_contexts: [],
      relationships: [
        {
          kind: "product-card",
          product_reference: officialCode === null ? { kind: "name", value: name } : officialReference(officialCode),
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
  if (scenario === "product-explicit-derived" || scenario === "product-deterministic-explicit") {
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
    const region = scenario === "gundam-product-asia" ? "EN-ASIA" : "EN-US";
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
  const artworkFingerprint = `sha256:${input.lineageMarker === "different" ? "c".repeat(64) : "a".repeat(64)}`;
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
      printed_rules_text: input.printedRulesText ?? "Official printed rules",
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
      printed_fields_digest: `sha256:${input.printedFieldsMarker === "conflicting" ? "d".repeat(64) : "b".repeat(64)}`,
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
    memberships: input.memberships ?? {
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
