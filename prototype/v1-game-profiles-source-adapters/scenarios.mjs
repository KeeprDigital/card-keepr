export const scenarios = [
  {
    key: "1",
    name: "One Piece repeated Recording membership",
    question: "Does one source record stay one Printing while retaining multiple source memberships?",
    operation: "run",
    input: {
      required_areas: ["card-list", "products", "restrictions", "errata"],
      completed_areas: ["card-list", "products", "restrictions", "errata"],
      partitions: [
        { key: "recording:synthetic-a", rendered_count: 2, parsed_count: 2, prior_count: 2 },
        { key: "recording:synthetic-b", rendered_count: 1, parsed_count: 1, prior_count: 1 }
      ],
      candidate: {
        card: {
          official_identity: { kind: "card_number", value: "DEMO-001" },
          game_data: {
            profile: "one-piece@1",
            attributes: {
              card_type: "character",
              colours: ["red"],
              cost: 3,
              life: null,
              battle_attributes: ["strike"],
              power: 5000,
              counter: 1000,
              traits: ["Synthetic Crew"],
              block_icons: ["9"],
              effect_text: "Synthetic effect.",
              trigger_text: null
            }
          }
        },
        printing: {
          source_locator: "DEMO-001_p1",
          rarity: { normalized: "rare", raw: "R" },
          recording_memberships: ["synthetic-a", "synthetic-b"]
        }
      }
    }
  },
  {
    key: "2",
    name: "One Piece DON!! boundary",
    question: "Can the generic DON!! Card exist truthfully without Printings or image coverage?",
    operation: "run",
    input: {
      required_areas: ["play-guide"],
      completed_areas: ["play-guide"],
      partitions: [{ key: "play-guide", rendered_count: 1, parsed_count: 1, prior_count: 1 }],
      candidate: {
        card: {
          official_identity: { kind: "functional_designation", value: "DON!!" },
          name: "DON!! Card",
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
              effect_text: "Synthetic rules-level function.",
              trigger_text: null
            }
          },
          printings: []
        },
        coverage_statement: "DON!! Printings and Printing Images are intentionally excluded."
      }
    }
  },
  {
    key: "3",
    name: "Fusion World suffixed-only Leader",
    question: "Does the contract avoid inventing a base Printing and require both Leader faces?",
    operation: "run",
    input: {
      required_areas: ["card-list", "products", "legality", "errata"],
      completed_areas: ["card-list", "products", "legality", "errata"],
      partitions: [
        { key: "card_type:leader", rendered_count: 80, parsed_count: 80, prior_count: 74 }
      ],
      candidate: {
        card: {
          official_identity: { kind: "card_number", value: "DEMO-L01" },
          game_data: {
            profile: "fusion-world@1",
            attributes: {
              card_type: "leader",
              colours: ["blue"],
              cost: null,
              specified_cost: [],
              power: 15000,
              combo_power: null,
              traits: ["Synthetic Trait"],
              skills: [
                { kind: "front", text: "Synthetic front skill." },
                { kind: "back", text: "Synthetic back skill." }
              ],
              leader_faces: [
                {
                  role: "front",
                  name: "Synthetic Leader",
                  power: 15000,
                  traits: ["Synthetic Trait"],
                  skills: "Synthetic front skill."
                },
                {
                  role: "back",
                  name: "Awakened Synthetic Leader",
                  power: 20000,
                  traits: ["Synthetic Trait"],
                  skills: "Synthetic back skill."
                }
              ]
            }
          }
        },
        printing: {
          source_locator: ["DEMO-L01", "_p2"],
          synthesized_base: false,
          image_roles: ["front", "back"]
        }
      }
    }
  },
  {
    key: "4",
    name: "Unresolved source cap",
    question: "Does a broad-query cap block publication instead of silently truncating coverage?",
    operation: "run",
    input: {
      required_areas: ["card-list"],
      completed_areas: ["card-list"],
      partitions: [
        {
          key: "fusion-world:battle",
          rendered_count: 0,
          parsed_count: 0,
          prior_count: 1200,
          cap_signal: "Too many search results"
        }
      ],
      candidate: { discovered_printings: 0 }
    }
  },
  {
    key: "5",
    name: "Digimon unknown mechanic",
    question: "Does an unknown optional source label survive without leaking into the Game Profile?",
    operation: "run",
    input: {
      required_areas: ["card-list", "products", "restrictions", "errata"],
      completed_areas: ["card-list", "products", "restrictions", "errata"],
      partitions: [
        { key: "category:synthetic", rendered_count: 120, parsed_count: 120, prior_count: 118 }
      ],
      unknown_fields: [
        {
          label: "[Synthetic Future Mechanic]",
          observation_id: "observation_demo_future_mechanic",
          raw_value: "Preserved verbatim"
        }
      ],
      candidate: {
        card: {
          official_identity: { kind: "card_number", value: "DEMO-D01" },
          game_data: {
            profile: "digimon@1",
            attributes: {
              card_type: "digimon",
              colours: ["blue"],
              level: 4,
              play_cost: 5,
              use_cost: null,
              dp: 6000,
              form: "Synthetic Form",
              attribute: "Synthetic Attribute",
              traits: ["Synthetic Trait"],
              digivolution_requirements: [],
              text_sections: [{ kind: "effect", text: "Synthetic effect." }],
              dual_colours: [],
              dual_cost: null,
              link_dp: null
            }
          }
        },
        source_observation_unknown_fields: {
          "[Synthetic Future Mechanic]": "Preserved verbatim"
        }
      }
    }
  },
  {
    key: "6",
    name: "Digimon missing category",
    question: "Does one unfetched live category make catalogue completeness unprovable?",
    operation: "run",
    input: {
      required_areas: ["category:synthetic-a", "category:synthetic-b"],
      completed_areas: ["category:synthetic-a"],
      partitions: [
        { key: "category:synthetic-a", rendered_count: 40, parsed_count: 40, prior_count: 40 }
      ],
      candidate: { discovered_printings: 40 }
    }
  },
  {
    key: "7",
    name: "Gundam corroborated cross-locale Printing",
    question: "Can one Printing retain two source records while Releases and Legality stay regional?",
    operation: "run",
    input: {
      required_areas: ["en-asia", "en-us", "products", "legality", "errata"],
      completed_areas: ["en-asia", "en-us", "products", "legality", "errata"],
      partitions: [
        { key: "en-asia:package:demo", rendered_count: 10, parsed_count: 10, prior_count: 10 },
        { key: "en-us:package:demo", rendered_count: 10, parsed_count: 10, prior_count: 10 }
      ],
      candidate: {
        card: {
          official_identity: { kind: "card_number", value: "DEMO-G01" },
          game_data: {
            profile: "gundam@1",
            attributes: {
              card_type: "unit",
              colours: ["blue"],
              level: 4,
              cost: 3,
              block_icon: "1",
              effect_text: "Synthetic effect.",
              zone: "space",
              traits: ["Synthetic Trait"],
              link_condition: null,
              ap: 4,
              hp: 5,
              series_titles: ["Synthetic Series"]
            }
          }
        },
        printing: {
          source_records: [
            { locale: "EN-ASIA", detailSearch: "DEMO-G01_p1" },
            { locale: "EN-US", detailSearch: "DEMO-G01_p1" }
          ],
          identity_evidence: {
            card_number: "equal",
            variant_key: "equal",
            artwork_fingerprint: "equal",
            rules_fields: "equal",
            rarity: "equal",
            product_code: "equal"
          }
        },
        releases: [
          { locale: "EN-ASIA", date: "2026-07-25" },
          { locale: "EN-US", date: "2026-07-24" }
        ],
        legality: [
          { locale: "EN-ASIA", effective_from: "2026-07-25" },
          { locale: "EN-US", effective_from: "2026-07-24" }
        ],
        oceania_legality_synthesized: false
      }
    }
  },
  {
    key: "8",
    name: "Gundam substantive locale conflict",
    question: "Does a supposedly shared rules conflict remain visible and block publication?",
    operation: "run",
    input: {
      required_areas: ["en-asia", "en-us"],
      completed_areas: ["en-asia", "en-us"],
      partitions: [
        { key: "en-asia:package:demo", rendered_count: 1, parsed_count: 1, prior_count: 1 },
        { key: "en-us:package:demo", rendered_count: 1, parsed_count: 1, prior_count: 1 }
      ],
      canonical_conflicts: ["/cards/DEMO-G02/game_data/attributes/effect_text"],
      candidate: {
        en_asia_effect: "Synthetic wording A.",
        en_us_effect: "Synthetic wording B.",
        selected_value: null
      }
    }
  },
  {
    key: "9",
    name: "Exact Printing re-identification",
    question: "Is a changed source suffix only reconnected when exactly one Printing matches all material evidence?",
    operation: "reidentify",
    input: {
      candidate: {
        locator: "DEMO-009_p9",
        card_id: "card_demo_009",
        source_family: "one-piece-en",
        artwork_fingerprint: "art_demo_a",
        printed_fields_digest: "fields_demo_a",
        rarity_normalized: "rare",
        treatment: "alternate",
        internally_consistent_new_appearance: false
      },
      existing: [
        {
          printing_id: "printing_demo_existing",
          card_id: "card_demo_009",
          source_family: "one-piece-en",
          artwork_fingerprint: "art_demo_a",
          printed_fields_digest: "fields_demo_a",
          rarity_normalized: "rare",
          treatment: "alternate"
        }
      ]
    }
  },
  {
    key: "0",
    name: "Ambiguous Printing re-identification",
    question: "Does matching two existing Printings stop automatic reconciliation?",
    operation: "reidentify",
    input: {
      candidate: {
        locator: "DEMO-010_p9",
        card_id: "card_demo_010",
        source_family: "digimon-en",
        artwork_fingerprint: "art_demo_same",
        printed_fields_digest: "fields_demo_same",
        rarity_normalized: "super_rare",
        treatment: null,
        internally_consistent_new_appearance: false
      },
      existing: [
        {
          printing_id: "printing_demo_a",
          card_id: "card_demo_010",
          source_family: "digimon-en",
          artwork_fingerprint: "art_demo_same",
          printed_fields_digest: "fields_demo_same",
          rarity_normalized: "super_rare",
          treatment: null
        },
        {
          printing_id: "printing_demo_b",
          card_id: "card_demo_010",
          source_family: "digimon-en",
          artwork_fingerprint: "art_demo_same",
          printed_fields_digest: "fields_demo_same",
          rarity_normalized: "super_rare",
          treatment: null
        }
      ]
    }
  }
];
