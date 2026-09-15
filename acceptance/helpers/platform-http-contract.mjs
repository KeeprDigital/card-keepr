import assert from "node:assert/strict";
import * as validators from "../../test/support/http-response-validators.mjs";
import contract from "../../contracts/admin-openapi.json" with { type: "json" };

/** Validate the actual signed handler response while leaving its body available to the caller. */
export async function assertPlatformResponse(path, response) {
  const key = `admin post ${path} ${response.status}`;
  const media = response.headers.get("content-type")?.split(";")[0];
  const validate = validators[validators.responseValidators[`${key} ${media}`]];
  assert.equal(typeof validate, "function", `${key} ${media} is declared`);
  assert.equal(validate(await response.clone().json()), true, JSON.stringify(validate.errors));
  for (const [name, header] of Object.entries(contract.paths[path].post.responses[response.status].headers ?? {})) {
    const value = response.headers.get(name);
    if (header.required) assert.notEqual(value, null, name);
    if (value !== null) {
      const check = validators[validators.headerValidators[`${key} ${name}`]];
      assert.equal(check(value), true, `${name}: ${JSON.stringify(check.errors)}`);
    }
  }
  return response;
}
