import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import type { StartEvidenceRunRequest } from "../../../src/catalogue/source-evidence";
import { buildCatalogueExport } from "../../../src/catalogue/export";
import { fixtureCandidate } from "../../../src/catalogue/fixture";
import {
  parseOnePieceOfficialErrataHtml,
} from "../../../src/catalogue/one-piece-official-errata-html";
import {
  onePieceOfficialErrataHtml,
} from "../../../acceptance/fixtures/one-piece-official-errata-html";
import {
  injectFixtureEvidencePlan,
  injectFixturePublication,
} from "./fixture-plan-injection";

const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
};
let requestSequence = 0;
const syntheticOfficialErrataSource = {
  game: "one-piece",
  lineage: "one-piece-en",
  adapter: "fixture-one-piece-official-errata-json@1",
};

beforeEach(async () => {
  await applyD1Migrations(
    testEnv.CATALOGUE_DB,
    testEnv.TEST_MIGRATIONS,
  );
});

describe("Errata rules-text lifecycle", () => {
  test("the Official Errata parser consumes an exact semantic child inventory in source order", async () => {
    const observations = await parseOnePieceOfficialErrataHtml(
      onePieceOfficialErrataHtml,
    );
    const zeff = observations.find(
      (observation) =>
        observation.target.official_identity.value === "OP03-047",
    );
    expect(zeff?.official_wording).toBe(
      "*Also applies to parallel card version.\n" +
        "Before: [DON!! x1] When this Character's attack deals damage to your opponent's Life, you may trash 7 cards from the top of your deck.\n" +
        "[On Play] You may return up to 1 Character with a cost of 3 or less to the owner's hand, and trash 2 cards from the top of your deck.\n" +
        "After: [DON!! x1] When this Character's attack deals damage to your opponent's Life, you may trash 7 cards from the top of your deck.\n" +
        "[On Play] Return up to 1 Character with a cost of 3 or less to the owner's hand, and you may trash 2 cards from the top of your deck.",
    );

    const malformedDocuments = [
      onePieceOfficialErrataHtml.replace(
        "                <dl>\n" +
          '                  <dt class="txtBlack mtS">Note:</dt>',
        "                <p>Injected residual wording.</p>\n" +
          "                <dl>\n" +
          '                  <dt class="txtBlack mtS">Note:</dt>',
      ),
      onePieceOfficialErrataHtml.replace(
        '<ul class="commonNoticeList isHalf">',
        '<ul class="alternateNotice">',
      ),
      onePieceOfficialErrataHtml.replace(
        "<dd>[On Play] Draw 1 card.</dd>",
        "<dd><p>[On Play] Draw 1 card.</p></dd>",
      ),
      onePieceOfficialErrataHtml.replace(
        "<dd>[On Play] Draw 1 card.</dd>",
        '<dd data-unrecognized="true">[On Play] Draw 1 card.</dd>',
      ),
    ];
    for (const malformed of malformedDocuments) {
      await expect(
        parseOnePieceOfficialErrataHtml(malformed),
      ).rejects.toMatchObject({
        status: 422,
        code: "source_parse_failed",
        message:
          "An Official Erratum contains unsupported semantic content.",
      });
    }
  });

  test("the Official Errata parser rejects an empty unknown direct entry child", async () => {
    const malformed = onePieceOfficialErrataHtml.replace(
      '<h5 class="smallTitRed">OP07-097 Vegapunk</h5>',
      '<h5 class="smallTitRed">OP07-097 Vegapunk</h5>' +
        "<aside></aside>",
    );

    await expect(
      parseOnePieceOfficialErrataHtml(malformed),
    ).rejects.toMatchObject({
      status: 422,
      code: "source_parse_failed",
      message:
        "An Official Erratum contains unsupported semantic content.",
    });
  });

  test("the Official Errata parser rejects an unknown wrapper around a recognized list", async () => {
    const malformed = onePieceOfficialErrataHtml
      .replace(
        '<ul class="commonNoticeList isHalf">',
        '<aside><ul class="commonNoticeList isHalf">',
      )
      .replace(
        "</ul>\n                <dl>",
        "</ul></aside>\n                <dl>",
      );

    await expect(
      parseOnePieceOfficialErrataHtml(malformed),
    ).rejects.toMatchObject({
      status: 422,
      code: "source_parse_failed",
      message:
        "An Official Erratum contains unsupported semantic content.",
    });
  });

  test("the Official Errata parser rejects a new dated entry outside recognized containers and headings", async () => {
    const malformed = onePieceOfficialErrataHtml.replace(
      "          </div>\n        </section>",
      `            <section class="contentsLCol" id="errata_new_shape">
              <section class="contentsMCol mtM">
                <h4 class="mediumTit">July 31, 2026</h4>
              </section>
              <article class="newErrataEntry">
                <h6 class="newCardHeading">OP99-999 New Erratum</h6>
                <img src="/images/rules/cards/20260731/OP99-999.png" alt="OP99-999">
                <dl>
                  <dt class="txtBlack mtS">Before:</dt>
                  <dd>Old wording.</dd>
                  <dt class="txtBlack mtS">After:</dt>
                  <dd>New wording.</dd>
                </dl>
              </article>
            </section>
          </div>
        </section>`,
    );

    await expect(
      parseOnePieceOfficialErrataHtml(malformed),
    ).rejects.toMatchObject({
      status: 422,
      code: "source_parse_failed",
    });
  });

  test("the Official Errata parser rejects multiple value containers for one field label", async () => {
    const malformed = onePieceOfficialErrataHtml.replace(
      "<dd>This correction applies in every game format.</dd>",
      "<dd>This correction applies in every game format.</dd>" +
        "<dd>Injected second value container.</dd>",
    );

    await expect(
      parseOnePieceOfficialErrataHtml(malformed),
    ).rejects.toMatchObject({
      status: 422,
      code: "source_parse_failed",
      message:
        "An Official Erratum field must contain exactly one value container.",
    });
  });

  test("the Official Errata parser requires a bijection of unique modal links and modal fragments", async () => {
    const anchorPattern =
      /(\s*<a class="modalOpen" data-src="#nov_11_2022_OP01-001">[\s\S]*?<\/a>)/u;
    const listItemPattern =
      /(\s*<li>\s*<a class="modalOpen"[\s\S]*?<\/li>)/u;
    const anchor = anchorPattern.exec(onePieceOfficialErrataHtml)?.[1];
    const listItem = listItemPattern.exec(onePieceOfficialErrataHtml)?.[1];
    if (anchor === undefined || listItem === undefined) {
      throw new Error("The retained modal fixture is unavailable.");
    }
    const duplicateModalWithoutLink = listItem.replace(
      anchorPattern,
      "",
    );
    const malformedDocuments = [
      onePieceOfficialErrataHtml.replace(anchor, `${anchor}${anchor}`),
      onePieceOfficialErrataHtml.replace(anchor, ""),
      onePieceOfficialErrataHtml.replace(
        'data-src="#nov_11_2022_OP01-001"',
        'data-src="#orphan_OP01-001"',
      ),
      onePieceOfficialErrataHtml.replace(
        listItem,
        `${listItem}${duplicateModalWithoutLink}`,
      ),
    ];

    for (const malformed of malformedDocuments) {
      await expect(
        parseOnePieceOfficialErrataHtml(malformed),
      ).rejects.toMatchObject({
        status: 422,
        code: "source_parse_failed",
      });
    }
  });

  test("an unregistered generic Card adapter cannot self-assert Official Errata authority", async () => {
    const started = await post("/v1/ingestion-runs/evidence", {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "one-piece-json-document@999",
      idempotency_key: "reject-generic-production-errata-authority",
      requests: [{
        id: "cards",
        method: "GET",
        url:
          "https://official-source.invalid/reconciliation/errata-card-rules-text",
        headers: { accept: "application/json" },
      }],
    });
    expect(started.response.status).toBe(422);
    expect(started.document).toMatchObject({
      code: "adapter_not_supported",
    });
    expect(await testEnv.CATALOGUE_DB.prepare(
      `SELECT COUNT(*) AS count FROM ingestion_runs
       WHERE idempotency_key = 'reject-generic-production-errata-authority'`,
    ).first("count")).toBe(0);
  });

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
      (entry) => entry.name === "errata",
    );
    const object = built.objects.find((entry) =>
      entry.key.includes(component?.compressed_sha256 ?? "missing")
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
        adapter: "fixture-gundam-en-asia-json@2",
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
        adapter: "fixture-gundam-en-us-json@2",
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
        adapter: "fixture-gundam-en-asia-json@2",
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
        adapter: "fixture-gundam-en-us-json@2",
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
    const reconciled = await reconcile(
      run.id,
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
    const carried = await reconcile(
      carriedRun.id,
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
        adapter: "fixture-gundam-en-us-json@2",
      },
    );
    const subset = await reconcile(
      subsetRun.id,
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
      (entry) =>
        entry.corrected_value ===
        "[On Play] Draw 2 cards, then discard 1 card.",
    );
    expect(erratum).toBeDefined();
    if (erratum === undefined) {
      throw new Error("Expected the published Card Erratum in the export.");
    }
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
    const sourceFacts = await testEnv.CATALOGUE_DB.prepare(
      `SELECT canonical_facts_json
       FROM reconciled_card_observations
       WHERE card_id = ? AND source_observation_id = ?`,
    )
      .bind(erratum.target_id, persisted?.source_observation_id ?? "")
      .first<{ canonical_facts_json: string }>();
    expect(JSON.parse(sourceFacts?.canonical_facts_json ?? "null")).toMatchObject(
      {
        effective_rules_text: "[On Play] Draw 1 card.",
      },
    );
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

  test("a dedicated nullable-date Printing Erratum resolves one already-published Printing without rewriting physical text", async () => {
    const seedRun = await collect(
      "/reconciliation/dedicated-printing-erratum-seed",
      "seed-dedicated-printing-erratum",
    );
    const seed = await reconcile(seedRun.id);
    expect(seed.response.status).toBe(200);
    const seedPublished = await approve(seed.document);
    expect(seedPublished.response.status).toBe(200);
    const seedRevisionId = requiredString(
      seedPublished.document,
      "resulting_revision_id",
    );
    const seedPrintings = Array.isArray(seed.document.printings)
      ? seed.document.printings
      : [];
    const inspected = await Promise.all(
      seedPrintings.map(async (printing) => {
        const id = requiredString(
          printing as Record<string, unknown>,
          "id",
        );
        return {
          id,
          lifecycle: await get(`/v1/reconciliation/printings/${id}`),
        };
      }),
    );
    const basePrinting = inspected.find(({ lifecycle }) =>
      JSON.stringify(lifecycle.document).includes(
        "/official/dedicated-multi/base",
      )
    );
    expect(basePrinting).toBeDefined();

    const run = await collect(
      "/reconciliation/dedicated-printing-erratum",
      "dedicated-printing-erratum",
      syntheticOfficialErrataSource,
    );
    const reconciled = await reconcile(run.id);
    expect(reconciled.response.status).toBe(200);
    expect(reconciled.document.cards).toEqual([
      expect.objectContaining({
        effective_rules_text: "Official effective rules",
      }),
    ]);
    expect(reconciled.document.printings).toEqual([
      expect.objectContaining({
        id: basePrinting?.id,
        printed_rules_text: "Official printed rules",
      }),
    ]);
    expect(reconciled.document.errata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_type: "printing",
          target_id: basePrinting?.id,
          effective_from: null,
          corrected_value: "Printing-scoped corrected rules",
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
        effective_rules_text: "Official effective rules",
        lifecycle: expect.objectContaining({
          last_observed_revision_id: seedRevisionId,
        }),
      }),
    );
    expect(printings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: basePrinting?.id,
          printed_rules_text: "Official printed rules",
          lifecycle: expect.objectContaining({
            last_observed_revision_id: seedRevisionId,
          }),
          locator_evidence: {
            current: [
              expect.objectContaining({
                locator: "/official/dedicated-multi/base",
                current: true,
              }),
            ],
            historical: [],
          },
        }),
      ]),
    );
    expect(printings.map((printing) => printing.id)).toEqual(
      expect.arrayContaining(inspected.map(({ id }) => id)),
    );
    for (const { id } of inspected) {
      const retainedPrinting = printings.find(
        (printing) => printing.id === id,
      );
      expect(retainedPrinting).toMatchObject({
        id,
        printed_rules_text: "Official printed rules",
      });
    }
    expect(errata).toContainEqual(
      expect.objectContaining({
        target_type: "printing",
        target_id: basePrinting?.id,
        effective_from: null,
      }),
    );
    const freshness = await testEnv.CATALOGUE_DB.prepare(
      `SELECT area, ingestion_run_id
       FROM source_freshness
       WHERE game = 'one-piece'
       ORDER BY area`,
    ).all<{ area: string; ingestion_run_id: string }>();
    expect(freshness.results).toEqual([
      {
        area: "cards-and-printings",
        ingestion_run_id: seedRun.id,
      },
      {
        area: "errata",
        ingestion_run_id: run.id,
      },
    ]);
  });

  test("a non-parallel Official Erratum fails closed unless it targets one exact Printing", async () => {
    const seedRun = await collect(
      "/reconciliation/dedicated-printing-erratum-seed",
      "seed-nonparallel-card-erratum",
    );
    const seed = await reconcile(seedRun.id);
    expect(seed.response.status).toBe(200);
    expect((await approve(seed.document)).response.status).toBe(200);

    const run = await collect(
      "/reconciliation/dedicated-card-nonparallel-erratum",
      "reject-nonparallel-card-erratum",
      syntheticOfficialErrataSource,
    );
    const reconciled = await reconcile(run.id);
    expect(reconciled.response.status).toBe(409);
    expect(reconciled.document.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "retained_evidence_invalid",
          detail: expect.stringContaining(
            "non-parallel Official Erratum must target exactly one Printing",
          ),
        }),
      ]),
    );
  });

  test("a complete Errata observation warns when a published Erratum disappears without deleting it", async () => {
    const seedRun = await collect(
      "/reconciliation/dedicated-printing-erratum-seed",
      "seed-disappearing-official-erratum",
    );
    const seed = await reconcile(seedRun.id);
    expect(seed.response.status).toBe(200);
    expect((await approve(seed.document)).response.status).toBe(200);

    const observedRun = await collect(
      "/reconciliation/dedicated-printing-erratum",
      "observe-disappearing-official-erratum",
      syntheticOfficialErrataSource,
    );
    const observed = await reconcile(observedRun.id);
    expect(observed.response.status).toBe(200);
    const observedErratum = requiredFirst(observed.document, "errata");
    const observedPublished = await approve(observed.document);
    expect(observedPublished.response.status).toBe(200);
    const observedRevisionId = requiredString(
      observedPublished.document,
      "resulting_revision_id",
    );

    const missingRun = await collect(
      "/reconciliation/complete-empty-lineage",
      "warn-disappearing-official-erratum",
      syntheticOfficialErrataSource,
    );
    const missing = await reconcile(missingRun.id);

    expect(missing.response.status).toBe(200);
    expect(missing.document.warnings).toContainEqual({
      code: "erratum_not_observed",
      erratum_id: requiredString(observedErratum, "id"),
      source_lineage: "one-piece-en",
      detail: expect.stringContaining(
        "retained without advancing its last-observed revision",
      ),
    });
    expect(missing.document.errata).toContainEqual(
      expect.objectContaining({ id: requiredString(observedErratum, "id") }),
    );
    const missingPublished = await approve(missing.document);
    expect(missingPublished.response.status).toBe(200);
    const retained = await testEnv.CATALOGUE_DB.prepare(
      `SELECT last_observed_revision_id
       FROM reconciled_errata
       WHERE id = ?`,
    )
      .bind(requiredString(observedErratum, "id"))
      .first<{ last_observed_revision_id: string }>();
    expect(retained).toEqual({
      last_observed_revision_id: observedRevisionId,
    });
  });

  test("a dedicated Printing Erratum fails closed for ambiguous or unpublished locators", async () => {
    const seedRun = await collect(
      "/reconciliation/multi-printing-shared-locator",
      "seed-ambiguous-dedicated-printing-erratum",
    );
    const seed = await reconcile(seedRun.id);
    expect(seed.response.status).toBe(200);
    const printingIds = (Array.isArray(seed.document.printings)
      ? seed.document.printings
      : []).map((printing) =>
        requiredString(printing as Record<string, unknown>, "id")
      ).sort();
    expect(printingIds).toHaveLength(2);
    expect((await approve(seed.document)).response.status).toBe(200);

    const ambiguousRun = await collect(
      "/reconciliation/dedicated-printing-erratum-ambiguous",
      "ambiguous-dedicated-printing-erratum",
      syntheticOfficialErrataSource,
    );
    const ambiguous = await reconcile(ambiguousRun.id);
    expect(ambiguous.response.status).toBe(409);
    expect(ambiguous.document.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "retained_evidence_invalid",
          locator: "/official/multi/shared",
          matched_printing_ids: printingIds,
          detail: expect.stringContaining("exactly one Printing"),
        }),
      ]),
    );

    const missingRun = await collect(
      "/reconciliation/dedicated-printing-erratum-missing",
      "missing-dedicated-printing-erratum",
      syntheticOfficialErrataSource,
    );
    const missing = await reconcile(missingRun.id);
    expect(missing.response.status).toBe(409);
    expect(missing.document.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "retained_evidence_invalid",
          locator: "/official/multi/missing",
          matched_printing_ids: [],
          detail: expect.stringContaining("exactly one Printing"),
        }),
      ]),
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

  test("D1 rejects Errata whose typed target is absent or belongs to another Supported Game", async () => {
    const run = await collect(
      "/reconciliation/base",
      "erratum-target-integrity",
    );
    const reconciled = await reconcile(run.id);
    expect(reconciled.response.status).toBe(200);
    const card = requiredFirst(reconciled.document, "cards");
    const printing = requiredFirst(reconciled.document, "printings");
    const published = await approve(reconciled.document);
    expect(published.response.status).toBe(200);
    const revisionId = requiredString(
      published.document,
      "resulting_revision_id",
    );
    const insert = (
      id: string,
      game: "one-piece" | "gundam",
      targetType: "card" | "printing",
      targetId: string,
    ) =>
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO reconciled_errata (
           id, game, target_type, target_id, effective_from,
           official_wording, corrected_value_json,
           first_revision_id, last_observed_revision_id
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          game,
          targetType,
          targetId,
          "Before: old\nAfter: corrected",
          JSON.stringify("corrected"),
          revisionId,
          revisionId,
        )
        .run();

    for (const invalid of [
      ["erratum_missing_card_target", "one-piece", "card", "card_missing_target"],
      [
        "erratum_wrong_game_card_target",
        "gundam",
        "card",
        requiredString(card, "id"),
      ],
      [
        "erratum_missing_printing_target",
        "one-piece",
        "printing",
        "printing_missing_target",
      ],
      [
        "erratum_wrong_game_printing_target",
        "gundam",
        "printing",
        requiredString(printing, "id"),
      ],
    ]) {
      await expect(
        insert(
          invalid[0]!,
          invalid[1]! as "one-piece" | "gundam",
          invalid[2]! as "card" | "printing",
          invalid[3]!,
        ),
      ).rejects.toThrow(
        "reconciled_erratum_target_invalid",
      );
    }
    await expect(
      insert(
        "erratum_valid_card_target",
        "one-piece",
        "card",
        requiredString(card, "id"),
      ),
    ).resolves.toMatchObject({ success: true });
    await expect(
      insert(
        "erratum_valid_printing_target",
        "one-piece",
        "printing",
        requiredString(printing, "id"),
      ),
    ).resolves.toMatchObject({ success: true });
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
    adapter_version: source?.adapter ?? "fixture-one-piece-json@3",
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

async function reconcile(
  runId: string,
  extraHeaders: Record<string, string> = {},
) {
  const shown = await get(`/v1/ingestion-runs/${runId}`);
  const expectedCurrentRevisionId = requiredString(
    shown.document,
    "expected_current_revision_id",
  );
  const body = {
    expected_current_revision_id: expectedCurrentRevisionId,
    idempotency_key: `reconcile-${runId}`,
  };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const observed = await post(
      `/v1/ingestion-runs/${runId}/reconciliation`,
      body,
      extraHeaders,
    );
    if (
      observed.document.status === "complete" &&
      observed.document.output !== null &&
      typeof observed.document.output === "object" &&
      !Array.isArray(observed.document.output)
    ) {
      const document = observed.document.output as Record<string, unknown>;
      return {
        response: new Response(null, {
          status: document.publishable === true ? 200 : 409,
        }),
        document,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`reconciliation Workflow ${runId} did not complete`);
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
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>)[valueField] === expectedValue,
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
    (entry) => entry.name === componentName,
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
