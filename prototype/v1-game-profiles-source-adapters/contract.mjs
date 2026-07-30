const HARD = "hard_failure";
const WARNING = "warning";

export const contractVersion = "card-keepr-game-contracts@1";

export function validatePrintingIdentityContract(text) {
  const required =
    "Variant key/suffix and Product, set, source-bucket, Release, and Legality memberships are corroborating provenance only and never identity gates.";
  if (!text.replaceAll("\n", " ").replaceAll(/\s+/g, " ").includes(required)) {
    throw new Error("The Printing identity contract must keep memberships out of identity.");
  }
  if (text.includes("must additionally agree") && text.includes("Product code")) {
    throw new Error("The stale Gundam Product/variant identity gate is forbidden.");
  }
}

const nullableInteger = { type: ["integer", "null"], minimum: 0 };
const nullableString = { type: ["string", "null"] };
const stringArray = { type: "array", items: { type: "string" }, uniqueItems: true };
const colourArray = {
  type: "array",
  items: {
    enum: ["red", "green", "blue", "purple", "black", "yellow", "white", "colourless"]
  },
  uniqueItems: true
};

function objectSchema(required, properties, allOf = []) {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
    ...(allOf.length ? { allOf } : {})
  };
}

export const gameProfiles = {
  "one-piece@1": {
    game: "one-piece",
    card: objectSchema(
      [
        "card_type",
        "colours",
        "cost",
        "life",
        "battle_attributes",
        "power",
        "counter",
        "traits",
        "block_icons",
        "effect_text",
        "trigger_text"
      ],
      {
        card_type: { enum: ["leader", "character", "event", "stage", "don"] },
        colours: colourArray,
        cost: nullableInteger,
        life: nullableInteger,
        battle_attributes: stringArray,
        power: nullableInteger,
        counter: nullableInteger,
        traits: stringArray,
        block_icons: stringArray,
        effect_text: nullableString,
        trigger_text: nullableString
      },
      [
        {
          if: { properties: { card_type: { const: "leader" } } },
          then: { required: ["life"], properties: { life: { type: "integer", minimum: 0 } } }
        },
        {
          if: { properties: { card_type: { enum: ["character", "event", "stage"] } } },
          then: { required: ["cost"], properties: { cost: { type: "integer", minimum: 0 } } }
        },
        {
          if: { properties: { card_type: { const: "don" } } },
          then: {
            properties: {
              colours: { maxItems: 0 },
              cost: { type: "null" },
              life: { type: "null" },
              power: { type: "null" },
              counter: { type: "null" }
            }
          }
        }
      ]
    ),
    printing: objectSchema([], {
      illustration_types: {
        type: "array",
        items: { enum: ["comic", "animation", "original", "other"] },
        uniqueItems: true
      }
    })
  },
  "fusion-world@1": {
    game: "fusion-world",
    card: objectSchema(
      [
        "card_type",
        "colours",
        "cost",
        "specified_cost",
        "power",
        "combo_power",
        "traits",
        "skills"
      ],
      {
        card_type: { enum: ["leader", "battle", "extra", "energy_marker"] },
        colours: colourArray,
        cost: nullableInteger,
        specified_cost: {
          type: "array",
          items: objectSchema(["colour", "count"], {
            colour: { enum: ["red", "blue", "green", "yellow", "black"] },
            count: { type: "integer", minimum: 1 }
          })
        },
        power: nullableInteger,
        combo_power: nullableInteger,
        traits: stringArray,
        skills: {
          type: "array",
          items: objectSchema(["kind", "text"], {
            kind: { enum: ["front", "back", "ordinary"] },
            text: { type: "string" }
          })
        },
        leader_faces: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: objectSchema(["role", "name", "traits", "skills"], {
            role: { enum: ["front", "back"] },
            name: { type: "string", minLength: 1 },
            power: nullableInteger,
            traits: stringArray,
            skills: { type: "string" }
          })
        }
      },
      [
        {
          if: { properties: { card_type: { const: "leader" } } },
          then: { required: ["leader_faces"] }
        }
      ]
    ),
    printing: objectSchema([], {})
  },
  "digimon@1": {
    game: "digimon",
    card: objectSchema(
      [
        "card_type",
        "colours",
        "level",
        "play_cost",
        "use_cost",
        "dp",
        "form",
        "attribute",
        "traits",
        "text_sections",
        "digivolution_requirements"
      ],
      {
        card_type: {
          enum: ["digi_egg", "digimon", "tamer", "option", "digimon_option"]
        },
        colours: colourArray,
        level: nullableInteger,
        play_cost: nullableInteger,
        use_cost: nullableInteger,
        dp: nullableInteger,
        form: nullableString,
        attribute: nullableString,
        traits: stringArray,
        digivolution_requirements: {
          type: "array",
          items: objectSchema(["cost"], {
            index: { type: "integer", minimum: 1 },
            from_level: nullableInteger,
            colours: colourArray,
            cost: { type: "integer", minimum: 0 },
            raw_condition: nullableString
          })
        },
        text_sections: {
          type: "array",
          items: objectSchema(["kind", "text"], {
            kind: {
              enum: [
                "effect",
                "inherited_effect",
                "security_effect",
                "rule",
                "special_digivolution_condition",
                "dual_effect",
                "dual_rule",
                "link_condition",
                "link_effect"
              ]
            },
            text: { type: "string" }
          })
        },
        dual_colours: colourArray,
        dual_cost: nullableInteger,
        link_dp: nullableInteger
      }
    ),
    printing: objectSchema(["alternative_art"], {
      alternative_art: { type: "boolean" }
    })
  },
  "gundam@1": {
    game: "gundam",
    card: objectSchema(
      [
        "card_type",
        "colours",
        "level",
        "cost",
        "block_icon",
        "effect_text",
        "zone",
        "traits",
        "link_condition",
        "ap",
        "hp",
        "series_titles"
      ],
      {
        card_type: {
          enum: [
            "unit",
            "pilot",
            "command",
            "base",
            "resource",
            "ex_base",
            "ex_resource",
            "unit_token"
          ]
        },
        colours: colourArray,
        level: nullableInteger,
        cost: nullableInteger,
        block_icon: nullableString,
        effect_text: nullableString,
        zone: nullableString,
        traits: stringArray,
        link_condition: nullableString,
        ap: nullableInteger,
        hp: nullableInteger,
        series_titles: stringArray
      }
    ),
    printing: objectSchema(["alternate_art"], {
      alternate_art: { type: "boolean" }
    })
  }
};

export const adapterContracts = {
  "one-piece-en@1": {
    game: "one-piece",
    profile: "one-piece@1",
    sourceLineage: "one-piece-en",
    locale: "EN-OCEANIA",
    discovery: {
      partitionOrder: ["recording"],
      discoverFrom: "card-list-series-options",
      capSignal: null,
      requiredAreas: [
        "card-list",
        "products",
        "restrictions-current",
        "restrictions-history",
        "block-policy",
        "errata"
      ]
    },
    identity: {
      card: ["game", "card_number"],
      printingLocator: ["source_lineage", "source_record_id"],
      functionalCard: "DON!!"
    },
    requiredCardFields: ["source_record_id", "card_number", "name", "Category", "Color", "image_url"],
    mappings: {
      Category: "/card/card_type",
      Color: "/card/colours",
      Cost: "/card/cost",
      Life: "/card/life",
      Attribute: "/card/battle_attributes",
      Power: "/card/power",
      Counter: "/card/counter",
      Type: "/card/traits",
      "Block icon": "/card/block_icons",
      Effect: "/card/effect_text",
      Trigger: "/card/trigger_text",
      Rarity: "/printing/rarity",
      "Illustration filter membership": "/printing/illustration_types",
      "Card Set(s)": "/relationship_candidate/raw_label"
    },
    invariants: [
      "all-discovered-recordings-snapshotted",
      "rendered-row-count-equals-parsed-membership-count",
      "membership-key-unique",
      "repeated-locator-payload-compatible",
      "required-fields-parse",
      "required-image-captured"
    ],
    authority: {
      cardFacts: "card-list",
      effectiveRulesText: "official-errata-over-card-list",
      releases: "product-detail-over-card-set-label",
      legality: "dated-rules-and-restriction-surfaces"
    }
  },
  "fusion-world-en@1": {
    game: "fusion-world",
    profile: "fusion-world@1",
    sourceLineage: "fusion-world-en",
    locale: "EN-OCEANIA",
    discovery: {
      partitionOrder: ["card_type", "colour", "cost"],
      discoverFrom: "live-card-database-facets",
      capSignal: "Too many search results",
      requiredAreas: ["card-list", "products", "legality-current-and-history", "errata"]
    },
    identity: {
      card: ["game", "card_number"],
      printingLocator: ["source_lineage", "card_number", "variant_suffix"],
      synthesizeUnsuffixedPrinting: false
    },
    requiredCardFields: ["card_number", "name", "card_type", "color", "image_urls"],
    mappings: {
      "Card Type": "/card/card_type",
      Color: "/card/colours",
      Cost: "/card/cost",
      "Specified Cost": "/card/specified_cost",
      Power: "/card/power",
      "Combo Power": "/card/combo_power",
      "Special Traits": "/card/traits",
      Skills: "/card/skills",
      "Leader face fields": "/card/leader_faces",
      Rarity: "/printing/rarity",
      "Where to get it": "/distribution_context/raw_label",
      "Product/category": "/relationship_candidate"
    },
    invariants: [
      "no-partition-retains-cap-signal",
      "all-leaf-partitions-snapshotted",
      "rendered-row-count-equals-parsed-reference-count",
      "printing-locator-unique-after-deduplication",
      "detail-card-number-equals-request",
      "leader-has-front-and-back-images",
      "required-fields-parse",
      "all-product-pages-and-coming-soon-snapshotted",
      "legality-and-errata-streams-parse"
    ],
    authority: {
      cardFacts: "validated-card-detail-consensus",
      effectiveRulesText: "official-errata-over-card-detail",
      releases: "product-detail-over-category-and-distribution-labels",
      legality: "rules-hub-current-list-and-dated-history"
    }
  },
  "digimon-en@1": {
    game: "digimon",
    profile: "digimon@1",
    sourceLineage: "digimon-en",
    locale: "EN",
    discovery: {
      partitionOrder: ["category", "cardcategory", "colour"],
      discoverFrom: "live-version-and-filter-options",
      capSignal: "more than 1,000",
      requiredAreas: ["card-list", "products", "restrictions", "errata"]
    },
    identity: {
      card: ["game", "card_number"],
      printingLocator: ["source_lineage", "popup_id"],
      preferredPresentation: "unsuffixed-base-record-when-present"
    },
    requiredCardFields: ["popup_id", "card_number", "name", "cardcategory", "image_url"],
    mappings: {
      "Card Type": "/card/card_type",
      Color: "/card/colours",
      Lv: "/card/level",
      "Play Cost": "/card/play_cost",
      "Use Cost": "/card/use_cost",
      DP: "/card/dp",
      Form: "/card/form",
      Attribute: "/card/attribute",
      Type: "/card/traits",
      "Digivolution Cost": "/card/digivolution_requirements",
      Effect: "/card/text_sections",
      "Inherited Effect": "/card/text_sections",
      "Security Effect": "/card/text_sections",
      "DUAL Color": "/card/dual_colours",
      "DUAL Cost": "/card/dual_cost",
      "[DUAL Effect]": "/card/text_sections",
      "[DUAL Rule]": "/card/text_sections",
      "[Link Condition]": "/card/text_sections",
      "[Link DP]": "/card/link_dp",
      "[Link Effect]": "/card/text_sections",
      "[Special Digivolution Condition]": "/card/text_sections",
      Rarity: "/printing/rarity",
      "Alternative Art": "/printing/alternative_art",
      Notes: "/distribution_context/raw_label"
    },
    invariants: [
      "all-discovered-categories-covered-by-leaf-partitions",
      "no-partition-retains-cap-signal",
      "all-leaf-partitions-snapshotted",
      "rendered-row-count-equals-parsed-record-count",
      "popup-id-unique-after-deduplication",
      "required-fields-parse",
      "required-image-captured",
      "all-product-tiles-classified",
      "restrictions-and-errata-streams-parse"
    ],
    authority: {
      cardName: "unsuffixed-base-record-then-unanimous-printing-value",
      cardFacts: "validated-record-consensus",
      effectiveRulesText: "official-errata-over-card-list",
      releases: "explicit-regional-product-fact-only",
      legality: "restriction-history-and-current-list",
      caveat: "english-source-states-japanese-list-has-priority"
    }
  },
  "gundam-en-asia@1": {
    game: "gundam",
    profile: "gundam@1",
    sourceLineage: "gundam-en-asia",
    locale: "EN-ASIA",
    discovery: {
      partitionOrder: ["package"],
      discoverFrom: "live-package-options",
      capSignal: null,
      requiredAreas: ["card-list", "products", "legality", "errata"]
    },
    identity: {
      card: ["game", "card_number"],
      printingLocator: ["source_lineage", "detailSearch"],
      crossLocaleMerge: "gundam-corroborated-printing"
    },
    requiredCardFields: ["detailSearch", "card_number", "name", "type", "image_url"],
    mappings: {
      Type: "/card/card_type",
      Color: "/card/colours",
      Level: "/card/level",
      Cost: "/card/cost",
      Block: "/card/block_icon",
      Effect: "/card/effect_text",
      Zone: "/card/zone",
      Trait: "/card/traits",
      Link: "/card/link_condition",
      AP: "/card/ap",
      HP: "/card/hp",
      Title: "/card/series_titles",
      Rarity: "/printing/rarity",
      "alternate-art decoration": "/printing/alternate_art",
      "Where to get it": "/distribution_context/raw_label"
    },
    invariants: [
      "all-discovered-packages-snapshotted",
      "rendered-row-count-equals-parsed-reference-count",
      "detail-search-key-unique-after-deduplication",
      "detail-card-number-equals-listing",
      "required-fields-parse",
      "required-image-captured",
      "all-product-pages-snapshotted",
      "legality-and-errata-streams-parse"
    ],
    authority: {
      sharedFacts: "en-asia-preferred-but-substantive-conflict-unresolved",
      releases: "locale-scoped-product-detail",
      legality: "locale-scoped-rules-and-news",
      effectiveRulesText: "official-errata-over-card-detail"
    }
  },
  "gundam-en-us@1": {
    game: "gundam",
    profile: "gundam@1",
    sourceLineage: "gundam-en-us",
    locale: "EN-US",
    discovery: {
      partitionOrder: ["package"],
      discoverFrom: "live-package-options",
      capSignal: null,
      requiredAreas: ["card-list", "products", "legality", "errata"]
    },
    identity: {
      card: ["game", "card_number"],
      printingLocator: ["source_lineage", "detailSearch"],
      crossLocaleMerge: "gundam-corroborated-printing"
    },
    requiredCardFields: ["detailSearch", "card_number", "name", "type", "image_url"],
    mappings: {
      Type: "/card/card_type",
      Color: "/card/colours",
      Level: "/card/level",
      Cost: "/card/cost",
      Block: "/card/block_icon",
      Effect: "/card/effect_text",
      Zone: "/card/zone",
      Trait: "/card/traits",
      Link: "/card/link_condition",
      AP: "/card/ap",
      HP: "/card/hp",
      Title: "/card/series_titles",
      Rarity: "/printing/rarity",
      "alternate-art decoration": "/printing/alternate_art",
      "Where to get it": "/distribution_context/raw_label"
    },
    invariants: [
      "all-discovered-packages-snapshotted",
      "rendered-row-count-equals-parsed-reference-count",
      "detail-search-key-unique-after-deduplication",
      "detail-card-number-equals-listing",
      "required-fields-parse",
      "required-image-captured",
      "all-product-pages-snapshotted",
      "legality-and-errata-streams-parse"
    ],
    authority: {
      sharedFacts: "corroborates-en-asia-and-fills-gaps",
      releases: "locale-scoped-product-detail",
      legality: "locale-scoped-rules-and-news",
      effectiveRulesText: "official-errata-over-card-detail"
    }
  }
};

export const diagnosticsPolicy = {
  warnings: {
    "new-source-vocabulary": "Any newly discovered facet, category, package, field label, or enum raw value.",
    "count-change": "Absolute count delta at least max(25 records, 20% of the prior successful comparable scope).",
    "not-observed": "A previously observed locator or Product is absent from a structurally complete run.",
    "unknown-optional-field": "The raw field is retained on the Source Observation but not added to Catalogue Data.",
    "unresolved-relationship": "A noncanonical Product or Distribution Context candidate cannot be mapped deterministically.",
    "single-locale-gundam-printing": "A Gundam Printing is observed on only one English surface."
  },
  hardFailures: {
    "required-area-incomplete": "Any required discovery area, partition, page, detail, or stream is missing after retries.",
    "source-cap-unresolved": "A leaf partition still carries the source's broad-query cap signal.",
    "source-count-mismatch": "The rendered/source-declared result count differs from parsed source records.",
    "identity-or-provenance-missing": "A required identity field, source locator, snapshot, or required image is absent.",
    "required-field-parse": "A required raw field is present but cannot be normalized into the profile.",
    "duplicate-or-conflicting-identity": "One natural identity maps to incompatible records.",
    "ambiguous-printing-reidentification": "A new locator has more than one compatible existing Printing or conflicts materially.",
    "canonical-conflict": "Competing canonical observations have no deterministic authority rule.",
    "unrepresentable-rules-change": "New Erratum or Legality Rule wording cannot be represented without invented precision.",
    "audit-persistence-failed": "Any required Source Snapshot, Source Observation set, or diagnostic cannot be persisted."
  },
  countChangesNeverFailAlone: true
};

function diagnostic(severity, code, detail) {
  return { severity, code, detail };
}

function valueHasType(value, expected) {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "integer") return Number.isInteger(value);
  return typeof value === expected;
}

function validateSchema(value, schema, path = "$") {
  const errors = [];
  const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (allowedTypes.length && !allowedTypes.some((type) => valueHasType(value, type))) {
    return [`${path} must have type ${allowedTypes.join(" or ")}`];
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
  }
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path} must contain at least ${schema.minLength} character(s)`);
  }
  if (Number.isInteger(value) && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path} must be at least ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path} must contain at most ${schema.maxItems} item(s)`);
    }
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      errors.push(`${path} must contain unique items`);
    }
    if (schema.items) {
      value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, `${path}[${index}]`)));
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      if (!(required in value)) errors.push(`${path}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const property of Object.keys(value)) {
        if (!(property in (schema.properties ?? {}))) {
          errors.push(`${path}.${property} is not part of this profile version`);
        }
      }
    }
    for (const [property, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (property in value) {
        errors.push(...validateSchema(value[property], propertySchema, `${path}.${property}`));
      }
    }
    for (const conditional of schema.allOf ?? []) {
      if (!validateSchema(value, conditional.if, path).length) {
        errors.push(...validateSchema(value, conditional.then, path));
      }
    }
  }
  return errors;
}

export function validateProfilePayload(gameData, printingData = undefined) {
  const profile = gameProfiles[gameData?.profile];
  if (!profile) {
    return [`$.profile '${gameData?.profile ?? "<missing>"}' is not a supported v1 profile`];
  }
  const errors = validateSchema(gameData.attributes, profile.card, "$.attributes");
  if (gameData.profile === "fusion-world@1" && gameData.attributes?.card_type === "leader") {
    const roles = gameData.attributes.leader_faces?.map((face) => face.role) ?? [];
    if (roles.filter((role) => role === "front").length !== 1) {
      errors.push("$.attributes.leader_faces must contain exactly one front face");
    }
    if (roles.filter((role) => role === "back").length !== 1) {
      errors.push("$.attributes.leader_faces must contain exactly one back face");
    }
  }
  if (printingData !== undefined) {
    errors.push(...validateSchema(printingData, profile.printing, "$.printing_attributes"));
  }
  return errors;
}

function compatibleMaterialFacts(left, right) {
  return (
    left.card_id === right.card_id &&
    left.source_family === right.source_family &&
    left.artwork_fingerprint === right.artwork_fingerprint &&
    left.printed_fields_digest === right.printed_fields_digest &&
    left.rarity_normalized === right.rarity_normalized &&
    (left.treatment ?? null) === (right.treatment ?? null)
  );
}

export function reidentifyPrinting(candidate, existing) {
  const matches = existing.filter((printing) => compatibleMaterialFacts(candidate, printing));
  if (matches.length === 1) {
    return {
      outcome: "reidentified",
      printing_id: matches[0].printing_id,
      evidence: [
        "card_id",
        "source_family",
        "artwork_fingerprint",
        "printed_fields_digest",
        "rarity_normalized",
        "treatment"
      ],
      diagnostics: []
    };
  }
  if (matches.length > 1) {
    return {
      outcome: "blocked",
      printing_id: null,
      diagnostics: [
        diagnostic(
          HARD,
          "ambiguous-printing-reidentification",
          `Candidate matches ${matches.length} existing Printings.`
        )
      ]
    };
  }
  if (candidate.internally_consistent_new_appearance) {
    return { outcome: "new_printing", printing_id: null, diagnostics: [] };
  }
  return {
    outcome: "blocked",
    printing_id: null,
    diagnostics: [
      diagnostic(
        HARD,
        "ambiguous-printing-reidentification",
        "Candidate is neither one exact compatible match nor a demonstrably new appearance."
      )
    ]
  };
}

export function evaluateRun(input) {
  const diagnostics = [];
  const gameData = input.candidate?.card?.game_data;
  if (gameData) {
    const profileErrors = validateProfilePayload(
      gameData,
      input.candidate?.printing?.game_data?.attributes
    );
    for (const error of profileErrors) {
      diagnostics.push(diagnostic(HARD, "required-field-parse", error));
    }
  }

  for (const area of input.required_areas ?? []) {
    if (!input.completed_areas?.includes(area)) {
      diagnostics.push(
        diagnostic(HARD, "required-area-incomplete", `Required area '${area}' is incomplete.`)
      );
    }
  }

  for (const partition of input.partitions ?? []) {
    if (partition.cap_signal) {
      diagnostics.push(
        diagnostic(HARD, "source-cap-unresolved", `Partition '${partition.key}' remains capped.`)
      );
    }
    if (partition.rendered_count !== partition.parsed_count) {
      diagnostics.push(
        diagnostic(
          HARD,
          "source-count-mismatch",
          `Partition '${partition.key}' rendered ${partition.rendered_count} but parsed ${partition.parsed_count}.`
        )
      );
    }
    if (partition.prior_count !== undefined) {
      const delta = Math.abs(partition.parsed_count - partition.prior_count);
      const threshold = Math.max(25, Math.ceil(partition.prior_count * 0.2));
      if (delta >= threshold) {
        diagnostics.push(
          diagnostic(
            WARNING,
            "count-change",
            `Partition '${partition.key}' changed by ${delta}; review threshold is ${threshold}.`
          )
        );
      }
    }
  }

  for (const field of input.unknown_fields ?? []) {
    diagnostics.push(
      diagnostic(
        WARNING,
        "unknown-optional-field",
        `Retained raw field '${field.label}' on Source Observation ${field.observation_id}.`
      )
    );
  }

  for (const locale of input.gundam_missing_locales ?? []) {
    diagnostics.push(
      diagnostic(
        WARNING,
        "single-locale-gundam-printing",
        `Printing is not observed on ${locale}; absence does not withhold it.`
      )
    );
  }

  for (const conflict of input.canonical_conflicts ?? []) {
    diagnostics.push(
      diagnostic(HARD, "canonical-conflict", `Unresolved canonical conflict at ${conflict}.`)
    );
  }

  const hardFailures = diagnostics.filter((item) => item.severity === HARD);
  return {
    contract_version: contractVersion,
    candidate: input.candidate ?? null,
    diagnostics,
    publication: hardFailures.length ? "blocked" : "owner_reviewable"
  };
}

export function evaluateScenario(scenario) {
  if (scenario.operation === "reidentify") {
    return {
      contract_version: contractVersion,
      candidate: scenario.input.candidate,
      result: reidentifyPrinting(scenario.input.candidate, scenario.input.existing)
    };
  }
  return evaluateRun(scenario.input);
}
