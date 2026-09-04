import { createServer as httpServer } from "node:http";
import { administrationPresentation } from "../../src/http/administration-presentation.mjs";
import { validatedProductionTarget } from "../../src/http/production-target.mjs";

/** Fixture servers model server-owned resolution and negotiated presentation.
 * Related fixture documents remain at their ordinary read routes. */
export function createServer(listener) {
  return httpServer((request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    const query = url.pathname === "/v1/status" ? url.searchParams : new URLSearchParams();
    if (query.size) request.url = url.pathname;
    const end = response.end.bind(response);
    response.end = (body, ...arguments_) => {
      const finish = async () => {
        if (typeof body === "string" && response.statusCode >= 200 && response.statusCode < 300) {
          let document;
          try {
            document = JSON.parse(body);
          } catch {
            return end(body, ...arguments_);
          }
          if (query.size) {
            const result = await resolveFixtureTarget(request, document, query);
            document = result.document;
            response.statusCode = result.status;
          }
          if (request.headers.accept === "application/vnd.card-keepr.cli+json" && response.statusCode < 300) {
            document = administrationPresentation(document, response.statusCode);
          }
          body = JSON.stringify(document);
        }
        return end(body, ...arguments_);
      };
      void finish().catch((error) => {
        response.statusCode = 500;
        end(JSON.stringify({ code: "fixture_resolution_failed", detail: String(error) }));
      });
      return response;
    };
    listener(request, response);
  });
}
async function resolveFixtureTarget(request, document, query) {
  const target = validatedProductionTarget(document.production_target);
  if (target === null) return { status: 200, document };
  const fail = (detail) => ({ status: 409, document: { code: "production_target_mismatch", detail } });
  const expected = query.get("expected_current_revision_id"),
    current = document.safe_state?.current_revision_id;
  const lookup = async (path) => {
    const response = await fetch(`http://${request.headers.host}${path}`, {
      headers: { authorization: request.headers.authorization },
    });
    return response.json();
  };
  if (query.has("ingestion_run_id")) {
    const run = await lookup(`/v1/ingestion-runs/${encodeURIComponent(query.get("ingestion_run_id"))}`);
    if (run.id !== query.get("ingestion_run_id") || run.expected_current_revision_id !== expected)
      return fail("The production Ingestion Run does not resolve to the supplied run and expected Catalogue Revision.");
  }
  if (expected !== null && expected !== current)
    return fail(`Production currently resolves to Catalogue Revision ${current ?? "unknown"}, not ${expected}.`);
  if (
    query.has("repair_revision_id") &&
    !document.repairable_catalogue_revision_ids?.includes(query.get("repair_revision_id"))
  )
    return fail("The target Catalogue Revision was not resolved from the authoritative retained revision chain.");
  if (query.has("recovery_id")) {
    const recovery = await lookup(`/v1/recoveries/${encodeURIComponent(query.get("recovery_id"))}`);
    if (
      recovery.id !== query.get("recovery_id") ||
      recovery.target_digest !== query.get("target_digest") ||
      (query.has("expected_restored_revision_id") &&
        recovery.target_revision_id !== query.get("expected_restored_revision_id"))
    )
      return fail("The production recovery operation does not match the supplied exact target evidence.");
    if (current !== recovery.expected_current_revision_id && current !== recovery.target_revision_id)
      return fail("Production does not resolve to either the recovery source or restored Catalogue Revision.");
  }
  let confirmation = JSON.stringify(target);
  if (query.has("curated_operation")) {
    const operation = query.get("curated_operation");
    let binding = JSON.parse(query.get("curated_binding"));
    if (operation !== "create") {
      const { revision } = await lookup(
        `/admin/v1/curated-revisions/${encodeURIComponent(binding.curated_revision_id)}`,
      );
      if (revision.event_version !== binding.expected_event_version)
        return fail("The Curated Revision does not resolve to the supplied lifecycle event version.");
      if ((revision.pending_conflict?.digest ?? null) !== binding.conflict_digest)
        return fail("The Curated Revision does not resolve to the supplied conflict digest.");
      binding = {
        ...binding,
        affected_supported_game: revision.content.game,
        current_content_digest: revision.content_digest,
        target: revision.content.target,
        conflict_id: revision.pending_conflict?.id ?? null,
      };
    }
    confirmation = JSON.stringify({
      production_target: target,
      operation,
      current_catalogue_revision_id: expected,
      ...binding,
    });
  }
  return { status: 200, document: { ...document, resolved_target: { production_target: target, confirmation } } };
}
