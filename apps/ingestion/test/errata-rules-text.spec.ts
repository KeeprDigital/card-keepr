import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { cardCollectionResponse } from "../../../src/catalogue/card-collection-read";
import {
  catalogueExportResponse,
  currentCardResponse,
} from "../../../src/catalogue/read";
import { authenticateCredentialBearer } from "../../../src/http/authentication";
import type { StartEvidenceRunRequest } from "../../../src/catalogue/source-evidence";
import { buildCatalogueExport } from "../../../src/catalogue/export";
import { fixtureCandidate } from "../../../src/catalogue/fixture";
import {
  injectFixtureEvidencePlan,
  injectFixturePublication,
} from "./fixture-plan-injection";

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

describe("Errata rules-text lifecycle", () => {
  test("raw Errata NDJSON bytes follow the manifest id:utf8 ordering contract", async () => {
    const base = await fixtureCandidate("first-catalogue", ["one-piece"]);
    const cardId = base.candidate.cards[0]!.id;
    const provenance = [{
      source_lineage: "one-piece-en",
      source_observation_id: "srcobs_errata_order",
    }];
    const built = await buildCatalogueExport(
      {
        ...base.candidate,
        errata: [
          {
            id: "erratum_z_late_utf8",
            game: "one-piece",
            target_type: "card",
            target_id: cardId,
            effective_from: "2026-01-01",
            official_wording: "Earlier effective date, later UTF-8 id.",
            corrected_value: "Earlier correction.",
            provenance,
          },
          {
            id: "erratum_a_early_utf8",
            game: "one-piece",
            target_type: "card",
            target_id: cardId,
            effective_from: "2026-12-31",
            official_wording: "Later effective date, earlier UTF-8 id.",
            corrected_value: "Later correction.",
            provenance,
          },
        ],
      },
      base.digest,
      "catrev_errata_raw_order",
      "2026-07-30T00:00:00.000Z",
    );
    const component = built.manifest.components.find(
      (candidate) => candidate.name === "errata",
    );
    const object = built.objects.find((candidate) =>
      candidate.key.includes(component?.compressed_sha256 ?? "missing")
    );
    expect(object).toBeDefined();
    const body = object!.body();
    const decompressed = body.readable.pipeThrough(
      new DecompressionStream("gzip"),
    );
    const raw = await new Response(decompressed).text();
    await body.completed;
    expect(
      raw.trim().split("\n").map((line) =>
        (JSON.parse(line) as { id: string }).id
      ),
    ).toEqual([
      "erratum_a_early_utf8",
      "erratum_z_late_utf8",
    ]);
    expect(raw.indexOf('"id":"erratum_a_early_utf8"')).toBeLessThan(
      raw.indexOf('"id":"erratum_z_late_utf8"'),
    );
  });

  test("applicable Card Errata reconcile the same raw rules across authoritative lineages", async () => {
    const asiaRun = await collect(
      "/reconciliation/gundam-errata-cross-lineage-asia",
      "reconcile-gundam-errata-asia",
      {
        game: "gundam",
        lineage: "gundam-en-asia",
        adapter: "fixture-gundam-en-asia-json@1",
      },
    );
    const asia = await reconcile(asiaRun.id);
    expect(asia.response.status).toBe(200);
    expect((await approve(asia.document)).response.status).toBe(200);

    const usRun = await collect(
      "/reconciliation/gundam-errata-cross-lineage-us",
      "reconcile-gundam-errata-us",
      {
        game: "gundam",
        lineage: "gundam-en-us",
        adapter: "fixture-gundam-en-us-json@1",
      },
    );
    const us = await reconcile(usRun.id);
    expect(us.response.status).toBe(200);
    expect(us.document).toMatchObject({
      cards: [{ effective_rules_text: "Corrected cross-lineage rules." }],
      diagnostics: [],
    });
    expect((await approve(us.document)).response.status).toBe(200);
  });

  test("current-run Official Errata authority applies before cross-lineage Card comparison", async () => {
    const asiaRun = await collect(
      "/reconciliation/gundam-current-run-errata-asia",
      "reconcile-current-run-errata-asia",
      {
        game: "gundam",
        lineage: "gundam-en-asia",
        adapter: "fixture-gundam-en-asia-json@1",
      },
    );
    const asia = await reconcile(asiaRun.id);
    expect(asia.response.status).toBe(200);
    expect((await approve(asia.document)).response.status).toBe(200);

    const usRun = await collect(
      "/reconciliation/gundam-current-run-errata-us",
      "reconcile-current-run-errata-us",
      {
        game: "gundam",
        lineage: "gundam-en-us",
        adapter: "fixture-gundam-en-us-json@1",
      },
    );
    const us = await reconcile(usRun.id);
    expect(us.response.status).toBe(200);
    expect(us.document).toMatchObject({
      diagnostics: [],
      cards: [{
        effective_rules_text: "Authoritative current Card wording.",
      }],
    });
    expect((await approve(us.document)).response.status).toBe(200);
  });

  test("legacy persisted candidates without Errata remain inspectable and retryable", async () => {
    const started = await injectFixturePublication(
      testEnv.CATALOGUE_DB,
      testEnv.CATALOGUE_EXPORTS,
      {
        fixture: "first-catalogue",
        selected_games: ["one-piece"],
        idempotency_key: "legacy-candidate-without-errata",
      },
      "2026-07-30T00:00:00.000Z",
    );
    const runId = requiredString(started, "id");
    const rejected = await post(`/v1/ingestion-runs/${runId}/rejection`, {
      candidate_digest: requiredString(started, "candidate_digest"),
      idempotency_key: "reject-legacy-candidate-without-errata",
    });
    expect(rejected.response.status).toBe(200);
    const stored = await testEnv.CATALOGUE_DB.prepare(
      "SELECT candidate_json FROM ingestion_runs WHERE id = ?",
    )
      .bind(runId)
      .first<{ candidate_json: string }>();
    const legacy = JSON.parse(stored?.candidate_json ?? "{}") as
      Record<string, unknown>;
    delete legacy.errata;
    const legacyRunId = "run_legacy_candidate_without_errata";
    await testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_digest, candidate_created_at, approval_deadline,
         approval_json, published_revision_id, export_manifest_digest,
         terminal_at, candidate_json, approval_idempotency_key,
         failure_code, progress_json, warnings_json,
         approval_history_json, publication_outcome,
         resulting_revision_id, freshness_checked_at,
         publication_revision_id, publication_started_at,
         publication_reconcile_after, publication_manifest_digest,
         publication_writer_token, candidate_catalogue_digest
       )
       SELECT ?, state, selected_games_json, started_at,
              expected_current_revision_id, NULL, ?,
              candidate_digest, candidate_created_at, approval_deadline,
              approval_json, published_revision_id, export_manifest_digest,
              terminal_at, ?, NULL,
              failure_code, progress_json, warnings_json,
              approval_history_json, publication_outcome,
              resulting_revision_id, freshness_checked_at,
              publication_revision_id, publication_started_at,
              publication_reconcile_after, publication_manifest_digest,
              publication_writer_token, candidate_catalogue_digest
       FROM ingestion_runs WHERE id = ?`,
    )
      .bind(
        legacyRunId,
        "persisted-legacy-candidate-without-errata",
        JSON.stringify(legacy),
        runId,
      )
      .run();

    expect((await get(`/v1/ingestion-runs/${legacyRunId}`)).response.status)
      .toBe(200);
    const retried = await post(`/v1/ingestion-runs/${legacyRunId}/retry`, {
      idempotency_key: "retry-legacy-candidate-without-errata",
    });
    expect(retried.response.status).toBe(201);
    const retriedRunId = requiredString(retried.document, "id");
    const retriedRejected = await post(
      `/v1/ingestion-runs/${retriedRunId}/rejection`,
      {
        candidate_digest: requiredString(
          retried.document,
          "candidate_digest",
        ),
        idempotency_key: "reject-retried-legacy-candidate",
      },
    );
    expect(retriedRejected.response.status).toBe(200);
  });

  test("a selected future Erratum cannot silently stale while awaiting approval", async () => {
    const run = await collect(
      "/reconciliation/errata-future-boundary",
      "reconcile-future-errata-before-boundary",
    );
    const reconciled = await post(
      `/v1/ingestion-runs/${run.id}/reconciliation`,
      {},
      { "x-keepr-test-now": "2026-07-31T23:59:00.000Z" },
    );
    expect(reconciled.response.status).toBe(200);
    expect(reconciled.document).toMatchObject({
      cards: [{ effective_rules_text: "Rules before the future Erratum." }],
    });
    const approval = await post(
      `/v1/ingestion-runs/${run.id}/approval`,
      {
        candidate_digest: requiredString(
          reconciled.document,
          "candidate_digest",
        ),
        expected_current_revision_id: requiredString(
          reconciled.document,
          "expected_current_revision_id",
        ),
        idempotency_key: "approve-future-errata-after-boundary",
      },
      { "x-keepr-test-now": "2026-08-01T00:01:00.000Z" },
    );
    expect(approval.response.status).toBe(409);
    expect(approval.document).toMatchObject({
      code: "candidate_errata_stale",
    });
    const rejected = await post(
      `/v1/ingestion-runs/${run.id}/rejection`,
      {
        candidate_digest: requiredString(
          reconciled.document,
          "candidate_digest",
        ),
        idempotency_key: "reject-stale-future-errata",
      },
      { "x-keepr-test-now": "2026-08-01T00:02:00.000Z" },
    );
    expect(rejected.response.status).toBe(200);

    const carriedRun = await collect(
      "/reconciliation/errata-future-boundary",
      "publish-future-errata-before-boundary",
    );
    const carried = await post(
      `/v1/ingestion-runs/${carriedRun.id}/reconciliation`,
      {},
      { "x-keepr-test-now": "2026-07-31T23:50:00.000Z" },
    );
    const carriedPublished = await post(
      `/v1/ingestion-runs/${carriedRun.id}/approval`,
      {
        candidate_digest: requiredString(carried.document, "candidate_digest"),
        expected_current_revision_id: requiredString(
          carried.document,
          "expected_current_revision_id",
        ),
        idempotency_key: "approve-future-errata-before-boundary",
      },
      { "x-keepr-test-now": "2026-07-31T23:55:00.000Z" },
    );
    expect(carriedPublished.response.status).toBe(200);

    const subsetRun = await collect(
      "/reconciliation/gundam-authority-us",
      "reconcile-unselected-future-errata-after-boundary",
      {
        game: "gundam",
        lineage: "gundam-en-us",
        adapter: "fixture-gundam-en-us-json@1",
      },
    );
    const subset = await post(
      `/v1/ingestion-runs/${subsetRun.id}/reconciliation`,
      {},
      { "x-keepr-test-now": "2026-08-01T00:05:00.000Z" },
    );
    const subsetPublished = await post(
      `/v1/ingestion-runs/${subsetRun.id}/approval`,
      {
        candidate_digest: requiredString(subset.document, "candidate_digest"),
        expected_current_revision_id: requiredString(
          subset.document,
          "expected_current_revision_id",
        ),
        idempotency_key: "approve-unselected-future-errata",
      },
      { "x-keepr-test-now": "2026-08-01T00:06:00.000Z" },
    );
    expect(subsetPublished.response.status).toBe(200);
    const cards = await exportComponentRecords(
      requiredString(subsetPublished.document, "resulting_revision_id"),
      "cards",
    );
    expect(cards).toContainEqual(
      expect.objectContaining({
        name: "Future Errata Card",
        effective_rules_text: "Rules before the future Erratum.",
      }),
    );
  });

  test("an official Erratum preserves observed and Printed Rules Text while publishing corrected Effective Rules Text", async () => {
    const run = await collect(
      "/reconciliation/errata-card-rules-text",
      "reconcile-errata-card-rules-text",
    );
    const reconciled = await reconcile(run.id);

    expect(reconciled.response.status).toBe(200);
    expect(reconciled.document).toMatchObject({
      state: "awaiting_approval",
      publishable: true,
      cards: [
        {
          effective_rules_text:
            "[On Play] Draw 2 cards, then discard 1 card.",
        },
      ],
      printings: [
        {
          printed_rules_text: "[On Play] Draw 1 card.",
        },
      ],
    });
    expect(reconciled.document.errata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_type: "card",
          effective_from: "2026-07-01",
          official_wording:
            'Replace "Draw 1 card" with "Draw 2 cards, then discard 1 card".',
          corrected_value:
            "[On Play] Draw 2 cards, then discard 1 card.",
        }),
      ]),
    );

    const published = await approve(reconciled.document);
    expect(published.response.status).toBe(200);
    const revisionId = requiredString(
      published.document,
      "resulting_revision_id",
    );
    const [cards, printings, errata] = await Promise.all([
      exportComponentRecords(revisionId, "cards"),
      exportComponentRecords(revisionId, "printings"),
      exportComponentRecords(revisionId, "errata"),
    ]);
    expect(cards).toContainEqual(
      expect.objectContaining({
        effective_rules_text:
          "[On Play] Draw 2 cards, then discard 1 card.",
      }),
    );
    expect(printings).toContainEqual(
      expect.objectContaining({
        printed_rules_text: "[On Play] Draw 1 card.",
      }),
    );
    expect(errata).toContainEqual(
      expect.objectContaining({
        target_type: "card",
        effective_from: "2026-07-01",
        corrected_value:
          "[On Play] Draw 2 cards, then discard 1 card.",
      }),
    );
    const erratum = errata.find(
      (candidate) =>
        candidate.corrected_value ===
        "[On Play] Draw 2 cards, then discard 1 card.",
    );
    expect(erratum).toBeDefined();
    if (erratum === undefined) {
      throw new Error("Expected the published Card Erratum in the export.");
    }
    const currentCard = await currentCardResponse(
      testEnv.CATALOGUE_DB,
      String(erratum.target_id),
    );
    expect(currentCard?.status).toBe(200);
    await expect(currentCard?.json()).resolves.toMatchObject({
      data: {
        id: erratum.target_id,
        effective_rules_text:
          "[On Play] Draw 2 cards, then discard 1 card.",
      },
    });
    const searchRequest = new Request(
      "https://card-keepr.invalid/v1/cards?q=draw%202%20cards",
      { headers: { authorization: "Bearer published-erratum-api-key" } },
    );
    expect(
      await authenticateCredentialBearer(
        searchRequest,
        testEnv.CATALOGUE_DB,
        "api_bearer_key",
        ["published-erratum-api-key"],
        "errata-published-authentication",
        {
          missing: "authentication_required",
          invalid: "invalid_api_key",
        },
      ),
    ).toBeNull();
    const search = await cardCollectionResponse(
      testEnv.CATALOGUE_DB,
      searchRequest,
      "errata-published-search",
    );
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      data: [{ id: erratum.target_id }],
      meta: { catalogue_revision_id: revisionId },
    });
    const exportResponse = await catalogueExportResponse(
      testEnv.CATALOGUE_DB,
      testEnv.CATALOGUE_EXPORTS,
      revisionId,
    );
    expect(exportResponse?.status).toBe(200);
    await expect(exportResponse?.json()).resolves.toMatchObject({
      data: {
        components: expect.arrayContaining([
          expect.objectContaining({ name: "errata" }),
        ]),
      },
      meta: { catalogue_revision_id: revisionId },
    });
    const persisted = await testEnv.CATALOGUE_DB.prepare(
      `SELECT erratum.id, provenance.source_lineage,
              provenance.source_observation_id
       FROM reconciled_errata AS erratum
       JOIN erratum_provenance AS provenance
         ON provenance.erratum_id = erratum.id
       JOIN revision_errata AS revision
         ON revision.erratum_id = erratum.id
       WHERE revision.catalogue_revision_id = ? AND erratum.id = ?`,
    )
      .bind(revisionId, erratum.id)
      .first<{
        id: string;
        source_lineage: string;
        source_observation_id: string;
      }>();
    expect(persisted).toMatchObject({
      id: erratum.id,
      source_lineage: "one-piece-en",
      source_observation_id: expect.stringMatching(/^srcobs_/),
    });
    await expect(
      testEnv.CATALOGUE_DB.prepare(
        `UPDATE reconciled_errata
         SET corrected_value_json = '"mutated wording"'
         WHERE id = ?`,
      )
        .bind(erratum.id)
        .run(),
    ).rejects.toThrow(/reconciled_erratum_immutable/);
    const observationSet = await testEnv.CATALOGUE_DB.prepare(
      `SELECT observation.content_object_key
       FROM source_observation_sets AS observation
       JOIN source_snapshots AS snapshot
         ON snapshot.id = observation.source_snapshot_id
       WHERE snapshot.ingestion_run_id = ?`,
    )
      .bind(run.id)
      .first<{ content_object_key: string }>();
    const retainedObservation = await testEnv.EVIDENCE_OBJECTS.get(
      observationSet?.content_object_key ?? "",
    );
    expect(await retainedObservation?.text()).toContain(
      '"effective_rules_text":"[On Play] Draw 1 card."',
    );
  });

  test("future and Printing-scoped Errata do not rewrite the Card or physical Printing history", async () => {
    const run = await collect(
      "/reconciliation/errata-effective-scope",
      "reconcile-errata-effective-scope",
    );
    const reconciled = await reconcile(run.id);

    expect(reconciled.response.status).toBe(200);
    expect(reconciled.document).toMatchObject({
      state: "awaiting_approval",
      publishable: true,
      cards: [
        {
          effective_rules_text: "Observed Card Rules Text.",
        },
      ],
      printings: [
        {
          printed_rules_text: "Physical Printing Rules Text.",
        },
      ],
    });
    expect(reconciled.document.errata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_type: "card",
          effective_from: "2099-01-01",
          corrected_value: "Future Card Rules Text.",
        }),
        expect.objectContaining({
          target_type: "printing",
          effective_from: "2026-07-01",
          corrected_value: "Printing-scoped corrected wording.",
        }),
      ]),
    );
    const rejected = await post(
      `/v1/ingestion-runs/${run.id}/rejection`,
      {
        candidate_digest: requiredString(
          reconciled.document,
          "candidate_digest",
        ),
        idempotency_key: "reject-errata-effective-scope",
      },
    );
    expect(rejected.response.status).toBe(200);
  });

  test("Erratum wording that requires invented precision hard-blocks publication", async () => {
    const run = await collect(
      "/reconciliation/errata-unrepresentable",
      "reconcile-errata-unrepresentable",
    );
    const blocked = await reconcile(run.id);

    expect(blocked.response.status).toBe(409);
    expect(blocked.document).toMatchObject({
      state: "failed",
      publishable: false,
      diagnostics: [
        expect.objectContaining({
          code: "retained_evidence_invalid",
          detail: expect.stringContaining(
            "cannot be represented without invented precision",
          ),
        }),
      ],
    });
  });

  test("Official Errata evidence rejects undeclared fields", async () => {
    const run = await collect(
      "/reconciliation/errata-extra-property",
      "reconcile-errata-extra-property",
    );
    const blocked = await reconcile(run.id);
    expect(blocked.response.status).toBe(409);
    expect(blocked.document).toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: "retained_evidence_invalid",
          detail: expect.stringContaining("undeclared"),
        }),
      ],
    });
  });

  test("equal-date Card Errata with conflicting Effective Rules Text hard-block publication", async () => {
    const run = await collect(
      "/reconciliation/errata-conflicting-effective-text",
      "reconcile-errata-conflicting-effective-text",
    );
    const blocked = await reconcile(run.id);

    expect(blocked.response.status).toBe(409);
    expect(blocked.document).toMatchObject({
      state: "failed",
      publishable: false,
      diagnostics: [
        expect.objectContaining({
          code: "canonical_card_conflict",
          detail: expect.stringContaining(
            "conflicting applicable Errata",
          ),
        }),
      ],
    });
  });

  test("official Errata may remove Effective Rules Text without changing Printed Rules Text", async () => {
    const run = await collect(
      "/reconciliation/errata-null-effective-text",
      "reconcile-errata-null-effective-text",
    );
    const reconciled = await reconcile(run.id);

    expect(reconciled.response.status).toBe(200);
    expect(reconciled.document).toMatchObject({
      state: "awaiting_approval",
      publishable: true,
      cards: [{ effective_rules_text: null }],
      printings: [
        { printed_rules_text: "Printed and observed rules text." },
      ],
    });
    expect(reconciled.document.errata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ corrected_value: null }),
      ]),
    );
    const published = await approve(reconciled.document);
    expect(published.response.status).toBe(200);
    const revisionId = requiredString(
      published.document,
      "resulting_revision_id",
    );
    const [cards, printings, errata] = await Promise.all([
      exportComponentRecords(revisionId, "cards"),
      exportComponentRecords(revisionId, "printings"),
      exportComponentRecords(revisionId, "errata"),
    ]);
    expect(cards).toContainEqual(
      expect.objectContaining({ effective_rules_text: null }),
    );
    expect(printings).toContainEqual(
      expect.objectContaining({
        printed_rules_text: "Printed and observed rules text.",
      }),
    );
    expect(errata).toContainEqual(
      expect.objectContaining({ corrected_value: null }),
    );
  });

  test("later effective Errata supersede current wording without mutating earlier Errata or Printed Rules Text", async () => {
    const firstRun = await collect(
      "/reconciliation/errata-card-rules-text-longitudinal",
      "reconcile-errata-layer-first",
    );
    const first = await reconcile(firstRun.id);
    const firstPublished = await approve(first.document);
    expect(firstPublished.response.status).toBe(200);
    const firstCard = requiredFirst(first.document, "cards");
    const firstErratum = requiredObjectWithField(
      first.document,
      "errata",
      "target_id",
      requiredString(firstCard, "id"),
    );
    const firstRevisionId = requiredString(
      firstPublished.document,
      "resulting_revision_id",
    );

    const secondRun = await collect(
      "/reconciliation/errata-card-rules-text-longitudinal-v2",
      "reconcile-errata-layer-second",
    );
    const second = await reconcile(secondRun.id);

    expect(second.response.status).toBe(200);
    expect(second.document).toMatchObject({
      state: "awaiting_approval",
      publishable: true,
      cards: [
        {
          effective_rules_text:
            "[On Play] Draw 2 cards, then discard 2 cards.",
        },
      ],
      printings: [
        {
          printed_rules_text: "[On Play] Draw 1 card.",
        },
      ],
    });
    const layeredErrata = Array.isArray(second.document.errata)
      ? second.document.errata.filter(
          (erratum) =>
            erratum !== null &&
            typeof erratum === "object" &&
            !Array.isArray(erratum) &&
            erratum.target_id === firstErratum.target_id,
        )
      : [];
    expect(layeredErrata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstErratum.id }),
        expect.objectContaining({
          effective_from: "2026-07-15",
          corrected_value:
            "[On Play] Draw 2 cards, then discard 2 cards.",
        }),
      ]),
    );
    expect(layeredErrata).toHaveLength(2);
    const secondPublished = await approve(second.document);
    expect(secondPublished.response.status).toBe(200);
    const secondRevisionId = requiredString(
      secondPublished.document,
      "resulting_revision_id",
    );
    const [persistedErratum, persistedProvenance, relationships] =
      await Promise.all([
        testEnv.CATALOGUE_DB.prepare(
          `SELECT first_revision_id, last_observed_revision_id
           FROM reconciled_errata WHERE id = ?`,
        )
          .bind(firstErratum.id)
          .first<{
            first_revision_id: string;
            last_observed_revision_id: string;
          }>(),
        testEnv.CATALOGUE_DB.prepare(
          `SELECT first_revision_id, last_observed_revision_id
           FROM erratum_provenance WHERE erratum_id = ?`,
        )
          .bind(firstErratum.id)
          .first<{
            first_revision_id: string;
            last_observed_revision_id: string;
          }>(),
        exportComponentRecords(secondRevisionId, "relationships"),
      ]);
    expect(persistedErratum).toEqual({
      first_revision_id: firstRevisionId,
      last_observed_revision_id: firstRevisionId,
    });
    expect(persistedProvenance).toEqual({
      first_revision_id: firstRevisionId,
      last_observed_revision_id: firstRevisionId,
    });
    expect(relationships).toContainEqual(
      expect.objectContaining({
        kind: "erratum-target",
        from: { type: "erratum", id: firstErratum.id },
        lifecycle: expect.objectContaining({
          first_revision_id: firstRevisionId,
          last_observed_revision_id: firstRevisionId,
        }),
      }),
    );
  });
});

async function collect(
  path: string,
  key: string,
  source?: { game: string; lineage: string; adapter: string },
  waitTimeoutMs = 15_000,
): Promise<{
  id: string;
  document: Record<string, unknown>;
}> {
  const started = await postFixtureEvidence({
    supported_game: source?.game ?? "one-piece",
    source_lineage: source?.lineage ?? "one-piece-en",
    adapter_version: source?.adapter ?? "fixture-one-piece-json@1",
    idempotency_key: key,
    requests: [
      {
        id: "cards",
        method: "GET",
        url: `https://official-source.invalid${path}`,
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(started.response.status).toBe(201);
  const id = requiredString(started.document, "id");
  const resumed = await post(
    `/v1/ingestion-runs/${id}/collection/resume`,
    {},
  );
  expect(resumed.response.status).toBe(202);
  const document = await waitForRunState(id, "parsing", waitTimeoutMs);
  return { id, document };
}

async function waitForRunState(
  id: string,
  expectedState: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const shown = await get(`/v1/ingestion-runs/${id}`);
    if (shown.document.state === expectedState) {
      return shown.document;
    }
    if (shown.document.state === "failed") {
      throw new Error(`collection failed: ${JSON.stringify(shown.document)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${id} did not reach ${expectedState}`);
}

function reconcile(runId: string) {
  return post(`/v1/ingestion-runs/${runId}/reconciliation`, {});
}

function approve(document: Record<string, unknown>) {
  return post(
    `/v1/ingestion-runs/${requiredString(document, "run_id")}/approval`,
    {
      candidate_digest: requiredString(document, "candidate_digest"),
      expected_current_revision_id: requiredString(
        document,
        "expected_current_revision_id",
      ),
      idempotency_key: `approve-${crypto.randomUUID()}`,
    },
  );
}

function get(pathname: string) {
  return request(pathname);
}

function post(
  pathname: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  return request(pathname, body, extraHeaders);
}

async function postFixtureEvidence(body: StartEvidenceRunRequest) {
  const document = await injectFixtureEvidencePlan(
    testEnv.CATALOGUE_DB,
    body,
  );
  return {
    response: new Response(null, { status: 201 }),
    document,
  };
}

async function request(
  pathname: string,
  body?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{
  response: Response;
  document: Record<string, unknown>;
}> {
  const response = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": `203.0.113.${(requestSequence++ % 250) + 1}`,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return {
    response,
    document: (await response.json()) as Record<string, unknown>,
  };
}

function requiredFirst(
  document: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const values = document[field];
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${field} is empty`);
  }
  const value = values[0];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field}[0] is invalid`);
  }
  return value as Record<string, unknown>;
}

function requiredObjectWithField(
  document: Record<string, unknown>,
  collectionField: string,
  valueField: string,
  expectedValue: unknown,
): Record<string, unknown> {
  const values = document[collectionField];
  if (!Array.isArray(values)) {
    throw new Error(`${collectionField} is not an array`);
  }
  const value = values.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>)[valueField] === expectedValue,
  );
  if (value === undefined) {
    throw new Error(
      `${collectionField} has no object with ${valueField}=${String(expectedValue)}`,
    );
  }
  return value as Record<string, unknown>;
}

function requiredString(
  document: Record<string, unknown>,
  field: string,
): string {
  const value = document[field];
  if (typeof value !== "string") throw new Error(`${field} is not a string`);
  return value;
}

async function exportComponentRecords(
  revisionId: string,
  componentName: string,
): Promise<Record<string, unknown>[]> {
  const exportRow = await testEnv.CATALOGUE_DB.prepare(
    `SELECT manifest_key FROM catalogue_exports
     WHERE catalogue_revision_id = ? AND verified = 1`,
  )
    .bind(revisionId)
    .first<{ manifest_key: string }>();
  const manifestObject = await testEnv.CATALOGUE_EXPORTS.get(
    exportRow?.manifest_key ?? "",
  );
  const manifest = await manifestObject?.json<{
    components: {
      name: string;
      compressed_sha256: string;
    }[];
  }>();
  const component = manifest?.components.find(
    (candidate) => candidate.name === componentName,
  );
  const object = await testEnv.CATALOGUE_EXPORTS.get(
    `catalogue-exports/${revisionId}/components/${component?.compressed_sha256}.ndjson.gz`,
  );
  if (object === null) throw new Error("export component missing");
  const decompressed = object.body.pipeThrough(
    new DecompressionStream("gzip"),
  );
  const text = await new Response(decompressed).text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
