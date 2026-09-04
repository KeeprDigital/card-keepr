import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const maximumBodyBytes = 16 * 1024 * 1024;

// The directory's JSON captures are the manifest. Re-fetch full responses, then
// compare both their full digest and the exact retained range. Goldens are never
// overwritten: a maintainer reviews the report and recaptured evidence artifact.
export async function recaptureOfficialBytes({
  fixturesDirectory,
  outputDirectory,
  fetch: fetchBytes = globalThis.fetch,
  intervalMs = 1_000,
}) {
  await mkdir(outputDirectory, { recursive: true });
  const captures = [];
  const byUrl = new Map();
  const names = (await readdir(fixturesDirectory)).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    try {
      const golden = JSON.parse(await readFile(join(fixturesDirectory, name), "utf8"));
      validateGolden(golden);
      const entries = byUrl.get(golden.source_url) ?? [];
      entries.push({ name, golden });
      byUrl.set(golden.source_url, entries);
    } catch (error) {
      captures.push({ file: name, status: "invalid_golden", error: error.message });
    }
  }
  let requested = false;
  for (const [url, entries] of byUrl) {
    if (requested && intervalMs > 0) await delay(intervalMs);
    requested = true;
    try {
      const response = await fetchBytes(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "user-agent": "Card-Keepr-retained-bytes-recapture/1 (+https://github.com/KeeprDigital/card-keepr)",
          accept: "text/html,application/json;q=0.9,*/*;q=0.1",
          "cache-control": "no-cache",
        },
      });
      const bytes = await boundedBytes(response);
      for (const { name, golden } of entries) {
        const retained = bytes.subarray(golden.range_start, golden.range_end_exclusive);
        const actual = {
          source_url: url,
          retrieved_at: new Date().toISOString(),
          http_status: response.status,
          content_type: response.headers.get("content-type"),
          effective_url: response.url || url,
          full_body_sha256: sha256(bytes),
          full_body_size: bytes.length,
          range_start: golden.range_start,
          range_end_exclusive: Math.min(bytes.length, golden.range_end_exclusive),
          body_sha256: sha256(retained),
          body_base64: retained.toString("base64"),
        };
        const differences = ["full_body_sha256", "full_body_size", "body_sha256", "range_end_exclusive"].filter(
          (key) => actual[key] !== golden[key],
        );
        if (actual.http_status !== (golden.http_status ?? 200)) differences.push("http_status");
        if (actual.effective_url !== (golden.effective_url ?? url)) differences.push("effective_url");
        await writeFile(join(outputDirectory, name), `${JSON.stringify(actual, null, 2)}\n`);
        captures.push({
          file: name,
          source_url: url,
          status: differences.length ? "drift" : "unchanged",
          differences,
          expected_full_body_sha256: golden.full_body_sha256,
          actual_full_body_sha256: actual.full_body_sha256,
        });
      }
    } catch (error) {
      for (const { name } of entries)
        captures.push({ file: name, source_url: url, status: "fetch_failed", error: error.message });
    }
  }
  captures.sort((a, b) => a.file.localeCompare(b.file));
  const result = { ok: captures.length > 0 && captures.every((capture) => capture.status === "unchanged"), captures };
  await writeFile(join(outputDirectory, "report.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function validateGolden(golden) {
  const url = new URL(golden.source_url);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Capture URL must be public HTTPS without credentials.");
  if (![golden.body_sha256, golden.full_body_sha256].every((value) => /^[a-f0-9]{64}$/u.test(value)))
    throw new Error("Capture digests must be SHA-256 hex.");
  if (
    ![golden.range_start, golden.range_end_exclusive, golden.full_body_size].every(Number.isSafeInteger) ||
    golden.range_start < 0 ||
    golden.range_end_exclusive < golden.range_start ||
    golden.range_end_exclusive > golden.full_body_size
  )
    throw new Error("Invalid retained range.");
  const bytes = Buffer.from(golden.body_base64, "base64");
  if (bytes.length !== golden.range_end_exclusive - golden.range_start || sha256(bytes) !== golden.body_sha256)
    throw new Error("Retained bytes do not match their range and digest.");
  if (
    golden.range_start === 0 &&
    golden.range_end_exclusive === golden.full_body_size &&
    sha256(bytes) !== golden.full_body_sha256
  )
    throw new Error("Full retained response digest does not match.");
}

async function boundedBytes(response) {
  if (Number(response.headers.get("content-length")) > maximumBodyBytes)
    throw new Error("Response exceeds 16 MiB recapture limit.");
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBodyBytes) throw new Error("Response exceeds 16 MiB recapture limit.");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = resolve(import.meta.dirname, "..");
  const result = await recaptureOfficialBytes({
    fixturesDirectory: resolve(root, "acceptance/fixtures/retained-official-source"),
    outputDirectory: resolve(process.argv[2] ?? join(root, ".artifacts/official-source-recapture")),
  });
  for (const capture of result.captures)
    console.log(
      `${capture.status}: ${capture.file}${capture.differences?.length ? ` (${capture.differences.join(", ")})` : ""}${capture.error ? `: ${capture.error}` : ""}`,
    );
  if (!result.ok) process.exitCode = 1;
}
