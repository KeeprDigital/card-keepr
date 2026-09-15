import ingestionWorker from "../../test/support/ingestion-worker";
export * from "../../test/support/ingestion-worker";
import { injectFixturePublication } from "../../test/support/fixture-publication";
import { collectFixtureEvidence, injectFixtureEvidencePlan } from "../../test/support/fixture-evidence-plan";

/** Setup retains real synthetic source/candidate data; every owner command runs
 * through the shipped HTTP Worker and its actual Workflow bindings. */
export default {
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    if (new URL(request.url).pathname !== "/acceptance/retained-owner-source")
      return ingestionWorker.fetch(request, env, context);
    if (request.method !== "POST" || request.headers.get("authorization") !== `Bearer ${env.ADMINISTRATION_KEY}`)
      return new Response(null, { status: 403 });
    const { kind } = await request.json<{ kind: "aggregate" | "evidence" }>();
    if (kind === "aggregate")
      return Response.json(
        await injectFixturePublication(env.CATALOGUE_DB, env.CATALOGUE_EXPORTS, {
          fixture: "first-catalogue",
          selected_games: ["one-piece"],
          idempotency_key: "retained-owner-aggregate",
        }),
      );
    if (kind !== "evidence") throw new Error("Unknown retained owner fixture");
    const run = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "fixture-one-piece-json@3",
      requests: [{ id: "one-piece-en:discovery", url: "https://official-source.invalid/reconciliation/base" }],
      idempotency_key: "retained-owner-evidence",
    });
    return Response.json(
      await collectFixtureEvidence(
        env.CATALOGUE_DB,
        env.EVIDENCE_OBJECTS,
        env.OFFICIAL_SOURCE_TRANSPORT,
        String(run.id),
      ),
    );
  },
};
