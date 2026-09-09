import type {
  CatalogueCandidate,
  CatalogueCard,
  CatalogueDistributionContext,
  CatalogueErratum,
  CataloguePrinting,
  CataloguePrintingImage,
  CatalogueProduct,
  ProductRelationship,
} from "../shared";
import type { ReconciliationCandidateState } from "./reconciliation-candidate-state";
export type PriorStatePositions = {
  cards: number;
  priorCards: number;
  printings: number;
  priorPrintings: number;
  printingImages: number;
  priorProducts: ReconciliationCandidateState["positions"];
  priorErrata: number;
  currentErrata: number;
};
export type PriorStateSeed = {
  card: (card: CatalogueCard) => Promise<void>;
  printing: (printing: CataloguePrinting) => Promise<void>;
  image: (image: CataloguePrintingImage) => Promise<void>;
  product: (product: CatalogueProduct) => Promise<void>;
  context: (context: CatalogueDistributionContext) => Promise<void>;
  relationship: (relationship: ProductRelationship) => Promise<void>;
  erratum: (erratum: CatalogueErratum) => Promise<void>;
  correction: (correction: NonNullable<CatalogueCandidate["identity_corrections"]>[number]) => Promise<void>;
};
export type PriorStateContinuation = {
  runId: string;
  capture: () => PriorStatePositions;
  restore: (positions: PriorStatePositions) => void;
  yieldAtCheckpoint: boolean;
};
