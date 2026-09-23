import { env } from "cloudflare:workers";
import type { WorkflowStep } from "cloudflare:workers";
import { expect } from "vitest";
import etched from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/etched.json?raw";
import { catalogueStore, sha256 } from "../../../src/catalogue/shared";
import { recordWorkflowIds } from "../../../src/catalogue/source-evidence";
import {
  archiveDecodeStepBudget,
  archiveStepSubrequestCeiling,
} from "../../../src/catalogue/source-evidence/source-archive-decode";
import { archiveDiscoveryStepBudget } from "../../../src/catalogue/source-evidence/source-archive-discovery";
import { archiveNormalizationStepBudget } from "../../../src/catalogue/source-evidence/source-archive-parse";
import { EvidenceHostWorkflow } from "../src/evidence-workflows";
import {
  boundedWorkflowInvocation,
  workflowInvocationStepBudget,
  workflowInvocationSubrequestBudget,
} from "../src/workflow-invocation-budget";
import * as queries from "./query-helpers/source-archive";
import { seedArchive } from "./source-archive-fixture";

type Cursors = {
  blocks: number;
  decode_state: string;
  records: number;
  discovered: number;
  parse_state: string | null;
};
const lostResponse = "lost archive step response";

/**
 * A synthetic bulk archive of `records` small valid Scryfall records: most are
 * excluded as non-English, and every 500th is a distinct English Printing, so
 * decode, normalization and discovery all run at the requested volume. Each
 * record carries deterministic incompressible text so the archive compresses
 * about as poorly as a real bulk export: near-identical records used to
 * compress the whole 150,000-record volume into 1.4 MiB, barely one
 * `gunzipRangeBytes` range, which left the decoder's range boundaries
 * untested at every volume (#327). This is a structure fixture, not real
 * source coverage.
 */
function syntheticArchive(records: number): Uint8Array {
  const english = JSON.parse(etched) as Record<string, unknown> & { image_uris: Record<string, string> };
  let seed = 0x2f6e2b1;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const distinct = (length: number) => Array.from({ length }, () => "0123456789abcdef"[(random() * 16) | 0]).join("");
  const lines: string[] = [];
  for (let index = 0; index < records; index++) {
    const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    const uri = `https://api.scryfall.com/cards/${id}`;
    lines.push(
      index % 500 === 0
        ? JSON.stringify({
            ...english,
            id,
            uri,
            flavor_text: distinct(128),
            image_uris: { ...english.image_uris, normal: `https://cards.scryfall.io/normal/front/0/0/${id}.jpg?1` },
          })
        : JSON.stringify({
            object: "card",
            id,
            uri,
            lang: "ja",
            games: ["paper"],
            digital: false,
            released_at: "2020-01-01",
            flavor_text: distinct(128),
          }),
    );
  }
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

/**
 * Drive one hostname-shard Workflow over a captured synthetic archive with a
 * recording step, losing one committed response mid-decode and one
 * mid-normalization. Every archive step must stay within its declared budget,
 * and the retried steps must resume from their cursors without duplicates.
 */
export async function assertArchiveStepStructure(key: string, records: number) {
  const input = syntheticArchive(records);
  const { run, request, snapshot } = await seedArchive(key, false, input);
  const db = catalogueStore(env.CATALOGUE_DB);
  const cursors = async () =>
    (await queries.archiveStepCursors(db).bind(snapshot.id).first<Cursors>()) ?? {
      blocks: 0,
      decode_state: "absent",
      records: 0,
      discovered: 0,
      parse_state: null,
    };
  // Lose each committed response once: first at the decode midpoint, then at
  // the normalization midpoint. The retry must re-derive and verify, not rewrite.
  const expectedBlocks = Math.ceil(records / 1024);
  const faults = [
    (cursor: Cursors) => cursor.decode_state === "decoding" && cursor.blocks >= Math.ceil(expectedBlocks / 2),
    (cursor: Cursors) => cursor.parse_state === "normalizing" && cursor.records >= Math.floor(records / 2),
  ];
  const faulted = new Proxy(env.CATALOGUE_DB, {
    get(target, property) {
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements);
          if (faults.length && faults[0]!(await cursors())) {
            faults.shift();
            throw new Error(lostResponse);
          }
          return result;
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const measured = boundedWorkflowInvocation({ ...env, CATALOGUE_DB: faulted }, {} as WorkflowStep, {
    mode: "immediate",
    budget: Number.POSITIVE_INFINITY,
  });
  const parentId = `evidence-${run.id}`;
  const childId = `evidence-host-archive-structure-${key}`;
  await recordWorkflowIds(db, run.id, parentId, [childId]);
  const steps: { name: string; subrequests: number; before: Cursors; after: Cursors }[] = [];
  const retried: string[] = [];
  const yields: number[] = [];
  const liveSteps: number[] = [];
  const step = {
    async do(name: string, configOrCallback: unknown, possibleCallback?: unknown) {
      const callback = (typeof configOrCallback === "function" ? configOrCallback : possibleCallback) as (
        context: unknown,
      ) => Promise<unknown>;
      for (let attempt = 1; ; attempt++) {
        const before = await cursors();
        const used = measured.usage().subrequests;
        try {
          const result = await callback({ step: { name, count: 1 }, attempt });
          steps.push({ name, subrequests: measured.usage().subrequests - used, before, after: await cursors() });
          return result === undefined ? undefined : structuredClone(result);
        } catch (error) {
          // The engine retries a failed callback; only the injected loss is expected.
          if (!(error instanceof Error) || !error.message.includes(lostResponse) || attempt > 1) throw error;
          retried.push(name);
        }
      }
    },
    async sleep(name: string) {
      if (!name.startsWith("yield Workflow invocation after ")) return;
      yields.push(measured.usage().subrequests);
      liveSteps.push(measured.usage().steps);
    },
    async sleepUntil() {},
  } as unknown as WorkflowStep;
  // Drive the production Workflow body directly; the platform scheduler is
  // covered by the binding tests.
  const workflow = Object.assign(Object.create(EvidenceHostWorkflow.prototype) as EvidenceHostWorkflow, {
    env: measured.env as Env,
  });
  await workflow.run(
    {
      payload: {
        ingestion_run_id: run.id,
        parent_workflow_id: parentId,
        hostname: new URL(request.url).hostname,
        minimum_sequence_number: request.sequence_number,
        maximum_sequence_number: request.sequence_number + 199,
      },
      timestamp: new Date(),
      instanceId: childId,
      workflowName: "card-keepr-evidence-host",
    },
    step,
  );

  // Completion: every raw record crossed exactly once.
  const final = await cursors();
  expect(final).toMatchObject({ decode_state: "decoded", records, parse_state: "complete" });
  expect(await queries.archiveDecodeReceipt(db).bind(snapshot.id).first()).toMatchObject({
    next_block: final.blocks,
    next_record: records,
  });
  expect(await queries.archiveReceiptCoverage(db).bind(snapshot.id).first()).toEqual({
    receipts: records,
    first: 0,
    last: records - 1,
    keys: records,
    selected: Math.ceil(records / 500),
  });
  const pages = await queries
    .archiveRecordPageCoverage(db)
    .bind(snapshot.id)
    .first<{ rows: number; ordinals: number; last: number }>();
  expect(pages!.rows).toBe(pages!.ordinals);
  expect(pages!.last).toBe(pages!.rows - 1);
  expect(final.discovered).toBe(pages!.rows);
  const derived = await env.EVIDENCE_OBJECTS.list({ prefix: `source-derived/${snapshot.id}/` });
  expect(derived.objects).toHaveLength(final.blocks);
  expect(await sha256(input)).toBe(
    (await queries.archiveDecodeDigest(db).bind(snapshot.id).first<{ decoded_digest: string }>())!.decoded_digest,
  );

  // Structure: the archive advanced across many bounded steps. A step spends
  // at most one call of each phase (the call that seals decoding may begin
  // normalizing, and the one that seals normalization may begin discovery).
  expect(retried).toHaveLength(2);
  const archiveSteps = steps.filter(({ name }) => name.startsWith("collect "));
  expect(archiveSteps.length).toBeGreaterThanOrEqual(
    Math.max(
      Math.ceil(final.blocks / archiveDecodeStepBudget.blocks),
      Math.ceil(records / archiveNormalizationStepBudget.records),
    ),
  );
  for (const { name, subrequests, before, after } of steps) {
    expect(subrequests, name).toBeLessThanOrEqual(archiveStepSubrequestCeiling);
    expect(after.blocks - before.blocks, name).toBeLessThanOrEqual(archiveDecodeStepBudget.blocks + 1);
    expect(after.records - before.records, name).toBeLessThanOrEqual(archiveNormalizationStepBudget.records);
    expect(after.discovered - before.discovered, name).toBeLessThanOrEqual(archiveDiscoveryStepBudget.records);
  }
  // Continuations stay inside one shard stage instead of reloading the shard.
  expect(steps.filter(({ name }) => name.startsWith("reload ")).length).toBeLessThanOrEqual(2);
  // The Workflow yields its invocation before the subrequests since the last
  // yield exceed the invocation budget by more than one step.
  const boundaries = [0, ...yields, measured.usage().subrequests];
  for (let index = 1; index < boundaries.length; index++)
    expect(boundaries[index]! - boundaries[index - 1]!).toBeLessThanOrEqual(
      workflowInvocationSubrequestBudget + archiveStepSubrequestCeiling,
    );
  // Archive steps spend CPU, not subrequests, so an engine lifetime is bounded
  // by its live step count too: every invocation runs at most the step budget.
  const lifetimes = [0, ...liveSteps, measured.usage().steps];
  for (let index = 1; index < lifetimes.length; index++)
    expect(lifetimes[index]! - lifetimes[index - 1]!).toBeLessThanOrEqual(workflowInvocationStepBudget);
  return {
    yields: yields.length,
    steps: archiveSteps.length,
    blocks: final.blocks,
    subrequests: measured.usage().subrequests,
    maximumStepSubrequests: Math.max(...steps.map(({ subrequests }) => subrequests)),
  };
}
