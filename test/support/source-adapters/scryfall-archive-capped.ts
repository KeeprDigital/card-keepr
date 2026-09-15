import { scryfallSourceAdapterRegistration } from "../../../src/catalogue/adapters/scryfall-source-adapter";

// Exercise a real archive's atomic discovery overflow with a small retained
// fixture. This test-only budget is independent of the production envelope.
export const scryfallArchiveCappedAdapter = {
  ...scryfallSourceAdapterRegistration,
  adapterVersion: "fixture-scryfall-archive-capped@1",
  requestCapacity: 10,
};
