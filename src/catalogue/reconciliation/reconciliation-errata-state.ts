import { type CatalogueErratum, type CatalogueStore, canonicalJson } from "../shared";
import { mergeCatalogueErrata } from "./errata-rules-text";
import { canonicalValueChunks } from "./reconciliation-preparation";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";

/** Immutable Errata merge independently; rules-text derivation reads only one Card's group. */
export class ReconciliationErrataState {
  private populated = false;
  private readonly index: ReconciliationReducerIndex<CatalogueErratum>;

  constructor(database: CatalogueStore, runId: string, namespace: string) {
    this.index = new ReconciliationReducerIndex(database, runId, namespace, (erratum) =>
      canonicalJson([erratum.game, erratum.target_type, erratum.target_id]),
    );
  }

  get position() {
    return this.index.position;
  }
  resumeAt(position: number) {
    this.index.resumeAt(position);
    this.populated = position > 0;
  }

  async merge(erratum: CatalogueErratum): Promise<void> {
    const previous = await this.index.get(erratum.id);
    const merged = mergeCatalogueErrata(previous ? [previous] : [], [erratum])[0]!;
    await assertErrataGroupBudget([merged]);
    await this.index.seed(erratum.id, merged);
    this.populated = true;
  }

  has(id: string): Promise<boolean> {
    return this.populated ? this.index.has(id) : Promise.resolve(false);
  }
  values(): AsyncIterable<CatalogueErratum> {
    return this.index.entityValues();
  }

  async forCard(game: string, cardId: string): Promise<CatalogueErratum[]> {
    if (!this.populated) return [];
    this.index.beginObservation();
    const result: CatalogueErratum[] = [];
    let bytes = 0;
    for await (const erratum of this.index.matchingBeforeObservation(canonicalJson([game, "card", cardId]))) {
      bytes += await erratumBytes(erratum);
      if (result.length === 500 || bytes > 1048576)
        throw new Error("reconciliation_capacity_exceeded: one Card's retained Errata exceed their work budget.");
      result.push(erratum);
    }
    return result;
  }
}

async function erratumBytes(erratum: CatalogueErratum): Promise<number> {
  let bytes = 0;
  for (const chunk of canonicalValueChunks(erratum)) bytes += new TextEncoder().encode(chunk).byteLength;
  return bytes;
}

async function assertErrataGroupBudget(errata: readonly CatalogueErratum[]): Promise<void> {
  for (const erratum of errata) {
    if (erratum.provenance.length > 500 || (await erratumBytes(erratum)) > 1048576)
      throw new Error("reconciliation_capacity_exceeded: one Erratum exceeds its evidence budget.");
  }
}
