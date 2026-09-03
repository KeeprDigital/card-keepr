// ADR 0004: superseded Source Adapter Version parser code is retired.
//
// Registration is permanent; implementation is not. Every version listed
// here keeps its registration identity so retained Source Observation Sets,
// Evidence Plans, and Ingestion Runs stay attributable, but carries no
// parser, no discovery, and no request-surface contract. The runtime refuses
// to capture or parse under a retired version (`adapter_version_retired`);
// reparsing retained Source Snapshots is done by registering a new version.
//
// Parser contract strings are the immutable values seeded in the
// source_adapter_versions migrations and must never drift from them. The
// reconciliation areas and discovery-header inheritance flags are the
// registration facts the retired parser code previously implied.
//
// A version is retired once it is neither the current version nor the
// immediate predecessor on its Source Lineage. Retiring a version means
// moving its row here, deleting its parser body and per-version tests, and
// adding it to scripts/retired-adapter-runs.sql (asserted by the acceptance
// suite to name exactly this list).

import type { SupportedGame } from "./catalogue-candidate";

export type RetiredSourceAdapterVersion = Readonly<{
  adapterVersion: string;
  sourceLineage: "one-piece-en" | "fusion-world-en" | "digimon-en" | "gundam-en-asia" | "gundam-en-us";
  supportedGame: SupportedGame;
  parserContract: string;
  reconciliationAreas: readonly ("catalogue" | "errata")[];
  inheritDiscoveryRequestHeaders: boolean;
}>;

const catalogueOnly = Object.freeze(["catalogue"] as const);
const catalogueAndErrata = Object.freeze(["catalogue", "errata"] as const);

export const retiredSourceAdapterVersions: readonly RetiredSourceAdapterVersion[] =
  Object.freeze([
    {
      adapterVersion: "one-piece-en@1",
      sourceLineage: "one-piece-en",
      supportedGame: "one-piece",
      parserContract: "one-piece-en-raw-surfaces@1",
      reconciliationAreas: catalogueOnly,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "one-piece-en@2",
      sourceLineage: "one-piece-en",
      supportedGame: "one-piece",
      parserContract: "one-piece-en-raw-surfaces-with-legality@2",
      reconciliationAreas: catalogueOnly,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "one-piece-en@3",
      sourceLineage: "one-piece-en",
      supportedGame: "one-piece",
      parserContract: "one-piece-en-complete-catalogue@3",
      reconciliationAreas: catalogueAndErrata,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "one-piece-en@4",
      sourceLineage: "one-piece-en",
      supportedGame: "one-piece",
      parserContract: "one-piece-en-restructured-complete-catalogue@4",
      reconciliationAreas: catalogueAndErrata,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "fusion-world-en@2",
      sourceLineage: "fusion-world-en",
      supportedGame: "fusion-world",
      parserContract: "fusion-world-en-raw-surfaces@1",
      reconciliationAreas: catalogueOnly,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "fusion-world-en@3",
      sourceLineage: "fusion-world-en",
      supportedGame: "fusion-world",
      parserContract: "fusion-world-en-raw-surfaces-with-legality@2",
      reconciliationAreas: catalogueOnly,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "fusion-world-en@4",
      sourceLineage: "fusion-world-en",
      supportedGame: "fusion-world",
      parserContract:
        "fusion-world-en-raw-surfaces-with-legality-and-catalogue@3",
      reconciliationAreas: catalogueAndErrata,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "fusion-world-en@5",
      sourceLineage: "fusion-world-en",
      supportedGame: "fusion-world",
      parserContract: "fusion-world-en-restructured-complete-catalogue@4",
      reconciliationAreas: catalogueOnly,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "fusion-world-en@6",
      sourceLineage: "fusion-world-en",
      supportedGame: "fusion-world",
      parserContract: "fusion-world-en-restructured-complete-catalogue@5",
      reconciliationAreas: catalogueOnly,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "fusion-world-en@7",
      sourceLineage: "fusion-world-en",
      supportedGame: "fusion-world",
      parserContract: "fusion-world-en-restructured-complete-catalogue@6",
      reconciliationAreas: catalogueOnly,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "digimon-en@2",
      sourceLineage: "digimon-en",
      supportedGame: "digimon",
      parserContract: "digimon-en-raw-surfaces@1",
      reconciliationAreas: catalogueOnly,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "digimon-en@3",
      sourceLineage: "digimon-en",
      supportedGame: "digimon",
      parserContract: "digimon-en-raw-surfaces-with-legality@2",
      reconciliationAreas: catalogueOnly,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "digimon-en@4",
      sourceLineage: "digimon-en",
      supportedGame: "digimon",
      parserContract: "digimon-en-raw-surfaces-complete-catalogue@3",
      reconciliationAreas: catalogueAndErrata,
      inheritDiscoveryRequestHeaders: true,
    },
    {
      adapterVersion: "digimon-en@5",
      sourceLineage: "digimon-en",
      supportedGame: "digimon",
      parserContract: "digimon-en-restructured-complete-catalogue@4",
      reconciliationAreas: catalogueAndErrata,
      inheritDiscoveryRequestHeaders: true,
    },
    {
      adapterVersion: "gundam-en-asia@2",
      sourceLineage: "gundam-en-asia",
      supportedGame: "gundam",
      parserContract: "gundam-en-asia-raw-surfaces@1",
      reconciliationAreas: catalogueOnly,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "gundam-en-asia@3",
      sourceLineage: "gundam-en-asia",
      supportedGame: "gundam",
      parserContract: "gundam-en-asia-raw-surfaces-with-legality@2",
      reconciliationAreas: catalogueOnly,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "gundam-en-asia@4",
      sourceLineage: "gundam-en-asia",
      supportedGame: "gundam",
      parserContract: "gundam-en-asia-raw-surfaces-complete-catalogue@3",
      reconciliationAreas: catalogueAndErrata,
      inheritDiscoveryRequestHeaders: true,
    },
    {
      adapterVersion: "gundam-en-asia@5",
      sourceLineage: "gundam-en-asia",
      supportedGame: "gundam",
      parserContract: "gundam-en-asia-restructured-complete-catalogue@4",
      reconciliationAreas: catalogueAndErrata,
      inheritDiscoveryRequestHeaders: true,
    },
    {
      adapterVersion: "gundam-en-us@2",
      sourceLineage: "gundam-en-us",
      supportedGame: "gundam",
      parserContract: "gundam-en-us-raw-surfaces@1",
      reconciliationAreas: catalogueOnly,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "gundam-en-us@3",
      sourceLineage: "gundam-en-us",
      supportedGame: "gundam",
      parserContract: "gundam-en-us-raw-surfaces-with-legality@2",
      reconciliationAreas: catalogueOnly,
      inheritDiscoveryRequestHeaders: false,
    },
    {
      adapterVersion: "gundam-en-us@4",
      sourceLineage: "gundam-en-us",
      supportedGame: "gundam",
      parserContract: "gundam-en-us-raw-surfaces-complete-catalogue@3",
      reconciliationAreas: catalogueAndErrata,
      inheritDiscoveryRequestHeaders: true,
    },
    {
      adapterVersion: "gundam-en-us@5",
      sourceLineage: "gundam-en-us",
      supportedGame: "gundam",
      parserContract: "gundam-en-us-restructured-complete-catalogue@4",
      reconciliationAreas: catalogueAndErrata,
      inheritDiscoveryRequestHeaders: true,
    },
  ]);
