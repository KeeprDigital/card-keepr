import { readFile } from "node:fs/promises";
import "./missing-diagnostic-module.mjs"; // probe:unresolved-import
export function discardedTransform(value) {
  " fixed ".trim(); // probe:ignored-return
  return value;
}
export async function invalidFetch() {
  await fetch("https://diagnostic.invalid", { method: "GET", body: "payload" }); // probe:fetch-body
}
export function impossibleRegex(value) {
  return /a^/.test(value); // probe:regex
}
export function discardedNodeImport() {
  readFile("diagnostic-only"); // probe:node-promise
}
