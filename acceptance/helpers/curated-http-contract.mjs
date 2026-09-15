import assert from "node:assert/strict";
import * as validators from "../../test/support/http-response-validators.mjs";

/** Successful CLI documents retain the generated Curated HTTP response shape. */
export function assertCuratedDocument(operation, status, document) {
  const root = "/v1/curated-revisions";
  const path = ["create", "list"].includes(operation)
    ? root
    : operation === "validate"
      ? `${root}/validate`
      : operation === "show"
        ? `${root}/{revision}`
        : `${root}/{revision}/${operation}`;
  const method = ["list", "show"].includes(operation) ? "get" : "post";
  const validate = validators[validators.responseValidators[`admin ${method} ${path} ${status} application/json`]];
  assert.equal(typeof validate, "function", `${method} ${path} ${status} is declared`);
  assert.equal(validate(document), true, JSON.stringify(validate.errors));
}
