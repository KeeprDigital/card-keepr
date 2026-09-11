import {
  type CatalogueProduct,
  type CatalogueStore,
  type ProductRelationship,
  type SupportedGame,
  canonicalJson,
  sha256Text,
  StreamingSha256,
  membershipDistributionContextId,
  membershipRelationshipId,
} from "../shared";
import { productIdFor } from "./product-release-catalogue";
import { ReconciliationCandidateState } from "./reconciliation-candidate-state";
import type { ReconciliationPlanState } from "./reconciliation-plan-state";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";

type ProductReceipt = {
  id: string;
  value: string;
  hash: StreamingSha256["checkpoint"];
  count: number;
};
export type MembershipCursor = {
  input: string;
  hasMemberships?: boolean;
  stage:
    | "declared_products"
    | "declared_contexts"
    | "declared_relationships"
    | "plans"
    | "products"
    | "relationships"
    | "complete";
  after: string;
  membership: number;
  declared: number;
  contexts: number;
  declaredRelationships: number;
  relationships: number;
  contextOrigins: number;
  products: number;
  result: ReconciliationCandidateState["positions"];
};

/** Derive membership targets before sealing, one retained observation or target per bounded unit. */
export async function prepareMembershipState(
  database: CatalogueStore,
  runId: string,
  prior: ReconciliationCandidateState,
  evidence: { plans: ReconciliationPlanState; checkedLineages: readonly string[] },
  game: SupportedGame,
  continuation: {
    cursor: MembershipCursor | undefined;
    retain: (cursor: MembershipCursor) => Promise<void>;
  },
) {
  const { plans, checkedLineages } = evidence;
  const checked = new Set(checkedLineages);
  const result = new ReconciliationCandidateState(database, runId, "membership", prior);
  const declared = new ReconciliationReducerIndex<{ id: string; target: string }>(
    database,
    runId,
    "membership_declared_products",
  );
  const products = new ReconciliationReducerIndex<ProductReceipt>(database, runId, "membership_product_receipts");
  const contexts = new ReconciliationReducerIndex<{ id: string; target: string }>(
    database,
    runId,
    "membership_declared_contexts",
  );
  const declaredRelationships = new ReconciliationReducerIndex<{ id: string }>(
    database,
    runId,
    "membership_declared_relationships",
  );
  const relationships = new ReconciliationReducerIndex<ProductRelationship>(
    database,
    runId,
    "membership_relationships",
  );
  const contextOrigins = new ReconciliationReducerIndex<{ id: string; lineage: string }>(
    database,
    runId,
    "membership_context_origins",
  );
  const input = await sha256Text(
    canonicalJson({ game, prior: prior.positions, plans: plans.position, checkedLineages }),
  );
  const cursor: MembershipCursor = continuation.cursor ?? {
    input,
    stage: "declared_products",
    after: "",
    membership: 0,
    declared: 0,
    contexts: 0,
    declaredRelationships: 0,
    relationships: 0,
    contextOrigins: 0,
    products: 0,
    result: {},
  };
  if (cursor.input !== input) throw new Error("Membership preparation provenance changed.");
  // The plan prefix is immutable and bound by input; retain this decision across callbacks.
  const hasMemberships = (cursor.hasMemberships ??= await plans.hasMemberships(game));
  result.resumeAt(cursor.result);
  declared.resumeAt(cursor.declared);
  products.resumeAt(cursor.products);
  contexts.resumeAt(cursor.contexts);
  declaredRelationships.resumeAt(cursor.declaredRelationships);
  relationships.resumeAt(cursor.relationships);
  contextOrigins.resumeAt(cursor.contextOrigins);
  let work = 0;
  let bytes = 0;
  const save = async () => {
    cursor.result = result.positions;
    cursor.declared = declared.position;
    cursor.products = products.position;
    cursor.contexts = contexts.position;
    cursor.declaredRelationships = declaredRelationships.position;
    cursor.relationships = relationships.position;
    cursor.contextOrigins = contextOrigins.position;
    await continuation.retain(cursor);
    work = bytes = 0;
  };
  const before = async (value: unknown) => {
    const size = new TextEncoder().encode(canonicalJson(value)).byteLength;
    if (size > 512000) throw new Error("reconciliation_capacity_exceeded: one membership input exceeds 512 KiB.");
    if (work && bytes + size > 512000) await save();
    bytes += size;
  };
  const tick = async () => {
    if (++work >= 4 || bytes >= 512000) await save();
  };
  const advance = async (stage: MembershipCursor["stage"]) => {
    cursor.stage = stage;
    cursor.after = "";
    await save();
  };
  if (cursor.stage === "declared_products") {
    for await (const product of hasMemberships ? prior.values("products", cursor.after) : []) {
      await before({ id: product.id, game: product.game, official_code: product.official_code, name: product.name });
      if (product.game === game && product.membership_evidence === undefined)
        for (const value of new Set([product.official_code, product.name])) {
          if (value === null) continue;
          // Canonical Product order preserves the existing deterministic explicit-target preference.
          if (!(await declared.get(value))) await declared.seed(value, { id: value, target: product.id });
        }
      cursor.after = product.id;
      await tick();
    }
    await advance("declared_relationships");
  }
  if (cursor.stage === "declared_relationships") {
    for await (const relationship of prior.values("product_relationships", cursor.after)) {
      await before(relationship);
      if (relationship.game === game) {
        if (await isMembershipRelationship(relationship)) {
          const lineage = relationship.source_lineage!;
          if (checked.has(lineage)) await result.set("product_relationships", { ...relationship, observed: false });
          if (
            relationship.kind === "printing-distribution-context" &&
            relationship.to.id ===
              (await membershipDistributionContextId(game, lineage, relationship.relationship_value))
          )
            await contextOrigins.seed(relationship.to.id, { id: relationship.to.id, lineage });
        } else if (hasMemberships) {
          const id = relationshipTargetKey(relationship);
          if (!(await declaredRelationships.get(id))) await declaredRelationships.seed(id, { id });
        }
      }
      cursor.after = relationship.id;
      await tick();
    }
    await advance("declared_contexts");
  }
  if (cursor.stage === "declared_contexts") {
    // Without current memberships, only prior derived contexts need observation updates.
    for await (const context of hasMemberships || contextOrigins.position > 0
      ? prior.values("distribution_contexts", cursor.after)
      : []) {
      await before(context);
      const lineage = (await contextOrigins.get(context.id))?.lineage;
      const inferred =
        lineage !== undefined &&
        context.evidence_category === "derived" &&
        context.id === (await membershipDistributionContextId(game, lineage, context.label));
      if (hasMemberships && context.game === game && !inferred && !(await contexts.get(context.key)))
        await contexts.seed(context.key, { id: context.key, target: context.id });
      if (inferred && checked.has(lineage!))
        await result.set("distribution_contexts", { ...context, observed: false, source_lineages: [] });
      cursor.after = context.id;
      await tick();
    }
    await advance("plans");
  }
  if (cursor.stage === "plans") {
    for await (const plan of hasMemberships ? plans.values(cursor.after) : []) {
      await before({
        sourceLineage: plan.sourceLineage,
        sourceObservationId: plan.sourceObservationId,
        printingId: plan.printingId,
        products: plan.memberships.products,
        contexts: plan.memberships.distribution_contexts,
      });
      if (plan.supportedGame === game && plan.printingId !== null)
        while (cursor.membership < plan.memberships.products.length + plan.memberships.distribution_contexts.length) {
          const product = cursor.membership < plan.memberships.products.length;
          const value = product
            ? plan.memberships.products[cursor.membership]!
            : plan.memberships.distribution_contexts[cursor.membership - plan.memberships.products.length]!;
          const target = await (product ? declared : contexts).get(value);
          const targetId =
            target?.target ??
            (product
              ? await productIdFor(game, { kind: "official_code", value })
              : await membershipDistributionContextId(game, plan.sourceLineage, value));
          const id = await membershipRelationshipId(
            game,
            plan.printingId,
            {
              source_lineage: plan.sourceLineage,
              relationship_kind: product ? "product" : "distribution_context",
              relationship_value: value,
            },
            targetId,
          );
          const relationship: ProductRelationship = {
            id,
            game,
            kind: product ? "printing-product" : "printing-distribution-context",
            from: { type: "printing", id: plan.printingId },
            to: { type: product ? "product" : "distribution_context", id: targetId },
            evidence_category: "derived",
            resolution: "canonical",
            source_lineage: plan.sourceLineage,
            source_observation_ids: [],
            relationship_value: value,
            observed: true,
          };
          const declaredRelationship = await declaredRelationships.get(relationshipTargetKey(relationship));
          if (!declaredRelationship) {
            const previous = await relationships.get(id);
            relationship.source_observation_ids = [
              ...new Set([...(previous?.source_observation_ids ?? []), plan.sourceObservationId]),
            ].sort();
            // A byte-bound continuation precedes every effect of this membership.
            await before(relationship);
          }
          if (product && target === undefined) {
            const id = targetId;
            const priorReceipt = await products.get(id);
            const hash = new StreamingSha256(priorReceipt?.hash);
            hash.update(
              new TextEncoder().encode(
                `${canonicalJson([plan.sourceLineage, plan.sourceObservationId, plan.printingId, value])}\n`,
              ),
            );
            await products.seed(id, { id, value, hash: hash.checkpoint, count: (priorReceipt?.count ?? 0) + 1 });
          }
          if (!product && target === undefined)
            await result.set("distribution_contexts", {
              id: targetId,
              game,
              key: value,
              kind: "other",
              label: value,
              product_id: null,
              evidence_category: "derived",
              observed: true,
              source_lineages: [plan.sourceLineage],
            });
          if (!declaredRelationship) await relationships.seed(id, relationship);
          cursor.membership++;
          await tick();
        }
      cursor.after = plan.sourceObservationId;
      cursor.membership = 0;
      await tick();
    }
    await advance("products");
  }
  if (cursor.stage === "products") {
    for await (const receipt of products.entityValues(cursor.after)) {
      await before(receipt);
      const existing = await prior.get("products", receipt.id);
      const product: CatalogueProduct = existing ?? {
        id: receipt.id,
        reference: { kind: "official_code", value: receipt.value },
        game,
        official_code: receipt.value,
        name: receipt.value,
        releases: [],
        observed: true,
        withdrawal: null,
        included: [],
        provenance: {},
        disagreements: [],
      };
      await result.set("products", {
        ...product,
        observed: true,
        membership_evidence: { sha256: new StreamingSha256(receipt.hash).digestHex(), count: receipt.count },
      });
      cursor.after = receipt.id;
      await tick();
    }
    await advance("relationships");
  }
  if (cursor.stage === "relationships") {
    for await (const relationship of relationships.entityValues(cursor.after)) {
      await before(relationship);
      await result.set("product_relationships", relationship);
      cursor.after = relationship.id;
      await tick();
    }
    await advance("complete");
  }
  return result;
}

function relationshipTargetKey(relationship: ProductRelationship): string {
  return canonicalJson({
    kind: relationship.kind,
    from: relationship.from,
    to: relationship.to,
    source_lineage: relationship.source_lineage ?? null,
  });
}

export async function isMembershipRelationship(relationship: ProductRelationship): Promise<boolean> {
  if (
    relationship.evidence_category !== "derived" ||
    relationship.source_lineage === undefined ||
    relationship.from.type !== "printing"
  )
    return false;
  const kind =
    relationship.kind === "printing-product"
      ? "product"
      : relationship.kind === "printing-distribution-context"
        ? "distribution_context"
        : null;
  return (
    kind !== null &&
    relationship.id ===
      (await membershipRelationshipId(
        relationship.game,
        relationship.from.id,
        {
          source_lineage: relationship.source_lineage,
          relationship_kind: kind,
          relationship_value: relationship.relationship_value,
        },
        relationship.to.id,
      ))
  );
}
