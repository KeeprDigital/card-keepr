import { expect, test } from "vitest";
import { administrationPresentation } from "../../src/http/administration-presentation.mjs";

test("CLI distinguishes immutable acceptance, pending, paused, failed and published outcomes", () => {
  for (const [contract, state, expected] of [
    ["card-keepr-publication-acceptance@1", "approved", 10],
    ["card-keepr-game-publication@1", "waiting_artifacts", 10],
    ["card-keepr-game-publication@1", "retry_paused", 10],
    ["card-keepr-game-publication@1", "failed", 8],
    ["card-keepr-game-publication@1", "published", 0],
  ]) {
    const result = administrationPresentation({
      contract,
      state,
      id: "publication_test",
      links: { status: "https://example.invalid/ingest/v1/publications/publication_test" },
    });
    expect(result.exit_code).toBe(expected);
  }
});
