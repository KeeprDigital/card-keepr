import { readFileSync } from "node:fs";

export function readAdministrationSecret(descriptor) {
  if (!/^(0|[3-9]|[1-9][0-9]+)$/.test(descriptor ?? "")) {
    return { error: "The administration key must be supplied through a readable stdin descriptor.", value: "" };
  }
  let text;
  try {
    text = readFileSync(Number.parseInt(descriptor, 10), "utf8");
  } catch {
    return { error: "The administration key stdin descriptor could not be read.", value: "" };
  }
  if (Buffer.byteLength(text) > 32_768) return { error: "The secret input exceeds 32 KiB.", value: "" };
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    document = null;
  }
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    Object.keys(document).length !== 1 ||
    typeof document.administration_key !== "string" ||
    document.administration_key.length === 0
  ) {
    return { error: "The secret input must contain only a non-empty administration_key.", value: "" };
  }
  return { error: null, value: document.administration_key };
}
