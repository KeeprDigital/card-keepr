import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, expect } from "vitest";
import { officialSourceDiscoveryRequests } from "../../../src/catalogue/product-release-source-adapters";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";

export type ProductionDiscoveryRequest = ReturnType<
  typeof officialSourceDiscoveryRequests
>[number];

export const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
  SCRATCH_DB: D1Database;
};
let requestSequence = 0;

export function installContextualLegalitySuite(): void {
  beforeEach(async () => {
    await applyD1Migrations(
      testEnv.CATALOGUE_DB,
      testEnv.TEST_MIGRATIONS,
    );
  });
}

export async function collectFixtureLegality(
  url: string,
  idempotencyKey: string,
  expectedStatus = 200,
): Promise<{
  runId: string;
  reconciled: Record<string, unknown>;
}> {
  const runId = await collectFixtureLegalityEvidence(url, idempotencyKey);
  const reconciled = await reconcile(runId);
  expect(
    reconciled.response.status,
    JSON.stringify(reconciled.document),
  ).toBe(expectedStatus);
  return { runId, reconciled: reconciled.document };
}

export async function collectFixtureOnePiece(
  url: string,
  idempotencyKey: string,
  expectedStatus = 200,
): Promise<{
  runId: string;
  reconciled: Record<string, unknown>;
}> {
  const started = await injectFixtureEvidencePlan(testEnv.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@1",
    idempotency_key: idempotencyKey,
    requests: [{
      id: "cards-and-products",
      method: "GET",
      url,
      headers: { accept: "application/json" },
    }],
  });
  const runId = requiredString(started, "id");
  expect((await request(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    {},
  )).response.status).toBe(202);
  await waitForState(runId, "parsing");
  const reconciled = await reconcile(runId);
  expect(
    reconciled.response.status,
    JSON.stringify(reconciled.document),
  ).toBe(expectedStatus);
  return { runId, reconciled: reconciled.document };
}

export async function collectFixtureLegalityEvidence(
  url: string,
  idempotencyKey: string,
): Promise<string> {
  const started = await injectFixtureEvidencePlan(testEnv.CATALOGUE_DB, {
    supported_game: "gundam",
    source_lineage: "gundam-en-asia",
    adapter_version: "fixture-gundam-en-asia-json@2",
    idempotency_key: idempotencyKey,
    requests: [{
      id: "cards-and-rules",
      method: "GET",
      url,
      headers: { accept: "application/json" },
    }],
  });
  const runId = requiredString(started, "id");
  const resumed = await request(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    {},
  );
  expect(resumed.response.status).toBe(202);
  await waitForState(runId, "parsing");
  return runId;
}

export async function reconcile(runId: string, observedAt?: string) {
  const shown = await request(`/v1/ingestion-runs/${runId}`);
  const body = {
    expected_current_revision_id: requiredString(
      shown.document,
      "expected_current_revision_id",
    ),
    idempotency_key: `reconcile-${runId}`,
  };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const observed = await request(
      `/v1/ingestion-runs/${runId}/reconciliation`,
      body,
      observedAt,
    );
    if (
      observed.response.status !== 200 &&
      observed.response.status !== 202
    ) {
      return observed;
    }
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

export function approve(
  reconciled: Record<string, unknown>,
  idempotencyKey: string,
  observedAt?: string,
) {
  return request(
    `/v1/ingestion-runs/${requiredString(reconciled, "run_id")}/approval`,
    {
      candidate_digest: requiredString(reconciled, "candidate_digest"),
      expected_current_revision_id: requiredString(
        reconciled,
        "expected_current_revision_id",
      ),
      idempotency_key: idempotencyKey,
    },
    observedAt,
  );
}

export function officialAdapterUrl(adapter: string, scenario: string): string {
  if (adapter.startsWith("one-piece-")) {
    return `https://en.onepiece-cardgame.com/reconciliation/${scenario}`;
  }
  if (adapter.startsWith("fusion-world-en@")) {
    return `https://www.dbs-cardgame.com/fw/en/reconciliation/${scenario}`;
  }
  if (adapter.startsWith("digimon-en@")) {
    return `https://world.digimoncard.com/reconciliation/${scenario}`;
  }
  if (adapter.startsWith("gundam-en-asia@")) {
    return `https://www.gundam-gcg.com/asia-en/reconciliation/${scenario}`;
  }
  return `https://www.gundam-gcg.com/en/reconciliation/${scenario}`;
}

export async function waitForState(runId: string, expected: string) {
  const deadline = Date.now() + 30_000;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const shown = await request(`/v1/ingestion-runs/${runId}`);
    last = shown.document;
    if (shown.document.state === expected) return shown.document;
    if (shown.document.state === "failed") {
      const persisted = await testEnv.CATALOGUE_DB.prepare(
        `SELECT warnings_json FROM ingestion_runs WHERE id = ?`,
      ).bind(runId).first<{ warnings_json: string }>();
      const sourceFailures = await testEnv.CATALOGUE_DB.prepare(
        `SELECT requests.request_id, requests.state AS request_state,
                requests.failure_code, requests.request_role,
                requests.method, requests.url,
                requests.request_headers_json,
                attempts.attempt_number, attempts.outcome,
                attempts.http_status, attempts.response_headers_json,
                attempts.diagnostic AS fetch_diagnostic,
                capture.state AS capture_state,
                capture.diagnostic AS capture_diagnostic,
                snapshots.id AS snapshot_id,
                snapshots.content_digest AS snapshot_content_digest,
                snapshots.content_byte_length AS snapshot_content_byte_length,
                snapshots.media_type AS snapshot_media_type,
                parse.id AS parse_operation_id,
                parse.state AS parse_operation_state
         FROM source_requests AS requests
         LEFT JOIN source_fetch_attempts AS attempts
           ON attempts.ingestion_run_id = requests.ingestion_run_id
          AND attempts.request_id = requests.request_id
         LEFT JOIN source_capture_operations AS capture
           ON capture.ingestion_run_id = requests.ingestion_run_id
          AND capture.request_id = requests.request_id
          AND capture.attempt_number = attempts.attempt_number
         LEFT JOIN source_snapshots AS snapshots
           ON snapshots.ingestion_run_id = requests.ingestion_run_id
          AND snapshots.request_id = requests.request_id
          AND snapshots.fetch_attempt_id = attempts.id
         LEFT JOIN source_parse_operations AS parse
           ON parse.source_snapshot_id = snapshots.id
         WHERE requests.ingestion_run_id = ?
           AND (requests.failure_code IS NOT NULL
             OR attempts.diagnostic IS NOT NULL
             OR capture.diagnostic IS NOT NULL)
         ORDER BY requests.request_id, attempts.attempt_number`,
      ).bind(runId).all();
      const discoveryChildren = await testEnv.CATALOGUE_DB.prepare(
        `SELECT parent_request_id, request_id, sequence_number,
                method, url, request_headers_json,
                representation_fingerprint, request_role
         FROM source_discovery_request_plans
         WHERE ingestion_run_id = ?
         ORDER BY sequence_number`,
      ).bind(runId).all();
      throw new Error(JSON.stringify({
        id: shown.document.id,
        state: shown.document.state,
        failure_code: shown.document.failure_code,
        reconciliation_diagnostics: JSON.parse(
          persisted?.warnings_json ?? "[]",
        ),
        source_failures: sourceFailures.results,
        parse_failure_diagnostic_persistence:
          "parse failures are represented by source_requests.failure_code; source_parse_operations persists state but has no failure diagnostic column",
        discovery_children: discoveryChildren.results,
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `run ${runId} did not reach ${expected}: ${JSON.stringify(last)}`,
  );
}

export function productionFusionLegalityRequests(
  marker: string,
  historyMarker = marker,
): ProductionDiscoveryRequest[] {
  return officialSourceDiscoveryRequests("fusion-world-en").map((request) => ({
    ...request,
    headers: {
      ...request.headers,
      "user-agent": marker,
      ...(historyMarker === marker
        ? {}
        : { "accept-language": historyMarker }),
    },
  }));
}

export function productionOnePieceReleaseTimingRequests(
  marker = "card-keepr-one-piece-release-timing-v2",
): ProductionDiscoveryRequest[] {
  return officialSourceDiscoveryRequests("one-piece-en").map((request) => ({
    ...request,
    headers: { ...request.headers, "user-agent": marker },
  }));
}

export async function request(
  pathname: string,
  body?: Record<string, unknown>,
  observedAt?: string,
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
        ...(observedAt === undefined
          ? {}
          : { "x-keepr-test-now": observedAt }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return {
    response,
    document: (await response.json()) as Record<string, unknown>,
  };
}

export function requiredString(
  document: Record<string, unknown>,
  field: string,
): string {
  const value = document[field];
  if (typeof value !== "string") throw new Error(`${field} is not a string`);
  return value;
}

export async function revisionLegalityRule(
  revisionId: string,
  officialId: string,
): Promise<Record<string, unknown> | undefined> {
  const retained = await testEnv.CATALOGUE_DB.prepare(
    `SELECT document_json
     FROM revision_legality_rules
     WHERE catalogue_revision_id = ?
       AND json_extract(document_json, '$.official_id') = ?`,
  )
    .bind(revisionId, officialId)
    .first<{ document_json: string }>();
  return retained === null
    ? undefined
    : JSON.parse(retained.document_json) as Record<string, unknown>;
}

export async function exportedLegalityRule(
  revisionId: string,
  officialId: string,
): Promise<Record<string, unknown>> {
  const rule = (await exportedComponentRecords(
    revisionId,
    "legality-rules",
  )).find((candidate) => candidate.official_id === officialId);
  if (rule === undefined) throw new Error("Exported Legality Rule is absent");
  return rule;
}

export async function exportedManifest(revisionId: string): Promise<{
  source_freshness: Array<Record<string, unknown>>;
}> {
  const exportRow = await testEnv.CATALOGUE_DB.prepare(
    `SELECT manifest_key FROM catalogue_exports
     WHERE catalogue_revision_id = ?`,
  ).bind(revisionId).first<{ manifest_key: string }>();
  if (exportRow === null) throw new Error("Catalogue Export is absent");
  const object = await testEnv.CATALOGUE_EXPORTS.get(exportRow.manifest_key);
  if (object === null) throw new Error("Export manifest is absent");
  return object.json();
}

export async function exportedComponentRecords(
  revisionId: string,
  componentName: string,
): Promise<Record<string, unknown>[]> {
  const exportRow = await testEnv.CATALOGUE_DB.prepare(
    `SELECT manifest_key FROM catalogue_exports
     WHERE catalogue_revision_id = ?`,
  ).bind(revisionId).first<{ manifest_key: string }>();
  if (exportRow === null) throw new Error("Catalogue Export is absent");
  const manifestObject = await testEnv.CATALOGUE_EXPORTS.get(
    exportRow.manifest_key,
  );
  if (manifestObject === null) throw new Error("Export manifest is absent");
  const manifest = await manifestObject.json<{
    components: Array<{ name: string; compressed_sha256: string }>;
  }>();
  const component = manifest.components.find(
    (candidate) => candidate.name === componentName,
  );
  if (component === undefined) {
    throw new Error(`Catalogue Export ${componentName} component is absent`);
  }
  const object = await testEnv.CATALOGUE_EXPORTS.get(
    `catalogue-exports/${revisionId}/components/${component.compressed_sha256}.ndjson.gz`,
  );
  if (object === null) throw new Error("Catalogue Export component is absent");
  const text = await new Response(
    object.body.pipeThrough(new DecompressionStream("gzip")),
  ).text();
  return text.length === 0
    ? []
    : text.trim().split("\n").map((line) =>
        JSON.parse(line) as Record<string, unknown>
      );
}

export function resolveJsonPointer(document: unknown, pointer: string): unknown {
  return pointer.split("/").slice(1).reduce<unknown>((value, encoded) => {
    if (value === null || typeof value !== "object") {
      throw new Error(`JSON Pointer ${pointer} does not resolve`);
    }
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    return (value as Record<string, unknown>)[key];
  }, document);
}

export async function canonicalLegalityCardIdInvariantErrors(
  database: D1Database,
  canonical: Record<string, unknown>,
  prefix: string,
): Promise<unknown[]> {
  const direct = ["card_invariant_a"];
  const withCards = ["card_invariant_b"];
  const union = [...direct, ...withCards];
  const effect = {
    type: "prohibited_combination",
    with_card_ids: withCards,
  };
  const malformed = [
    { direct: direct[0], effect, union },
    { direct: [7], effect, union },
    { direct: [direct[0], direct[0]], effect, union },
    {
      direct: ["card_invariant_z", "card_invariant_a"],
      effect,
      union: [
        "card_invariant_a",
        "card_invariant_b",
        "card_invariant_z",
      ],
    },
    {
      direct,
      effect: {
        type: "prohibited_combination",
        with_card_ids: withCards[0],
      },
      union,
    },
    {
      direct,
      effect: { type: "prohibited_combination", with_card_ids: [7] },
      union,
    },
    {
      direct,
      effect: {
        type: "prohibited_combination",
        with_card_ids: [withCards[0], withCards[0]],
      },
      union,
    },
    {
      direct,
      effect: {
        type: "prohibited_combination",
        with_card_ids: ["card_invariant_z", "card_invariant_b"],
      },
      union: [
        "card_invariant_a",
        "card_invariant_b",
        "card_invariant_z",
      ],
    },
    { direct, effect, union: direct },
    {
      direct,
      effect: {
        type: "prohibited_combination",
        with_card_ids: direct,
      },
      union: direct,
    },
    { direct, effect, union: [...union].reverse() },
    { direct: [" card_invalid"], effect, union },
    { direct: [`card_${"x".repeat(200)}`], effect, union },
  ];
  return Promise.all(
    malformed.map((variant, index) =>
      rejectedError(
        database.prepare(
          `INSERT INTO legality_rules (
             id, official_id, supported_game, region, format, event_tier,
             effective_from, effective_until, official_wording, effect_json,
             card_ids_json, direct_card_ids_json, source_lineage,
             source_snapshot_id, source_observation_set_id,
             source_observation_id, source_observation_pointer,
             source_field_pointers_json, first_revision_id,
             last_observed_revision_id, current, last_missing_revision_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, 1, NULL)`,
        ).bind(
          `legality_rule_${prefix}_malformed_${index}`,
          `${prefix}-malformed-${index}`,
          canonical.supported_game ?? canonical.game,
          canonical.region,
          canonical.format,
          canonical.event_tier,
          canonical.effective_from,
          canonical.effective_until,
          canonical.official_wording,
          JSON.stringify(variant.effect),
          JSON.stringify(variant.union),
          JSON.stringify(variant.direct),
          canonical.source_lineage,
          canonical.source_snapshot_id,
          canonical.source_observation_set_id,
          `srcobs_${prefix}_malformed_${index}`,
          `/observations/0/value/legality_rules/${index + 20}`,
          canonical.source_field_pointers_json ??
            JSON.stringify(canonical.source_field_pointers),
          canonical.first_revision_id,
          canonical.last_observed_revision_id,
        ).run(),
      )
    ),
  );
}

export async function canonicalLegalityEffectInvariantErrors(
  database: D1Database,
  canonical: Record<string, unknown>,
  prefix: string,
): Promise<unknown[]> {
  const direct = ["card_effect_direct"];
  const malformed = [
    { effect: { type: "eligible", attacker: true }, direct },
    { effect: { type: "copy_limit", maximum_copies: 0 }, direct },
    {
      effect: {
        type: "prohibited_combination",
        with_card_ids: ["card_effect_companion"],
      },
      direct: [],
    },
    {
      effect: { type: "prohibited_combination", with_card_ids: [] },
      direct,
    },
    {
      effect: { type: "membership", attribute: "traits", includes_any: [] },
      direct,
    },
    {
      effect: { type: "rotation", eligible_blocks: ["1", "1"] },
      direct,
    },
    { effect: { type: "release_timing", legal_from: "2026-02-30" }, direct },
    { effect: { type: "unresolved", reason: " " }, direct },
    { effect: { type: "attacker_defined" }, direct },
  ] as const;
  return Promise.all(
    malformed.map((variant, index) => {
      const companion = "with_card_ids" in variant.effect &&
          Array.isArray(variant.effect.with_card_ids)
        ? variant.effect.with_card_ids
        : [];
      const allCardIds = [...variant.direct, ...companion].sort();
      return rejectedError(
        database.prepare(
          `INSERT INTO legality_rules (
             id, official_id, supported_game, region, format, event_tier,
             effective_from, effective_until, official_wording, effect_json,
             card_ids_json, direct_card_ids_json, source_lineage,
             source_snapshot_id, source_observation_set_id,
             source_observation_id, source_observation_pointer,
             source_field_pointers_json, first_revision_id,
             last_observed_revision_id, current, last_missing_revision_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, 1, NULL)`,
        ).bind(
          `legality_rule_${prefix}_malformed_effect_${index}`,
          `${prefix}-malformed-effect-${index}`,
          canonical.supported_game ?? canonical.game,
          canonical.region,
          canonical.format,
          canonical.event_tier,
          canonical.effective_from,
          canonical.effective_until,
          canonical.official_wording,
          JSON.stringify(variant.effect),
          JSON.stringify(allCardIds),
          JSON.stringify(variant.direct),
          canonical.source_lineage,
          canonical.source_snapshot_id,
          canonical.source_observation_set_id,
          `srcobs_${prefix}_malformed_effect_${index}`,
          `/observations/0/value/legality_rules/${index + 40}`,
          canonical.source_field_pointers_json ??
            JSON.stringify(canonical.source_field_pointers),
          canonical.first_revision_id,
          canonical.last_observed_revision_id,
        ).run(),
      );
    }),
  );
}

export async function canonicalLegalityScopeInvariantErrors(
  database: D1Database,
  canonical: Record<string, unknown>,
  prefix: string,
): Promise<unknown[]> {
  const unresolved = {
    type: "unresolved",
    reason: "The Official Source omits contextual scope.",
  };
  const variants = [
    {
      effectiveFrom: null,
      effectiveUntil: null,
      eventTier: null,
      scope: null,
      direct: ["card_scope_direct"],
      effect: unresolved,
    },
    {
      effectiveFrom: "2026-01-01",
      effectiveUntil: null,
      eventTier: null,
      scope: { dimensions: ["effective_interval"] },
      direct: ["card_scope_direct"],
      effect: unresolved,
    },
    {
      effectiveFrom: null,
      effectiveUntil: null,
      eventTier: "championship",
      scope: { dimensions: ["effective_interval", "event_tier"] },
      direct: ["card_scope_direct"],
      effect: unresolved,
    },
    {
      effectiveFrom: "2026-01-01",
      effectiveUntil: null,
      eventTier: null,
      scope: { dimensions: ["event_tier"] },
      direct: [],
      effect: unresolved,
    },
    {
      effectiveFrom: null,
      effectiveUntil: null,
      eventTier: null,
      scope: { dimensions: ["effective_interval"] },
      direct: ["card_scope_direct"],
      effect: { type: "eligible" },
    },
    {
      effectiveFrom: null,
      effectiveUntil: null,
      eventTier: null,
      scope: { dimensions: ["effective_interval", "effective_interval"] },
      direct: ["card_scope_direct"],
      effect: unresolved,
    },
  ] as const;
  return Promise.all(variants.map((variant, index) =>
    rejectedError(database.prepare(
      `INSERT INTO legality_rules (
         id, official_id, supported_game, region, format, event_tier,
         effective_from, effective_until, unresolved_scope_json,
         official_wording, effect_json, card_ids_json, direct_card_ids_json,
         source_lineage, source_snapshot_id, source_observation_set_id,
         source_observation_id, source_observation_pointer,
         source_field_pointers_json, first_revision_id,
         last_observed_revision_id, current, last_missing_revision_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, 1, NULL)`,
    ).bind(
      `legality_rule_${prefix}_malformed_scope_${index}`,
      `${prefix}-malformed-scope-${index}`,
      canonical.supported_game ?? canonical.game,
      canonical.region,
      canonical.format,
      variant.eventTier,
      variant.effectiveFrom,
      variant.effectiveUntil,
      JSON.stringify(variant.scope),
      canonical.official_wording,
      JSON.stringify(variant.effect),
      JSON.stringify(variant.direct),
      JSON.stringify(variant.direct),
      canonical.source_lineage,
      canonical.source_snapshot_id,
      canonical.source_observation_set_id,
      `srcobs_${prefix}_malformed_scope_${index}`,
      `/observations/0/value/legality_rules/${index + 60}`,
      canonical.source_field_pointers_json ??
        JSON.stringify(canonical.source_field_pointers),
      canonical.first_revision_id,
      canonical.last_observed_revision_id,
    ).run())
  ));
}

export async function rejectedError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}