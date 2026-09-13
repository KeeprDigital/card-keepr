import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { expect, test } from "vitest";

const schema = JSON.parse(readFileSync("contracts/schemas/administration.schema.json", "utf8"));
const ajv = new Ajv2020({ strict: false });
ajv.addSchema(schema);

test("native approval requires the exact whole candidate, manifest, game predecessor and generation", () => {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/PublicationApprovalCommandRequest`);
  expect(validate).toBeDefined();
  const request = {
    candidate_id: "candidate_approved",
    manifest_digest: "a".repeat(64),
    expected_game_revision_id: "catrev_spine_000",
    generation: 0,
    idempotency_key: "approve-native-candidate",
  };
  expectCompleteRequest(validate!, request);
  for (const changed of [
    { expected_current_revision_id: "catrev_global" },
    { candidate_digest: "a".repeat(64) },
    { printing_ids: ["printing_subset"] },
    { generation: -1 },
    { generation: 0.5 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { manifest_digest: "invalid" },
  ])
    expect(validate!({ ...request, ...changed })).toBe(false);
});

test.each([
  [
    "GameCandidatePrepareCommandRequest",
    {
      ingestion_run_id: "run_source",
      supported_game: "one-piece",
      expected_game_revision_id: "catrev_spine_000",
      idempotency_key: "prepare@1",
    },
  ],
  ["GameCandidateActionCommandRequest", { generation: 0, idempotency_key: "pause@1" }],
  [
    "PublicationPreparationCommandRequest",
    {
      manifest_digest: "b".repeat(64),
      generation: 0,
      sequence: 0,
      idempotency_key: "artifacts@1",
    },
  ],
  ["PublicationResumeCommandRequest", { generation: 0, idempotency_key: "resume-publication" }],
] as const)("%s accepts its complete native intent and rejects incomplete or extra bindings", (name, request) => {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  expect(validate).toBeDefined();
  expectCompleteRequest(validate!, request);
  expect(validate!({ ...request, expected_current_revision_id: "catrev_global" })).toBe(false);
  expect(validate!({ ...request, idempotency_key: "" })).toBe(false);
  if ("generation" in request) expect(validate!({ ...request, generation: -1 })).toBe(false);
  if ("sequence" in request) {
    expect(validate!({ ...request, sequence: 0.5 })).toBe(false);
    expect(validate!({ ...request, resume: true })).toBe(true);
    expect(validate!({ ...request, resume: "yes" })).toBe(false);
  }
  if ("supported_game" in request) expect(validate!({ ...request, supported_game: "unregistered" })).toBe(false);
});

test.each(["dev", "staging", "production"])("recovery accepts the complete %s environment intent", (environment) => {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/CatalogueRecoveryBeginCommandRequest`)!;
  const request = {
    environment,
    recovery_id: "recovery_exact_backup",
    method: "time_travel",
    target_revision_id: "catrev_recoverable",
    target_bookmark: "retained-bookmark",
    target_digest: "c".repeat(64),
    backup_attempt_id: "backup_verified",
    expected_current_revision_id: "catrev_current",
    idempotency_key: "recover-exact-backup",
  };
  expectCompleteRequest(validate, request);
  expect(validate({ ...request, environment: "other" })).toBe(false);
});

function expectCompleteRequest(validate: ValidateFunction, request: Record<string, unknown>) {
  expect(validate(request)).toBe(true);
  for (const field of Object.keys(request)) {
    const incomplete = { ...request };
    delete incomplete[field];
    expect(validate(incomplete)).toBe(false);
  }
}
