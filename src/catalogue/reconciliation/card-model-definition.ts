import {
  AdministrationProblem,
  type CatalogueStore,
  type CatalogueCard,
  type CataloguePrinting,
  type CatalogueDraft,
  canonicalProfileAttributes,
  derivedCardModel,
  decodeDocument,
} from "../shared";
import { candidateCardModelStatement } from "./game-candidate-repository";

/** Pending work cannot reuse a receipt produced under an earlier definition. */
export async function assertCurrentCardModel(db: CatalogueStore, candidateId: string) {
  if (!(await candidateCardModelStatement(db, candidateId).first()))
    throw new AdministrationProblem(
      409,
      "reconciliation_definition_changed",
      "This candidate predates Card categories. Abandon it, collect/reconcile fresh evidence and approve the whole new candidate.",
    );
}

/** Checked during the existing bounded sealing scan, after curated/identity work. */
export async function validateCardModelRecord(
  kind: "cards" | "printings",
  value: CatalogueCard | CataloguePrinting,
  draft: Pick<CatalogueDraft, "get">,
) {
  const invalid = () =>
    new AdministrationProblem(
      409,
      "candidate_card_model_invalid",
      "Card categories, gameplay applicability and evidenced relationships must resolve before sealing.",
    );
  if (kind === "cards") {
    const card = decodeDocument<CatalogueCard>("catalogueCard", value, invalid);
    const classification = derivedCardModel(card);
    if (
      classification.category !== card.category ||
      classification.gameplay_applicability !== card.gameplay_applicability ||
      (card.category === "art" && card.effective_rules_text !== null)
    )
      throw invalid();
    canonicalProfileAttributes(card.id, card.game_data.profile, "card", card.game_data.attributes, [], card.category);
    if (card.related_cards.reduce((count, relation) => count + relation.evidence.length, 0) > 8) throw invalid();
    for (const relation of card.related_cards) {
      const target = await draft.get("cards", relation.card_id);
      if (
        !target ||
        target.id === card.id ||
        target.game !== card.game ||
        target.game_data.profile !== card.game_data.profile ||
        (target.category === "art") === (card.category === "art")
      )
        throw invalid();
      for (const evidence of relation.evidence) {
        const sourcePrinting = await draft.get("printings", evidence.printing_id);
        const targetPrinting = await draft.get("printings", evidence.related_printing_id);
        if (sourcePrinting?.card_id !== card.id || targetPrinting?.card_id !== target.id) throw invalid();
      }
    }
  } else {
    const printing = decodeDocument<CataloguePrinting>("cataloguePrinting", value, invalid);
    const card = await draft.get("cards", printing.card_id);
    if (
      !card ||
      card.gameplay_applicability !== printing.gameplay_applicability ||
      (printing.gameplay_applicability === "inapplicable" && printing.printed_rules_text !== null)
    )
      throw invalid();
  }
}
