import { canonicalRecordSource } from "./reconciliation-canonical-digest";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import type { ReconciliationInputRecordCursor } from "./reconciliation-input";
import type { ReconciliationRecordSink } from "./reconciliation-record-collection";
import type {
  CatalogueStore,
  CatalogueDraftEntity,
  CatalogueEntityCollection,
  CatalogueProduct,
  CatalogueDistributionContext,
  ProductRelationship,
  ProductSourceObservation,
  SupportedGame,
} from "../shared";
import { ReconciliationCandidateState } from "./reconciliation-candidate-state";
import { canonicalValueChunks } from "./reconciliation-preparation";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import { prepareMembershipState, type MembershipCursor } from "./reconciliation-membership-state";
import type { ReconciliationPlanState } from "./reconciliation-plan-state";
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

/** Fresh inputs can share a predecessor lookup, with bounded hydrated data and effects. */
async function* productInputBatches(source: AsyncIterable<ProductInputEntry>, game: SupportedGame, fresh: boolean) {
  type Entry = { entry: ProductInputEntry; parsed: Awaited<ReturnType<typeof parseProductReleaseObservation>> | null };
  let batch: Entry[] = [];
  let bytes = 0;
  let effects = 0;
  for await (const entry of source) {
    const parsed = entry.input === null ? null : await parseProductReleaseObservation(entry.input, game);
    const size = new TextEncoder().encode(JSON.stringify([entry.input, parsed])).byteLength;
    const count = parsed ? parsed.products.length + parsed.distributionContexts.length : 0;
    if (batch.length && (!fresh || batch.length === 8 || bytes + size > 131072 || effects + count > 16)) {
      yield batch;
      batch = [];
      bytes = effects = 0;
    }
    batch.push({ entry, parsed });
    bytes += size;
    effects += count;
  }
  if (batch.length) yield batch;
}
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
  | "memberships"
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
  membership?: MembershipCursor;
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
  options: {
    hasInputs: boolean;
    yieldAtCheckpoint: boolean;
    membershipEvidence?: { plans: ReconciliationPlanState; checkedLineages: readonly string[] };
  },
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
  let membership = checkpoint?.value.membership;
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  const checkedLineages = new Set<string>(checkpoint?.value.checkedLineages);
  if (checkpoint) {
    result.resumeAt(checkpoint.value.result);
    for (const [name, retained] of Object.entries(indexes)) retained.resumeAt(checkpoint.value.indexes[name]!);
    warnings.resumeAt(checkpoint.value.warnings);
  }
  let flushResults = async () => {};
  const save = async () => {
    await flushResults();
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
      ...(membership === undefined ? {} : { membership }),
    } satisfies ProductCursor);
    if (options.yieldAtCheckpoint) throw new ReconciliationContinuation({ phase, ordinal });
    ordinal++;
  };
  if (!checkpoint) await save();
  let records = 0;
  let bytes = 0;
  let inputEffects = 0;
  const fresh = () => priorProductCount === 0 && priorContexts.position === 0 && priorRelationships.position === 0;
  const recordLimit = () => {
    if (stage === "inputs") return fresh() ? 16 : 4;
    if (stage === "existing_products") return 8;
    if (stage === "new_products" && priorProductCount === 0) return 128;
    if (stage === "new_contexts" && priorContexts.position === 0) return 128;
    if (stage === "new_relationships" && priorRelationships.position === 0) return 128;
    return 16;
  };
  const effectLimit = () => (fresh() ? 32 : 4);
  const finishRecord = async () => {
    if (records >= recordLimit() || bytes >= 512000 || inputEffects >= effectLimit()) {
      await save();
      records = bytes = inputEffects = 0;
    }
  };
  const budget = async (size: number, effects = 0) => {
    const limit = recordLimit();
    if (effects > (fresh() ? 24 : 8))
      throw new Error("reconciliation_capacity_exceeded: one Product input has too many effects.");
    if (records > 0 && (records >= limit || bytes + size > 512000 || inputEffects + effects > effectLimit())) {
      await save();
      records = 0;
      bytes = 0;
      inputEffects = 0;
    }
    inputEffects += effects;
    records++;
    bytes += size;
  };
  const consume = async <T extends { id: string }>(values: AsyncIterable<T>, action: (value: T) => Promise<void>) => {
    for await (const value of values) {
      await budget(new TextEncoder().encode(JSON.stringify(value)).byteLength);
      await action(value);
      after = value.id;
      await finishRecord();
    }
  };
  const consumeNew = async <T extends { id: string }, K extends CatalogueEntityCollection>(
    values: AsyncIterable<T>,
    kind: K,
    transform: (value: T) => Promise<CatalogueDraftEntity<K> | undefined>,
  ) => {
    let pending: CatalogueDraftEntity<K>[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (pending.length) await result.setMany(kind, pending);
      pending = [];
      pendingBytes = 0;
    };
    flushResults = flush;
    try {
      await consume(values, async (value) => {
        const entity = await transform(value);
        if (!entity) return;
        const size = new TextEncoder().encode(JSON.stringify(entity)).byteLength;
        if (pending.length && pendingBytes + size > 262144) await flush();
        pending.push(entity);
        pendingBytes += size;
        if (pending.length === 16) await flush();
      });
      await flush();
    } finally {
      flushResults = async () => {};
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
    inputEffects = 0;
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
    for await (const batch of productInputBatches(inputs(inputAfter), game, fresh())) {
      const productKeys = batch.flatMap(({ parsed }) => parsed?.products.map(({ id }) => id) ?? []);
      const contextKeys = batch.flatMap(({ parsed }) => parsed?.distributionContexts.map(({ id }) => id) ?? []);
      const canBatch = fresh() && productKeys.length + contextKeys.length <= 16;
      const productWindow = canBatch ? await groups.getMany(productKeys) : null;
      const contextWindow = canBatch ? await contexts.getMany(contextKeys) : null;
      let productWrites: { key: string; value: ProductGroup }[] = [];
      let contextWrites: { key: string; value: CatalogueDistributionContext }[] = [];
      let writeBytes = 0;
      const flush = async () => {
        await groups.seedManyAlongside(productWrites, { index: contexts, entries: contextWrites });
        productWrites = [];
        contextWrites = [];
        writeBytes = 0;
      };
      flushResults = flush;
      try {
      for (const { entry, parsed } of batch) {
      const input = entry.input;
      if (input !== null && parsed !== null) {
        await budget(
          entry.byteLength,
          parsed.products.length +
            parsed.distributionContexts.length +
            parsed.relationships.length +
            parsed.warnings.length,
        );
        if (input.value !== undefined) checkedLineages.add(input.sourceLineage);
        // Identity matching needs only candidates with the same normalized name or official code.
        let matchingVisits = 0;
        const observation = await preservePublishedProductIdentity(
          parsed,
          async (product) => {
            if (priorProductCount === 0) return [];
            const matches = new Map<string, CatalogueProduct>();
            const add = async (match: CatalogueProduct) => {
              if (++matchingVisits > 16)
                throw new Error(
                  "reconciliation_capacity_exceeded: one Product input requires too many identity visits.",
                );
              if (matches.has(match.id)) return;
              if (matches.size === 8)
                throw new Error("reconciliation_capacity_exceeded: one Product identity has too many candidates.");
              await assertProductGroupBudget([...matches.values(), match]);
              matches.set(match.id, match);
            };
            for await (const match of names.matchingBeforeObservation(normalizedProductName(product.name) ?? "", {
              records: 8,
              bytes: 512000,
            }))
              await add(match);
            if (product.officialCode !== null) {
              for await (const match of codes.matchingBeforeObservation(product.officialCode, {
                records: 8,
                bytes: 512000,
              }))
                await add(match);
            }
            return [...matches.values()];
          },
          game,
        );
        await warnings.push(...observation.warnings);
        for (
          let index = 0;
          index < Math.max(observation.products.length, observation.distributionContexts.length);
          index++
        ) {
          const product = observation.products[index];
          const context = observation.distributionContexts[index];
          const [previousProduct, previousContext] =
            productWindow && contextWindow
              ? [product ? productWindow.get(product.id) : undefined, context ? contextWindow.get(context.id) : undefined]
              : product && context
              ? await groups.getAlongside(product.id, { index: contexts, key: context.id })
              : [
                  product ? await groups.get(product.id) : undefined,
                  context ? await contexts.get(context.id) : undefined,
                ];
          const group = product
            ? { id: product.id, observations: [...(previousProduct?.observations ?? []), product] }
            : undefined;
          if (group) await assertProductGroupBudget(group.observations);
          const merged = context
            ? aggregateContexts(previousContext ? [previousContext, context] : [context])[0]!
            : undefined;
          if (productWindow && contextWindow) {
            const size = new TextEncoder().encode(JSON.stringify([group, merged])).byteLength;
            if (writeBytes && writeBytes + size > 131072) await flush();
            if (size > 131072) {
              if (group) await groups.seed(group.id, group);
              if (merged) await contexts.seed(merged.id, merged);
            } else {
              if (group) productWrites.push({ key: group.id, value: group });
              if (merged) contextWrites.push({ key: merged.id, value: merged });
              writeBytes += size;
            }
            if (group) productWindow.set(group.id, group);
            if (merged) contextWindow.set(merged.id, merged);
          } else if (group && merged) {
            groups.beginObservation();
            contexts.beginObservation();
            await groups.setAlongside(group.id, group, { index: contexts, key: merged.id, value: merged });
          } else if (group) await groups.seed(group.id, group);
          else if (merged) await contexts.seed(merged.id, merged);
        }
        for (const relationship of observation.relationships) {
          const previous = await relationships.get(relationship.id);
          const merged = aggregateRelationships(previous ? [previous, relationship] : [relationship])[0]!;
          await relationships.seed(relationship.id, merged);
        }

        processedInputs++;
      } else await budget(entry.byteLength);
      inputAfter = entry.cursor;
      await finishRecord();
      }
      await flush();
      } finally {
        flushResults = async () => {};
      }
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
    await consumeNew(groups.entityValues(after), "products", async (group) => {
      if (priorProductCount > 0 && (await names.has(group.id))) return;
      return resolveProduct(group.observations, game);
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
    await consumeNew(contexts.entityValues(after), "distribution_contexts", async (context) => {
      if (!(await priorContexts.has(context.id))) return { ...context, observed: true };
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
  await runStage("new_relationships", options.membershipEvidence ? "memberships" : "complete", async () => {
    await consumeNew(relationships.entityValues(after), "product_relationships", async (relationship) => {
      if (!(await priorRelationships.has(relationship.id))) return relationship;
    });
  });
  let draft = result;
  if (options.membershipEvidence && (stage === "memberships" || stage === "complete")) {
    draft = await prepareMembershipState(database, runId, result, options.membershipEvidence, game, {
      cursor: membership,
      retain: async (cursor) => {
        membership = cursor;
        await save();
      },
    });
    if (stage === "memberships") {
      stage = "complete";
      await save();
    }
  }
  return {
    draft,
    observedProducts,
    productSurfaceObserved,
    checkedLineages: [...checkedLineages],
  };
}

async function assertProductGroupBudget(values: readonly unknown[]): Promise<void> {
  let bytes = 0;
  if (values.length > 500)
    throw new Error("reconciliation_capacity_exceeded: one Product has too many evidence records.");
  for (const chunk of canonicalValueChunks(values)) {
    bytes += new TextEncoder().encode(chunk).byteLength;
    if (bytes > 1048576) throw new Error("reconciliation_capacity_exceeded: one Product evidence group exceeds 1 MiB.");
  }
}
