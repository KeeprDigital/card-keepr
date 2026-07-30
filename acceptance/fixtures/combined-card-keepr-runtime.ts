import { WorkerEntrypoint } from "cloudflare:workers";
import apiWorker from "../../apps/api/src/index";
import ingestionWorker, {
  EvidenceHostWorkflow,
  EvidenceIngestionWorkflow,
} from "../../apps/ingestion/src/index";

export {
  EvidenceHostWorkflow,
  EvidenceIngestionWorkflow,
};

export class AcceptanceOfficialSourceTransport extends WorkerEntrypoint<Env> {
  fetch(): Response {
    return Response.json({ cards: errataObservations() });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    return (
      url.pathname.startsWith("/v1/ingestion-runs/") ||
      url.pathname === "/v1/status" ||
      url.pathname.startsWith("/v1/reconciliation/") ||
      url.pathname === "/v1/catalogue-search-materialization/repair"
    )
      ? ingestionWorker.fetch(request, env)
      : apiWorker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;

function errataObservations() {
  const artworkFingerprint = `sha256:${"a".repeat(64)}`;
  const first = {
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
        source_url:
          "https://en.onepiece-cardgame.com/images/cardlist/card/OP29-009.png",
        artwork_fingerprint: artworkFingerprint,
      },
    },
    appearance_evidence: {
      images: [{
        role: "front",
        source_url:
          "https://en.onepiece-cardgame.com/images/cardlist/card/OP29-009.png",
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
  return [
    first,
    {
      ...first,
      card: {
        ...first.card,
        effective_rules_text:
          "[On Play] Draw one card. (Observed alternate wording)",
      },
    },
  ];
}
