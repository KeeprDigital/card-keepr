import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";

const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
};
let requestSequence = 0;

beforeEach(async () => {
  await applyD1Migrations(
    testEnv.CATALOGUE_DB,
    testEnv.TEST_MIGRATIONS,
  );
});

test("Cards and Printings keep opaque identities when a new locator adds compatible evidence", async () => {
  const first = await reconcile("catrev_reconcile_001", [
    printingObservation({
      source_observation_id: "srcobs_reconcile_001",
      locator: "/cards/OP01-001?variant=base",
    }),
  ]);

  expect(first.response.status).toBe(200);
  expect(first.document).toMatchObject({
    contract: "card-keepr-card-printing-reconciliation@1",
    publishable: true,
    diagnostics: [],
    warnings: [],
  });
  const firstCard = requiredFirstRecord(first.document, "cards");
  const firstPrinting = requiredFirstRecord(first.document, "printings");
  expect(firstCard.id).toMatch(/^card_[a-f0-9]{32}$/);
  expect(firstPrinting.id).toMatch(/^printing_[a-f0-9]{32}$/);
  expect(firstCard).toMatchObject({
    supported_game: "one-piece",
    official_identity: {
      kind: "card_number",
      value: "OP01-001",
    },
    lifecycle: {
      first_revision_id: "catrev_reconcile_001",
      last_observed_revision_id: "catrev_reconcile_001",
      withdrawn: false,
    },
  });

  const repeated = await reconcile("catrev_reconcile_002", [
    printingObservation({
      source_observation_id: "srcobs_reconcile_002",
      locator: "/cards/OP01-001?variant=renamed",
    }),
  ]);

  expect(repeated.response.status).toBe(200);
  const repeatedCard = requiredFirstRecord(repeated.document, "cards");
  const repeatedPrinting = requiredFirstRecord(
    repeated.document,
    "printings",
  );
  expect(repeatedCard.id).toBe(firstCard.id);
  expect(repeatedPrinting.id).toBe(firstPrinting.id);
  expect(repeatedPrinting).toMatchObject({
    locators: [
      "/cards/OP01-001?variant=base",
      "/cards/OP01-001?variant=renamed",
    ],
    lifecycle: {
      first_revision_id: "catrev_reconcile_001",
      last_observed_revision_id: "catrev_reconcile_002",
      withdrawn: false,
    },
  });
});

test("insufficient or contradictory Printing evidence blocks publication with stable diagnostics", async () => {
  const established = await reconcile("catrev_reconcile_conflict_001", [
    printingObservation({
      source_observation_id: "srcobs_reconcile_conflict_001",
      locator: "/cards/OP01-001?variant=conflict",
    }),
  ]);
  expect(established.response.status).toBe(200);

  const insufficientObservation = printingObservation({
    source_observation_id: "srcobs_reconcile_insufficient_001",
    locator: "/cards/OP01-002",
  });
  delete insufficientObservation.artwork_fingerprint;
  const insufficient = await reconcile(
    "catrev_reconcile_conflict_002",
    [insufficientObservation],
  );
  expect(insufficient.response.status).toBe(409);
  expect(insufficient.document).toMatchObject({
    publishable: false,
    diagnostics: [
      {
        code: "printing_match_insufficient_evidence",
        source_observation_id: "srcobs_reconcile_insufficient_001",
        locator: "/cards/OP01-002",
        candidate_printing_ids: [],
      },
    ],
  });

  const contradictory = await reconcile(
    "catrev_reconcile_conflict_003",
    [
      printingObservation({
        source_observation_id: "srcobs_reconcile_conflict_002",
        locator: "/cards/OP01-001?variant=conflict",
        treatment: "parallel-foil",
      }),
    ],
  );
  expect(contradictory.response.status).toBe(409);
  expect(contradictory.document).toMatchObject({
    publishable: false,
    diagnostics: [
      {
        code: "printing_match_contradictory",
        source_observation_id: "srcobs_reconcile_conflict_002",
        locator: "/cards/OP01-001?variant=conflict",
      },
    ],
  });
  expect(contradictory.document).toEqual(
    JSON.parse(JSON.stringify(contradictory.document)),
  );
});

test("unknown optional fields stay in the Source Observation, warn, and do not leak into a Game Profile", async () => {
  const sourceObservationId = "srcobs_reconcile_unknown_001";
  const reconciled = await reconcile("catrev_reconcile_unknown_001", [
    printingObservation({
      source_observation_id: sourceObservationId,
      new_official_flag: "Bandai-added-value",
      game_profile: {
        profile: "one-piece@1",
        attributes: {
          card_type: "leader",
          finish: "future-vocabulary",
        },
      },
    }),
  ]);

  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document).toMatchObject({
    publishable: true,
    warnings: [
      {
        code: "unknown_source_observation_fields",
        source_observation_id: sourceObservationId,
        fields: [
          "game_profile.attributes.finish",
          "new_official_flag",
        ],
      },
    ],
  });
  const printing = requiredFirstRecord(reconciled.document, "printings");
  expect(printing).not.toHaveProperty("game_profile");
  expect(printing).not.toHaveProperty("new_official_flag");

  const retained = await administrationGet(
    `/v1/reconciliation/source-observations/${sourceObservationId}`,
  );
  expect(retained.response.status).toBe(200);
  expect(retained.document).toMatchObject({
    contract: "card-keepr-reconciliation-source-observation@1",
    source_observation_id: sourceObservationId,
    observation: {
      new_official_flag: "Bandai-added-value",
      game_profile: {
        attributes: {
          finish: "future-vocabulary",
        },
      },
    },
    unknown_fields: {
      new_official_flag: "Bandai-added-value",
      "game_profile.attributes.finish": "future-vocabulary",
    },
  });
});

test("contradictory Source Observations in one candidate fail closed before any identity is recorded", async () => {
  const locator = "/cards/OP01-001?variant=candidate-conflict";
  const sourceLineage = "one-piece-candidate-conflict-en";
  const conflicted = await reconcile(
    "catrev_reconcile_candidate_conflict_001",
    [
      printingObservation({
        source_observation_id: "srcobs_candidate_conflict_001",
        locator,
        source_lineage: sourceLineage,
        official_identity: {
          kind: "card_number",
          value: "OP09-999",
        },
      }),
      printingObservation({
        source_observation_id: "srcobs_candidate_conflict_002",
        locator,
        source_lineage: sourceLineage,
        official_identity: {
          kind: "card_number",
          value: "OP09-999",
        },
        treatment: "parallel-foil",
      }),
    ],
  );

  expect(conflicted.response.status).toBe(409);
  expect(conflicted.document).toMatchObject({
    publishable: false,
    cards: [],
    printings: [],
    diagnostics: [
      {
        code: "printing_match_contradictory",
        source_observation_id: "srcobs_candidate_conflict_001",
        locator,
      },
    ],
  });
  const reversed = await reconcile(
    "catrev_reconcile_candidate_conflict_001",
    [
      printingObservation({
        source_observation_id: "srcobs_candidate_conflict_002",
        source_lineage: sourceLineage,
        locator,
        official_identity: {
          kind: "card_number",
          value: "OP09-999",
        },
        treatment: "parallel-foil",
      }),
      printingObservation({
        source_observation_id: "srcobs_candidate_conflict_001",
        source_lineage: sourceLineage,
        locator,
        official_identity: {
          kind: "card_number",
          value: "OP09-999",
        },
      }),
    ],
  );
  expect(reversed.response.status).toBe(409);
  expect(reversed.document).toEqual(conflicted.document);

  const afterFailure = await reconcile(
    "catrev_reconcile_candidate_conflict_002",
    [
      printingObservation({
        source_observation_id: "srcobs_candidate_conflict_003",
        locator,
        source_lineage: sourceLineage,
        official_identity: {
          kind: "card_number",
          value: "OP09-999",
        },
        treatment: "parallel-foil",
      }),
    ],
  );
  expect(afterFailure.response.status).toBe(200);
  expect(requiredFirstRecord(afterFailure.document, "cards")).toMatchObject({
    lifecycle: {
      first_revision_id: "catrev_reconcile_candidate_conflict_002",
    },
  });
});

test("membership, disappearance, and explicit withdrawal preserve one Printing lifecycle", async () => {
  const sourceLineage = "one-piece-lifecycle-en";
  const base = printingObservation({
    source_observation_id: "srcobs_lifecycle_001",
    source_lineage: sourceLineage,
    locator: "/cards/OP07-001?variant=original",
    official_identity: {
      kind: "card_number",
      value: "OP07-001",
    },
    memberships: {
      product_ids: ["product_op07"],
      distribution_context_ids: [],
      source_buckets: ["main-list"],
    },
  });
  const first = await reconcile("catrev_lifecycle_001", [base]);
  expect(first.response.status).toBe(200);
  const printingId = requiredFirstRecord(first.document, "printings").id;

  const expanded = await reconcile("catrev_lifecycle_002", [
    {
      ...base,
      source_observation_id: "srcobs_lifecycle_002",
      locator: "/cards/OP07-001?variant=new-locator",
      memberships: {
        product_ids: ["product_promotion"],
        distribution_context_ids: ["context_event"],
        source_buckets: ["promotion-list"],
      },
    },
  ]);
  const expandedPrinting = requiredFirstRecord(
    expanded.document,
    "printings",
  );
  expect(expandedPrinting).toMatchObject({
    id: printingId,
    memberships: {
      product_ids: ["product_op07", "product_promotion"],
      distribution_context_ids: ["context_event"],
      source_buckets: ["main-list", "promotion-list"],
    },
  });

  const absent = await reconcileWithLineages(
    "catrev_lifecycle_003",
    [sourceLineage],
    [],
  );
  expect(absent.response.status).toBe(200);
  expect(absent.document).toMatchObject({
    warnings: [
      {
        code: "record_not_observed",
        printing_id: printingId,
      },
    ],
  });
  expect(requiredFirstRecord(absent.document, "printings")).toMatchObject({
    id: printingId,
    lifecycle: {
      first_revision_id: "catrev_lifecycle_001",
      last_observed_revision_id: "catrev_lifecycle_002",
      withdrawn: false,
      withdrawal: null,
    },
  });

  const withdrawn = await reconcile("catrev_lifecycle_004", [
    {
      ...base,
      source_observation_id: "srcobs_lifecycle_004",
      withdrawal: {
        explicit: true,
        entity: "printing",
        evidence: "Official notice dated 2026-07-29",
      },
    },
  ]);
  expect(withdrawn.response.status).toBe(200);
  expect(requiredFirstRecord(withdrawn.document, "printings")).toMatchObject({
    id: printingId,
    lifecycle: {
      first_revision_id: "catrev_lifecycle_001",
      last_observed_revision_id: "catrev_lifecycle_004",
      withdrawn: true,
      withdrawal: {
        revision_id: "catrev_lifecycle_004",
        evidence: {
          explicit: true,
          entity: "printing",
          evidence: "Official notice dated 2026-07-29",
        },
      },
    },
  });
  expect(requiredFirstRecord(withdrawn.document, "cards")).toMatchObject({
    lifecycle: {
      withdrawn: false,
      withdrawal: null,
    },
  });
});

test("the official Card identity rules keep DON!! artwork differences as Printings and reject invented identities", async () => {
  const sourceLineage = "one-piece-don-en";
  const first = await reconcile("catrev_don_001", [
    printingObservation({
      source_observation_id: "srcobs_don_001",
      source_lineage: sourceLineage,
      locator: "/cards/don/artwork-001",
      official_identity: {
        kind: "functional_designation",
        value: "DON!!",
      },
    }),
  ]);
  expect(first.response.status).toBe(200);
  const cardId = requiredFirstRecord(first.document, "cards").id;
  const firstPrintingId = requiredFirstRecord(
    first.document,
    "printings",
  ).id;

  const second = await reconcile("catrev_don_002", [
    printingObservation({
      source_observation_id: "srcobs_don_002",
      source_lineage: sourceLineage,
      locator: "/cards/don/artwork-002",
      official_identity: {
        kind: "functional_designation",
        value: "DON!!",
      },
      artwork_fingerprint: `sha256:${"c".repeat(64)}`,
    }),
  ]);
  expect(second.response.status).toBe(200);
  expect(requiredFirstRecord(second.document, "cards").id).toBe(cardId);
  const donPrintingIds = requiredRecords(second.document, "printings").map(
    (printing) => printing.id,
  );
  expect(donPrintingIds).toHaveLength(2);
  expect(donPrintingIds).toContain(firstPrintingId);

  const invented = await reconcile("catrev_don_invalid_001", [
    printingObservation({
      source_observation_id: "srcobs_don_invalid_001",
      source_lineage: "one-piece-invalid-identity-en",
      locator: "/cards/not-an-official-identity",
      official_identity: {
        kind: "card_number",
        value: "invented identity",
      },
    }),
  ]);
  expect(invented.response.status).toBe(422);
  expect(invented.document).toMatchObject({
    code: "invalid_reconciliation_request",
  });
});

function printingObservation(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    source_observation_id: "srcobs_reconcile_default",
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    locator: "/cards/OP01-001",
    official_identity: {
      kind: "card_number",
      value: "OP01-001",
    },
    artwork_fingerprint: `sha256:${"a".repeat(64)}`,
    printed_rules_fingerprint: `sha256:${"b".repeat(64)}`,
    rarity: {
      raw: "L",
      normalized: "leader",
    },
    treatment: "standard",
    memberships: {
      product_ids: ["product_op01"],
      distribution_context_ids: [],
      source_buckets: ["leaders"],
    },
    ...overrides,
  };
}

async function reconcile(
  catalogueRevisionId: string,
  sourceObservations: Record<string, unknown>[],
): Promise<{
  response: Response;
  document: Record<string, unknown>;
}> {
  return reconcileWithLineages(
    catalogueRevisionId,
    [
      ...new Set(
        sourceObservations.map((observation) =>
          String(observation.source_lineage),
        ),
      ),
    ],
    sourceObservations,
  );
}

async function reconcileWithLineages(
  catalogueRevisionId: string,
  observedSourceLineages: string[],
  sourceObservations: Record<string, unknown>[],
): Promise<{
  response: Response;
  document: Record<string, unknown>;
}> {
  const response = await exports.default.fetch(
    new Request(
      "https://card-keepr.invalid/v1/reconciliation/card-printings",
      {
        method: "POST",
        headers: {
          authorization: "Bearer vitest-administration-key",
          "cf-connecting-ip": `198.51.100.${(requestSequence++ % 250) + 1}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          catalogue_revision_id: catalogueRevisionId,
          observed_source_lineages: observedSourceLineages,
          source_observations: sourceObservations,
        }),
      },
    ),
  );
  return {
    response,
    document: (await response.json()) as Record<string, unknown>,
  };
}

async function administrationGet(
  pathname: string,
): Promise<{
  response: Response;
  document: Record<string, unknown>;
}> {
  const response = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": `198.51.100.${(requestSequence++ % 250) + 1}`,
      },
    }),
  );
  return {
    response,
    document: (await response.json()) as Record<string, unknown>,
  };
}

function requiredFirstRecord(
  document: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const records = document[field];
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error(`${field} does not contain exactly one record`);
  }
  const record = records[0];
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record)
  ) {
    throw new Error(`${field} does not contain an object`);
  }
  return record as Record<string, unknown>;
}

function requiredRecords(
  document: Record<string, unknown>,
  field: string,
): Record<string, unknown>[] {
  const records = document[field];
  if (!Array.isArray(records)) {
    throw new Error(`${field} is not an array`);
  }
  return records.map((record) => {
    if (
      record === null ||
      typeof record !== "object" ||
      Array.isArray(record)
    ) {
      throw new Error(`${field} does not contain only objects`);
    }
    return record as Record<string, unknown>;
  });
}
