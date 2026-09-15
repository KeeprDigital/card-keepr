import assert from "node:assert/strict";
import * as validators from "../../test/support/http-response-validators.mjs";

export function assertIdentityDocument(path, method, status, document) {
  const media = status >= 400 ? "application/problem+json" : "application/json";
  const validate = validators[validators.responseValidators[`admin ${method} ${path} ${status} ${media}`]];
  assert.equal(typeof validate, "function", `${method} ${path} ${status} is declared`);
  assert.equal(validate(document), true, `${method} ${path}: ${JSON.stringify(validate.errors)}`);
}

/** The actual CLI JSON must obey the same response contract as HTTP. */
export function assertIdentityCliDocument([command, operation], document) {
  if (command !== "entity-proposal" && command !== "identity-correction") return;
  const base = command === "entity-proposal" ? "/v1/entity-proposals" : "/v1/identity-corrections";
  const resource = command === "entity-proposal" ? "{proposal}" : "{correction}";
  const path =
    operation === "inspect"
      ? `${base}/${resource}`
      : operation === "evidence"
        ? `${base}/${resource}/evidence`
        : operation === "validate"
          ? `${base}/validate`
          : ["admit", "link", "reject", "reconsider"].includes(operation)
            ? `${base}/${resource}/decisions`
            : base;
  assertIdentityDocument(
    path,
    ["list", "inspect", "evidence"].includes(operation) ? "get" : "post",
    operation === "create" ? 201 : 200,
    document,
  );
}
