import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect, test } from "vitest";

const document = JSON.parse(readFileSync("contracts/admin-openapi.json", "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(document, "administration");
const proposal = {
  game: "one-piece",
  entity_kind: "card",
  action: "merge",
  source_ids: ["card_original"],
  replacement_ids: ["card_survivor"],
  printing_assignments: {},
  expected_current_revision_id: "catrev_reviewed",
  rationale: "Synthetic retained owner review",
  evidence: { attestation: "Synthetic comparison" },
};

test("generated correction creation accepts complete current and historical replay envelopes", () => {
  const validate = ajv.compile({
    $ref: "administration#/paths/~1v1~1identity-corrections/post/requestBody/content/application~1json/schema",
  });
  for (const action of ["merge", ["merge"], [[["split"]]], [["assign"]]]) {
    const request = {
      ...proposal,
      action,
      review_digest: "a".repeat(64),
      idempotency_key: "retained-correction",
    };
    expect(validate(request), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...request, unexpected: true })).toBe(false);
    expect(validate({ ...request, action: ["merge", "split"] })).toBe(false);
    expect(validate({ ...request, action: [] })).toBe(false);
  }
});

test("generated correction validation requires a scalar action and validates every assignment value", () => {
  const validate = ajv.compile({
    $ref: "administration#/paths/~1v1~1identity-corrections~1validate/post/requestBody/content/application~1json/schema",
  });
  expect(validate(proposal), JSON.stringify(validate.errors)).toBe(true);
  expect(validate({ ...proposal, action: ["merge"] })).toBe(false);
  expect(validate({ ...proposal, printing_assignments: JSON.parse('{"__proto__":null}') })).toBe(false);
});
