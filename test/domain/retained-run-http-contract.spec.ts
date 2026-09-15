import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect, test } from "vitest";

const document = JSON.parse(readFileSync("contracts/admin-openapi.json", "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true, inlineRefs: false });
addFormats(ajv);
ajv.addSchema(document, "administration");
const run = "/v1/ingestion-runs/{run}";
function request(suffix: string) {
  return ajv.compile({
    $ref: `administration#/paths/${(run + suffix).replaceAll("/", "~1")}/post/requestBody/content/application~1json/schema`,
  });
}

test("generated retained run commands require exact immutable bindings without coercion or defaults", () => {
  for (const [suffix, body] of [
    [
      "/approval",
      { candidate_digest: "a".repeat(64), expected_current_revision_id: "catrev_retained", idempotency_key: "approve" },
    ],
    ["/rejection", { candidate_digest: "a".repeat(64), idempotency_key: "reject" }],
    ["/retry", { idempotency_key: "retry" }],
    ["/publication-cleanup", { idempotency_key: "cleanup" }],
    ["/reconciliation", { expected_current_revision_id: "catrev_retained", idempotency_key: "reconcile" }],
  ] as const) {
    const validate = request(suffix);
    expect(validate(body), `${suffix}: ${JSON.stringify(validate.errors)}`).toBe(true);
    for (const field of Object.keys(body)) {
      const missing = { ...body } as Record<string, unknown>;
      delete missing[field];
      expect(validate(missing), `${suffix} requires ${field}`).toBe(false);
      expect(validate({ ...body, [field]: null })).toBe(false);
      expect(validate({ ...body, [field]: [body[field as keyof typeof body]] })).toBe(false);
    }
    expect(validate({ ...body, unexpected: true })).toBe(false);
    expect(validate(JSON.parse(JSON.stringify(body).replace(/}$/, ',"__proto__":{}}')))).toBe(false);
  }
  expect(request("/rejection")({ candidate_digest: "A".repeat(64), idempotency_key: "reject" })).toBe(false);
});

test("generated reconciliation action requests preserve numeric retained intent and nonopaque action keys", () => {
  for (const action of ["pause", "resume", "abandon"]) {
    const validate = request(`/reconciliation/${action}`);
    const input = { generation: 1, idempotency_key: "retained action / " + "x".repeat(240) };
    expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...input, generation: 0 })).toBe(true);
    for (const generation of ["01", "1", null, [1], -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(validate({ ...input, generation }), JSON.stringify(generation)).toBe(false);
    expect(validate({ ...input, idempotency_key: "" })).toBe(false);
    expect(validate({ ...input, extra: true })).toBe(false);
  }
});

test("generated retired approval pending response allows a historical reservation without inventing a claim", () => {
  const validate = ajv.compile({ $ref: "administration#/components/schemas/RetainedAdministrationOperation" });
  const reservation = {
    contract: "card-keepr-administration-operation@1",
    operation: "approve_ingestion_run",
    status: "in_progress",
    run_id: "run_retained",
    idempotency_key: "approval",
    retry_after: "2026-09-15T00:05:00.000Z",
    links: { run: "https://keepr.invalid/v1/ingestion-runs/run_retained", status: "https://keepr.invalid/v1/status" },
  };
  expect(validate(reservation), JSON.stringify(validate.errors)).toBe(true);
  expect(validate({ ...reservation, claimed_at: "2026-09-15T00:00:00.000Z" })).toBe(true);
  expect(validate({ ...reservation, claimed_at: null })).toBe(false);
  expect(validate({ ...reservation, status: "complete" })).toBe(false);
  expect(validate({ ...reservation, operation: "publish_game_candidate" })).toBe(false);
});
