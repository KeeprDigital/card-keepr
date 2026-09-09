import { type CataloguePrinting, type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { nativePredecessorGameCandidateStatement } from "./game-candidate-repository";
import { pinnedCardIdentityResolver } from "./identity-correction-pins";
import {
  type NativePrintingMatchKind,
  nativePriorPrintingIdentityMatchesStatement,
  nativePriorPrintingLocatorsStatement,
} from "./native-printing-locators-repository";
import type { NativePrintingIdentity, PriorStatePositions } from "./prior-state-types";
import { reconciliationCheckpoint } from "./reconciliation-checkpoint";
import { documentStorage } from "./reconciliation-document";
import type { PrintingCompatibility } from "./reconciliation-model";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import { exactReducerStateStatement } from "./reconciliation-reducer-state-repository";

export function retainPrintingLocator(
  previous: CataloguePrinting | undefined,
  evidence: NonNullable<CataloguePrinting["locator_evidence"]>[number],
) {
  const locators = [...(previous?.locator_evidence ?? [])];
  if (
    !locators.some(
      (old) =>
        old.source_lineage === evidence.source_lineage &&
        old.locator === evidence.locator &&
        old.variant_key === evidence.variant_key,
    )
  )
    locators.push(evidence);
  locators.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  if (
    locators.length > 128 ||
    locators.some((entry) => entry.locator.length > 32768) ||
    new TextEncoder().encode(canonicalJson(locators)).byteLength > 131072
  )
    throw new Error("reconciliation_capacity_exceeded: one Printing has too much retained locator evidence.");
  return locators;
}

/** Undefined selects legacy lookup; an empty native result must never fall back. */
export async function nativePrintingsAtLocator(
  db: CatalogueStore,
  prior: { preparationId: string; revision: string; game: string; cardId: string; through: number },
  lineage: string,
  locator: string,
): Promise<{ id: string }[] | undefined> {
  const candidate = await documentStorage(() =>
    nativePredecessorGameCandidateStatement(db, prior.revision, prior.game).first<{ id: string }>(),
  );
  if (!candidate) return undefined;
  // Prior-state seeding verifies the exact member's manifest partitions before
  // retaining this immutable, card-indexed view. Read only its completed prefix.
  const group = await sha256Text(prior.cardId);
  const rows = (
    await documentStorage(() =>
      nativePriorPrintingLocatorsStatement(db, prior.preparationId, group, prior.through, lineage, locator).all<{
        key_digest: string;
        observation_ordinal: number;
        byte_length: number;
      }>(),
    )
  ).results;
  if (rows.length > 8 || rows.reduce((total, row) => total + row.byte_length, 0) > 512000)
    throw new Error("reconciliation_capacity_exceeded: one locator exceeds its Printing match budget.");
  const ids = new Set<string>();
  for (const match of rows) {
    const row = await documentStorage(() =>
      exactReducerStateStatement(
        db,
        prior.preparationId,
        "prior_printings",
        match.key_digest,
        match.observation_ordinal,
      ).first<{ content: string; sha256: string }>(),
    );
    if (
      !row ||
      new TextEncoder().encode(row.content).byteLength !== match.byte_length ||
      (await sha256Text(row.content)) !== row.sha256
    )
      throw new Error("Prior Printing locator evidence failed integrity verification.");
    const value = JSON.parse(row.content).value as CataloguePrinting;
    if (value.card_id !== prior.cardId) throw new Error("Prior Printing locator evidence has another Card identity.");
    ids.add(value.id);
  }
  return [...ids].sort().map((id) => ({ id }));
}

/** Copy identity evidence only from the completed, exact native predecessor. */
export async function nativePriorPrintingIdentity(
  db: CatalogueStore,
  preparation: string,
  printing: CataloguePrinting,
): Promise<NativePrintingIdentity | undefined> {
  const checkpoint = await reconciliationCheckpoint<{
    complete: boolean;
    indexes: { localPrintingCompatibility: number };
    prior: PriorStatePositions;
  }>(db, preparation, "official_reduction");
  if (!checkpoint?.value.complete) throw new Error("Native predecessor has no completed identity reduction.");
  const observed = new ReconciliationReducerIndex<{ printingId: string; compatibility: PrintingCompatibility }>(
    db,
    preparation,
    "printing_compatibility",
  );
  observed.resumeAt(checkpoint.value.indexes.localPrintingCompatibility);
  const carried = new ReconciliationReducerIndex<NativePrintingIdentity>(db, preparation, "prior_printing_identities");
  carried.resumeAt(checkpoint.value.prior.priorPrintingIdentities ?? 0);
  const identity = await observed.get(printing.id);
  const compatibility = identity?.compatibility ?? (await carried.get(printing.id))?.compatibility;
  if (!compatibility) {
    if (printing.locator_evidence?.length)
      throw new Error("Native prior Printing compatibility evidence is unavailable.");
    return undefined;
  }
  if (identity && identity.printingId !== printing.id)
    throw new Error("Native prior Printing compatibility has another identity.");
  if (compatibility.card_id !== printing.card_id) {
    const associations = await reconciliationCheckpoint<{ complete: boolean }>(
      db,
      preparation,
      "identity_associations",
    );
    if (!associations?.value.complete) throw new Error("Native prior Printing compatibility has another identity.");
    const corrected = await pinnedCardIdentityResolver(db, preparation);
    let card = compatibility.card_id;
    const visited = new Set<string>();
    for (;;) {
      const next = await corrected.next(card, printing.id);
      if (!next || next === card) break;
      if (visited.size === 32 || visited.has(next))
        throw new Error("Native prior Printing owner correction is cyclic or exceeds its bounded chain.");
      visited.add(card);
      card = next;
    }
    if (card !== printing.card_id) throw new Error("Native prior Printing compatibility has another identity.");
  }
  return { id: printing.id, compatibility, locators: printing.locator_evidence ?? [] };
}

export function nativePrintingLocatorKey(
  locator: Pick<NativePrintingIdentity["locators"][number], "source_lineage" | "locator" | "variant_key">,
) {
  return canonicalJson([locator.source_lineage, locator.locator, locator.variant_key]);
}
export function nativePrintingLocatorStateKey(identity: NativePrintingIdentity) {
  if (identity.locators.length !== 1) throw new Error("One native locator unit must retain exactly one locator.");
  return canonicalJson([identity.id, nativePrintingLocatorKey(identity.locators[0]!)]);
}

type PrintingMatch = PrintingCompatibility & { id: string };
/** An exact native member never consults mutable legacy identity tables. */
export async function nativePrintingMatches(
  db: CatalogueStore,
  prior: { preparationId: string; revision: string; game: string; through: number; locatorThrough: number },
  compatibility: PrintingCompatibility,
  locator: { locator: string; variantKey: string | null; reviewed: boolean },
): Promise<[PrintingMatch | null, PrintingMatch[], PrintingMatch[], PrintingMatch[]] | undefined> {
  if (!(await documentStorage(() => nativePredecessorGameCandidateStatement(db, prior.revision, prior.game).first())))
    return undefined;
  const group = await sha256Text(compatibility.card_id);
  const read = async (kind: NativePrintingMatchKind): Promise<PrintingMatch[]> => {
    const namespace = kind === "locator" ? "prior_printing_locators" : "prior_printing_identities";
    const matchingGroup =
      kind === "locator"
        ? await sha256Text(
            nativePrintingLocatorKey({
              source_lineage: compatibility.source_lineage,
              locator: locator.locator,
              variant_key: locator.variantKey,
            }),
          )
        : group;
    const through = kind === "locator" ? prior.locatorThrough : prior.through;
    const matches = (
      await documentStorage(() =>
        nativePriorPrintingIdentityMatchesStatement(
          db,
          { ...prior, group: matchingGroup, through, namespace },
          compatibility,
          locator,
          kind,
        ).all<{
          key_digest: string;
          observation_ordinal: number;
          byte_length: number;
        }>(),
      )
    ).results;
    if (matches.length > 8 || matches.reduce((total, row) => total + row.byte_length, 0) > 512000)
      throw new Error("reconciliation_capacity_exceeded: one Printing identity match exceeds its candidate budget.");
    const values: PrintingMatch[] = [];
    for (const match of matches) {
      const row = await documentStorage(() =>
        exactReducerStateStatement(
          db,
          prior.preparationId,
          namespace,
          match.key_digest,
          match.observation_ordinal,
        ).first<{ content: string; sha256: string }>(),
      );
      if (
        !row ||
        new TextEncoder().encode(row.content).byteLength !== match.byte_length ||
        (await sha256Text(row.content)) !== row.sha256
      )
        throw new Error("Native prior Printing identity failed integrity verification.");
      const value = JSON.parse(row.content).value as NativePrintingIdentity;
      const key = kind === "locator" ? nativePrintingLocatorStateKey(value) : value.id;
      if (
        (kind !== "locator" && value.compatibility.card_id !== compatibility.card_id) ||
        (await sha256Text(key)) !== match.key_digest
      )
        throw new Error("Native prior Printing match has another identity.");
      values.push({ id: value.id, ...value.compatibility });
    }
    return values.sort((a, b) => a.id.localeCompare(b.id));
  };
  const [located, compatible, appearance, crossSource] = await Promise.all([
    read("locator"),
    locator.reviewed ? [] : read("compatible"),
    locator.reviewed ? [] : read("appearance"),
    locator.reviewed || prior.game === "gundam" ? [] : read("cross_source"),
  ]);
  if (located.length > 1) throw new Error("Native prior locator resolves multiple Printing identities.");
  return [located[0] ?? null, compatible, appearance, crossSource];
}
