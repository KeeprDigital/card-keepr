// The Catalogue Candidate's shape lives in the leaf module
// `catalogue-candidate-types`; this module keeps the historical import path
// working for every consumer outside the candidate's own behaviour modules.
export {
  catalogueCandidateContract,
  type CatalogueCandidate,
  type CatalogueCard,
  type CataloguePrinting,
  type CataloguePrintingImage,
  type CatalogueSourceCheck,
  type SupportedGame,
} from "./catalogue-candidate-types";
