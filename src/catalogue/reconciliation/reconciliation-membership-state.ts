import {
  type CatalogueProduct,
  type CatalogueStore,
  type SupportedGame,
  canonicalJson,
  sha256Text,
  StreamingSha256,
} from "../shared";
import { productIdFor } from "./product-release-catalogue";
import { ReconciliationCandidateState } from "./reconciliation-candidate-state";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import type { ReconciliationPlanState } from "./reconciliation-plan-state";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";

type ProductReceipt = {
  id: string;
  value: string;
  hash: StreamingSha256["checkpoint"];
  count: number;
};
type Cursor = {
  input: string;
  stage: "declared_products" | "plans" | "products" | "complete";
  after: string;
  membership: number;
  declared: number;
  products: number;
  result: ReconciliationCandidateState["positions"];
};

/** Derive membership targets before sealing, one retained observation or target per bounded unit. */
export async function prepareMembershipProducts(
  database: CatalogueStore,
  runId: string,
  prior: ReconciliationCandidateState,
  plans: ReconciliationPlanState,
  game: SupportedGame,
  yieldAtCheckpoint: boolean,
) {
  const result = new ReconciliationCandidateState(database, runId, "membership", prior);
  const declared = new ReconciliationReducerIndex<{ id: string; target: string }>(
    database,
    runId,
    "membership_declared_products",
  );
  const products = new ReconciliationReducerIndex<ProductReceipt>(database, runId, "membership_product_receipts");
  const input = await sha256Text(canonicalJson({ game, prior: prior.positions, plans: plans.position }));
  const phase = "membership_preparation";
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, phase);
  const cursor: Cursor = checkpoint?.value ?? {
    input,
    stage: "declared_products",
    after: "",
    membership: 0,
    declared: 0,
    products: 0,
    result: {},
  };
  if (cursor.input !== input) throw new Error("Membership preparation provenance changed.");
  result.resumeAt(cursor.result);
  declared.resumeAt(cursor.declared);
  products.resumeAt(cursor.products);
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  let work = 0;
  let bytes = 0;
  const save = async () => {
    cursor.result = result.positions;
    cursor.declared = declared.position;
    cursor.products = products.position;
    await retainReconciliationCheckpoint(database, runId, phase, ordinal, cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase, ordinal });
    ordinal++;
    work = bytes = 0;
  };
  const before = async (value: unknown) => {
    const size = new TextEncoder().encode(canonicalJson(value)).byteLength;
    if (size > 512000) throw new Error("reconciliation_capacity_exceeded: one membership input exceeds 512 KiB.");
    if (work && bytes + size > 512000) await save();
    bytes += size;
  };
  const tick = async () => {
    if (++work >= 8 || bytes >= 512000) await save();
  };
  const advance = async (stage: Cursor["stage"]) => {
    cursor.stage = stage;
    cursor.after = "";
    await save();
  };
  if (cursor.stage === "declared_products") {
    for await (const product of prior.values("products", cursor.after)) {
      await before(product);
      if (product.game === game && product.membership_evidence === undefined)
        for (const value of new Set([product.official_code, product.name])) {
          if (value === null) continue;
          // Canonical Product order preserves the existing deterministic explicit-target preference.
          if (!(await declared.get(value))) await declared.seed(value, { id: value, target: product.id });
        }
      cursor.after = product.id;
      await tick();
    }
    await advance("plans");
  }
  if (cursor.stage === "plans") {
    for await (const plan of plans.values(cursor.after)) {
      await before(plan);
      if (plan.supportedGame === game && plan.printingId !== null)
        while (cursor.membership < plan.memberships.products.length) {
          const value = plan.memberships.products[cursor.membership]!;
          if (!(await declared.get(value))) {
            const id = await productIdFor(game, { kind: "official_code", value });
            const priorReceipt = await products.get(id);
            const hash = new StreamingSha256(priorReceipt?.hash);
            hash.update(
              new TextEncoder().encode(
                `${canonicalJson([plan.sourceLineage, plan.sourceObservationId, plan.printingId, value])}\n`,
              ),
            );
            await products.seed(id, { id, value, hash: hash.checkpoint, count: (priorReceipt?.count ?? 0) + 1 });
          }
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
    await advance("complete");
  }
  return result;
}
