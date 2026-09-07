import { canonicalRecordSource } from "./reconciliation-canonical-digest";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import type { ReconciliationInputRecordCursor } from "./reconciliation-input";
import type { ReconciliationRecordSink } from "./reconciliation-record-collection";
import type {
  CatalogueStore,
  CatalogueProduct,
  CatalogueDistributionContext,
  ProductRelationship,
  ProductSourceObservation,
  SupportedGame,
} from "../shared";
import { ReconciliationCandidateState } from "./reconciliation-candidate-state";
import { canonicalValueChunks } from "./reconciliation-preparation";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import {
  type ProductReleaseEvidenceInput,
  aggregateContexts,
  aggregateRelationships,
  normalizedProductName,
  parseProductReleaseObservation,
  preservePublishedProductIdentity,
  resolveProduct,
  sourceObservationsForProduct,
} from "./product-release-catalogue";

type ProductGroup = { id: string; observations: ProductSourceObservation[] };
export type ProductInputEntry = {
  input: ProductReleaseEvidenceInput | null;
  cursor: ReconciliationInputRecordCursor;
  byteLength: number;
};
type Stage =
  | "prior_products"
  | "prior_contexts"
  | "prior_relationships"
  | "inputs"
  | "existing_products"
  | "new_products"
  | "existing_contexts"
  | "new_contexts"
  | "existing_relationships"
  | "new_relationships"
  | "complete";
type ProductCursor = {
  stage: Stage;
  after: string;
  inputAfter: ReconciliationInputRecordCursor | null;
  result: ReconciliationCandidateState["positions"];
  indexes: Record<string, number>;
  checkedLineages: string[];
  warnings: { position: number; count: number };
  processedInputs: number;
  priorProductCount: number;
};

/** Each Product's evidence is reduced separately; source-wide observations are never collected in memory. */
export async function reconcileProductReleaseState(
  database: CatalogueStore,
  runId: string,
  prior: ReconciliationCandidateState,
  inputs: (after: ReconciliationInputRecordCursor | null) => AsyncIterable<ProductInputEntry>,
  game: SupportedGame,
  warnings: ReconciliationRecordSink<Record<string, unknown>> & {
    readonly cursor: { position: number; count: number };
    resumeAt(cursor: { position: number; count: number }): void;
  },
  options: { hasInputs: boolean; yieldAtCheckpoint: boolean },
) {
  const result = new ReconciliationCandidateState(database, runId, `product_result_${game}`, prior);
  const index = <T>(name: string, group?: (value: T) => string) =>
    new ReconciliationReducerIndex<T>(database, runId, `${name}_${game}`, group);
  const names = index<CatalogueProduct>("prior_product_names", (product) => normalizedProductName(product.name) ?? "");
  const codes = index<CatalogueProduct>("prior_product_codes", (product) => product.official_code ?? "");
  const priorContexts = index<CatalogueDistributionContext>("prior_product_contexts");
  const priorRelationships = index<ProductRelationship>("prior_product_relationships");
  const groups = index<ProductGroup>("product_observations");
  const contexts = index<CatalogueDistributionContext>("product_contexts");
  const relationships = index<ProductRelationship>("product_relationships");
  const phase = `product_reduction:${game}` as const;
  const checkpoint = await reconciliationCheckpoint<ProductCursor>(database, runId, phase);
  const indexes = { names, codes, priorContexts, priorRelationships, groups, contexts, relationships };
  let stage: Stage = checkpoint?.value.stage ?? "prior_products";
  let after = checkpoint?.value.after ?? "";
  let inputAfter = checkpoint?.value.inputAfter ?? null;
  let processedInputs = checkpoint?.value.processedInputs ?? 0;
  let priorProductCount = checkpoint?.value.priorProductCount ?? 0;
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  const checkedLineages = new Set<string>(checkpoint?.value.checkedLineages);
  if (checkpoint) {
    result.resumeAt(checkpoint.value.result);
    for (const [name, retained] of Object.entries(indexes)) retained.resumeAt(checkpoint.value.indexes[name]!);
    warnings.resumeAt(checkpoint.value.warnings);
  }
  const save = async () => {
    await retainReconciliationCheckpoint(database, runId, phase, ordinal, {
      stage,
      after,
      inputAfter,
      result: result.positions,
      indexes: Object.fromEntries(Object.entries(indexes).map(([name, retained]) => [name, retained.position])),
      checkedLineages: [...checkedLineages],
      warnings: warnings.cursor,
      processedInputs,
      priorProductCount,
    } satisfies ProductCursor);
    if (options.yieldAtCheckpoint) throw new ReconciliationContinuation({ phase, ordinal });
    ordinal++;
  };
  if (!checkpoint) await save();
  let records = 0;
  let bytes = 0;
  const budget = async (size: number) => {
    const limit = stage === "inputs" || stage === "existing_products" ? 8 : 16;
    if (records > 0 && (records >= limit || bytes + size > 512000)) {
      await save();
      records = 0;
      bytes = 0;
    }
    records++;
    bytes += size;
  };
  const consume = async <T extends { id: string }>(values: AsyncIterable<T>, action: (value: T) => Promise<void>) => {
    for await (const value of values) {
      await budget(new TextEncoder().encode(JSON.stringify(value)).byteLength);
      await action(value);
      after = value.id;
    }
  };
  const runStage = async (expected: Stage, next: Stage, action: () => Promise<void>) => {
    if (stage !== expected) return;
    await action();
    stage = next;
    after = "";
    inputAfter = null;
    await save();
    records = 0;
    bytes = 0;
  };
  await runStage("prior_products", "prior_contexts", async () => {
    await consume(prior.values("products", after), async (product) => {
      if (product.game !== game) return;
      await names.seed(product.id, product);
      await codes.seed(product.id, product);
      priorProductCount++;
    });
    names.beginObservation();
    codes.beginObservation();
  });
  await runStage("prior_contexts", "prior_relationships", async () => {
    await consume(prior.values("distribution_contexts", after), (context) => priorContexts.seed(context.id, context));
  });
  await runStage("prior_relationships", "inputs", async () => {
    await consume(prior.values("product_relationships", after), (relationship) =>
      priorRelationships.seed(relationship.id, relationship),
    );
  });
  await runStage("inputs", "existing_products", async () => {
    if (!options.hasInputs) return;
    for await (const entry of inputs(inputAfter)) {
      await budget(entry.byteLength);
      const input = entry.input;
      if (input !== null) {
        if (input.value !== undefined) checkedLineages.add(input.sourceLineage);
        const parsed = await parseProductReleaseObservation(input, game);
        // Identity matching needs only candidates with the same normalized name or official code.
        const observation = await preservePublishedProductIdentity(
          parsed,
          async (product) => {
            if (priorProductCount === 0) return [];
            const matches = new Map<string, CatalogueProduct>();
            const add = async (match: CatalogueProduct) => {
              if (matches.has(match.id)) return;
              await assertProductGroupBudget([...matches.values(), match]);
              matches.set(match.id, match);
            };
            for await (const match of names.matchingBeforeObservation(normalizedProductName(product.name) ?? ""))
              await add(match);
            if (product.officialCode !== null) {
              for await (const match of codes.matchingBeforeObservation(product.officialCode)) await add(match);
            }
            return [...matches.values()];
          },
          game,
        );
        await warnings.push(...observation.warnings);
        for (const product of observation.products) {
          const previous = await groups.get(product.id);
          const observations = [...(previous?.observations ?? []), product];
          await assertProductGroupBudget(observations);
          await groups.seed(product.id, { id: product.id, observations });
        }
        for (const context of observation.distributionContexts) {
          const previous = await contexts.get(context.id);
          const merged = aggregateContexts(previous ? [previous, context] : [context])[0]!;
          await contexts.seed(context.id, merged);
        }
        for (const relationship of observation.relationships) {
          const previous = await relationships.get(relationship.id);
          const merged = aggregateRelationships(previous ? [previous, relationship] : [relationship])[0]!;
          await relationships.seed(relationship.id, merged);
        }

        processedInputs++;
      }
      inputAfter = entry.cursor;
    }
  });
  const productSurfaceObserved = checkedLineages.size > 0;
  const observedProducts = canonicalRecordSource(async function* (after) {
    for await (const product of groups.entityValues(after)) yield { key: product.id, value: product.id };
  });
  await runStage("existing_products", "new_products", async () => {
    await consume(prior.values("products", after), async (product) => {
      if (product.game !== game) {
        return;
      }
      const current = await groups.get(product.id);
      const retained = sourceObservationsForProduct(product);
      const observations = [
        ...retained.filter(({ evidence }) => !checkedLineages.has(evidence.source)),
        ...(current?.observations ?? []),
      ];
      await assertProductGroupBudget(observations);
      const resolved = observations.length > 0 ? resolveProduct(observations, game) : product;
      const productResult = { ...resolved, observed: current !== undefined };
      await result.set("products", productResult);
      if (!current && productSurfaceObserved && retained.some(({ evidence }) => checkedLineages.has(evidence.source))) {
        await warnings.push({
          code: "product_not_observed",
          game: product.game,
          product_id: product.id,
          source_lineages: retained
            .map(({ evidence }) => evidence.source)
            .filter((lineage) => checkedLineages.has(lineage))
            .sort(),
          detail: "The Product was not observed in this complete run; it remains historical and is not withdrawn.",
        });
      }
    });
  });
  await runStage("new_products", "existing_contexts", async () => {
    await consume(groups.entityValues(after), async (group) => {
      if (priorProductCount > 0 && (await names.has(group.id))) return;
      const product = resolveProduct(group.observations, game);
      await result.set("products", product);
    });
  });
  await runStage("existing_contexts", "new_contexts", async () => {
    await consume(prior.values("distribution_contexts", after), async (context) => {
      let preserved = context;
      if (context.game === game && productSurfaceObserved && context.source_lineages !== undefined) {
        const lineages = context.source_lineages.filter((lineage) => !checkedLineages.has(lineage));
        preserved = { ...context, source_lineages: lineages, ...(lineages.length === 0 ? { observed: false } : {}) };
      }
      const current = await contexts.get(context.id);
      const merged = aggregateContexts(current ? [preserved, current] : [preserved])[0]!;
      await result.set("distribution_contexts", {
        ...merged,
        observed: current !== undefined || (merged.source_lineages?.length ?? 0) > 0,
      });
    });
  });
  await runStage("new_contexts", "existing_relationships", async () => {
    await consume(contexts.entityValues(after), async (context) => {
      if (!(await priorContexts.has(context.id)))
        await result.set("distribution_contexts", { ...context, observed: true });
    });
  });
  await runStage("existing_relationships", "new_relationships", async () => {
    await consume(prior.values("product_relationships", after), async (relationship) => {
      const current = await relationships.get(relationship.id);
      if (current) {
        await result.set("product_relationships", current);
        return;
      }
      if (relationship.evidence_category === "curated") {
        await result.delete("product_relationships", relationship.id);
        return;
      }
      await result.set("product_relationships", {
        ...relationship,
        observed:
          relationship.game === game &&
          productSurfaceObserved &&
          relationship.source_lineage !== undefined &&
          checkedLineages.has(relationship.source_lineage)
            ? false
            : relationship.observed,
      });
    });
  });
  await runStage("new_relationships", "complete", async () => {
    await consume(relationships.entityValues(after), async (relationship) => {
      if (!(await priorRelationships.has(relationship.id))) await result.set("product_relationships", relationship);
    });
  });
  return {
    draft: result,
    observedProducts,
    productSurfaceObserved,
    checkedLineages: [...checkedLineages],
  };
}

async function assertProductGroupBudget(values: readonly unknown[]): Promise<void> {
  let bytes = 0;
  if (values.length > 500)
    throw new Error("reconciliation_capacity_exceeded: one Product has too many evidence records.");
  for await (const chunk of canonicalValueChunks(values)) {
    bytes += new TextEncoder().encode(chunk).byteLength;
    if (bytes > 1048576) throw new Error("reconciliation_capacity_exceeded: one Product evidence group exceeds 1 MiB.");
  }
}
