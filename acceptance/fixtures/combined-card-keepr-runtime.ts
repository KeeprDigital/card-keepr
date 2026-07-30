import { WorkerEntrypoint } from "cloudflare:workers";
import apiWorker from "../../apps/api/src/index";
import ingestionWorker, {
  EvidenceHostWorkflow,
  EvidenceIngestionWorkflow,
} from "../../apps/ingestion/src/index";
import { startEvidenceRun } from "../../src/catalogue/source-evidence";

export {
  EvidenceHostWorkflow,
  EvidenceIngestionWorkflow,
};

export class AcceptanceOfficialSourceTransport extends WorkerEntrypoint<Env> {
  fetch(): Response {
    return Response.json({ cards: [errataObservation()] });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      url.pathname === "/__test/errata-evidence" &&
      request.headers.get("x-card-keepr-acceptance-fixture") ===
        "errata-rules-text"
    ) {
      return Response.json(
        await startEvidenceRun(
          env.CATALOGUE_DB,
          {
            supported_game: "one-piece",
            source_lineage: "one-piece-en",
            adapter_version: "fixture-one-piece-json@1",
            idempotency_key: "errata-runtime-source",
            requests: [{
              id: "errata-rules-text",
              url: "https://official-source.invalid/errata-rules-text",
              headers: { accept: "application/json" },
            }],
          },
          "synthetic_fixture",
        ),
        { status: 201 },
      );
    }
    return (
      url.pathname.startsWith("/v1/ingestion-runs/") ||
      url.pathname === "/v1/status" ||
      url.pathname.startsWith("/v1/reconciliation/")
    )
      ? ingestionWorker.fetch(request, env)
      : apiWorker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;

function errataObservation() {
  const artworkFingerprint = `sha256:${"a".repeat(64)}`;
  return {
    card: {
      game: "one-piece",
      official_identity: { kind: "card_number", value: "OP29-009" },
      name: "Black-box Errata Card",
      effective_rules_text: "[On Play] Draw 1 card.",
      game_data: {
        profile: "one-piece@1",
        attributes: {
          card_type: "leader",
          colours: ["red"],
          cost: null,
          life: 5,
          battle_attributes: ["strike"],
          power: 5000,
          counter: null,
          traits: ["Straw Hat Crew"],
          block_icons: ["1"],
          effect_text: "[On Play] Draw 1 card.",
          trigger_text: null,
        },
      },
    },
    printing: {
      rarity: { raw: "L", normalized: "leader" },
      printed_rules_text: "[On Play] Draw 1 card.",
      game_data: {
        profile: "one-piece@1",
        attributes: { illustration_types: [] },
      },
    },
    identity_evidence: {
      locator: "/official/errata/OP29-009",
      artwork_fingerprint: artworkFingerprint,
      printed_fields_digest: `sha256:${"b".repeat(64)}`,
      treatment: "standard",
      demonstrably_novel: true,
      novelty_basis: {
        kind: "official_printing_image",
        source_url: "https://official-source.invalid/images/OP29-009.png",
        artwork_fingerprint: artworkFingerprint,
      },
    },
    appearance_evidence: {
      images: [{
        role: "front",
        source_url: "https://official-source.invalid/images/OP29-009.png",
        artwork_fingerprint: artworkFingerprint,
      }],
    },
    completeness: {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 1,
      parsed_record_count: 1,
    },
    memberships: {
      products: ["product_op29"],
      distribution_contexts: [],
      source_buckets: ["official-card-list"],
    },
    errata: [{
      authority: "official_errata",
      field: "effective_rules_text",
      target_type: "card",
      effective_from: "2026-07-01",
      official_wording: 'Replace "Draw 1 card" with "Draw 2 cards".',
      corrected_value: "[On Play] Draw 2 cards.",
    }],
  };
}
