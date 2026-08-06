import { expect, test } from "vitest";
import {
  installReconciliationSuite,
  testEnv,
  approve,
  collect,
  exportComponentRecords,
  exportManifest,
  post,
  reconcile,
  requiredString,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("a 1001-entity reconciliation publishes atomically within bounded D1 statement budgets", async () => {
  const run = await collect(
    "/reconciliation/scale-1001-cards",
    "bounded-d1-scale-1001-cards",
    undefined,
    30_000,
  );
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  expect(reconciled.response.status).toBe(200);
  expect(
    Array.isArray(reconciled.document.cards)
      ? reconciled.document.cards
      : [],
  ).toHaveLength(1_001);
  const publicCardIds = (
    Array.isArray(reconciled.document.cards)
      ? reconciled.document.cards
      : []
  ).map((card) =>
    requiredString(card as Record<string, unknown>, "id")
  );
  expect(new Set(publicCardIds).size).toBe(1_001);
  if (!("workflow_instance_id" in reconciled)) {
    throw new Error("Expected an accepted reconciliation Workflow.");
  }
  const workflowInstance = await testEnv.RECONCILIATION_WORKFLOW.get(
    reconciled.workflow_instance_id,
  );
  const workflowStatus = await workflowInstance.status();
  expect(workflowStatus.status).toBe("complete");
  const durableOutputBytes = new TextEncoder().encode(
    JSON.stringify(workflowStatus.output),
  ).byteLength;
  expect(durableOutputBytes).toBeLessThan(1_048_576);
  expect(workflowStatus.output).toMatchObject({
    result_json: expect.stringContaining(
      "card-keepr-reconciliation-workflow-result@1",
    ),
  });
  const publicReplay = await post(
    `/v1/ingestion-runs/${run.id}/reconciliation`,
    {
      expected_current_revision_id: requiredString(
        reconciled.document,
        "expected_current_revision_id",
      ),
      idempotency_key: `reconcile-${run.id}`,
    },
  );
  expect(publicReplay.response.status).toBe(200);
  expect(publicReplay.document.output).toEqual(reconciled.document);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const persisted = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM revision_cards
     WHERE catalogue_revision_id = ?`,
  )
    .bind(revisionId)
    .first<{ count: number }>();
  expect(persisted?.count).toBeGreaterThan(1_000);
  expect(await exportComponentRecords(revisionId, "cards")).toHaveLength(
    persisted?.count ?? 0,
  );
  const chunks = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count,
            MAX(length(CAST(content AS BLOB))) AS maximum_bytes,
            SUM(
              CASE WHEN payload_kind = 'candidate'
                THEN length(CAST(content AS BLOB))
                ELSE 0
              END
            ) AS candidate_bytes
     FROM reconciliation_payload_chunks
     WHERE ingestion_run_id = ?`,
  )
    .bind(run.id)
    .first<{
      count: number;
      maximum_bytes: number;
      candidate_bytes: number;
    }>();
  expect(chunks?.count).toBeGreaterThan(32);
  expect(chunks?.count).toBeLessThan(900);
  expect(chunks?.maximum_bytes).toBeLessThanOrEqual(524_288);
  expect(chunks?.candidate_bytes).toBeGreaterThan(8 * 1024 * 1024);
  expect(chunks?.candidate_bytes).toBeLessThan(16 * 1024 * 1024);
  const searchMaterialization = await testEnv.CATALOGUE_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM revision_card_search_terms
        WHERE catalogue_revision_id = ?
          AND card_id IN (
            SELECT CAST(value AS TEXT) FROM json_each(?)
          )) AS term_count,
       (SELECT MAX(length(term)) FROM revision_card_search_terms
        WHERE catalogue_revision_id = ?) AS maximum_term_length,
       (SELECT SUM(length(CAST(search_text AS BLOB)))
        FROM revision_card_search_chunks
        WHERE catalogue_revision_id = ?) AS chunk_bytes`,
  )
    .bind(
      revisionId,
      JSON.stringify(publicCardIds),
      revisionId,
      revisionId,
    )
    .first<{
      term_count: number;
      maximum_term_length: number;
      chunk_bytes: number;
    }>();
  expect(searchMaterialization?.term_count).toBeLessThanOrEqual(
    256 * 1_001,
  );
  expect(searchMaterialization?.maximum_term_length).toBeLessThanOrEqual(6);
  expect(searchMaterialization?.chunk_bytes).toBeLessThan(
    16 * 1024 * 1024,
  );
  const storedRun = await testEnv.CATALOGUE_DB.prepare(
    "SELECT candidate_json FROM ingestion_runs WHERE id = ?",
  )
    .bind(run.id)
    .first<{ candidate_json: string }>();
  expect(storedRun?.candidate_json).toContain(
    '"chunked_reconciliation_payload":"candidate"',
  );
  const exportRow = await testEnv.CATALOGUE_DB.prepare(
    `SELECT manifest_key FROM catalogue_exports
     WHERE catalogue_revision_id = ?`,
  )
    .bind(revisionId)
    .first<{ manifest_key: string }>();
  const manifest = await (
    await testEnv.CATALOGUE_EXPORTS.get(exportRow?.manifest_key ?? "")
  )?.json<{ components: { compressed_bytes: number }[] }>();
  expect(
    manifest?.components.reduce(
      (total, component) => total + component.compressed_bytes,
      0,
    ),
  ).toBeGreaterThan(1_048_576);
}, 180_000);

test("a Product-heavy export publishes bounded verified R2 components", async () => {
  const run = await collect(
    "/reconciliation/scale-1001-products",
    "bounded-export-scale-1001-products",
    undefined,
    45_000,
  );
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const [products, releases, contexts, manifest] = await Promise.all([
    exportComponentRecords(revisionId, "products"),
    exportComponentRecords(revisionId, "releases"),
    exportComponentRecords(revisionId, "distribution-contexts"),
    exportManifest(revisionId),
  ]);
  const scaleProducts = products.filter(({ official_code }) =>
    /^SC-[0-9]{4}$/u.test(String(official_code)),
  );
  expect(scaleProducts).toHaveLength(1_001);
  const scaleProductIds = new Set(
    scaleProducts.map(({ id }) => String(id)),
  );
  expect(
    releases.filter(({ product_id }) =>
      scaleProductIds.has(String(product_id)),
    ),
  ).toHaveLength(1_001);
  expect(
    contexts.filter(({ product_id }) =>
      scaleProductIds.has(String(product_id)),
    ),
  ).toHaveLength(1_001);
  const productBytes = manifest.components
    .filter(({ name }) =>
      ["products", "releases", "distribution-contexts"].includes(name),
    )
    .reduce((total, component) => total + component.uncompressed_bytes, 0);
  expect(productBytes).toBeGreaterThan(8 * 1024 * 1024);
  for (const component of manifest.components) {
    const key =
      `catalogue-exports/${revisionId}/components/` +
      `${component.compressed_sha256}.ndjson.gz`;
    const stored = await testEnv.CATALOGUE_EXPORTS.head(key);
    expect(stored?.size).toBe(component.compressed_bytes);
    expect(stored?.checksums.sha256).toBeDefined();
  }
}, 120_000);
