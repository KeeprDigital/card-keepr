import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createOfficialSourceAssessment, excludedRecaptures } from "./official-source-recapture-assessment.mjs";
import { sha256, validateGolden } from "./retained-source-integrity.mjs";

// Reassess an immutable downloaded artifact with today's adapters without a
// network request. Old artifacts may contain only the old retained range.
export async function assessRetainedRecapture({ fixturesDirectory, captureDirectory, outputFile }) {
  const original = JSON.parse(await readFile(join(captureDirectory, "report.json"), "utf8"));
  const assess = await createOfficialSourceAssessment({ fixturesDirectory });
  const captures = [];
  for (const capture of original.captures) {
    let assessment;
    try {
      if (!/^[a-z0-9-]+\.json$/u.test(capture.file)) throw new Error("Invalid capture filename.");
      const golden = JSON.parse(await readFile(join(fixturesDirectory, capture.file), "utf8"));
      validateGolden(golden);
      if (capture.status === "skipped" && excludedRecaptures.has(capture.file)) {
        assessment = {
          category: "out_of_scope",
          actionable: false,
          reason: "ADR 0014 eligibility capture; raw evidence remains preserved.",
        };
      } else if (["invalid_golden", "fetch_failed"].includes(capture.status)) {
        assessment = {
          category: capture.status === "invalid_golden" ? "integrity_failure" : "transport_failure",
          actionable: true,
          reason: capture.error,
        };
      } else {
        const actual = JSON.parse(await readFile(join(captureDirectory, capture.file), "utf8"));
        validateGolden(actual);
        if (actual.source_url !== golden.source_url) throw new Error("Recapture Source URL does not match the golden.");
        let bytes = Buffer.from(actual.body_base64, "base64");
        if (actual.full_body_file) {
          if (!/^[a-f0-9]{64}\.body$/u.test(actual.full_body_file)) throw new Error("Invalid full response filename.");
          bytes = await readFile(join(captureDirectory, actual.full_body_file));
          if (sha256(bytes) !== actual.full_body_sha256 || bytes.length !== actual.full_body_size)
            throw new Error("Full response does not match its retained digest and size.");
        }
        if (excludedRecaptures.has(capture.file))
          assessment = {
            category: "out_of_scope",
            actionable: false,
            reason: "ADR 0014 eligibility capture; raw evidence remains preserved.",
          };
        else if (actual.http_status !== 200 || actual.effective_url !== golden.source_url)
          assessment = {
            category: "transport_failure",
            actionable: true,
            reason: `HTTP ${actual.http_status}; effective URL ${actual.effective_url}.`,
          };
        else if (bytes.length !== actual.full_body_size)
          assessment = {
            category: "unresolved_drift",
            actionable: true,
            reason:
              "Original recapture discarded bytes outside the retained range; complete current response unavailable.",
          };
        else
          assessment = await assess({
            name: capture.file,
            golden,
            actual,
            bytes,
            differences: capture.differences ?? [],
          });
      }
    } catch (error) {
      assessment = { category: "integrity_failure", actionable: true, reason: error.message };
    }
    captures.push({ ...capture, ...assessment });
  }
  const summary = {};
  for (const { category } of captures) summary[category] = (summary[category] ?? 0) + 1;
  const result = { ok: captures.length > 0 && captures.every(({ actionable }) => !actionable), summary, captures };
  await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.length !== 4)
    throw new Error("Usage: node scripts/assess-official-recapture.mjs <artifact-directory> <new-report-file>");
  const result = await assessRetainedRecapture({
    fixturesDirectory: resolve(import.meta.dirname, "../acceptance/fixtures/retained-official-source"),
    captureDirectory: resolve(process.argv[2]),
    outputFile: resolve(process.argv[3]),
  });
  console.log(JSON.stringify(result.summary, null, 2));
  if (!result.ok) process.exitCode = 1;
}
