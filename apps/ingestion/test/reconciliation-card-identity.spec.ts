import * as reconciliationQueries from "./query-helpers/reconciliation";
import { expect, test } from "vitest";
import {
  installReconciliationSuite,
  testEnv,
  approve,
  collect,
  exportComponentRecords,
  get,
  post,
  reconcile,
  requiredFirst,
  requiredString,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("a structurally complete non-DON Card may have zero catalogued Printings", async () => {
  const run = await collect("/reconciliation/card-without-printing", "reconcile-card-without-printing");
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document.cards).toHaveLength(1);
  expect(reconciled.document.printings).toEqual([]);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
});

test("DON!! accepts explicit known Printing evidence while retaining incomplete-coverage warning semantics", async () => {
  const run = await collect("/reconciliation/profile-don-printing", "reconcile-don-known-printing");
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document.cards).toHaveLength(1);
  expect(reconciled.document.printings).toHaveLength(1);
  expect(reconciled.document.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "printing_coverage_incomplete",
        card_id: requiredString(requiredFirst(reconciled.document, "cards"), "id"),
      }),
    ]),
  );
  await approve(reconciled.document);
});

test("unnumbered DON!! card content survives collection and publication", async () => {
  const run = await collect("/reconciliation/profile-don-card", "reconcile-don-card", {
    game: "one-piece",
    lineage: "one-piece-en",
    adapter: "fixture-one-piece-json@3",
  });
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  const cards = reconciled.document.cards as Array<Record<string, unknown>>;
  const don = cards.find(
    (card) => (card.official_identity as Record<string, unknown>).kind === "functional_designation",
  );
  const companion = cards.find((card) => (card.official_identity as Record<string, unknown>).value === "OP30-001");
  if (don === undefined || companion === undefined) {
    throw new Error("DON!! card fixture cards are absent");
  }
  expect(don.official_identity).toEqual({ kind: "functional_designation", value: "DON!!" });
  expect(reconciled.document).not.toHaveProperty("legality_rules");

  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
});

test("functional DON!! identity rejects a non-don Card shape even when Printing evidence exists", async () => {
  const run = await collect("/reconciliation/profile-don-invalid-printing", "reconcile-invalid-don-printing");
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    diagnostics: [
      {
        code: "retained_evidence_invalid",
        detail: expect.stringContaining("functional DON!! identity requires"),
      },
    ],
  });
});

test("numbered One Piece identities cannot claim the functional DON card type", async () => {
  const run = await collect("/reconciliation/profile-numbered-don-invalid", "reconcile-invalid-numbered-don");
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    diagnostics: [
      {
        code: "retained_evidence_invalid",
        detail: expect.stringContaining("card_type don requires functional DON!! identity"),
      },
    ],
  });
});

test("official numbered identities canonicalize permitted case and reject whitespace or malformed variants", async () => {
  const lowerRun = await collect("/reconciliation/identity-lower", "reconcile-identity-lower");
  const lower = await reconcile(lowerRun.id);
  expect(lower.response.status).toBe(200);
  const cardId = requiredString(requiredFirst(lower.document, "cards"), "id");
  expect(requiredFirst(lower.document, "cards")).toMatchObject({
    official_identity: { kind: "card_number", value: "OP06-006" },
  });
  await approve(lower.document);

  const upperRun = await collect("/reconciliation/identity-upper", "reconcile-identity-upper");
  const upper = await reconcile(upperRun.id);
  expect(upper.response.status).toBe(200);
  expect(requiredFirst(upper.document, "cards")).toMatchObject({
    id: cardId,
    official_identity: { kind: "card_number", value: "OP06-006" },
  });
  await approve(upper.document);

  for (const scenario of ["identity-whitespace", "identity-malformed"]) {
    const run = await collect(`/reconciliation/${scenario}`, `reconcile-${scenario}`);
    const blocked = await reconcile(run.id);
    expect(blocked.response.status).toBe(409);
    expect(blocked.document).toMatchObject({
      diagnostics: [
        {
          code: "retained_evidence_invalid",
          detail: expect.stringContaining("official card number"),
        },
      ],
    });
  }
});

test("conflicting explicit withdrawal assertions fail during reconciliation with stable diagnostics", async () => {
  const run = await collect("/reconciliation/withdrawal-conflict", "reconcile-withdrawal-conflict");
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    state: "failed",
    publishable: false,
    diagnostics: [
      expect.objectContaining({
        code: "withdrawal_evidence_conflict",
        detail: expect.stringContaining("withdrawal assertions conflict"),
      }),
    ],
  });
});

test("withdrawal assertions are longitudinal, append-only, and preserve the first transition", async () => {
  const firstRun = await collect("/reconciliation/withdrawn-longitudinal", "reconcile-withdrawal-longitudinal-first");
  const first = await reconcile(firstRun.id);
  const firstPublished = await approve(first.document);
  const firstRevision = requiredString(firstPublished.document, "resulting_revision_id");
  const printingId = requiredString(requiredFirst(first.document, "printings"), "id");

  const repeatRun = await collect(
    "/reconciliation/withdrawn-longitudinal-corroboration",
    "reconcile-withdrawal-longitudinal-repeat",
  );
  const repeat = await reconcile(repeatRun.id);
  expect(repeat.response.status).toBe(200);
  expect(repeat.document.candidate_digest).not.toBe(first.document.candidate_digest);
  const repeated = await approve(repeat.document);
  expect(repeated.document).toMatchObject({
    publication_outcome: "no_change",
    resulting_revision_id: firstRevision,
  });
  const retained = await get(`/v1/reconciliation/printings/${printingId}`);
  expect(retained.document).toMatchObject({
    lifecycle: {
      withdrawn: true,
      withdrawal: { revision_id: firstRevision },
    },
  });
  const history = await reconciliationQueries
    .readReconciledWithdrawalAssertionsEvidenceJson(testEnv.CATALOGUE_DB)
    .bind(printingId)
    .all<{ evidence_json: string }>();
  expect(history.results).toHaveLength(2);

  const conflictRun = await collect(
    "/reconciliation/withdrawn-conflicting-later",
    "reconcile-withdrawal-longitudinal-conflict",
  );
  const conflict = await reconcile(conflictRun.id);
  expect(conflict.response.status).toBe(409);
  expect(conflict.document).toMatchObject({
    diagnostics: [expect.objectContaining({ code: "withdrawal_evidence_conflict" })],
  });
});

test("Gundam EN-ASIA and EN-US evidence converges on one Printing while substantive conflict blocks", async () => {
  const asiaRun = await collect("/reconciliation/gundam-cross-asia", "reconcile-gundam-cross-asia", {
    game: "gundam",
    lineage: "gundam-en-asia",
    adapter: "fixture-gundam-en-asia-json@2",
  });
  const asia = await reconcile(asiaRun.id);
  const printingId = requiredString(requiredFirst(asia.document, "printings"), "id");
  expect(asia.document.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "single_locale_gundam_printing",
        printing_id: printingId,
        source_lineage: "gundam-en-asia",
      }),
    ]),
  );
  await approve(asia.document);

  const productMismatchRun = await collect(
    "/reconciliation/gundam-cross-product-conflict",
    "reconcile-gundam-product-conflict",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@2",
    },
  );
  const productMismatch = await reconcile(productMismatchRun.id);
  expect(productMismatch.response.status).toBe(409);
  expect(productMismatch.document.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "printing_match_insufficient_evidence",
        matched_printing_ids: [printingId],
        detail: expect.stringContaining("Product"),
      }),
    ]),
  );
  expect(productMismatch.document).not.toMatchObject({
    publishable: true,
  });

  const usRun = await collect("/reconciliation/gundam-cross-us", "reconcile-gundam-cross-us", {
    game: "gundam",
    lineage: "gundam-en-us",
    adapter: "fixture-gundam-en-us-json@2",
  });
  const us = await reconcile(usRun.id);
  expect(requiredFirst(us.document, "printings")).toMatchObject({
    id: printingId,
  });
  expect(us.document.warnings).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "single_locale_gundam_printing",
        printing_id: printingId,
      }),
    ]),
  );
  await approve(us.document);
  const lifecycle = await get(`/v1/reconciliation/printings/${printingId}`);
  expect(lifecycle.document.locators).toMatchObject({
    current: [
      expect.objectContaining({
        locator: "/official/gundam/gundam-cross-asia",
        source_lineage: "gundam-en-asia",
        current: true,
      }),
      expect.objectContaining({
        locator: "/official/gundam/gundam-cross-us",
        source_lineage: "gundam-en-us",
        current: true,
      }),
    ],
    historical: [],
  });
  expect(lifecycle.document.relationship_evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source_lineage: "gundam-en-asia",
        relationship_value: "product_gd99",
        current: true,
      }),
      expect.objectContaining({
        source_lineage: "gundam-en-us",
        relationship_value: "product_gd99",
        current: true,
      }),
    ]),
  );

  const usMissingRun = await collect(
    "/reconciliation/complete-empty-lineage",
    "reconcile-gundam-cross-us-whole-printing-omitted",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@2",
    },
  );
  const usMissing = await reconcile(usMissingRun.id);
  expect(usMissing.document.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "single_locale_gundam_printing",
        printing_id: printingId,
        source_lineage: "gundam-en-asia",
      }),
    ]),
  );
  const inspected = await get(`/v1/ingestion-runs/${usMissingRun.id}/candidate`);
  expect(inspected.document.diff).toMatchObject({
    printings: {
      missing_observations: [printingId],
    },
  });
  const usMissingPublished = await approve(usMissing.document);
  const usMissingRevision = requiredString(usMissingPublished.document, "resulting_revision_id");
  const omittedCardObservation = await reconciliationQueries
    .readReconciledCardObservationsCurrentLastMissingRevisionId(testEnv.CATALOGUE_DB)
    .bind(requiredString(requiredFirst(us.document, "cards"), "id"))
    .first<{ current: number; last_missing_revision_id: string | null }>();
  expect(omittedCardObservation).toEqual({
    current: 0,
    last_missing_revision_id: usMissingRevision,
  });
  const omittedPrintingLocator = await reconciliationQueries
    .readReconciledPrintingLocatorsCurrentLastMissingRevisionId(testEnv.CATALOGUE_DB)
    .bind(printingId)
    .first<{ current: number; last_missing_revision_id: string | null }>();
  expect(omittedPrintingLocator).toEqual({
    current: 0,
    last_missing_revision_id: usMissingRevision,
  });
  const isolated = await get(`/v1/reconciliation/printings/${printingId}`);
  expect(isolated.document.relationship_evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source_lineage: "gundam-en-asia",
        relationship_value: "product_gd99",
        current: true,
      }),
      expect.objectContaining({
        source_lineage: "gundam-en-us",
        relationship_value: "product_gd99",
        current: false,
      }),
    ]),
  );

  const cardConflictRun = await collect("/reconciliation/gundam-card-conflict", "reconcile-gundam-card-conflict", {
    game: "gundam",
    lineage: "gundam-en-us",
    adapter: "fixture-gundam-en-us-json@2",
  });
  const cardConflict = await reconcile(cardConflictRun.id);
  expect(cardConflict.response.status).toBe(409);
  expect(cardConflict.document).toMatchObject({
    diagnostics: [
      {
        code: "canonical_card_conflict",
        detail: expect.stringContaining("source lineages"),
      },
    ],
  });

  const conflictRun = await collect("/reconciliation/gundam-cross-conflict", "reconcile-gundam-cross-conflict", {
    game: "gundam",
    lineage: "gundam-en-us",
    adapter: "fixture-gundam-en-us-json@2",
  });
  const conflict = await reconcile(conflictRun.id);
  expect(conflict.response.status).toBe(409);
  expect(conflict.document).toMatchObject({
    diagnostics: [
      {
        code: "printing_match_contradictory",
        matched_printing_ids: [printingId],
      },
    ],
  });

  const variantMismatchRun = await collect(
    "/reconciliation/gundam-cross-variant-conflict",
    "reconcile-gundam-variant-conflict",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@2",
    },
  );
  const variantMismatch = await reconcile(variantMismatchRun.id);
  expect(variantMismatch.response.status).toBe(200);
  expect(requiredFirst(variantMismatch.document, "printings")).toMatchObject({
    id: printingId,
  });
  await approve(variantMismatch.document);
}, 30_000);

test("Gundam Printing identity is independent of locale observation order when EN-US is first", async () => {
  const usRun = await collect("/reconciliation/gundam-mirror-us", "stable-id-en-us-first", {
    game: "gundam",
    lineage: "gundam-en-us",
    adapter: "fixture-gundam-en-us-json@2",
  });
  const us = await reconcile(usRun.id);
  const printingId = requiredString(requiredFirst(us.document, "printings"), "id");
  expect(printingId).toBe("printing_133c063736fd275c675f6db014416609");
  await approve(us.document);

  const asiaRun = await collect("/reconciliation/gundam-mirror-asia", "stable-id-en-asia-second", {
    game: "gundam",
    lineage: "gundam-en-asia",
    adapter: "fixture-gundam-en-asia-json@2",
  });
  const asia = await reconcile(asiaRun.id);
  expect(requiredFirst(asia.document, "printings")).toMatchObject({
    id: printingId,
  });
  await approve(asia.document);
}, 20_000);

test("Gundam EN-ASIA Printing facts remain canonical when formatting-equivalent EN-US evidence arrives later", async () => {
  const asiaRun = await collect(
    "/reconciliation/gundam-printing-format-asia-first",
    "gundam-printing-format-asia-first",
    {
      game: "gundam",
      lineage: "gundam-en-asia",
      adapter: "fixture-gundam-en-asia-json@2",
    },
  );
  const asia = await reconcile(asiaRun.id);
  const printingId = requiredString(requiredFirst(asia.document, "printings"), "id");
  const firstPublished = await approve(asia.document);
  expect(firstPublished.response.status).toBe(200);

  const usRun = await collect("/reconciliation/gundam-printing-format-us-second", "gundam-printing-format-us-second", {
    game: "gundam",
    lineage: "gundam-en-us",
    adapter: "fixture-gundam-en-us-json@2",
  });
  const us = await reconcile(usRun.id);
  expect(requiredFirst(us.document, "printings")).toMatchObject({
    id: printingId,
    rarity: { raw: "L", normalized: "leader" },
    printed_rules_text: "Official printed rules",
    game_data: {
      profile: "gundam@1",
      attributes: { alternate_art: false },
    },
  });
  const published = await approve(us.document);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const exported = await exportComponentRecords(revisionId, "printings");
  expect(exported).toContainEqual(
    expect.objectContaining({
      id: printingId,
      rarity: { raw: "L", normalized: "leader" },
      printed_rules_text: "Official printed rules",
      game_data: {
        profile: "gundam@1",
        attributes: { alternate_art: false },
      },
    }),
  );
});

test("historical Gundam locators survive disappearance without retaining stale Card authority", async () => {
  const asiaOptions = {
    game: "gundam",
    lineage: "gundam-en-asia",
    adapter: "fixture-gundam-en-asia-json@2",
  } as const;
  const usOptions = {
    game: "gundam",
    lineage: "gundam-en-us",
    adapter: "fixture-gundam-en-us-json@2",
  } as const;

  const asiaRun = await collect(
    "/reconciliation/gundam-printing-lifecycle-primary-format-asia-first",
    "historical-authority-asia-first",
    asiaOptions,
  );
  const asia = await reconcile(asiaRun.id);
  const cardId = requiredString(requiredFirst(asia.document, "cards"), "id");
  const printingId = requiredString(requiredFirst(asia.document, "printings"), "id");
  await approve(asia.document);

  const asiaMissingRun = await collect(
    "/reconciliation/complete-empty-lineage",
    "historical-authority-asia-missing",
    asiaOptions,
  );
  const asiaMissing = await reconcile(asiaMissingRun.id);
  await approve(asiaMissing.document);
  const missingPrinting = await get(`/v1/reconciliation/printings/${printingId}`);
  expect(missingPrinting.document).toMatchObject({
    lifecycle: { withdrawn: false },
    locators: {
      historical: [
        expect.objectContaining({
          source_lineage: "gundam-en-asia",
          current: false,
        }),
      ],
    },
  });

  const historicalProductConflictRun = await collect(
    "/reconciliation/gundam-printing-lifecycle-primary-disappearance-us-product-conflict",
    "historical-provenance-us-product-conflict",
    usOptions,
  );
  const historicalProductConflict = await reconcile(historicalProductConflictRun.id);
  expect(historicalProductConflict.response.status).toBe(409);
  expect(historicalProductConflict.document.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "printing_match_insufficient_evidence",
        matched_printing_ids: [printingId],
        detail: expect.stringContaining("Product"),
      }),
    ]),
  );

  const usEquivalentRun = await collect(
    "/reconciliation/gundam-printing-lifecycle-primary-format-us-second",
    "historical-authority-us-equivalent",
    usOptions,
  );
  const usEquivalent = await reconcile(usEquivalentRun.id);
  expect(requiredFirst(usEquivalent.document, "cards")).toMatchObject({
    id: cardId,
    name: "  Printing   authority  ",
    effective_rules_text: "Official effective rules",
    game_data: {
      profile: "gundam@1",
      attributes: { effect_text: "  Official   effect  " },
    },
  });
  expect(requiredFirst(usEquivalent.document, "printings")).toMatchObject({
    id: printingId,
    rarity: { raw: "  L  ", normalized: "leader" },
    printed_rules_text: "  Official   printed rules  ",
    game_data: {
      profile: "gundam@1",
      attributes: { alternate_art: false },
    },
  });
  const usEquivalentPublished = await approve(usEquivalent.document);
  const usEquivalentRevision = requiredString(usEquivalentPublished.document, "resulting_revision_id");
  expect(await exportComponentRecords(usEquivalentRevision, "cards")).toContainEqual(
    expect.objectContaining({
      id: cardId,
      name: "  Printing   authority  ",
      effective_rules_text: "Official effective rules",
    }),
  );
  expect(await exportComponentRecords(usEquivalentRevision, "printings")).toContainEqual(
    expect.objectContaining({
      id: printingId,
      rarity: { raw: "  L  ", normalized: "leader" },
      printed_rules_text: "  Official   printed rules  ",
    }),
  );
  const corroborated = await get(`/v1/reconciliation/printings/${printingId}`);
  expect(corroborated.document.locators).toMatchObject({
    current: [expect.objectContaining({ source_lineage: "gundam-en-us" })],
    historical: [expect.objectContaining({ source_lineage: "gundam-en-asia" })],
  });

  const usConflictRun = await collect(
    "/reconciliation/gundam-printing-lifecycle-primary-disappearance-us-conflict",
    "historical-authority-us-conflict",
    usOptions,
  );
  const usConflict = await reconcile(usConflictRun.id);
  expect(usConflict.response.status).toBe(200);
  expect(requiredFirst(usConflict.document, "cards")).toMatchObject({
    id: cardId,
    name: "Contradictory historical-authority Card",
    game_data: {
      attributes: {
        effect_text: "Substantively different Card effect",
      },
    },
  });
  await post(`/v1/ingestion-runs/${usConflictRun.id}/rejection`, {
    candidate_digest: requiredString(usConflict.document, "candidate_digest"),
    idempotency_key: "reject-absent-asia-card-authority",
  });
  const usPrintingConflictRun = await collect(
    "/reconciliation/gundam-printing-lifecycle-primary-disappearance-us-printing-conflict",
    "historical-authority-us-printing-conflict",
    usOptions,
  );
  const usPrintingConflict = await reconcile(usPrintingConflictRun.id);
  expect(usPrintingConflict.response.status).toBe(200);
  expect(requiredFirst(usPrintingConflict.document, "printings")).toMatchObject({
    id: printingId,
    rarity: { raw: "Leader Rare", normalized: "leader" },
    printed_rules_text: "Substantively different printed rules",
    game_data: {
      attributes: { alternate_art: true },
    },
  });
  await post(`/v1/ingestion-runs/${usPrintingConflictRun.id}/rejection`, {
    candidate_digest: requiredString(usPrintingConflict.document, "candidate_digest"),
    idempotency_key: "reject-current-us-printing-evolution",
  });

  const usFirstRun = await collect(
    "/reconciliation/gundam-printing-lifecycle-reverse-format-us-first",
    "historical-authority-us-first",
    usOptions,
  );
  const usFirst = await reconcile(usFirstRun.id);
  const reverseCardId = requiredString(requiredFirst(usFirst.document, "cards"), "id");
  const reversePrintingId = requiredString(requiredFirst(usFirst.document, "printings"), "id");
  await approve(usFirst.document);
  const usMissingRun = await collect(
    "/reconciliation/complete-empty-lineage",
    "historical-authority-us-missing",
    usOptions,
  );
  const usMissing = await reconcile(usMissingRun.id);
  await approve(usMissing.document);
  const asiaEquivalentRun = await collect(
    "/reconciliation/gundam-printing-lifecycle-reverse-format-asia-second",
    "historical-authority-asia-equivalent",
    asiaOptions,
  );
  const asiaEquivalent = await reconcile(asiaEquivalentRun.id);
  expect(requiredFirst(asiaEquivalent.document, "cards")).toMatchObject({
    id: reverseCardId,
    name: "Printing authority",
    effective_rules_text: "Official effective rules",
    game_data: {
      profile: "gundam@1",
      attributes: { effect_text: "Official effect" },
    },
  });
  expect(requiredFirst(asiaEquivalent.document, "printings")).toMatchObject({
    id: reversePrintingId,
    rarity: { raw: "L", normalized: "leader" },
    printed_rules_text: "Official printed rules",
  });
  await approve(asiaEquivalent.document);

  const reverseConflictUsRun = await collect(
    "/reconciliation/gundam-printing-lifecycle-reverse-conflict-us-first",
    "historical-authority-conflict-us-first",
    usOptions,
  );
  const reverseConflictUs = await reconcile(reverseConflictUsRun.id);
  const reverseConflictCardId = requiredString(requiredFirst(reverseConflictUs.document, "cards"), "id");
  const reverseConflictPrintingId = requiredString(requiredFirst(reverseConflictUs.document, "printings"), "id");
  await approve(reverseConflictUs.document);
  const reverseConflictMissingRun = await collect(
    "/reconciliation/complete-empty-lineage",
    "historical-authority-conflict-us-missing",
    usOptions,
  );
  const reverseConflictMissing = await reconcile(reverseConflictMissingRun.id);
  await approve(reverseConflictMissing.document);
  const reverseConflictAsiaRun = await collect(
    "/reconciliation/gundam-printing-lifecycle-reverse-disappearance-asia-conflict",
    "historical-authority-conflict-asia-second",
    asiaOptions,
  );
  const reverseConflictAsia = await reconcile(reverseConflictAsiaRun.id);
  expect(reverseConflictAsia.response.status).toBe(200);
  expect(requiredFirst(reverseConflictAsia.document, "cards")).toMatchObject({
    id: reverseConflictCardId,
    name: "Contradictory historical-authority Card",
  });
  expect(requiredFirst(reverseConflictAsia.document, "printings")).toMatchObject({
    id: reverseConflictPrintingId,
    rarity: { raw: "Leader Rare", normalized: "leader" },
    printed_rules_text: "Different substantive Asia printed rules",
    game_data: { attributes: { alternate_art: true } },
  });
  await post(`/v1/ingestion-runs/${reverseConflictAsiaRun.id}/rejection`, {
    candidate_digest: requiredString(reverseConflictAsia.document, "candidate_digest"),
    idempotency_key: "reject-current-asia-printing-evolution",
  });
}, 45_000);

test("Gundam EN-ASIA Printing facts become canonical when formatting-equivalent EN-US evidence arrived first", async () => {
  const usRun = await collect("/reconciliation/gundam-printing-format-us-first", "gundam-printing-format-us-first", {
    game: "gundam",
    lineage: "gundam-en-us",
    adapter: "fixture-gundam-en-us-json@2",
  });
  const us = await reconcile(usRun.id);
  const printingId = requiredString(requiredFirst(us.document, "printings"), "id");
  await approve(us.document);

  const asiaRun = await collect(
    "/reconciliation/gundam-printing-format-asia-second",
    "gundam-printing-format-asia-second",
    {
      game: "gundam",
      lineage: "gundam-en-asia",
      adapter: "fixture-gundam-en-asia-json@2",
    },
  );
  const asia = await reconcile(asiaRun.id);
  expect(requiredFirst(asia.document, "printings")).toMatchObject({
    id: printingId,
    rarity: { raw: "L", normalized: "leader" },
    printed_rules_text: "Official printed rules",
    game_data: {
      profile: "gundam@1",
      attributes: { alternate_art: false },
    },
  });
  const published = await approve(asia.document);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const exported = await exportComponentRecords(revisionId, "printings");
  expect(exported).toContainEqual(
    expect.objectContaining({
      id: printingId,
      rarity: { raw: "L", normalized: "leader" },
      printed_rules_text: "Official printed rules",
      game_data: {
        profile: "gundam@1",
        attributes: { alternate_art: false },
      },
    }),
  );
});

test("Gundam substantive Printing fact conflicts outside the identity tuple block in both locale orders", async () => {
  for (const sequence of [
    {
      firstScenario: "gundam-printing-conflict-asia-first",
      firstLineage: "gundam-en-asia",
      firstAdapter: "fixture-gundam-en-asia-json@2",
      secondScenario: "gundam-printing-conflict-us-second",
      secondLineage: "gundam-en-us",
      secondAdapter: "fixture-gundam-en-us-json@2",
    },
    {
      firstScenario: "gundam-printing-conflict-us-first",
      firstLineage: "gundam-en-us",
      firstAdapter: "fixture-gundam-en-us-json@2",
      secondScenario: "gundam-printing-conflict-asia-second",
      secondLineage: "gundam-en-asia",
      secondAdapter: "fixture-gundam-en-asia-json@2",
    },
  ] as const) {
    const firstRun = await collect(`/reconciliation/${sequence.firstScenario}`, sequence.firstScenario, {
      game: "gundam",
      lineage: sequence.firstLineage,
      adapter: sequence.firstAdapter,
    });
    const first = await reconcile(firstRun.id);
    const printingId = requiredString(requiredFirst(first.document, "printings"), "id");
    await approve(first.document);

    const secondRun = await collect(`/reconciliation/${sequence.secondScenario}`, sequence.secondScenario, {
      game: "gundam",
      lineage: sequence.secondLineage,
      adapter: sequence.secondAdapter,
    });
    const second = await reconcile(secondRun.id);
    expect(second.response.status).toBe(409);
    expect(second.document).toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: "printing_match_contradictory",
          matched_printing_ids: [printingId],
          detail:
            "The retained Printing facts conflict across Gundam English " +
            "source lineages; EN-ASIA precedence cannot erase a substantive " +
            "EN-US disagreement.",
        }),
      ],
    });
  }
}, 15_000);

test("Gundam cross-locale formatting normalizes while substantive shared-fact conflicts block in both orders", async () => {
  const usRun = await collect("/reconciliation/gundam-authority-us", "reconcile-gundam-authority-us-first", {
    game: "gundam",
    lineage: "gundam-en-us",
    adapter: "fixture-gundam-en-us-json@2",
  });
  const us = await reconcile(usRun.id);
  await approve(us.document);

  const asiaRun = await collect("/reconciliation/gundam-authority-asia", "reconcile-gundam-authority-asia-second", {
    game: "gundam",
    lineage: "gundam-en-asia",
    adapter: "fixture-gundam-en-asia-json@2",
  });
  const asia = await reconcile(asiaRun.id);
  expect(asia.response.status).toBe(200);
  expect(requiredFirst(asia.document, "cards")).toMatchObject({
    id: requiredString(requiredFirst(us.document, "cards"), "id"),
    name: "Formatting equivalent name",
  });
  await approve(asia.document);

  const laterUsRun = await collect(
    "/reconciliation/gundam-authority-us-conflict",
    "reconcile-gundam-authority-us-conflict",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@2",
    },
  );
  const laterUs = await reconcile(laterUsRun.id);
  expect(laterUs.response.status).toBe(409);
  expect(laterUs.document).toMatchObject({
    diagnostics: [expect.objectContaining({ code: "canonical_card_conflict" })],
  });

  for (const sequence of [
    [
      "gundam-conflict-us-first",
      "gundam-en-us",
      "fixture-gundam-en-us-json@2",
      "gundam-conflict-asia-second",
      "gundam-en-asia",
      "fixture-gundam-en-asia-json@2",
    ],
    [
      "gundam-conflict-asia-first",
      "gundam-en-asia",
      "fixture-gundam-en-asia-json@2",
      "gundam-conflict-us-second",
      "gundam-en-us",
      "fixture-gundam-en-us-json@2",
    ],
  ] as const) {
    const [firstScenario, firstLineage, firstAdapter, secondScenario, secondLineage, secondAdapter] = sequence;
    const firstRun = await collect(`/reconciliation/${firstScenario}`, `reconcile-${firstScenario}`, {
      game: "gundam",
      lineage: firstLineage,
      adapter: firstAdapter,
    });
    const first = await reconcile(firstRun.id);
    expect(first.response.status).toBe(200);
    await approve(first.document);

    const secondRun = await collect(`/reconciliation/${secondScenario}`, `reconcile-${secondScenario}`, {
      game: "gundam",
      lineage: secondLineage,
      adapter: secondAdapter,
    });
    const second = await reconcile(secondRun.id);
    expect(second.response.status).toBe(409);
    expect(second.document).toMatchObject({
      diagnostics: [expect.objectContaining({ code: "canonical_card_conflict" })],
    });
  }
}, 30_000);
