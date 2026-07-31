import type {
  CatalogueCandidate,
  CatalogueCard,
  CataloguePrinting,
} from "../../../src/catalogue/catalogue-candidate";

// This compile-time consumer represents the production domain module's public
// vocabulary. Synthetic fixture names belong only to test setup, while the
// candidate itself is Catalogue Data regardless of how test evidence entered.
export type CatalogueDomainContract = {
  candidate: CatalogueCandidate;
  card: CatalogueCard;
  printing: CataloguePrinting;
};

type Assert<T extends true> = T;

export type CatalogueCandidateHasDomainContract = Assert<
  CatalogueCandidate["contract"] extends
    "card-keepr-catalogue-candidate@1" ? true : false
>;

export type CatalogueCandidateExcludesFixtureIdentity = Assert<
  "fixture" extends keyof CatalogueCandidate ? false : true
>;
