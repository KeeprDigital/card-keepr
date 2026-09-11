import { type CatalogueCard, type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { canonicalValueDigest } from "./reconciliation-preparation";
import { ReconciliationReducerIndex, ReconciliationReducerStorageError } from "./reconciliation-reducer-state";
import {
  nextReducerCardReferenceStatement,
  unknownCardReferencePresentStatement,
} from "./reconciliation-reducer-state-repository";

type CardReference = { id: string; identity_kind: CatalogueCard["official_identity"]["kind"] };
type MatchReference = CardReference & { match_digest: string };

/** Identity searches return references; complete Card facts are read one at a time. */
export class ReconciliationCardState {
  private cards: ReconciliationReducerIndex<CatalogueCard>;
  private facts: ReconciliationReducerIndex<MatchReference>;
  private unknownReferences: boolean | undefined;
  private absentOfficialIdentities = new Set<string>();
  constructor(
    private database: CatalogueStore,
    private runId: string,
    private namespace: string,
  ) {
    this.cards = new ReconciliationReducerIndex(database, runId, namespace, (card) =>
      canonicalJson([card.game, card.official_identity]),
    );
    this.facts = new ReconciliationReducerIndex(
      database,
      runId,
      `${namespace}_matches`,
      (reference) => reference.match_digest,
    );
  }
  get position() {
    return this.cards.position;
  }
  resumeAt(position: number) {
    this.unknownReferences = undefined;
    this.absentOfficialIdentities.clear();
    this.cards.resumeAt(position);
    this.facts.resumeAt(position);
  }
  beginObservation() {
    this.cards.beginObservation();
    this.facts.beginObservation();
  }
  async seed(card: CatalogueCard) {
    this.beginObservation();
    await this.set(card.id, card);
  }
  async get(id: string) {
    return this.cards.get(id);
  }
  async has(id: string) {
    return this.cards.has(id);
  }
  async set(
    id: string,
    card: CatalogueCard,
    comparison?: { index: ReconciliationReducerIndex<string>; value: string },
  ) {
    await this.cards.setAlongside(
      id,
      card,
      {
        index: this.facts,
        key: id,
        value: { id, identity_kind: card.official_identity.kind, match_digest: await factsDigest(card) },
      },
      comparison ? { ...comparison, key: id } : undefined,
    );
    if (card.official_identity.kind === "unknown") this.unknownReferences = true;
    this.absentOfficialIdentities.delete(canonicalJson([card.game, card.official_identity]));
  }
  entityValues(after = "") {
    return this.cards.entityValues(after);
  }
  values() {
    return this.cards.latestValues();
  }
  sameOfficialIdentity(game: string, identity: CatalogueCard["official_identity"], includeCurrent = false) {
    const key = canonicalJson([game, identity]);
    return !includeCurrent && this.absentOfficialIdentities.has(key) ? Promise.resolve([]) : this.references(this.namespace, key, includeCurrent);
  }
  /** Only cache proven absences in this small input window; writes invalidate the affected identity. */
  async prefetchOfficialIdentities(cards: readonly Pick<CatalogueCard, "game" | "official_identity">[]) {
    if (cards.length > 8) throw new Error("Card identity lookup window exceeds eight records.");
    this.absentOfficialIdentities.clear();
    const keys = [...new Set(cards.filter((card) => card.official_identity.kind !== "unknown").map((card) => canonicalJson([card.game, card.official_identity])))];
    if (!this.cards.position) {
      this.absentOfficialIdentities = new Set(keys);
      return;
    }
    if (!keys.length) return;
    const statements = [];
    for (const key of keys) statements.push(nextReducerCardReferenceStatement(this.database, this.runId, this.namespace, await sha256Text(key), this.cards.position + 1, "", false));
    try {
      const results = await this.database.batch(statements);
      for (const [index, key] of keys.entries()) {
        if (!results[index]) throw new Error("Card identity lookup window is incomplete.");
        if (!results[index]!.results.length) this.absentOfficialIdentities.add(key);
      }
    } catch (cause) {
      throw new ReconciliationReducerStorageError(cause);
    }
  }
  async sameFacts(card: Omit<CatalogueCard, "id">, unknownOnly: boolean): Promise<CardReference[]> {
    if (unknownOnly) {
      if (this.unknownReferences === undefined) {
        try {
          this.unknownReferences =
            (await unknownCardReferencePresentStatement(
              this.database,
              this.runId,
              `${this.namespace}_matches`,
              this.cards.position,
            ).first()) !== null;
        } catch (cause) {
          throw new ReconciliationReducerStorageError(cause);
        }
      }
      // Known-only writes preserve absence as the observation cursor advances.
      // Resume discards the flag, and an unnumbered write makes it conservative.
      if (!this.unknownReferences) return [];
    }
    const references = await this.references(`${this.namespace}_matches`, await factsDigest(card), false, unknownOnly);
    const matches: CardReference[] = [];
    for (const reference of references) {
      if (unknownOnly && reference.identity_kind !== "unknown") continue;
      const retained = await this.get(reference.id);
      if (
        retained &&
        retained.game === card.game &&
        retained.name === card.name &&
        retained.effective_rules_text === card.effective_rules_text &&
        canonicalJson(retained.game_data) === canonicalJson(card.game_data)
      )
        matches.push(reference);
    }
    return matches;
  }
  private async references(
    namespace: string,
    group: string,
    includeCurrent: boolean,
    unknownOnly = false,
  ): Promise<CardReference[]> {
    const digest = await sha256Text(group);
    let after = "";
    let bytes = 0;
    const references: (CardReference & { first_ordinal: number })[] = [];
    for (;;) {
      let row: {
        key_digest: string;
        id: string;
        identity_kind: CardReference["identity_kind"];
        first_ordinal: number;
      } | null;
      try {
        row = await nextReducerCardReferenceStatement(
          this.database,
          this.runId,
          namespace,
          digest,
          this.cards.position + (includeCurrent ? 1 : 0),
          after,
          unknownOnly,
        ).first<typeof row>();
      } catch (cause) {
        throw new ReconciliationReducerStorageError(cause);
      }
      if (!row) break;
      bytes += new TextEncoder().encode(canonicalJson(row)).byteLength;
      if (references.length === 8 || bytes > 512000)
        throw new Error("reconciliation_capacity_exceeded: one Card identity has too many candidates.");
      references.push({
        id: row.id,
        identity_kind: row.identity_kind,
        first_ordinal: row.first_ordinal,
      });
      after = row.key_digest;
    }
    return references
      .sort((left, right) => left.first_ordinal - right.first_ordinal || left.id.localeCompare(right.id))
      .map(({ first_ordinal: _ordinal, ...reference }) => reference);
  }
}

function factsDigest(card: Omit<CatalogueCard, "id">): Promise<string> {
  return canonicalValueDigest([card.game, card.name, card.effective_rules_text, card.game_data]);
}
