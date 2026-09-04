import { createHash } from "node:crypto";
import type { PublisherScenario } from "./scenario.ts";

export interface CloudflareApiMockOptions {
  readonly accountId: string;
  readonly disposableDatabaseId: string;
  readonly verificationToken: string;
  readonly schemaMigrationLevel: number;
}

// The Cloudflare REST surfaces the backup, recovery, and release paths call:
// D1 database lifecycle, export, import, and the query endpoint. Probe-table
// state is keyed by the probe table each caller names, and the disposable
// database generation lives in the mock instance, so a fresh publisher starts
// clean.
export function cloudflareApiMock(
  options: CloudflareApiMockOptions,
): PublisherScenario {
  const ambiguousD1Tables = new Map<string, string>();
  const unconfirmedD1Drops = new Set<string>();
  let disposableD1Generation = 0;
  let disposableD1DatabaseId = options.disposableDatabaseId;
  return async ({ request, url }) => {
    const d1CollectionPath =
      `/client/v4/accounts/${options.accountId}/d1/database`;
    if (
      url.hostname === "api.cloudflare.com" &&
      url.pathname === d1CollectionPath && request.method === "GET"
    ) {
      return Response.json({
        success: true,
        result: [{
          name: "card-keepr-disposable-verification",
          uuid: disposableD1DatabaseId,
        }],
      });
    }
    if (
      url.hostname === "api.cloudflare.com" &&
      url.pathname === d1CollectionPath && request.method === "POST"
    ) {
      disposableD1Generation += 1;
      disposableD1DatabaseId =
        `00000000-0000-4000-8000-${
          String(disposableD1Generation).padStart(12, "0")
        }`;
      return Response.json({
        success: true,
        result: {
          name: "card-keepr-disposable-verification",
          uuid: disposableD1DatabaseId,
        },
      });
    }
    if (
      url.hostname === "api.cloudflare.com" &&
      url.pathname.startsWith(`${d1CollectionPath}/`) &&
      request.method === "DELETE"
    ) {
      return Response.json({ success: true, result: {} });
    }
    if (url.hostname === "vitest-d1-export.invalid") {
      const body = "-- vitest D1 backup SQL\n";
      return new Response(body, {
        headers: { "content-length": String(Buffer.byteLength(body)) },
      });
    }
    if (url.hostname === "vitest-d1-upload.invalid") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const etag = createHash("md5").update(bytes).digest("hex");
      return new Response(null, { headers: { etag: `"${etag}"` } });
    }
    if (
      url.hostname === "api.cloudflare.com" &&
      url.pathname.endsWith("/export")
    ) {
      return Response.json({
        success: true,
        result: {
          type: "export",
          status: "complete",
          success: true,
          at_bookmark: "vitest-export-bookmark",
          result: {
            filename: "vitest-catalogue.sql",
            signed_url: "https://vitest-d1-export.invalid/catalogue.sql",
          },
          messages: [],
        },
      });
    }
    if (
      url.hostname === "api.cloudflare.com" &&
      url.pathname.endsWith("/import")
    ) {
      const body = await request.clone().json<{
        action?: string;
      }>();
      return Response.json({
        success: true,
        result: body.action === "init"
          ? {
            type: "import",
            status: "upload",
            success: true,
            filename: "vitest-catalogue.sql",
            upload_url: "https://vitest-d1-upload.invalid/catalogue.sql",
            messages: [],
          }
          : {
            type: "import",
            status: "complete",
            success: true,
            at_bookmark: "vitest-restore-bookmark",
            messages: [],
          },
      });
    }
    if (
      url.hostname === "api.cloudflare.com" &&
      url.pathname.endsWith("/query")
    ) {
      const body = await request.clone().json<{
        sql?: string;
        params?: string[];
      }>();
      if (
        request.headers.get("authorization") ===
          `Bearer ${options.verificationToken}`
      ) {
        let expected: Record<string, unknown> = {};
        try {
          expected = JSON.parse(body.params?.[1] ?? "{}") as
            Record<string, unknown>;
        } catch {
          // Non-verification reconstruction statements have no evidence.
        }
        return Response.json({
          success: true,
          result: [{
            success: true,
            results: body.sql?.includes(
                "SELECT catalogue.current_revision_id",
              )
              ? [{
                ...expected,
                current_revision_id:
                  body.params?.[0] ?? "catrev_spine_000",
                schema_migration_level: options.schemaMigrationLevel,
                card_search_state: "ready",
                card_search_fts_tables: 1,
                missing_fts_rows: 0,
                invalid_api_documents: 0,
                invalid_curated_provenance: 0,
                invalid_audit_rows: 0,
              }]
              : body.sql === "PRAGMA quick_check"
              ? [{ quick_check: "ok" }]
              : body.sql?.includes(
                  "WITH expected_card(value) AS (SELECT ?)",
                )
              ? [{
                sort_game: "one-piece",
                sort_identity_kind: "card_number",
                sort_identity_value: "VITEST-001",
                sort_id: body.params?.[0],
                summary_json: JSON.stringify({
                  id: body.params?.[0],
                  game: "one-piece",
                  official_identity: {
                    kind: "card_number",
                    value: "VITEST-001",
                  },
                }),
              }]
              : [],
          }],
        });
      }
      const table = /"(__keepr_probe_[0-9a-f]+)"/u.exec(
        body.sql ?? "",
      )?.[1];
      const owner = body.params?.[0];
      if (
        body.sql?.startsWith("CREATE TABLE") &&
        table !== undefined &&
        typeof owner === "string" &&
        ["8".repeat(64), "9".repeat(64)].includes(
          owner,
        )
      ) {
        ambiguousD1Tables.set(table, owner);
        if (owner === "9".repeat(64)) {
          throw new Error("CREATE response lost after apply");
        }
        return Response.json({
          success: true,
          result: [{ success: true }],
        });
      }
      if (
        body.sql?.startsWith("SELECT owner") &&
        table !== undefined &&
        ambiguousD1Tables.has(table)
      ) {
        return Response.json({
          success: true,
          result: [{
            success: true,
            results: [{
              owner: ambiguousD1Tables.get(table),
            }],
          }],
        });
      }
      if (
        body.sql?.startsWith("DROP TABLE") &&
        table !== undefined &&
        ambiguousD1Tables.has(table)
      ) {
        const storedOwner = ambiguousD1Tables.get(table);
        if (storedOwner === "8".repeat(64)) {
          ambiguousD1Tables.delete(table);
          unconfirmedD1Drops.add(table);
          throw new Error("DROP response lost after apply");
        }
        if (storedOwner !== "9".repeat(64)) {
          return Response.json(
            { success: false, errors: [{ code: 9000 }] },
            { status: 500 },
          );
        }
        ambiguousD1Tables.delete(table);
        return Response.json({
          success: true,
          result: [{ success: true }],
        });
      }
      if (
        body.sql?.startsWith(
          "SELECT name FROM sqlite_schema",
        )
      ) {
        const inspected = body.params?.[0] ?? "";
        if (unconfirmedD1Drops.delete(inspected)) {
          return Response.json(
            { success: false, errors: [{ code: 9000 }] },
            { status: 500 },
          );
        }
        return Response.json({
          success: true,
          result: [{
            success: true,
            results: ambiguousD1Tables.has(inspected)
              ? [{ name: inspected }]
              : [],
          }],
        });
      }
      if (body.sql?.startsWith("CREATE TABLE")) {
        if (table !== undefined && owner !== undefined) {
          ambiguousD1Tables.set(table, owner);
        }
        return Response.json({
          success: true,
          result: [{ success: true }],
        });
      }
      return Response.json(
        { success: false, errors: [{ code: 9000 }] },
        { status: 500 },
      );
    }
    return null;
  };
}
