import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Read-only local measurements. D1 preparations and batch submissions are
// separate counters; table counts measure retained rows, not exact SQL writes.
export async function onePieceEvidenceMetrics(
  databaseDirectory,
  output,
  captures,
  served,
  elapsedMs,
  driverUsage,
  census,
) {
  let database;
  for (const name of await readdir(databaseDirectory, { recursive: true })) {
    if (!name.endsWith(".sqlite")) continue;
    const candidate = new DatabaseSync(join(databaseDirectory, name), { readOnly: true });
    if (candidate.prepare("SELECT 1 FROM sqlite_schema WHERE name='catalogue_state'").get()) {
      database = candidate;
      break;
    }
    candidate.close();
  }
  if (!database) throw new Error("Catalogue measurement database not found.");
  const storage = {};
  try {
    for (const { name, type } of database
      .prepare("SELECT name,type FROM sqlite_schema WHERE type IN ('table','index') ORDER BY name")
      .all()) {
      storage[name] = { type };
      if (type === "table")
        storage[name].rows = database
          .prepare(`SELECT count(*) AS count FROM "${name.replaceAll('"', '""')}"`)
          .get().count;
    }
    for (const row of database.prepare("SELECT name,sum(pgsize) AS bytes FROM dbstat GROUP BY name").all()) {
      if (storage[row.name]) storage[row.name].allocated_page_bytes = row.bytes;
    }
  } finally {
    database.close();
  }
  const workflow = {};
  for (const line of output.split("\n")) {
    const start = line.indexOf('{"contract":"card-keepr-operational-log@1"');
    if (start < 0) continue;
    let record;
    try {
      record = JSON.parse(line.slice(start));
    } catch {
      continue;
    }
    if (record.event !== "workflow.step.completed") continue;
    const name = record.workflow.step.replace(/-unit-[0-9]+$/u, "");
    workflow[name] ??= {
      attempts: 0,
      elapsed_ms: 0,
      prepared_statements: 0,
      batch_calls: 0,
      batch_statements: 0,
    };
    const total = workflow[name];
    total.attempts++;
    total.elapsed_ms += record.duration_ms;
    for (const field of ["prepared_statements", "batch_calls", "batch_statements"]) total[field] += record.d1[field];
  }
  const selected = [...captures.values()].filter((capture) => served.includes(capture.id));
  return {
    contract: "card-keepr-local-p001-measurements@1",
    scope:
      "Complete local acceptance journey; retained 2026-09-06 responses, simulated HTTP delivery and Cloudflare control plane, actual SQLite/export/import. No live-source freshness or production-capacity claim.",
    concurrency:
      process.env.KEEPR_EVIDENCE_CONCURRENCY_NOTE ??
      "Uncontrolled shared host; no CPU, memory or timing capacity claim.",
    elapsed_ms: elapsedMs,
    measurement_interval:
      "Source database and runtime snapshot before restored consumer verification; final journey timing is recorded separately.",
    driver_only: driverUsage,
    source: {
      unique_responses: selected.length,
      response_deliveries_including_faults: served.length,
      unique_entity_bytes: selected.reduce((sum, capture) => sum + capture.bodyBytes.length, 0),
      unique_original_header_bytes: selected.every((capture) => Number.isSafeInteger(capture.headerByteLength))
        ? selected.reduce((sum, capture) => sum + capture.headerByteLength, 0)
        : null,
      ...census,
    },
    workflow,
    storage,
  };
}
