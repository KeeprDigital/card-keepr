import { expect, test } from "vitest";
import { canonicalJson, sha256Text } from "../../../src/catalogue/shared";
import {
  approve,
  exportComponentRecords,
  collect,
  get,
  installReconciliationSuite,
  post,
  reconcile,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";
import { runReconciliationWorkflow } from "../src/reconciliation-workflow";

installReconciliationSuite();

test.each(["release", "relationships"])(
  "a curated %s lookup returns bounded progress across unrelated entities",
  async (kind) => {
    const scenario = kind === "release" ? "card-only-work-units" : "curated-lookup-relationships";
    const seed = await reconcile((await collect(`/reconciliation/${scenario}`, "curated-lookup-seed")).id);
    const products = seed.document.products as { id: string; releases: { id: string; status: string }[] }[];
    expect(products).toHaveLength(32);
    const product = [...products].sort((a, b) => a.id.localeCompare(b.id)).at(-1)!;
    const release = product.releases[0]!;
    const published = await approve(seed.document);
    expect(published.response.status).toBe(200);
    const relationship =
      kind === "relationships"
        ? (await exportComponentRecords(String(published.document.resulting_revision_id), "relationships"))
            .sort((a, b) => String(a.id).localeCompare(String(b.id)))
            .at(-1)!
        : undefined;
    if (kind === "relationships") expect(relationship).toBeDefined();
    const proposal = {
      game: "one-piece",
      target: relationship
        ? { kind: "relationship", relationship_kind: relationship.kind, from: relationship.from, to: relationship.to }
        : { kind: "field", entity_type: "release", entity_id: release.id, path: "/status" },
      assertion: relationship ? { kind: "relationship", presence: "absent" } : { kind: "field", value: "released" },
      rationale: "Synthetic reviewed release status",
      evidence: [
        { kind: "owner_reference", uri: "https://owner.example/review/lookup", content_digest: "c".repeat(64) },
      ],
      effective_interval: { from: null, to: null },
      reviewed_source_digest: await sha256Text(canonicalJson(relationship ? "present" : release.status)),
      supersedes_revision_id: null,
    };
    expect(
      (
        await post("/admin/v1/curated-revisions", {
          environment: "production",
          expected_current_revision_id: published.document.resulting_revision_id,
          proposal,
          proposal_digest: await sha256Text(canonicalJson(proposal)),
          idempotency_key: "curated-lookup-revision",
        })
      ).response.status,
    ).toBe(201);
    const run = await collect(`/reconciliation/${scenario}`, "curated-lookup-next");
    let calls = 0;
    let prefix = "";
    let resumed = false;
    let failures = 0;
    const curatedCalls: number[] = [];
    const lookupPrefixes: string[] = [];
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...values: unknown[]) => {
              const namespace = values.findIndex(
                (value) =>
                  typeof value === "string" &&
                  value.startsWith("candidate_") &&
                  value.endsWith(kind === "release" ? "_products" : "_product_relationships"),
              );
              if (prefix && namespace >= 0 && sql.includes("AS entity_id")) {
                expect(String(values[namespace + 2]) >= prefix).toBe(true);
                if (!resumed) {
                  failures++;
                  throw new Error("Injected lookup storage outage after a completed Product prefix.");
                }
              }
              return wrap(target.bind(...values), sql);
            };
          const value = Reflect.get(target, property);
          if (["run", "first", "all", "raw"].includes(String(property)))
            return (...args: unknown[]) => {
              calls++;
              return Reflect.apply(value, target, args);
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const database = new Proxy(testEnv.CATALOGUE_DB, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
        if (property === "batch")
          return (...args: Parameters<D1Database["batch"]>) => {
            calls++;
            return target.batch(...args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const step = {
      do: async (_name: string, _config: unknown, callback: () => Promise<string>) => {
        let result: string;
        for (let attempt = 0; ; attempt++) {
          try {
            calls = 0;
            result = await callback();
            break;
          } catch (error) {
            if (attempt === 3) throw error;
          }
        }
        if (JSON.parse(result).continuation?.phase === "curated_revisions") {
          curatedCalls.push(calls);
          const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
          const checkpoint = (
            status.checkpoints as {
              phase: string;
              cursor: {
                progress: {
                  stage: string;
                  lookups?: {
                    official?: Partial<Record<"release" | "relationships", { after: string; complete: boolean }>>;
                  };
                };
              };
            }[]
          ).find(({ phase }) => phase === "curated_revisions")!;
          const lookup = checkpoint.cursor.progress.lookups?.official?.[kind as "release" | "relationships"];
          prefix = checkpoint.cursor.progress.stage === "compare" && lookup && !lookup.complete ? lookup.after : "";
          if (lookup && !lookup.complete && lookup.after) lookupPrefixes.push(lookup.after);
        }
        return result;
      },
    } as unknown as import("cloudflare:workers").WorkflowStep;
    const event = {
      payload: {
        ingestion_run_id: run.id,
        expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
        idempotency_key: "curated-lookup-next",
        observed_at: new Date().toISOString(),
        generation: 0,
      },
    } as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >;
    await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
    expect(failures).toBe(4);
    const paused = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
    expect(paused).toMatchObject({ state: "paused", generation: 1 });
    expect(
      (
        await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
          generation: 1,
          idempotency_key: "curated-lookup-resume",
        })
      ).response.status,
    ).toBe(200);
    resumed = true;
    await runReconciliationWorkflow(
      { ...testEnv, CATALOGUE_DB: database },
      { payload: { ...event.payload, generation: 1 } } as typeof event,
      step,
    );
    expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
      state: "sealed",
      deadline: paused.deadline,
    });
    expect(Math.max(...curatedCalls)).toBeLessThanOrEqual(100);
    expect(lookupPrefixes.length).toBeGreaterThan(0);
    const page = (await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions`)).document;
    const found: Record<string, unknown>[] = [];
    for (const partition of page.partitions as { kind: string; ordinal: number }[]) {
      if (partition.kind !== (relationship ? "product_relationships" : "products")) continue;
      found.push(
        ...((await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions/${partition.ordinal}`)).document
          .records as Record<string, unknown>[]),
      );
    }
    if (relationship)
      expect(found.find(({ id }) => id === relationship.id)).toMatchObject({
        observed: false,
        curated_provenance: [expect.objectContaining({ reviewed_source_value: "present" })],
      });
    else
      expect(found.find(({ id }) => id === product.id)).toMatchObject({
        releases: [expect.objectContaining({ id: release.id, product_id: product.id, status: "released" })],
      });
  },
);
