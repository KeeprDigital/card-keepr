import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  canonicalJson,
  sha256,
  utf8,
} from "../../../src/catalogue/serialization";
import { requiredSourceAdapter } from "../../../src/catalogue/source-adapters";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import {
  approve,
  collectFixtureLegality,
  collectFixtureOnePiece,
  exportedComponentRecords,
  installContextualLegalitySuite,
  reconcile,
  request,
  requiredString,
  testEnv,
  waitForState,
} from "./contextual-legality-helpers";

installContextualLegalitySuite();

test("same-URL legality observations with byte-identical source representations deduplicate", async () => {
  const sourceUrl =
    "https://official-source.invalid/reconciliation/contextual-legality-byte-identity";
  const started = await injectFixtureEvidencePlan(testEnv.CATALOGUE_DB, {
    supported_game: "gundam",
    source_lineage: "gundam-en-asia",
    adapter_version: "fixture-gundam-en-asia-json@2",
    idempotency_key: "legality-byte-identity-control",
    requests: ["current", "history"].map((id) => ({
      id,
      method: "GET" as const,
      url: sourceUrl,
      headers: { "accept-language": "en-AU" },
    })),
  });
  const runId = requiredString(started, "id");
  expect((await request(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    {},
  )).response.status).toBe(202);
  await waitForState(runId, "parsing");

  const shown = await request(`/v1/ingestion-runs/${runId}`);
  const snapshots = shown.document.snapshots as Array<{
    content: { digest: string };
  }>;
  expect(snapshots).toHaveLength(2);
  expect(new Set(snapshots.map(({ content }) => content.digest)).size).toBe(1);

  const reconciled = await reconcile(runId);
  expect(reconciled.response.status, JSON.stringify(reconciled.document))
    .toBe(200);
  const rejected = await request(`/v1/ingestion-runs/${runId}/rejection`, {
    candidate_digest: requiredString(reconciled.document, "candidate_digest"),
    idempotency_key: "reject-byte-identical-control",
  });
  expect(rejected.response.status).toBe(200);
}, 90_000);

test("same-URL legality observations with byte-distinct source representations fail closed", async () => {
  const sourceUrl =
    "https://official-source.invalid/reconciliation/contextual-legality-byte-identity";
  const started = await injectFixtureEvidencePlan(testEnv.CATALOGUE_DB, {
    supported_game: "gundam",
    source_lineage: "gundam-en-asia",
    adapter_version: "fixture-gundam-en-asia-json@2",
    idempotency_key: "legality-byte-identity",
    requests: [
      {
        id: "current-compact",
        method: "GET",
        url: sourceUrl,
        headers: { "accept-language": "en-AU" },
      },
      {
        id: "history-pretty",
        method: "GET",
        url: sourceUrl,
        headers: { "accept-language": "en-US" },
      },
    ],
  });
  const runId = requiredString(started, "id");
  expect((await request(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    {},
  )).response.status).toBe(202);
  await waitForState(runId, "parsing");

  const shown = await request(`/v1/ingestion-runs/${runId}`);
  const snapshots = shown.document.snapshots as Array<{
    id: string;
    content: { digest: string };
  }>;
  expect(snapshots).toHaveLength(2);
  expect(new Set(snapshots.map(({ content }) => content.digest)).size).toBe(2);
  const retainedBodies = await Promise.all(snapshots.map(async ({ id }) => {
    const response = await exports.default.fetch(new Request(
      `https://card-keepr.invalid/v1/source-snapshots/${id}/content`,
      { headers: { authorization: "Bearer vitest-administration-key" } },
    ));
    expect(response.status).toBe(200);
    return response.text();
  }));
  expect(retainedBodies[0]).not.toBe(retainedBodies[1]);

  const blocked = await reconcile(runId);
  expect(blocked.response.status).toBe(409);
  expect(JSON.stringify(blocked.document)).toMatch(/conflict|representation/iu);
}, 90_000);

test.each([
  ["disjoint official rule identities", "contextual-legality-byte-disjoint"],
  ["different empty publications", "contextual-legality-byte-empty"],
])(
  "same-URL legality publications fail closed for %s when retained bytes differ",
  async (_caseName, scenario) => {
    const sourceUrl =
      `https://official-source.invalid/reconciliation/${scenario}`;
    const started = await injectFixtureEvidencePlan(testEnv.CATALOGUE_DB, {
      supported_game: "gundam",
      source_lineage: "gundam-en-asia",
      adapter_version: "fixture-gundam-en-asia-json@2",
      idempotency_key: `legality-publication-identity-${scenario}`,
      requests: [
        {
          id: "current-compact",
          method: "GET",
          url: sourceUrl,
          headers: { "accept-language": "en-AU" },
        },
        {
          id: "history-pretty",
          method: "GET",
          url: sourceUrl,
          headers: { "accept-language": "en-US" },
        },
      ],
    });
    const runId = requiredString(started, "id");
    expect((await request(
      `/v1/ingestion-runs/${runId}/collection/resume`,
      {},
    )).response.status).toBe(202);
    await waitForState(runId, "parsing");

    const shown = await request(`/v1/ingestion-runs/${runId}`);
    const snapshots = shown.document.snapshots as Array<{
      content: { digest: string };
    }>;
    expect(snapshots).toHaveLength(2);
    expect(new Set(snapshots.map(({ content }) => content.digest)).size).toBe(2);

    const blocked = await reconcile(runId);
    if (blocked.response.status === 200) {
      const rejected = await request(`/v1/ingestion-runs/${runId}/rejection`, {
        candidate_digest: requiredString(blocked.document, "candidate_digest"),
        idempotency_key: `reject-unexpected-publication-${scenario}`,
      });
      expect(rejected.response.status).toBe(200);
    }
    expect(blocked.response.status).toBe(409);
    expect(JSON.stringify(blocked.document)).toMatch(
      /conflict|publication|representation/iu,
    );
  },
  90_000,
);

test.each([
  ["one-piece-normalized-envelope@1", "one-piece", "one-piece-en"],
  ["one-piece-normalized-envelope@2", "one-piece", "one-piece-en"],
  ["fusion-world-normalized-envelope@1", "fusion-world", "fusion-world-en"],
  ["digimon-normalized-envelope@1", "digimon", "digimon-en"],
  ["gundam-asia-normalized-envelope@1", "gundam", "gundam-en-asia"],
  ["gundam-us-normalized-envelope@1", "gundam", "gundam-en-us"],
])(
  "production planning rejects unavailable adapter identity %s before capture",
  async (adapter, game, lineage) => {
    const idempotencyKey = `reject-unavailable-${adapter}`;
    const blocked = await request("/v1/ingestion-runs/evidence", {
      supported_game: game,
      source_lineage: lineage,
      adapter_version: adapter,
      idempotency_key: idempotencyKey,
      requests: [
        {
          id: "discovery",
          method: "GET",
          url: "https://official-source.invalid/normalized-envelope",
          headers: { accept: "application/json" },
        },
      ],
    });
    expect(blocked.response.status).toBe(422);
    expect(blocked.document).toMatchObject({
      code: "adapter_not_supported",
    });
    const retained = await testEnv.CATALOGUE_DB.prepare(
      `SELECT COUNT(*) AS count FROM ingestion_runs
       WHERE idempotency_key = ?`,
    ).bind(idempotencyKey).first<{ count: number }>();
    expect(retained?.count).toBe(0);
  },
);

test("authenticated reparse rejects a normalized fixture envelope through an unavailable production adapter", async () => {
  const runId = "run_unavailable_adapter_raw_boundary";
  const snapshotId = "srcsnap_unavailable_adapter_raw_boundary";
  const objectKey = `source-snapshots/${snapshotId}.bin`;
  const bytes = utf8(JSON.stringify({
    cards: [
      {
        card: {
          game: "one-piece",
          official_identity: { kind: "card_number", value: "OP99-999" },
        },
      },
    ],
    legality_rules: [
      {
        id: "normalized-effect-that-production-must-not-accept",
        effect: { type: "ban" },
      },
    ],
  }));
  const digest = await sha256(bytes);
  const plan = JSON.stringify({
    requests: [
      {
        id: "raw-boundary",
        method: "GET",
        url: "https://official-source.invalid/normalized-envelope",
        headers: {},
        representation_fingerprint: "5".repeat(64),
      },
    ],
  });
  await testEnv.EVIDENCE_OBJECTS.put(objectKey, bytes);
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_json
       ) VALUES (?, 'parsing', '["one-piece"]',
         '2026-08-01T00:00:00.000Z', 'catrev_spine_000', NULL, ?, '{}')`,
    ).bind(runId, "unavailable-adapter-raw-boundary"),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_evidence_plans (
         ingestion_run_id, source_lineage, supported_game,
         game_profile_version, adapter_version, request_plan_json,
         plan_origin
       ) VALUES (?, 'one-piece-en', 'one-piece', 'one-piece@1',
         'fixture-one-piece-json@3', ?, 'synthetic_fixture')`,
    ).bind(runId, plan),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state,
         source_snapshot_id
       ) VALUES (?, 'raw-boundary', 0, 'GET',
         'https://official-source.invalid/normalized-envelope', '{}', ?,
         'observed', ?)`,
    ).bind(runId, "5".repeat(64), snapshotId),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_fetch_attempts (
         id, ingestion_run_id, request_id, attempt_number,
         requested_at, completed_at, outcome, http_status,
         response_headers_json, retry_after_ms, diagnostic
       ) VALUES ('srcfetch_unavailable_adapter_raw_boundary', ?,
         'raw-boundary', 1, '2026-08-01T00:00:00.000Z',
         '2026-08-01T00:00:01.000Z', 'success', 200, '{}', NULL, NULL)`,
    ).bind(runId),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_snapshots (
         id, ingestion_run_id, request_id, fetch_attempt_id,
         request_method, request_url, request_headers_json,
         representation_fingerprint, response_vary_json, retrieved_at,
         http_status, response_headers_json, media_type, content_digest,
         content_byte_length, content_object_key, source_lineage,
         supported_game, game_profile_version, adapter_version,
         reused_source_snapshot_id
       ) VALUES (?, ?, 'raw-boundary',
         'srcfetch_unavailable_adapter_raw_boundary', 'GET',
         'https://official-source.invalid/normalized-envelope', '{}', ?, '[]',
         '2026-08-01T00:00:01.000Z', 200, '{}', 'application/json', ?, ?, ?,
         'one-piece-en', 'one-piece', 'one-piece@1',
         'fixture-one-piece-json@3', NULL)`,
    ).bind(
      snapshotId,
      runId,
      "5".repeat(64),
      digest,
      bytes.byteLength,
      objectKey,
    ),
  ]);

  const blocked = await request(
    `/v1/source-snapshots/${snapshotId}/observations`,
    {
      adapter_version: "one-piece-normalized-envelope@1",
      idempotency_key: "unavailable-adapter-raw-boundary-reparse",
    },
  );
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({ code: "adapter_not_supported" });
  const retained = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_parse_operations
     WHERE source_snapshot_id = ?`,
  ).bind(snapshotId).first<{ count: number }>();
  expect(retained?.count).toBe(0);
});

test.each([
  {
    adapterVersion: "one-piece-en@6",
    lineage: "one-piece-en",
    game: "one-piece",
    surface: "restrictions",
    scriptPrefix: "one-piece-card-game",
    entry: {
      notice_no: "OP-CONDITIONAL-WORKER",
      published_text:
        "If your Leader is red, OP30-001 is eligible for Standard play.",
      territory: "EN-OCEANIA",
      format_name: "standard",
      event_class: null,
      start_date: "2026-01-01",
      end_date: null,
      card_numbers: ["OP30-001"],
      restriction_code: "eligible",
    },
  },
  {
    adapterVersion: "fusion-world-en@9",
    lineage: "fusion-world-en",
    game: "fusion-world",
    surface: "legality-current",
    scriptPrefix: "fusion-world-card-game",
    entry: {
      rule_ref: "FW-CONDITIONAL-WORKER",
      notice:
        "If your Leader is red, FB30-001 is eligible for Standard play.",
      market: "EN-OCEANIA",
      play_format: "standard",
      tier: null,
      active_on: "2026-01-01",
      expires_on: null,
      cards: ["FB30-001"],
      directive: "eligible",
    },
  },
  {
    adapterVersion: "digimon-en@7",
    lineage: "digimon-en",
    game: "digimon",
    surface: "restrictions-current",
    scriptPrefix: "digimon-card-game",
    entry: {
      restriction_id: "DG-CONDITIONAL-WORKER",
      body: "If your Leader is red, BT30-001 is eligible for Standard play.",
      language_scope: "EN-OCEANIA",
      ruleset: "standard",
      tournament_level: null,
      applies_from: "2026-01-01",
      applies_until: null,
      card_ids: ["BT30-001"],
      status_code: "eligible",
    },
  },
  ...([
    ["gundam-en-asia@7", "gundam-en-asia", "EN-ASIA"],
    ["gundam-en-us@7", "gundam-en-us", "EN-US"],
  ] as const).map(([adapterVersion, lineage, region]) => ({
    adapterVersion,
    lineage,
    game: "gundam",
    surface: "legality",
    scriptPrefix: lineage === "gundam-en-asia"
      ? "gundam-card-game-asia"
      : "gundam-card-game-us",
    entry: {
      news_id: `${lineage}-conditional-worker`,
      text: "If your Leader is red, GD30-001 is eligible for Standard play.",
      region,
      format: "standard",
      event_tier: null,
      effective_date: "2026-01-01",
      end_date: null,
      card_numbers: ["GD30-001"],
      ruling: "eligible",
    },
  })),
])(
  "authenticated Worker parsing rejects conditional leading legality prose for $lineage",
  async ({ adapterVersion, lineage, game, surface, scriptPrefix, entry }) => {
    const adapter = requiredSourceAdapter(adapterVersion);
    const requestUrl = adapter.requestUrlForSurface!(surface);
    const payload = {
      publication: lineage.startsWith("gundam-")
        ? "gundam-legality"
        : `${lineage.replace(/-en$/u, "")}-${surface}`,
      ...(lineage.startsWith("gundam-")
        ? { locale: lineage === "gundam-en-asia" ? "EN-ASIA" : "EN-US" }
        : {}),
      revision: "2026-07",
      declared_record_count: 1,
      partition: { page: 1, pages: 1, total: 1, has_next: false },
      entries: [entry],
    };
    const html = `<html><title>BANDAI ${game} CARD PRODUCT RELEASE RULE ERRATA RESTRICTION</title><script type="application/json" id="${scriptPrefix}-${surface}-data">${JSON.stringify(payload)}</script></html>`;
    const bytes = utf8(html);
    const digest = await sha256(bytes);
    const suffix = lineage.replaceAll("-", "_");
    const runId = `run_conditional_worker_${suffix}`;
    const snapshotId = `srcsnap_conditional_worker_${suffix}`;
    const fetchId = `srcfetch_conditional_worker_${suffix}`;
    const objectKey = `source-snapshots/${snapshotId}.bin`;
    const fingerprint = digest;
    const plan = JSON.stringify({
      requests: [{
        id: "conditional-worker",
        method: "GET",
        url: requestUrl,
        headers: { accept: "text/html" },
        representation_fingerprint: fingerprint,
      }],
    });
    await testEnv.EVIDENCE_OBJECTS.put(objectKey, bytes);
    await testEnv.CATALOGUE_DB.batch([
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO ingestion_runs (
           id, state, selected_games_json, started_at,
           expected_current_revision_id, linked_run_id, idempotency_key,
           candidate_json
         ) VALUES (?, 'parsing', ?, '2026-08-01T00:00:00.000Z',
           'catrev_spine_000', NULL, ?, '{}')`,
      ).bind(runId, JSON.stringify([game]), `conditional-worker-${lineage}`),
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO ingestion_evidence_plans (
           ingestion_run_id, source_lineage, supported_game,
           game_profile_version, adapter_version, request_plan_json,
           plan_origin
         ) VALUES (?, ?, ?, ?, ?, ?, 'production')`,
      ).bind(runId, lineage, game, `${game}@1`, adapterVersion, plan),
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO source_requests (
           ingestion_run_id, request_id, sequence_number, method, url,
           request_headers_json, representation_fingerprint, state,
           source_snapshot_id
         ) VALUES (?, 'conditional-worker', 0, 'GET', ?, ?, ?, 'observed', ?)`,
      ).bind(
        runId,
        requestUrl,
        JSON.stringify({ accept: "text/html" }),
        fingerprint,
        snapshotId,
      ),
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO source_fetch_attempts (
           id, ingestion_run_id, request_id, attempt_number,
           requested_at, completed_at, outcome, http_status,
           response_headers_json, retry_after_ms, diagnostic
         ) VALUES (?, ?, 'conditional-worker', 1,
           '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:01.000Z',
           'success', 200, '{}', NULL, NULL)`,
      ).bind(fetchId, runId),
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO source_snapshots (
           id, ingestion_run_id, request_id, fetch_attempt_id,
           request_method, request_url, request_headers_json,
           representation_fingerprint, response_vary_json, retrieved_at,
           http_status, response_headers_json, media_type, content_digest,
           content_byte_length, content_object_key, source_lineage,
           supported_game, game_profile_version, adapter_version,
           reused_source_snapshot_id
         ) VALUES (?, ?, 'conditional-worker', ?, 'GET', ?, ?, ?, '[]',
           '2026-08-01T00:00:01.000Z', 200, '{}', 'text/html', ?, ?, ?,
           ?, ?, ?, ?, NULL)`,
      ).bind(
        snapshotId,
        runId,
        fetchId,
        requestUrl,
        JSON.stringify({ accept: "text/html" }),
        fingerprint,
        digest,
        bytes.byteLength,
        objectKey,
        lineage,
        game,
        `${game}@1`,
        adapterVersion,
      ),
    ]);

    const blocked = await request(
      `/v1/source-snapshots/${snapshotId}/observations`,
      {
        adapter_version: adapterVersion,
        idempotency_key: `conditional-worker-reparse-${lineage}`,
      },
    );
    expect(blocked.response.status).toBe(422);
    expect(blocked.document).toMatchObject({ code: "source_parse_failed" });
  },
);

test("an unfetched nested image URL cannot enter through an unregistered production representation", async () => {
  const blocked = await request("/v1/ingestion-runs/evidence", {
    supported_game: "gundam",
    source_lineage: "gundam-en-asia",
    adapter_version: "gundam-en-asia@999",
    idempotency_key: "reject-unfetched-image-identity",
    requests: [
      {
        id: "discovery",
        method: "GET",
        url:
          "https://www.gundam-gcg.com/asia-en/reconciliation/contextual-legality-unfetched-image",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "adapter_not_supported",
  });
});

test("a nested Fusion World image candidate cannot enter through an unregistered representation", async () => {
  const blocked = await request("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@999",
    idempotency_key: "reject-unverified-fusion-world-image-list",
    requests: [
      {
        id: "discovery",
        method: "GET",
        url:
          "https://www.dbs-cardgame.com/fw/en/reconciliation/contextual-legality-secondary-foreign-image",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "adapter_not_supported",
  });
});

test.each([
  "copy-count",
  "companion-card",
  "membership-value",
  "rotation-block",
  "release-date",
])(
  "invented JSON cannot claim official wording agrees with a structured %s operand",
  async (operand) => {
    const blocked = await request("/v1/ingestion-runs/evidence", {
      supported_game: "gundam",
      source_lineage: "gundam-en-asia",
      adapter_version: "gundam-en-asia@999",
      idempotency_key: `reject-structured-${operand}`,
      requests: [
        {
          id: "discovery",
          method: "GET",
          url:
            `https://www.gundam-gcg.com/asia-en/reconciliation/contextual-legality-${operand}-operand-mismatch`,
          headers: { accept: "application/json" },
        },
      ],
    });
    expect(blocked.response.status).toBe(422);
    expect(blocked.document).toMatchObject({
      code: "adapter_not_supported",
    });
  },
);

test("an Official Source field change requires exact reaffirmation before a fresh linked run", async () => {
  const baseline = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain",
    "curated-field-source-baseline",
  );
  const baselineCard = (
    baseline.reconciled.cards as Array<Record<string, unknown>>
  ).find((card) =>
    (card.official_identity as Record<string, unknown>).value === "GD30-001"
  );
  if (baselineCard === undefined) {
    throw new Error("The baseline GD30-001 Card is absent");
  }
  const published = await approve(
    baseline.reconciled,
    "publish-curated-field-source-baseline",
  );
  expect(published.response.status).toBe(200);
  const currentRevisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const proposal = {
    game: "gundam",
    target: {
      kind: "field",
      entity_type: "card",
      entity_id: requiredString(baselineCard, "id"),
      path: "/name",
    },
    assertion: {
      kind: "field",
      value: "Owner-reviewed Card Name",
    },
    rationale: "The retained publication needs an owner-reviewed clarification.",
    evidence: [{
      kind: "owner_reference",
      uri: "https://owner.example/review/gundam-card-name",
      content_digest: "a".repeat(64),
    }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256(utf8(canonicalJson(
      requiredString(baselineCard, "name"),
    ))),
    supersedes_revision_id: null,
  };
  const authored = await request("/admin/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: currentRevisionId,
    proposal,
    proposal_digest: await sha256(utf8(canonicalJson(proposal))),
    idempotency_key: "author-curated-field-source-baseline",
  });
  expect(authored.response.status).toBe(201);
  const curatedRevisionId = requiredString(
    authored.document,
    "curated_revision_id",
  );
  const contentDigest = requiredString(authored.document, "content_digest");

  const changed = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain?semantics=changed",
    "curated-field-source-changed",
    409,
  );
  expect(changed.reconciled).toMatchObject({
    state: "failed",
    publishable: false,
    diagnostics: [expect.objectContaining({
      code: "curated_revision_reconfirmation_required",
      curated_revision_id: curatedRevisionId,
    })],
  });

  const shown = await request(
    `/admin/v1/curated-revisions/${curatedRevisionId}`,
  );
  expect(shown.response.status).toBe(200);
  const revision = shown.document.revision as Record<string, unknown>;
  const conflict = revision.pending_conflict as Record<string, unknown>;
  expect(revision).toMatchObject({
    status: "reconfirmation_required",
    event_version: 2,
    pending_conflict: {
      run_id: changed.runId,
      previous_source_digest: proposal.reviewed_source_digest,
      observed_source_digest: await sha256(utf8(canonicalJson(
        "Changed Official Source Card Name",
      ))),
    },
  });
  expect(requiredString(conflict, "digest")).toBe(await sha256(utf8(
    canonicalJson({
      conflict_id: requiredString(conflict, "id"),
      run_id: changed.runId,
      revision_id: curatedRevisionId,
      previous_source_digest: proposal.reviewed_source_digest,
      observed_source_digest: requiredString(
        conflict,
        "observed_source_digest",
      ),
    }),
  )));
  expect(shown.document.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "authored", event_version: 1 }),
    expect.objectContaining({
      type: "source_change_detected",
      event_version: 2,
    }),
  ]));

  const blocked = await request(
    `/v1/ingestion-runs/${changed.runId}/collection/retry`,
    { idempotency_key: "retry-curated-field-before-reaffirmation" },
  );
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    code: "curated_revision_reconfirmation_required",
  });

  const reaffirmed = await request(
    `/admin/v1/curated-revisions/${curatedRevisionId}/reaffirm`,
    {
      environment: "production",
      expected_current_revision_id: currentRevisionId,
      expected_event_version: 2,
      conflict_digest: requiredString(conflict, "digest"),
      rationale: "The assertion remains necessary after reviewing the new publication.",
      idempotency_key: "reaffirm-curated-field-source-change",
    },
  );
  expect(reaffirmed.response.status).toBe(200);
  expect(reaffirmed.document).toMatchObject({
    curated_revision_id: curatedRevisionId,
    content_digest: contentDigest,
    status: "active",
    event_version: 3,
  });

  const fresh = await request(
    `/v1/ingestion-runs/${changed.runId}/collection/retry`,
    { idempotency_key: "retry-curated-field-after-reaffirmation" },
  );
  expect(fresh.response.status).toBe(201);
  expect(fresh.document).toMatchObject({
    state: "collecting",
    linked_run_id: changed.runId,
  });
  const freshRunId = requiredString(fresh.document, "id");
  const resumed = await request(
    `/v1/ingestion-runs/${freshRunId}/collection/resume`,
    {},
  );
  expect(resumed.response.status).toBe(202);
  await waitForState(freshRunId, "parsing");
  const candidate = await reconcile(freshRunId);
  expect(candidate.response.status).toBe(200);
  const reaffirmedCard = (
    candidate.document.cards as Array<Record<string, unknown>>
  ).find((card) =>
    (card.official_identity as Record<string, unknown>).value === "GD30-001"
  );
  expect(reaffirmedCard).toMatchObject({
    name: proposal.assertion.value,
    curated_provenance: [expect.objectContaining({
      curated_revision_id: curatedRevisionId,
      content_digest: contentDigest,
      reviewed_source_value: "Changed Official Source Card Name",
    })],
  });
  expect((await request(
    `/v1/ingestion-runs/${freshRunId}/rejection`,
    {
      candidate_digest: requiredString(candidate.document, "candidate_digest"),
      idempotency_key: "reject-curated-field-after-reaffirmation",
    },
  )).response.status).toBe(200);
}, 45_000);

test("an Official Source relationship change recovers through supersession and retirement", async () => {
  const baseline = await collectFixtureOnePiece(
    "https://official-source.invalid/reconciliation/product-typed-relationships",
    "curated-relationship-source-baseline",
  );
  const published = await approve(
    baseline.reconciled,
    "publish-curated-relationship-source-baseline",
  );
  expect(published.response.status).toBe(200);
  const currentRevisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const relationship = (
    await exportedComponentRecords(currentRevisionId, "relationships")
  ).find((entry) => entry.kind === "product-card");
  if (relationship === undefined) {
    throw new Error("The baseline product-card relationship is absent");
  }
  const target = {
    kind: "relationship",
    relationship_kind: "product-card",
    from: relationship.from,
    to: relationship.to,
  };
  const proposal = {
    game: "one-piece",
    target,
    assertion: { kind: "relationship", presence: "absent" },
    rationale: "The owner reviewed this derived relationship as absent.",
    evidence: [{
      kind: "owner_reference",
      uri: "https://owner.example/review/product-card-relationship",
      content_digest: "b".repeat(64),
    }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256(utf8(canonicalJson("present"))),
    supersedes_revision_id: null,
  };
  const authored = await request("/admin/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: currentRevisionId,
    proposal,
    proposal_digest: await sha256(utf8(canonicalJson(proposal))),
    idempotency_key: "author-curated-relationship-source-baseline",
  });
  expect(authored.response.status).toBe(201);
  const priorRevisionId = requiredString(
    authored.document,
    "curated_revision_id",
  );

  const changed = await collectFixtureOnePiece(
    "https://official-source.invalid/reconciliation/product-typed-relationships-changed",
    "curated-relationship-source-changed",
    409,
  );
  expect(changed.reconciled).toMatchObject({
    state: "failed",
    publishable: false,
    diagnostics: [expect.objectContaining({
      code: "curated_revision_reconfirmation_required",
      curated_revision_id: priorRevisionId,
    })],
  });
  const priorShown = await request(
    `/admin/v1/curated-revisions/${priorRevisionId}`,
  );
  const prior = priorShown.document.revision as Record<string, unknown>;
  const conflict = prior.pending_conflict as Record<string, unknown>;
  expect(prior).toMatchObject({
    status: "reconfirmation_required",
    event_version: 2,
    pending_conflict: {
      run_id: changed.runId,
      previous_source_digest: proposal.reviewed_source_digest,
      observed_source_digest: await sha256(utf8(canonicalJson("absent"))),
    },
  });

  const replacementProposal = {
    ...proposal,
    assertion: { kind: "relationship", presence: "present" },
    rationale: "The owner reviewed the missing relationship and requires it.",
    reviewed_source_digest: requiredString(
      conflict,
      "observed_source_digest",
    ),
    supersedes_revision_id: priorRevisionId,
  };
  const invalidReplacement = {
    ...replacementProposal,
    reviewed_source_digest: "f".repeat(64),
  };
  const invalidReviewedSource = await request(
    `/admin/v1/curated-revisions/${priorRevisionId}/supersede`,
    {
      environment: "production",
      expected_current_revision_id: currentRevisionId,
      expected_event_version: 2,
      conflict_digest: requiredString(conflict, "digest"),
      proposal: invalidReplacement,
      proposal_digest: await sha256(utf8(canonicalJson(invalidReplacement))),
      rationale: "Replace the exception after reviewing the changed source.",
      idempotency_key: "reject-invalid-relationship-reviewed-source",
    },
  );
  expect(invalidReviewedSource.response.status).toBe(409);
  expect(invalidReviewedSource.document).toMatchObject({
    code: "curated_revision_reviewed_source_mismatch",
  });

  const supersedeInput = {
    environment: "production",
    expected_current_revision_id: currentRevisionId,
    expected_event_version: 2,
    conflict_digest: requiredString(conflict, "digest"),
    proposal: replacementProposal,
    proposal_digest: await sha256(utf8(canonicalJson(replacementProposal))),
    rationale: "Replace the exception after reviewing the changed source.",
    idempotency_key: "supersede-curated-relationship-source-change",
  };
  const superseded = await request(
    `/admin/v1/curated-revisions/${priorRevisionId}/supersede`,
    supersedeInput,
  );
  expect(superseded.response.status).toBe(201);
  const supersedeReplay = await request(
    `/admin/v1/curated-revisions/${priorRevisionId}/supersede`,
    supersedeInput,
  );
  expect(supersedeReplay.response.status).toBe(200);
  expect(supersedeReplay.document).toEqual(superseded.document);
  const changedSupersedeReuse = await request(
    `/admin/v1/curated-revisions/${priorRevisionId}/supersede`,
    {
      ...supersedeInput,
      rationale: "A changed request must not reuse the accepted key.",
      idempotency_key: "supersede-curated-relationship-source-change",
    },
  );
  expect(changedSupersedeReuse.response.status).toBe(409);
  expect(changedSupersedeReuse.document).toMatchObject({
    code: "idempotency_conflict",
  });
  const replacementRevisionId = requiredString(
    superseded.document,
    "curated_revision_id",
  );
  expect(superseded.document).toMatchObject({
    status: "active",
    event_version: 1,
    code: "curated_revision_superseded",
  });
  const supersededPrior = await request(
    `/admin/v1/curated-revisions/${priorRevisionId}`,
  );
  expect(supersededPrior.document.revision).toMatchObject({
    status: "superseded",
    event_version: 3,
  });

  const afterSupersession = await request(
    `/v1/ingestion-runs/${changed.runId}/collection/retry`,
    { idempotency_key: "retry-relationship-after-supersession" },
  );
  expect(afterSupersession.response.status).toBe(201);
  expect(afterSupersession.document).toMatchObject({
    state: "collecting",
    linked_run_id: changed.runId,
  });
  const supersessionRunId = requiredString(afterSupersession.document, "id");
  expect((await request(
    `/v1/ingestion-runs/${supersessionRunId}/collection/resume`,
    {},
  )).response.status).toBe(202);
  await waitForState(supersessionRunId, "parsing");
  const supersessionCandidate = await reconcile(supersessionRunId);
  expect(supersessionCandidate.response.status).toBe(200);
  const inspectedSupersession = await request(
    `/v1/ingestion-runs/${supersessionRunId}/candidate`,
  );
  expect(inspectedSupersession.document).toMatchObject({
    curated_revision_ids: [replacementRevisionId],
    diff: {
      curated_effects: [expect.objectContaining({
        revision_id: replacementRevisionId,
        target: expect.any(String),
        assertion: replacementProposal.assertion,
        evidence_category: "curated",
      })],
    },
  });
  const rejected = await request(
    `/v1/ingestion-runs/${supersessionRunId}/rejection`,
    {
      candidate_digest: requiredString(
        supersessionCandidate.document,
        "candidate_digest",
      ),
      idempotency_key: "reject-relationship-after-supersession",
    },
  );
  expect(rejected.response.status).toBe(200);

  const replacementBeforeRetirement = await request(
    `/admin/v1/curated-revisions/${replacementRevisionId}`,
  );
  expect(replacementBeforeRetirement.response.status).toBe(200);
  const immutableReplacement = replacementBeforeRetirement.document
    .revision as Record<string, unknown>;

  const retired = await request(
    `/admin/v1/curated-revisions/${replacementRevisionId}/retire`,
    {
      environment: "production",
      expected_current_revision_id: currentRevisionId,
      expected_event_version: 1,
      conflict_digest: null,
      rationale: "The changed Official Source no longer needs an exception.",
      idempotency_key: "retire-curated-relationship-replacement",
    },
  );
  expect(retired.response.status).toBe(200);
  expect(retired.document).toMatchObject({
    curated_revision_id: replacementRevisionId,
    status: "retired",
    event_version: 2,
  });
  const replacementAfterRetirement = await request(
    `/admin/v1/curated-revisions/${replacementRevisionId}`,
  );
  expect(replacementAfterRetirement.response.status).toBe(200);
  const retiredReplacement = replacementAfterRetirement.document
    .revision as Record<string, unknown>;
  expect({
    id: retiredReplacement.id,
    content: retiredReplacement.content,
    content_digest: retiredReplacement.content_digest,
    author: retiredReplacement.author,
    created_at: retiredReplacement.created_at,
  }).toEqual({
    id: immutableReplacement.id,
    content: immutableReplacement.content,
    content_digest: immutableReplacement.content_digest,
    author: immutableReplacement.author,
    created_at: immutableReplacement.created_at,
  });
  expect(replacementAfterRetirement.document).toMatchObject({
    revision: {
      status: "retired",
      event_version: 2,
    },
    events: [
      expect.objectContaining({ type: "authored", event_version: 1 }),
      expect.objectContaining({ type: "retired", event_version: 2 }),
    ],
  });

  const afterRetirement = await request(
    `/v1/ingestion-runs/${changed.runId}/collection/retry`,
    { idempotency_key: "retry-relationship-after-retirement" },
  );
  expect(afterRetirement.response.status).toBe(201);
  const retirementRunId = requiredString(afterRetirement.document, "id");
  expect((await request(
    `/v1/ingestion-runs/${retirementRunId}/collection/resume`,
    {},
  )).response.status).toBe(202);
  await waitForState(retirementRunId, "parsing");
  const retirementCandidate = await reconcile(retirementRunId);
  expect(retirementCandidate.response.status).toBe(200);
  const inspectedRetirement = await request(
    `/v1/ingestion-runs/${retirementRunId}/candidate`,
  );
  expect(inspectedRetirement.document).toMatchObject({
    curated_revision_ids: [],
    diff: { curated_effects: [] },
  });
  expect((await request(
    `/v1/ingestion-runs/${retirementRunId}/rejection`,
    {
      candidate_digest: requiredString(
        retirementCandidate.document,
        "candidate_digest",
      ),
      idempotency_key: "reject-relationship-after-retirement",
    },
  )).response.status).toBe(200);
}, 60_000);

