import { sha256, validateGolden } from "./retained-source-integrity.mjs";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const maximumBodyBytes = 16 * 1024 * 1024;

// The directory's JSON captures are the manifest. Re-fetch full responses, then
// compare both their full digest and the exact retained range. Goldens are never
// overwritten: a maintainer reviews the report and recaptured evidence artifact.
export async function recaptureOfficialBytes({
  fixturesDirectory,
  outputDirectory,
  fetch: fetchBytes = globalThis.fetch,
  intervalMs = 1_000,
  assess,
  excludedCaptures = new Set(),
}) {
  const goldenDirectory = await realpath(fixturesDirectory);
  const outputTarget = await realpath(outputDirectory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (outputTarget === goldenDirectory) throw new Error("The output directory must not alias the golden directory.");
  await mkdir(outputDirectory, { recursive: true });
  const captures = [];
  const byUrl = new Map();
  const names = (await readdir(fixturesDirectory)).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    try {
      const golden = JSON.parse(await readFile(join(fixturesDirectory, name), "utf8"));
      validateGolden(golden);
      if (excludedCaptures.has(name)) {
        captures.push({
          file: name,
          source_url: golden.source_url,
          status: "skipped",
          category: "out_of_scope",
          actionable: false,
          reason: "ADR 0014 eligibility capture; retained bytes verified and preserved.",
        });
        continue;
      }
      const entries = byUrl.get(golden.source_url) ?? [];
      entries.push({ name, golden });
      byUrl.set(golden.source_url, entries);
    } catch (error) {
      captures.push({
        file: name,
        status: "invalid_golden",
        category: "integrity_failure",
        actionable: true,
        error: error.message,
      });
    }
  }
  let requested = false;
  for (const [url, entries] of byUrl) {
    if (requested && intervalMs > 0) await delay(intervalMs);
    requested = true;
    let failureCategory = "transport_failure";
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
      failureCategory = "integrity_failure";
      const fullBodyFile = `${sha256(url)}.body`;
      await writeFile(join(outputDirectory, fullBodyFile), bytes, { flag: "wx" });
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
          full_body_file: fullBodyFile,
          range_start: Math.min(bytes.length, golden.range_start),
          range_end_exclusive: Math.min(bytes.length, golden.range_end_exclusive),
          body_sha256: sha256(retained),
          body_base64: retained.toString("base64"),
        };
        const differences = ["full_body_sha256", "full_body_size", "body_sha256", "range_end_exclusive"].filter(
          (key) => actual[key] !== golden[key],
        );
        if (actual.http_status !== (golden.http_status ?? 200)) differences.push("http_status");
        if (actual.effective_url !== (golden.effective_url ?? url)) differences.push("effective_url");
        failureCategory = "integrity_failure";
        await writeFile(join(outputDirectory, name), `${JSON.stringify(actual, null, 2)}\n`, { flag: "wx" });
        failureCategory = "unresolved_drift";
        const assessment =
          response.status !== 200 || actual.effective_url !== url
            ? {
                category: "transport_failure",
                actionable: true,
                reason: `HTTP ${response.status}; effective URL ${actual.effective_url}.`,
              }
            : assess
              ? await assess({ name, golden, actual, bytes, differences })
              : { category: differences.length ? "unresolved_drift" : "unchanged", actionable: differences.length > 0 };
        captures.push({
          ...assessment,
          file: name,
          source_url: url,
          status: differences.length ? "drift" : "unchanged",
          differences,
          expected_full_body_sha256: golden.full_body_sha256,
          actual_full_body_sha256: actual.full_body_sha256,
        });
      }
    } catch (error) {
      for (const { name } of entries.filter((entry) => !captures.some((capture) => capture.file === entry.name)))
        captures.push({
          file: name,
          source_url: url,
          status: failureCategory === "transport_failure" ? "fetch_failed" : "assessment_failed",
          category: failureCategory,
          actionable: true,
          error: error.message,
        });
    }
  }
  captures.sort((a, b) => a.file.localeCompare(b.file));
  const summary = Object.fromEntries(
    [...new Set(captures.map(({ category }) => category))]
      .sort()
      .map((category) => [category, captures.filter((capture) => capture.category === category).length]),
  );
  const result = {
    summary,
    ok: captures.some(({ status }) => status !== "skipped") && captures.every((capture) => !capture.actionable),
    captures,
  };
  await writeFile(join(outputDirectory, "report.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
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
  const { createOfficialSourceAssessment, excludedRecaptures } = await import(
    "./official-source-recapture-assessment.mjs"
  );
  const fixturesDirectory = resolve(root, "acceptance/fixtures/retained-official-source");
  const result = await recaptureOfficialBytes({
    fixturesDirectory,
    assess: await createOfficialSourceAssessment({
      fixturesDirectory,
      reviewedBaselinesDirectory: join(fixturesDirectory, "monitoring"),
    }),
    excludedCaptures: excludedRecaptures,
    outputDirectory: resolve(process.argv[2] ?? join(root, ".artifacts/official-source-recapture")),
  });
  for (const capture of result.captures)
    console.log(
      `${capture.category}: ${capture.file}${capture.differences?.length ? ` (${capture.differences.join(", ")})` : ""}${capture.error ? `: ${capture.error}` : ""}`,
    );
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Official Source recapture\n\n${Object.entries(result.summary)
        .map(([category, count]) => `- ${category}: ${count}`)
        .join("\n")}\n\n${result.captures
        .filter(({ actionable }) => actionable)
        .map((capture) => `- ${capture.file}: ${capture.category}${capture.reason ? ` — ${capture.reason}` : ""}`)
        .join("\n")}\n`,
    );
  }
  if (!result.ok) process.exitCode = 1;
}
