import { expect, test } from "vitest";
import { canonicalJson, sha256Text } from "../../../src/catalogue/shared";
import {
  approve,
  collect,
  get,
  installReconciliationSuite,
  post,
  reconcile,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";

installReconciliationSuite();

test("all 32 changed Curated Revisions become reconfirmable with a bounded final transaction", async () => {
  const seed = await reconcile(
    (await collect("/reconciliation/curated-conflict-fanout-base", "curated-fanout-seed")).id,
  );
  expect(seed.response.status).toBe(200);
  const cards = seed.document.cards as { id: string; name: string }[];
  expect(cards).toHaveLength(32);
  const published = await approve(seed.document);
  expect(published.response.status).toBe(200);
  const revisions: string[] = [];
  for (const card of cards) {
    const proposal = {
      game: "one-piece",
      target: { kind: "field", entity_type: "card", entity_id: card.id, path: "/name" },
      assertion: { kind: "field", value: `Synthetic curated ${card.name}` },
      rationale: "Synthetic reviewed correction",
      evidence: [
        { kind: "owner_reference", uri: `https://owner.example/review/${card.id}`, content_digest: "a".repeat(64) },
      ],
      effective_interval: { from: null, to: null },
      reviewed_source_digest: await sha256Text(canonicalJson(card.name)),
      supersedes_revision_id: null,
    };
    const created = await post("/admin/v1/curated-revisions", {
      environment: "production",
      expected_current_revision_id: published.document.resulting_revision_id,
      proposal,
      proposal_digest: await sha256Text(canonicalJson(proposal)),
      idempotency_key: `curated-fanout-${card.id}`,
    });
    expect(created.response.status, JSON.stringify(created.document)).toBe(201);
    revisions.push(requiredString(created.document, "curated_revision_id"));
  }
  const run = await collect("/reconciliation/curated-conflict-fanout-changed", "curated-fanout-next");
  const sqlByStatement = new WeakMap<object, string>();
  const bytesByStatement = new WeakMap<object, number>();
  let interrupted = false;
  let serviceCalls = 0;
  const curatedCalls: number[] = [];
  const sortingCalls: number[] = [];
  const diagnosticCalls: number[] = [];
  const compared: number[] = [];
  const wrap = (statement: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql, values);
        const value = Reflect.get(target, property);
        if (["run", "first", "all", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            serviceCalls++;
            return Reflect.apply(value, target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    sqlByStatement.set(proxy, sql);
    bytesByStatement.set(proxy, new TextEncoder().encode(sql + JSON.stringify(values)).byteLength);
    return proxy;
  };
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          serviceCalls++;
          const final = statements.some((statement) =>
            sqlByStatement.get(statement)?.includes("reconciliation_preparation_incomplete"),
          );
          if (final) {
            if (statements.length > 20)
              throw new Error("The final reconciliation transaction exceeds its 20-statement budget.");
            expect(
              statements.reduce((bytes, statement) => bytes + (bytesByStatement.get(statement) ?? 0), 0),
            ).toBeLessThanOrEqual(65_536);
            if (!interrupted) {
              interrupted = true;
              for (const id of revisions)
                expect((await get(`/admin/v1/curated-revisions/${id}`)).document).toMatchObject({
                  revision: { status: "active", event_version: 1, pending_conflict: null },
                });
              throw new Error("Injected interruption while prepared conflicts remain invisible.");
            }
          }
          const result = await target.batch(statements);
          if (final) expect(result.reduce((rows, batch) => rows + batch.meta.rows_written, 0)).toBeLessThanOrEqual(20);
          return result;
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const event = {
    payload: {
      ingestion_run_id: run.id,
      expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
      idempotency_key: "curated-fanout-next",
      observed_at: new Date().toISOString(),
      generation: 0,
    },
  } as import("cloudflare:workers").WorkflowEvent<
    import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
  >;
  const step = {
    do: async (_name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
      for (let attempt = 0; ; attempt++) {
        try {
          serviceCalls = 0;
          const result = await callback();
          if (JSON.parse(result).continuation?.phase === "curated_diagnostics") diagnosticCalls.push(serviceCalls);
          if (JSON.parse(result).continuation?.phase?.startsWith("record_sorting:")) sortingCalls.push(serviceCalls);
          if (JSON.parse(result).continuation?.phase === "curated_revisions") {
            curatedCalls.push(serviceCalls);
            const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
            const checkpoint = (
              status.checkpoints as { phase: string; cursor: { progress: { stage: string; revision: number } } }[]
            ).find(({ phase }) => phase === "curated_revisions")!;
            if (checkpoint.cursor.progress.stage === "compare") compared.push(checkpoint.cursor.progress.revision);
          }
          return result;
        } catch (error) {
          if (attempt >= config.retries.limit) throw error;
        }
      }
    },
  } as unknown as import("cloudflare:workers").WorkflowStep;
  await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
  expect(diagnosticCalls.length).toBeGreaterThan(0);
  expect(Math.max(...diagnosticCalls)).toBeLessThanOrEqual(100);
  expect(sortingCalls.length).toBeGreaterThan(0);
  expect(Math.max(...sortingCalls)).toBeLessThanOrEqual(100);
  expect(curatedCalls.length).toBeGreaterThan(0);
  expect(Math.max(...curatedCalls)).toBeLessThanOrEqual(100);
  expect(compared.some((value) => value > 0 && value < 31)).toBe(true);
  expect(interrupted).toBe(true);
  const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
  expect(status, JSON.stringify(status)).toMatchObject({
    state: "failed",
    generation: 0,
  });
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({
    failure_code: "curated_revision_reconfirmation_required",
  });
  const manifest = await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions`);
  const conflicted = new Set<string>();
  for (const partition of manifest.document.partitions as { ordinal: number; kind: string; byte_length: number }[]) {
    expect(partition.byte_length).toBeLessThanOrEqual(524_288);
    if (partition.kind !== "warnings") continue;
    const page = await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions/${partition.ordinal}`);
    for (const diagnostic of page.document.records as { code: string; curated_revision_id: string }[])
      if (diagnostic.code === "curated_revision_reconfirmation_required")
        conflicted.add(diagnostic.curated_revision_id);
  }
  expect([...conflicted].sort()).toEqual([...revisions].sort());
  for (const id of revisions)
    expect((await get(`/admin/v1/curated-revisions/${id}`)).document).toMatchObject({
      revision: { status: "reconfirmation_required", pending_conflict: { run_id: run.id } },
    });
  for (const [index, action] of ["reaffirm", "retire"].entries()) {
    const id = revisions[index]!;
    const before = (await get(`/admin/v1/curated-revisions/${id}`)).document;
    const revision = before.revision as { event_version: number; pending_conflict: { digest: string } };
    const mutated = await post(`/admin/v1/curated-revisions/${id}/${action}`, {
      environment: "production",
      expected_current_revision_id: published.document.resulting_revision_id,
      expected_event_version: revision.event_version,
      conflict_digest: revision.pending_conflict.digest,
      rationale: "Synthetic reviewed source change",
      idempotency_key: `curated-fanout-${action}`,
    });
    expect(mutated.response.status, JSON.stringify(mutated.document)).toBe(200);
    const after = (await get(`/admin/v1/curated-revisions/${id}`)).document;
    expect(after).toMatchObject({
      revision: { status: action === "reaffirm" ? "active" : "retired", event_version: 3, pending_conflict: null },
    });
  }
});
