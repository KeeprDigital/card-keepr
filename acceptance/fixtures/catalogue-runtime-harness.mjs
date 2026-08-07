import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";

// Compatibility shim: the catalogue runtime helpers now live in
// acceptance/helpers/acceptance-runtime.mjs so every acceptance file shares
// one implementation with runtime-allocated ports.
export {
  administrationDocument,
  allocatePort,
  applyMigrations,
  runCli,
  startWorker,
  stopWorker,
  waitForAdministrationDocument,
  waitForHealth,
  waitForResponse,
  waitForRunState,
} from "../helpers/acceptance-runtime.mjs";

export async function exportRecords(port, apiKey, revisionId, component) {
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/catalogue-exports/${revisionId}/components/${component}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(response.status, 200);
  return gunzipSync(Buffer.from(await response.arrayBuffer()))
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
