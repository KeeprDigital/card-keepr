import { pathToFileURL } from "node:url";
import { createServer } from "vite";

/** Read-only query; use the same immutable-event authority predicate as mutations. */
export async function adapterRetirementSql(adapterVersions) {
  if (
    !Array.isArray(adapterVersions) ||
    adapterVersions.length === 0 ||
    adapterVersions.some((version) => typeof version !== "string" || !/^[a-z0-9][a-z0-9-]*@[1-9][0-9]*$/u.test(version))
  )
    throw new Error("Supply one or more exact Source Adapter Version identifiers.");
  const vite = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const { verifiedRunCurrentSql } = await vite.ssrLoadModule(
      "/src/catalogue/shared/ingestion-run-event-repository.ts",
    );
    return `WITH retiring(adapter_version) AS (
  SELECT value FROM json_each('${JSON.stringify(adapterVersions)}')
), pinned(ingestion_run_id, adapter_version) AS (
  SELECT ingestion_run_id, adapter_version FROM ingestion_evidence_plans
  UNION SELECT ingestion_run_id, adapter_version FROM source_snapshots
  UNION SELECT snapshot.ingestion_run_id, operation.adapter_version
    FROM source_parse_operations AS operation
    JOIN source_snapshots AS snapshot ON snapshot.id = operation.source_snapshot_id
  UNION SELECT snapshot.ingestion_run_id, observations.adapter_version
    FROM source_observation_sets AS observations
    JOIN source_snapshots AS snapshot ON snapshot.id = observations.source_snapshot_id
  UNION SELECT ingestion_run_id, adapter_version FROM reconciliation_evidence_partitions
)
SELECT DISTINCT pinned.ingestion_run_id, current.state, pinned.adapter_version
FROM pinned JOIN retiring USING (adapter_version)
LEFT JOIN ingestion_run_current AS current USING (ingestion_run_id)
WHERE current.ingestion_run_id IS NULL
  OR (${verifiedRunCurrentSql}) IS NOT 1
  OR current.state NOT IN ('published', 'rejected', 'expired', 'failed')
UNION ALL
SELECT NULL AS ingestion_run_id, NULL AS state, retiring.adapter_version
FROM retiring WHERE NOT EXISTS (
  SELECT 1 FROM source_adapter_versions AS registered
  WHERE registered.adapter_version = retiring.adapter_version
)
ORDER BY ingestion_run_id, adapter_version;\n`;
  } finally {
    await vite.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(await adapterRetirementSql(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Retirement query generation failed."}\n`);
    process.exitCode = 1;
  }
}
