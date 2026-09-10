import { expect, test } from "vitest";
import { nativeCandidateRecords, waitForNativeCandidates } from "./native-candidate-helpers";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import { nativeDiagnosticRecords } from "./query-helpers/native-diagnostic-records";
import * as reconciliationQueries from "./query-helpers/reconciliation";
import {
  approve,
  collect,
  exportComponentRecords,
  get,
  installReconciliationSuite,
  post,
  reconcile,
  requiredFirst,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("a structurally complete non-DON Card may have zero catalogued Printings", async () => {
  const run = await collect("/reconciliation/card-without-printing", "reconcile-card-without-printing");
  const candidate = await prepareNativeCandidate(
    run.id,
    "one-piece",
    "catrev_spine_000",
    "card-without-printing-candidate",
  );
  const records = await nativeCandidateRecords(String(candidate.id));
  expect(records.cards).toHaveLength(1);
  expect(records.printings ?? []).toEqual([]);
  const published = await approveNativeCandidate(candidate, "card-without-printing-publication");
  expect(published.response.status).toBe(200);
});

test("DON!! accepts explicit known Printing evidence while retaining incomplete-coverage warning semantics", async () => {
  const run = await collect("/reconciliation/profile-don-printing", "reconcile-don-known-printing");
  const candidate = await prepareNativeCandidate(
    run.id,
    "one-piece",
    "catrev_spine_000",
    "don-known-printing-candidate",
  );
  const records = await nativeCandidateRecords(String(candidate.id));
  expect(records.cards).toHaveLength(1);
  expect(records.printings).toHaveLength(1);
  expect([...(records.warnings ?? []), ...(records.shared_warnings ?? [])]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "printing_coverage_incomplete",
        card_id: requiredString(requiredFirst(records, "cards"), "id"),
      }),
    ]),
  );
  await approveNativeCandidate(candidate, "don-known-printing-publication");
});

test("unnumbered DON!! card content survives collection and publication", async () => {
  const run = await collect("/reconciliation/profile-don-card", "reconcile-don-card", {
    game: "one-piece",
    lineage: "one-piece-en",
    adapter: "fixture-one-piece-json@3",
  });
  const candidate = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "don-card-candidate");
  const records = await nativeCandidateRecords(String(candidate.id));
  const cards = records.cards!;
  const don = cards.find(
    (card) => (card.official_identity as Record<string, unknown>).kind === "functional_designation",
  );
  const companion = cards.find((card) => (card.official_identity as Record<string, unknown>).value === "OP30-001");
  if (don === undefined || companion === undefined) {
    throw new Error("DON!! card fixture cards are absent");
  }
  expect(don.official_identity).toEqual({ kind: "functional_designation", value: "DON!!" });
  expect(records).not.toHaveProperty("legality_rules");

  const published = await approveNativeCandidate(candidate, "don-card-publication");
  expect(published.response.status).toBe(200);
  expect(await exportComponentRecords(String(published.document.resulting_revision_id), "cards")).toContainEqual(
    expect.objectContaining({ id: don.id, official_identity: don.official_identity }),
  );
});

test("functional DON!! identity rejects a non-don Card shape even when Printing evidence exists", async () => {
  const run = await collect("/reconciliation/profile-don-invalid-printing", "reconcile-invalid-don-printing");
  const blocked = await prepareFailedNativeIdentity(
    run.id,
    "one-piece",
    "catrev_spine_000",
    "invalid-don-printing-candidate",
  );
  expect(blocked.outcome).toMatchObject({
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
  const blocked = await prepareFailedNativeIdentity(
    run.id,
    "one-piece",
    "catrev_spine_000",
    "invalid-numbered-don-candidate",
  );
  expect(blocked.outcome).toMatchObject({
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
  const lower = await prepareNativeCandidate(lowerRun.id, "one-piece", "catrev_spine_000", "identity-lower-candidate");
  const lowerRecords = await nativeCandidateRecords(String(lower.id));
  const cardId = requiredString(requiredFirst(lowerRecords, "cards"), "id");
  expect(requiredFirst(lowerRecords, "cards")).toMatchObject({
    official_identity: { kind: "card_number", value: "OP06-006" },
  });
  const lowerPublication = await approveNativeCandidate(lower, "identity-lower-publication");

  const upperRun = await collect("/reconciliation/identity-upper", "reconcile-identity-upper");
  const upper = await prepareNativeCandidate(
    upperRun.id,
    "one-piece",
    String(lowerPublication.document.resulting_revision_id),
    "identity-upper-candidate",
  );
  expect(requiredFirst(await nativeCandidateRecords(String(upper.id)), "cards")).toMatchObject({
    id: cardId,
    official_identity: { kind: "card_number", value: "OP06-006" },
  });
  const upperPublication = await approveNativeCandidate(upper, "identity-upper-publication");

  for (const scenario of ["identity-whitespace", "identity-malformed"]) {
    const run = await collect(`/reconciliation/${scenario}`, `reconcile-${scenario}`);
    const blocked = await prepareFailedNativeIdentity(
      run.id,
      "one-piece",
      String(upperPublication.document.resulting_revision_id),
      `${scenario}-candidate`,
    );
    expect(blocked.outcome).toMatchObject({
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
  const blocked = await prepareFailedNativeIdentity(
    run.id,
    "one-piece",
    "catrev_spine_000",
    "withdrawal-conflict-candidate",
  );
  expect(blocked).toMatchObject({ state: "failed" });
  expect(blocked.outcome).toMatchObject({
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
  const us = await prepareNativeCandidate(usRun.id, "gundam", "catrev_spine_000", "gundam-canonical-0-first");
  const usRecords = await nativeCandidateRecords(String(us.id));
  const printingId = requiredString(requiredFirst(usRecords, "printings"), "id");
  expect(printingId).toMatch(/^printing_[a-f0-9]{32}$/);
  const firstPublished = await approveNativeCandidate(us, "gundam-canonical-0-first-publication");

  const asiaRun = await collect("/reconciliation/gundam-mirror-asia", "stable-id-en-asia-second", {
    game: "gundam",
    lineage: "gundam-en-asia",
    adapter: "fixture-gundam-en-asia-json@2",
  });
  const asia = await prepareNativeCandidate(
    asiaRun.id,
    "gundam",
    String(firstPublished.document.resulting_revision_id),
    "gundam-canonical-0-second",
  );
  const asiaRecords = await nativeCandidateRecords(String(asia.id));
  expect(requiredFirst(asiaRecords, "printings")).toMatchObject({
    id: printingId,
  });
  await approveNativeCandidate(asia, "gundam-canonical-0-second-publication");
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
  const asia = await prepareNativeCandidate(asiaRun.id, "gundam", "catrev_spine_000", "gundam-canonical-1-first");
  const asiaRecords = await nativeCandidateRecords(String(asia.id));
  const printingId = requiredString(requiredFirst(asiaRecords, "printings"), "id");
  const firstPublished = await approveNativeCandidate(asia, "gundam-canonical-1-first-publication");
  expect(firstPublished.response.status).toBe(200);

  const usRun = await collect("/reconciliation/gundam-printing-format-us-second", "gundam-printing-format-us-second", {
    game: "gundam",
    lineage: "gundam-en-us",
    adapter: "fixture-gundam-en-us-json@2",
  });
  const us = await prepareNativeCandidate(
    usRun.id,
    "gundam",
    String(firstPublished.document.resulting_revision_id),
    "gundam-canonical-1-second",
  );
  const usRecords = await nativeCandidateRecords(String(us.id));
  expect(requiredFirst(usRecords, "printings")).toMatchObject({
    id: printingId,
    rarity: { raw: "L", normalized: "leader" },
    printed_rules_text: "Official printed rules",
    game_data: {
      profile: "gundam@1",
      attributes: { alternate_art: false },
    },
  });
  const published = await approveNativeCandidate(us, "gundam-canonical-1-second-publication");
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

function nativeGundamHistory() {
  let predecessor = "catrev_spine_000";
  const publish = async (candidate: Record<string, unknown>, key: string) => {
    const published = await approveNativeCandidate(candidate, key);
    expect(published.response.status, JSON.stringify(published.document)).toBe(200);
    predecessor = requiredString(published.document, "resulting_revision_id");
    return published;
  };
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

  return {
    get predecessor() {
      return predecessor;
    },
    publish,
    asiaOptions,
    usOptions,
  };
}

test("historical Gundam locators survive disappearance without retaining stale Card authority", async () => {
  const history = nativeGundamHistory();
  const { asiaOptions, usOptions } = history;
  const asiaRun = await collect(
    "/reconciliation/gundam-printing-lifecycle-primary-format-asia-first",
    "historical-authority-asia-first",
    asiaOptions,
  );
  const asia = await prepareNativeCandidate(asiaRun.id, "gundam", history.predecessor, "historical-native-asia");
  const asiaRecords = await nativeCandidateRecords(String(asia.id));
  const cardId = requiredString(requiredFirst(asiaRecords, "cards"), "id");
  const printingId = requiredString(requiredFirst(asiaRecords, "printings"), "id");
  await history.publish(asia, "historical-native-asia-publication");

  const asiaMissingRun = await collect(
    "/reconciliation/complete-empty-lineage",
    "historical-authority-asia-missing",
    asiaOptions,
  );
  const asiaMissing = await prepareNativeCandidate(
    asiaMissingRun.id,
    "gundam",
    history.predecessor,
    "historical-native-asiaMissing",
  );
  await history.publish(asiaMissing, "historical-native-asiaMissing-publication");
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
  const historicalProductConflict = await prepareFailedNativeIdentity(
    historicalProductConflictRun.id,
    "gundam",
    history.predecessor,
    "historical-native-product-conflict",
  );
  expect(await nativeDiagnosticRecords(testEnv.CATALOGUE_DB, String(historicalProductConflict.id))).toEqual(
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
  const usEquivalent = await prepareNativeCandidate(
    usEquivalentRun.id,
    "gundam",
    history.predecessor,
    "historical-native-usEquivalent",
  );
  const usEquivalentRecords = await nativeCandidateRecords(String(usEquivalent.id));
  expect(requiredFirst(usEquivalentRecords, "cards")).toMatchObject({
    id: cardId,
    name: "  Printing   authority  ",
    effective_rules_text: "Official effective rules",
    game_data: {
      profile: "gundam@1",
      attributes: { effect_text: "  Official   effect  " },
    },
  });
  expect(requiredFirst(usEquivalentRecords, "printings")).toMatchObject({
    id: printingId,
    rarity: { raw: "  L  ", normalized: "leader" },
    printed_rules_text: "  Official   printed rules  ",
    game_data: {
      profile: "gundam@1",
      attributes: { alternate_art: false },
    },
  });
  const usEquivalentPublished = await history.publish(usEquivalent, "historical-native-usEquivalent-publication");
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
  const usConflict = await prepareNativeCandidate(
    usConflictRun.id,
    "gundam",
    history.predecessor,
    "historical-native-usConflict",
  );
  const usConflictRecords = await nativeCandidateRecords(String(usConflict.id));
  expect(requiredFirst(usConflictRecords, "cards")).toMatchObject({
    id: cardId,
    name: "Contradictory historical-authority Card",
    game_data: {
      attributes: {
        effect_text: "Substantively different Card effect",
      },
    },
  });
  const usConflictAbandoned = await post(`/v1/game-candidates/${usConflict.id}/abandon`, {
    generation: usConflict.generation,
    idempotency_key: "reject-absent-asia-card-authority",
  });
  expect(usConflictAbandoned.response.status).toBe(200);
  expect(usConflictAbandoned.document.state).toBe("abandoned");
  const usPrintingConflictRun = await collect(
    "/reconciliation/gundam-printing-lifecycle-primary-disappearance-us-printing-conflict",
    "historical-authority-us-printing-conflict",
    usOptions,
  );
  const usPrintingConflict = await prepareNativeCandidate(
    usPrintingConflictRun.id,
    "gundam",
    history.predecessor,
    "historical-native-usPrintingConflict",
  );
  const usPrintingConflictRecords = await nativeCandidateRecords(String(usPrintingConflict.id));
  expect(requiredFirst(usPrintingConflictRecords, "printings")).toMatchObject({
    id: printingId,
    rarity: { raw: "Leader Rare", normalized: "leader" },
    printed_rules_text: "Substantively different printed rules",
    game_data: {
      attributes: { alternate_art: true },
    },
  });
  const usPrintingConflictAbandoned = await post(`/v1/game-candidates/${usPrintingConflict.id}/abandon`, {
    generation: usPrintingConflict.generation,
    idempotency_key: "reject-current-us-printing-evolution",
  });
  expect(usPrintingConflictAbandoned.response.status).toBe(200);
  expect(usPrintingConflictAbandoned.document.state).toBe("abandoned");
}, 45_000);

test("historical Gundam locators permit formatting-equivalent Asia evidence after US disappearance", async () => {
  const history = nativeGundamHistory();
  const { asiaOptions, usOptions } = history;
  const usFirstRun = await collect(
    "/reconciliation/gundam-printing-lifecycle-reverse-format-us-first",
    "historical-authority-us-first",
    usOptions,
  );
  const usFirst = await prepareNativeCandidate(
    usFirstRun.id,
    "gundam",
    history.predecessor,
    "historical-native-usFirst",
  );
  const usFirstRecords = await nativeCandidateRecords(String(usFirst.id));
  const reverseCardId = requiredString(requiredFirst(usFirstRecords, "cards"), "id");
  const reversePrintingId = requiredString(requiredFirst(usFirstRecords, "printings"), "id");
  await history.publish(usFirst, "historical-native-usFirst-publication");
  const usMissingRun = await collect(
    "/reconciliation/complete-empty-lineage",
    "historical-authority-us-missing",
    usOptions,
  );
  const usMissing = await prepareNativeCandidate(
    usMissingRun.id,
    "gundam",
    history.predecessor,
    "historical-native-usMissing",
  );
  await history.publish(usMissing, "historical-native-usMissing-publication");
  const asiaEquivalentRun = await collect(
    "/reconciliation/gundam-printing-lifecycle-reverse-format-asia-second",
    "historical-authority-asia-equivalent",
    asiaOptions,
  );
  const asiaEquivalent = await prepareNativeCandidate(
    asiaEquivalentRun.id,
    "gundam",
    history.predecessor,
    "historical-native-asiaEquivalent",
  );
  const asiaEquivalentRecords = await nativeCandidateRecords(String(asiaEquivalent.id));
  expect(requiredFirst(asiaEquivalentRecords, "cards")).toMatchObject({
    id: reverseCardId,
    name: "Printing authority",
    effective_rules_text: "Official effective rules",
    game_data: {
      profile: "gundam@1",
      attributes: { effect_text: "Official effect" },
    },
  });
  expect(requiredFirst(asiaEquivalentRecords, "printings")).toMatchObject({
    id: reversePrintingId,
    rarity: { raw: "L", normalized: "leader" },
    printed_rules_text: "Official printed rules",
  });
  await history.publish(asiaEquivalent, "historical-native-asiaEquivalent-publication");
}, 45_000);

test("historical Gundam locators permit changed Asia facts after conflicting US evidence disappears", async () => {
  const history = nativeGundamHistory();
  const { asiaOptions, usOptions } = history;
  const reverseConflictUsRun = await collect(
    "/reconciliation/gundam-printing-lifecycle-reverse-conflict-us-first",
    "historical-authority-conflict-us-first",
    usOptions,
  );
  const reverseConflictUs = await prepareNativeCandidate(
    reverseConflictUsRun.id,
    "gundam",
    history.predecessor,
    "historical-native-reverseConflictUs",
  );
  const reverseConflictUsRecords = await nativeCandidateRecords(String(reverseConflictUs.id));
  const reverseConflictCardId = requiredString(requiredFirst(reverseConflictUsRecords, "cards"), "id");
  const reverseConflictPrintingId = requiredString(requiredFirst(reverseConflictUsRecords, "printings"), "id");
  await history.publish(reverseConflictUs, "historical-native-reverseConflictUs-publication");
  const reverseConflictMissingRun = await collect(
    "/reconciliation/complete-empty-lineage",
    "historical-authority-conflict-us-missing",
    usOptions,
  );
  const reverseConflictMissing = await prepareNativeCandidate(
    reverseConflictMissingRun.id,
    "gundam",
    history.predecessor,
    "historical-native-reverseConflictMissing",
  );
  await history.publish(reverseConflictMissing, "historical-native-reverseConflictMissing-publication");
  const reverseConflictAsiaRun = await collect(
    "/reconciliation/gundam-printing-lifecycle-reverse-disappearance-asia-conflict",
    "historical-authority-conflict-asia-second",
    asiaOptions,
  );
  const reverseConflictAsia = await prepareNativeCandidate(
    reverseConflictAsiaRun.id,
    "gundam",
    history.predecessor,
    "historical-native-reverseConflictAsia",
  );
  const reverseConflictAsiaRecords = await nativeCandidateRecords(String(reverseConflictAsia.id));
  expect(requiredFirst(reverseConflictAsiaRecords, "cards")).toMatchObject({
    id: reverseConflictCardId,
    name: "Contradictory historical-authority Card",
  });
  expect(requiredFirst(reverseConflictAsiaRecords, "printings")).toMatchObject({
    id: reverseConflictPrintingId,
    rarity: { raw: "Leader Rare", normalized: "leader" },
    printed_rules_text: "Different substantive Asia printed rules",
    game_data: { attributes: { alternate_art: true } },
  });
  const reverseConflictAsiaAbandoned = await post(`/v1/game-candidates/${reverseConflictAsia.id}/abandon`, {
    generation: reverseConflictAsia.generation,
    idempotency_key: "reject-current-asia-printing-evolution",
  });
  expect(reverseConflictAsiaAbandoned.response.status).toBe(200);
  expect(reverseConflictAsiaAbandoned.document.state).toBe("abandoned");
}, 45_000);

test("Gundam EN-ASIA Printing facts become canonical when formatting-equivalent EN-US evidence arrived first", async () => {
  const usRun = await collect("/reconciliation/gundam-printing-format-us-first", "gundam-printing-format-us-first", {
    game: "gundam",
    lineage: "gundam-en-us",
    adapter: "fixture-gundam-en-us-json@2",
  });
  const us = await prepareNativeCandidate(usRun.id, "gundam", "catrev_spine_000", "gundam-canonical-2-first");
  const usRecords = await nativeCandidateRecords(String(us.id));
  const printingId = requiredString(requiredFirst(usRecords, "printings"), "id");
  const firstPublished = await approveNativeCandidate(us, "gundam-canonical-2-first-publication");

  const asiaRun = await collect(
    "/reconciliation/gundam-printing-format-asia-second",
    "gundam-printing-format-asia-second",
    {
      game: "gundam",
      lineage: "gundam-en-asia",
      adapter: "fixture-gundam-en-asia-json@2",
    },
  );
  const asia = await prepareNativeCandidate(
    asiaRun.id,
    "gundam",
    String(firstPublished.document.resulting_revision_id),
    "gundam-canonical-2-second",
  );
  const asiaRecords = await nativeCandidateRecords(String(asia.id));
  expect(requiredFirst(asiaRecords, "printings")).toMatchObject({
    id: printingId,
    rarity: { raw: "L", normalized: "leader" },
    printed_rules_text: "Official printed rules",
    game_data: {
      profile: "gundam@1",
      attributes: { alternate_art: false },
    },
  });
  const published = await approveNativeCandidate(asia, "gundam-canonical-2-second-publication");
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

// Synthetic source fixture exercises the authenticated administration boundary.
test("opaque identities retain inspectable source mappings before and after publication", async () => {
  const run = await collect("/reconciliation/base", "opaque-mapping");
  const candidate = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "opaque-mapping-candidate");
  const printing = requiredFirst(await nativeCandidateRecords(String(candidate.id)), "printings");
  const mapped = await get(`/v1/reconciliation/identities/${printing.id}?preparation_id=${candidate.id}`);
  expect(mapped.response.status).toBe(200);
  expect(mapped.document).toMatchObject({
    id: printing.id,
    kind: "printing",
    allocation: "opaque",
    mappings: [expect.objectContaining({ source_lineage: "one-piece-en", ingestion_run_id: run.id })],
  });
  const published = await approveNativeCandidate(candidate, "opaque-mapping-publication");
  const publishedMappings = await get(`/v1/reconciliation/identities/${printing.id}?preparation_id=${candidate.id}`);
  expect(publishedMappings.response.status).toBe(200);
  const refreshedRun = await collect("/reconciliation/new-locator", "opaque-mapping-refresh");
  const refreshed = await prepareNativeCandidate(
    refreshedRun.id,
    "one-piece",
    String(published.document.resulting_revision_id),
    "opaque-mapping-refresh-candidate",
  );
  expect(requiredFirst(await nativeCandidateRecords(String(refreshed.id)), "printings").id).toBe(printing.id);
  const history = await get(`/v1/reconciliation/identities/${printing.id}?preparation_id=${refreshed.id}`);
  expect(history.response.status).toBe(200);
  expect(history.document.mappings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ preparation_id: refreshed.id, ingestion_run_id: refreshedRun.id }),
    ]),
  );
  expect(
    (mapped.document.mappings as unknown[]).length + (history.document.mappings as unknown[]).length,
  ).toBeGreaterThan(1);
  expect((await get(`/v1/reconciliation/identities/${printing.id}?preparation_id=${candidate.id}`)).document).toEqual(
    publishedMappings.document,
  );
});

test("synthetic exact cross-source evidence retains one consumer Printing after an explicit authority change", async () => {
  const run = await collect("/reconciliation/canonical-official", "cross-official");
  const initial = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "cross-official-candidate");
  const printing = requiredFirst(await nativeCandidateRecords(String(initial.id)), "printings");
  const seedPublished = await approveNativeCandidate(initial, "cross-official-publication");
  for (const area of ["card_facts", "printing_details"]) {
    const designated = await post("/v1/source-authorities", {
      game: "one-piece",
      locale: "en",
      release_region: "OCEANIA",
      area,
      source_lineage: "limitless-one-piece-en",
      expected_generation: "0",
      rationale: "Synthetic cross-source matching test",
      idempotency_key: `cross-${area}`,
    });
    expect(designated.response.status).toBe(200);
  }
  const other = await collect("/reconciliation/canonical-tabular", "cross-tabular", {
    game: "one-piece",
    lineage: "limitless-one-piece-en",
    adapter: "fixture-one-piece-tabular@1",
  });
  const matched = await prepareNativeCandidate(
    other.id,
    "one-piece",
    String(seedPublished.document.resulting_revision_id),
    "cross-tabular-candidate",
  );
  const records = await nativeCandidateRecords(String(matched.id));
  expect(records.printings).toHaveLength(1);
  expect(requiredFirst(records, "printings").id).toBe(printing.id);
  const published = await approveNativeCandidate(matched, "cross-tabular-publication");
  expect(published.response.status).toBe(200);
  const exported = await exportComponentRecords(
    requiredString(published.document, "resulting_revision_id"),
    "printings",
  );
  expect(exported).toHaveLength(1);
  expect(exported[0]).toMatchObject({ id: printing.id });
});

test("synthetic missing publisher number stays unknown through candidate and consumer export", async () => {
  const run = await collect("/reconciliation/identity-missing-number", "missing-number");
  const candidate = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "missing-number-candidate");
  const records = await nativeCandidateRecords(String(candidate.id));
  expect(requiredFirst(records, "cards").official_identity).toEqual({ kind: "unknown", value: null });
  const published = await approveNativeCandidate(candidate, "missing-number-publication");
  expect(published.response.status, JSON.stringify(published.document)).toBe(200);
  const cards = await exportComponentRecords(requiredString(published.document, "resulting_revision_id"), "cards");
  expect(cards[0]).toMatchObject({ official_identity: { kind: "unknown", value: null } });
});

test("equal source-local artwork labels require owner evidence review across sources", async () => {
  const firstRun = await collect("/reconciliation/canonical-official-ambiguous", "review-official");
  const first = await prepareNativeCandidate(firstRun.id, "one-piece", "catrev_spine_000", "review-official-candidate");
  const printingId = requiredString(requiredFirst(await nativeCandidateRecords(String(first.id)), "printings"), "id");
  const publication = await approveNativeCandidate(first, "review-official-publication");
  const predecessor = String(publication.document.resulting_revision_id);
  for (const area of ["card_facts", "printing_details"]) {
    expect(
      (
        await post("/v1/source-authorities", {
          game: "one-piece",
          locale: "en",
          release_region: "OCEANIA",
          area,
          source_lineage: "limitless-one-piece-en",
          expected_generation: "0",
          rationale: "Synthetic review test",
          idempotency_key: `review-${area}`,
        })
      ).response.status,
    ).toBe(200);
  }
  const source = { game: "one-piece", lineage: "limitless-one-piece-en", adapter: "fixture-one-piece-tabular@1" };
  const run = await collect("/reconciliation/canonical-tabular-ambiguous", "review-ambiguous", source);
  const blocked = await prepareFailedNativeIdentity(run.id, "one-piece", predecessor, "review-ambiguous-candidate");
  const reviews = await get(`/v1/reconciliation/identity-reviews?run_id=${run.id}&preparation_id=${blocked.id}`);
  expect(reviews.response.status).toBe(200);
  const review = requiredFirst(reviews.document, "reviews");
  expect(review).toMatchObject({ candidate_printing_ids: [printingId], source_lineage: "limitless-one-piece-en" });
  expect(review.evidence).toBeDefined();
  const repeatedRun = await collect("/reconciliation/canonical-tabular-ambiguous", "review-unresolved-retry", source);
  const repeated = await prepareFailedNativeIdentity(
    repeatedRun.id,
    "one-piece",
    predecessor,
    "review-unresolved-candidate",
  );
  const repeatedReviews = await get(
    `/v1/reconciliation/identity-reviews?run_id=${repeatedRun.id}&preparation_id=${repeated.id}`,
  );
  expect(repeatedReviews.document.reviews).toHaveLength(1);
  const request = {
    printing_id: printingId,
    rationale: "Owner inspected both retained depictions and established the same issued Printing",
    idempotency_key: "resolve-identity",
  };
  const invalidTarget = await post(`/v1/reconciliation/identity-reviews/${review.id}/resolve`, {
    ...request,
    printing_id: "unreviewed-printing",
  });
  expect(invalidTarget.response.status).toBe(422);
  expect(invalidTarget.document.code).toBe("identity_review_target_invalid");
  const resolved = await post(`/v1/reconciliation/identity-reviews/${review.id}/resolve`, request);
  expect(resolved.response.status, JSON.stringify(resolved.document)).toBe(200);
  expect(resolved.document).not.toHaveProperty("native_candidate_id");
  expect(resolved.document).not.toHaveProperty("historical_printing_id");
  expect((await post(`/v1/reconciliation/identity-reviews/${review.id}/resolve`, request)).document).toEqual(
    resolved.document,
  );
  for (const changed of [
    { ...request, rationale: "A different owner decision" },
    { ...request, idempotency_key: "different-identity-decision" },
  ]) {
    const refused = await post(`/v1/reconciliation/identity-reviews/${review.id}/resolve`, changed);
    expect(refused.response.status).toBe(409);
    expect(refused.document.code).toBe("identity_review_already_resolved");
  }
  const retry = await collect("/reconciliation/canonical-tabular-ambiguous", "review-retry", source);
  const matched = await prepareNativeCandidate(retry.id, "one-piece", predecessor, "review-retry-candidate");
  expect(requiredFirst(await nativeCandidateRecords(String(matched.id)), "printings").id).toBe(printingId);
  expect((await approveNativeCandidate(matched, "review-retry-publication")).response.status).toBe(200);
});

test("missing-number Printing keeps both opaque IDs when its source locator changes", async () => {
  const originalRun = await collect("/reconciliation/identity-missing-number", "unknown-original");
  const original = await prepareNativeCandidate(
    originalRun.id,
    "one-piece",
    "catrev_spine_000",
    "unknown-original-candidate",
  );
  const originalRecords = await nativeCandidateRecords(String(original.id));
  const published = await approveNativeCandidate(original, "unknown-original-publication");
  const movedRun = await collect("/reconciliation/identity-missing-number-moved", "unknown-moved");
  const moved = await prepareNativeCandidate(
    movedRun.id,
    "one-piece",
    String(published.document.resulting_revision_id),
    "unknown-moved-candidate",
  );
  const records = await nativeCandidateRecords(String(moved.id));
  expect(records.cards).toHaveLength(1);
  expect(records.printings).toHaveLength(1);
  expect(requiredFirst(records, "cards").id).toBe(requiredFirst(originalRecords, "cards").id);
  expect(requiredFirst(records, "printings").id).toBe(requiredFirst(originalRecords, "printings").id);
});

test("owner can traverse all retained source mappings without repeating pages", async () => {
  const run = await collect("/reconciliation/identity-many-mappings", "mapping-pages");
  const candidate = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "mapping-pages-candidate");
  const id = requiredString(requiredFirst(await nativeCandidateRecords(String(candidate.id)), "printings"), "id");
  const first = await get(`/v1/reconciliation/identities/${id}?preparation_id=${candidate.id}`);
  expect(first.document.mappings).toHaveLength(100);
  const second = await get(
    `/v1/reconciliation/identities/${id}?preparation_id=${candidate.id}&after=${first.document.next_cursor}`,
  );
  expect(second.document.mappings).toHaveLength(1);
  expect(second.document.next_cursor).toBeNull();
});

test("missing-number cross-source evidence reviews the existing Card and Printing instead of creating duplicates", async () => {
  const firstRun = await collect("/reconciliation/identity-missing-number", "unknown-cross-first");
  const first = await prepareNativeCandidate(
    firstRun.id,
    "one-piece",
    "catrev_spine_000",
    "unknown-cross-first-candidate",
  );
  const firstRecords = await nativeCandidateRecords(String(first.id));
  const cardId = requiredString(requiredFirst(firstRecords, "cards"), "id");
  const printingId = requiredString(requiredFirst(firstRecords, "printings"), "id");
  const publication = await approveNativeCandidate(first, "unknown-cross-first-publication");
  const predecessor = String(publication.document.resulting_revision_id);
  for (const area of ["card_facts", "printing_details"]) {
    expect(
      (
        await post("/v1/source-authorities", {
          game: "one-piece",
          locale: "en",
          release_region: "OCEANIA",
          area,
          source_lineage: "limitless-one-piece-en",
          expected_generation: "0",
          rationale: "Synthetic missing-number mapping",
          idempotency_key: `unknown-cross-${area}`,
        })
      ).response.status,
    ).toBe(200);
  }
  const source = { game: "one-piece", lineage: "limitless-one-piece-en", adapter: "fixture-one-piece-tabular@1" };
  const run = await collect("/reconciliation/identity-missing-number-tabular", "unknown-cross-review", source);
  const failed = await prepareFailedNativeIdentity(run.id, "one-piece", predecessor, "unknown-cross-review-candidate");
  const review = requiredFirst(
    (await get(`/v1/reconciliation/identity-reviews?run_id=${run.id}&preparation_id=${failed.id}`)).document,
    "reviews",
  );
  expect(review.candidate_printing_ids).toEqual([printingId]);
  expect(
    (
      await post(`/v1/reconciliation/identity-reviews/${review.id}/resolve`, {
        printing_id: printingId,
        rationale: "Reviewed the exact retained Printing evidence",
        idempotency_key: "unknown-cross-resolve",
      })
    ).response.status,
  ).toBe(200);
  const changedRun = await collect(
    "/reconciliation/identity-missing-number-tabular-changed",
    "unknown-cross-changed-artwork",
    source,
  );
  const changed = await prepareFailedNativeIdentity(
    changedRun.id,
    "one-piece",
    predecessor,
    "unknown-cross-changed-candidate",
  );
  expect(changed.outcome).toMatchObject({ publishable: false });
  const matchedRun = await collect("/reconciliation/identity-missing-number-tabular", "unknown-cross-retry", source);
  const matched = await prepareNativeCandidate(
    matchedRun.id,
    "one-piece",
    predecessor,
    "unknown-cross-retry-candidate",
  );
  const matchedRecords = await nativeCandidateRecords(String(matched.id));
  expect(matchedRecords.cards).toHaveLength(1);
  expect(requiredFirst(matchedRecords, "cards").id).toBe(cardId);
  expect(requiredFirst(matchedRecords, "printings").id).toBe(printingId);
  const matchedPublication = await approveNativeCandidate(matched, "unknown-cross-retry-publication");
  const laterRun = await collect("/reconciliation/identity-missing-number-tabular", "unknown-cross-later", source);
  const later = await prepareNativeCandidate(
    laterRun.id,
    "one-piece",
    String(matchedPublication.document.resulting_revision_id),
    "unknown-cross-later-candidate",
  );
  expect(requiredFirst(await nativeCandidateRecords(String(later.id)), "printings").id).toBe(printingId);
});

test("equal unknown Card facts and distinct artwork require identity review, not automatic Card equivalence", async () => {
  const run = await collect("/reconciliation/identity-missing-number", "unknown-equivalence-first");
  const first = await prepareNativeCandidate(
    run.id,
    "one-piece",
    "catrev_spine_000",
    "unknown-equivalence-first-candidate",
  );
  const published = await approveNativeCandidate(first, "unknown-equivalence-first-publication");
  const distinctRun = await collect("/reconciliation/identity-missing-number-distinct", "unknown-equivalence-distinct");
  const distinct = await prepareFailedNativeIdentity(
    distinctRun.id,
    "one-piece",
    String(published.document.resulting_revision_id),
    "unknown-equivalence-distinct-candidate",
  );
  expect(distinct.outcome).toMatchObject({
    publishable: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "canonical_card_conflict" })]),
  });
});

async function prepareFailedNativeIdentity(runId: string, game: string, predecessor: string, key: string) {
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: runId,
    supported_game: game,
    expected_game_revision_id: predecessor,
    idempotency_key: key,
  });
  expect(created.response.status, JSON.stringify(created.document)).toBe(201);
  const [candidate] = await waitForNativeCandidates(runId, 1, 15_000, { [game]: "failed" });
  return candidate!;
}
