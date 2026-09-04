import {
  collectFixtureEvidence,
  injectFixtureEvidencePlan,
} from "../../test/support/fixture-evidence-plan";
import { fixtureSourceSnapshotStatement, cloneFixtureFetchAttemptStatement, cloneFixtureSourceSnapshotStatement, restoreFixturePublicationHealthStatement } from "../helpers/query-helpers/runtime-fixtures";
import { catalogueStore } from "../../src/catalogue/shared";
import {
  WorkerEntrypoint,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
// The combined bundle shares one adapter registry; the ingestion test entrypoint installs it once.
import apiWorker from "../../apps/api/src/index";
import ingestionWorker, {
  EvidenceHostWorkflow,
  EvidenceIngestionWorkflow,
  ReconciliationWorkflow,
} from "../../test/support/ingestion-worker";
import type {
  CatalogueBackupWorkflowParams,
} from "../../src/catalogue/backup-recovery";
import {
  onePieceOfficialErrataHtml,
  onePieceOfficialErrataShapeDriftHtml,
} from "./one-piece-official-errata-html";
import type { StartEvidenceRunRequest } from "../../src/catalogue/source-evidence";

export {
  EvidenceHostWorkflow,
  EvidenceIngestionWorkflow,
  ReconciliationWorkflow,
};

export class CatalogueBackupWorkflow extends WorkflowEntrypoint<
  Env,
  CatalogueBackupWorkflowParams
> {
  override async run(
    event: Readonly<WorkflowEvent<CatalogueBackupWorkflowParams>>,
    _step: WorkflowStep,
  ): Promise<{ result_json: string }> {
    return {
      result_json: JSON.stringify({
        contract: "card-keepr-combined-acceptance-backup-harness@1",
        idempotency_key: event.payload.idempotency_key,
        ok: true,
      }),
    };
  }
}

export class AcceptanceOfficialSourceTransport extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/rules/errata_card/") {
      return new Response(onePieceOfficialErrataHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (pathname === "/errata-without-vegapunk") {
      return Response.json({ cards: [errataWithoutVegapunk()] });
    }
    if (pathname === "/card-list-refreshed") {
      return Response.json({
        cards: await seedObservations("Dr. Vegapunk"),
      });
    }
    return Response.json({ cards: await seedObservations("Vegapunk") });
  }
}

export class AcceptanceShapeDriftOfficialSourceTransport
  extends WorkerEntrypoint<Env> {
  fetch(): Response {
    return new Response(onePieceOfficialErrataShapeDriftHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      url.pathname === "/acceptance/synthetic-evidence" &&
      request.headers.get("authorization") ===
        `Bearer ${env.ADMINISTRATION_KEY}`
    ) {
      const run = await injectFixtureEvidencePlan(
        env.CATALOGUE_DB,
        await request.json<StartEvidenceRunRequest>(),
      );
      const collected = await collectFixtureEvidence(
        env.CATALOGUE_DB,
        env.EVIDENCE_OBJECTS,
        env.OFFICIAL_SOURCE_TRANSPORT,
        String(run.id),
      );
      return Response.json(collected, { status: 201 });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/acceptance/retained-snapshot-adapter" &&
      request.headers.get("authorization") ===
        `Bearer ${env.ADMINISTRATION_KEY}`
    ) {
      const body = await request.json<{
        source_snapshot_id: string;
        adapter_version: string;
      }>();
      if (body.adapter_version !== "one-piece-official-errata-html@1") {
        return Response.json({ code: "invalid_fixture_adapter" }, {
          status: 422,
        });
      }
      const suffix = crypto.randomUUID();
      const snapshotId = `srcsnap_acceptance_${suffix}`;
      const fetchAttemptId = `srcfetch_acceptance_${suffix}`;
      const source = await fixtureSourceSnapshotStatement(env.CATALOGUE_DB).bind(body.source_snapshot_id).first<{
        ingestion_run_id: string;
        request_id: string;
        fetch_attempt_id: string;
      }>();
      if (source === null) {
        return Response.json({ code: "source_snapshot_not_found" }, {
          status: 404,
        });
      }
      await env.CATALOGUE_DB.batch([
        cloneFixtureFetchAttemptStatement(env.CATALOGUE_DB).bind(fetchAttemptId, source.fetch_attempt_id),
        cloneFixtureSourceSnapshotStatement(env.CATALOGUE_DB).bind(
          snapshotId,
          fetchAttemptId,
          body.adapter_version,
          body.source_snapshot_id,
        ),
      ]);
      return Response.json({ source_snapshot_id: snapshotId }, {
        status: 201,
      });
    }
    const response = (
      url.pathname.startsWith("/v1/ingestion-runs/") ||
      url.pathname.startsWith("/v1/source-snapshots/") ||
      url.pathname === "/v1/status" ||
      url.pathname.startsWith("/v1/reconciliation/") ||
      url.pathname === "/v1/catalogue-search-materialization/repair"
    )
      ? ingestionWorker.fetch(request, env)
      : apiWorker.fetch(request, env);
    if (
      request.method === "POST" &&
      /^\/v1\/ingestion-runs\/[^/]+\/approval$/u.test(url.pathname)
    ) {
      const resolved = await response;
      if (resolved.status === 200) {
        await restoreFixturePublicationHealthStatement(env.CATALOGUE_DB).run();
      }
      return resolved;
    }
    return response;
  },
} satisfies ExportedHandler<Env>;

async function seedObservations(vegapunkName: string) {
  return Promise.all([
    seedObservation({
      identity: "OP07-097",
      name: vegapunkName,
      rules:
        "This Leader cannot attack.\n[Activate: Main] [Once Per Turn] You may rest 1 of your DON!! cards Select up to 1 {Egghead} typSelectup to 1 {Egghead} type card with a cost of 5 or less from your hand and play it or add it to the top of your Life cards face-up.",
      printedDigestCharacter: "b",
    }),
    seedObservation({
      identity: "OP03-047",
      name: "Zeff",
      rules:
        "[DON!! x1] When this Character's attack deals damage to your opponent's Life, you may trash 7 cards from the top of your deck.\n[On Play] You may return up to 1 Character with a cost of 3 or less to the owner's hand, and trash 2 cards from the top of your deck.",
      printedDigestCharacter: "d",
    }),
    seedObservation({
      identity: "OP01-001",
      name: "Monkey D. Luffy",
      rules: "[On Play] Draw 1 card.",
      printedDigestCharacter: "f",
    }),
  ]);
}

async function seedObservation(input: {
  identity: string;
  name: string;
  rules: string;
  printedDigestCharacter: string;
}) {
  const imageBytes = printingImageBytes(input.identity);
  const imageDigest = await sha256Hex(imageBytes);
  const artworkFingerprint = `sha256:${imageDigest}`;
  return {
    card: {
      game: "one-piece",
      official_identity: { kind: "card_number", value: input.identity },
      name: input.name,
      effective_rules_text: input.rules,
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
          effect_text: input.rules,
          trigger_text: null,
        },
      },
    },
    printing: {
      rarity: { raw: "L", normalized: "leader" },
      printed_rules_text: input.rules,
      game_data: {
        profile: "one-piece@1",
        attributes: { illustration_types: [] },
      },
    },
    identity_evidence: {
      locator: officialErrataPrintingLocator(input.identity) ??
        `/official/card-list/${input.identity}`,
      artwork_fingerprint: artworkFingerprint,
      printed_fields_digest: `sha256:${
        input.printedDigestCharacter.repeat(64)
      }`,
      treatment: "standard",
      demonstrably_novel: true,
      novelty_basis: {
        kind: "official_printing_image",
        source_url:
          `https://en.onepiece-cardgame.com/images/cardlist/card/${input.identity}.png`,
        artwork_fingerprint: artworkFingerprint,
      },
    },
    appearance_evidence: {
      images: [{
        role: "front",
        source_url:
          `https://en.onepiece-cardgame.com/images/cardlist/card/${input.identity}.png`,
        artwork_fingerprint: artworkFingerprint,
        media_type: "image/png",
        width: 1,
        height: 1,
        content_sha256: imageDigest,
        content_base64: btoa(String.fromCharCode(...imageBytes)),
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
      products: [],
      distribution_contexts: [],
      source_buckets: ["official-card-list"],
    },
    errata: [],
  };
}

function officialErrataPrintingLocator(identity: string): string | null {
  if (identity === "OP07-097") {
    return "https://en.onepiece-cardgame.com/images/rules/cards/20250516/OP07-097_p2.png";
  }
  if (identity === "OP01-001") {
    return "https://en.onepiece-cardgame.com/images/rules/cards/20230217/op01-001_dummy.png";
  }
  return null;
}

function errataWithoutVegapunk() {
  return {
    kind: "official_erratum",
    game: "one-piece",
    target: {
      type: "card",
      official_identity: { kind: "card_number", value: "OP03-047" },
    },
    published_on: "2023-07-14",
    effective_from: null,
    observed_printed_rules_text:
      "[DON!! x1] When this Character's attack deals damage to your " +
      "opponent's Life, you may trash 7 cards from the top of your deck.\n" +
      "[On Play] You may return up to 1 Character with a cost of 3 or " +
      "less to the owner's hand, and trash 2 cards from the top of your deck.",
    corrected_rules_text:
      "[DON!! x1] When this Character's attack deals damage to your " +
      "opponent's Life, you may trash 7 cards from the top of your deck.\n" +
      "[On Play] Return up to 1 Character with a cost of 3 or less to " +
      "the owner's hand, and you may trash 2 cards from the top of your deck.",
    official_wording:
      "Before: Prior Zeff wording.\nAfter: Corrected Zeff wording.",
    applies_to_parallel_printings: true,
    source: {
      fragment: "#errata_10",
      display_name: "OP03-047 Zeff",
      image_url:
        "https://en.onepiece-cardgame.com/images/rules/cards/" +
        "20230714/op03-047_dummy.png",
    },
    completeness: {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 1,
      parsed_record_count: 1,
    },
  };
}

function printingImageBytes(identity: string): Uint8Array {
  return new TextEncoder().encode(`fixture-printing-image:${identity}`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
