import { expect, test } from "vitest";
import { administrationRequest, installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

test("owner cannot admit Riftbound Printing codes as distinct Card identities", async () => {
  for (const code of ["OGN-066/298", "OGN-066a/298"]) {
    const created = await administrationRequest("/v1/entity-proposals", "POST", {
      game: "riftbound",
      source_lineage: "owner",
      reference: `numbered:${code}`,
      idempotency_key: `numbered:${code}`,
      evidence: { attestation: "Synthetic admission regression, not real publisher evidence." },
      content: {
        card: {
          game: "riftbound",
          official_identity: { kind: "card_number", value: code },
          name: "Ahri, Alluring",
          effective_rules_text: null,
          game_data: {
            profile: "riftbound@1",
            attributes: {
              card_types: ["unit"],
              supertypes: ["champion"],
              domains: ["calm"],
              energy: 5,
              power: 1,
              might: 4,
              might_bonus: null,
              tags: ["Ahri", "Ionia"],
              ability_text: null,
              effect_text: null,
            },
          },
        },
      },
    });
    expect(created.status).toBe(201);
    const proposal = await created.json<{ id: string }>();
    const admitted = await administrationRequest(`/v1/entity-proposals/${proposal.id}/decisions`, "POST", {
      action: "admit",
      expected_generation: "0",
      rationale: "Attempt identity from public Printing code",
      idempotency_key: `admit-numbered:${code}`,
    });
    expect(admitted.status).toBe(422);
  }
});
