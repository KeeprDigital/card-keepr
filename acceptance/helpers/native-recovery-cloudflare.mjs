import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { nativeSqliteExport } from "./native-sqlite-export.mjs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unstable_splitSqlQuery } from "wrangler";

// Only the Cloudflare control-plane boundary is simulated. SQL export/import
// and every verification query execute against actual independent SQLite files.
export function nativeRecoveryCloudflare({ databaseDirectory, directory }) {
  let exported,
    uploaded,
    target,
    targetId,
    generation = 0;
  const snapshots = [];
  const faults = { lostImportResponses: 0, exportFailures: 0 };
  const hooks = { afterImport: undefined, afterExport: undefined };
  const success = (result) => Response.json({ success: true, result });
  async function sourceFile() {
    const names = await readdir(databaseDirectory, { recursive: true });
    for (const name of names.filter((name) => name.endsWith(".sqlite"))) {
      const path = join(databaseDirectory, name);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='catalogue_state'").get()) return path;
      } finally {
        db.close();
      }
    }
    throw new Error("Native source database was not found.");
  }
  return {
    sourceFile,
    snapshots,
    faults,
    hooks,
    get target() {
      return target;
    },
    close() {
      target?.close();
    },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.hostname === "native-export.invalid")
        return new Response(exported, { headers: { "content-length": String(Buffer.byteLength(exported)) } });
      if (url.hostname === "native-upload.invalid") {
        uploaded = await request.text();
        return new Response(null, { headers: { etag: createHash("md5").update(uploaded).digest("hex") } });
      }
      assert.equal(url.hostname, "api.cloudflare.com", `Unexpected network request ${url}`);
      if (url.pathname.endsWith("/time_travel/bookmark")) return success({ bookmark: "native-current-bookmark" });
      if (url.pathname.endsWith("/export")) {
        if (faults.exportFailures > 0) {
          faults.exportFailures--;
          return Response.json({ success: false, errors: [{ message: "Injected SQL export failure" }] });
        }
        exported = await nativeSqliteExport(await sourceFile(), join(directory, "native-export.sql"));
        const virtual = exported.split("\n").filter((line) => line.includes("CREATE VIRTUAL TABLE"));
        if (virtual.length > 0) throw new Error(`Export still contains virtual tables: ${virtual.join(" | ")}`);
        // D1 management exports omit provider-owned bookkeeping; AUTOINCREMENT
        // counters are reconstructed by inserting the retained primary keys.
        const statements = unstable_splitSqlQuery(exported).filter(
          (sql) =>
            !/^(?:CREATE TABLE|INSERT INTO) ["`]?_cf_/i.test(sql.trim()) &&
            !/^(?:INSERT INTO|DELETE FROM) sqlite_sequence/i.test(sql.trim()) &&
            !/^(?:PRAGMA foreign_keys|BEGIN TRANSACTION|COMMIT)/i.test(sql.trim()),
        );
        exported =
          "PRAGMA defer_foreign_keys=ON;\n" +
          [
            ...statements.filter((sql) => /^CREATE TABLE/i.test(sql.trim())),
            ...statements.filter((sql) => /^CREATE (?:UNIQUE )?INDEX/i.test(sql.trim())),
            ...statements.filter((sql) => !/^CREATE (?:TABLE|(?:UNIQUE )?INDEX)/i.test(sql.trim())),
          ].join(";\n") +
          ";";
        snapshots.push(exported);
        await hooks.afterExport?.();
        return success({
          status: "complete",
          at_bookmark: `native-bookmark-${snapshots.length}`,
          result: { signed_url: "https://native-export.invalid/snapshot", filename: "snapshot.sql" },
        });
      }
      if (url.pathname.endsWith("/import")) {
        const body = await request.json();
        if (body.action === "init")
          return success({ upload_url: "https://native-upload.invalid/snapshot", filename: "snapshot.sql" });
        assert.ok(target);
        target.exec("PRAGMA foreign_keys=OFF;\n" + uploaded + "\nPRAGMA foreign_keys=ON;");
        await hooks.afterImport?.();
        if (faults.lostImportResponses > 0) {
          faults.lostImportResponses--;
          return Response.json({
            success: false,
            errors: [{ message: "Injected lost import response after SQL commit" }],
          });
        }
        return success({ status: "complete" });
      }
      if (url.pathname.endsWith("/query")) {
        const body = await request.json();
        try {
          const statement = target.prepare(body.sql);
          const results = statement.columns().length
            ? statement.all(...(body.params ?? []))
            : (statement.run(...(body.params ?? [])), []);
          return success([{ success: true, results }]);
        } catch (error) {
          throw new Error(`Native restore query failed: ${body.sql}`, { cause: error });
        }
      }
      if (request.method === "DELETE") {
        target?.close();
        target = undefined;
        return success({});
      }
      if (request.method === "GET")
        return success(targetId ? [{ uuid: targetId, name: "card-keepr-disposable-verification" }] : []);
      if (request.method === "POST" && url.pathname.endsWith("/database")) {
        target?.close();
        const retainedGenerations = (await readdir(directory))
          .filter((name) => /^restore-[0-9]+\.sqlite$/.test(name))
          .map((name) => Number(name.match(/[0-9]+/)[0]));
        let allocatedGeneration = Math.max(generation, ...retainedGenerations) + 1;
        for (;;) {
          try {
            const reserved = await open(join(directory, `restore-${allocatedGeneration}.sqlite`), "wx");
            await reserved.close();
            break;
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
            allocatedGeneration++;
          }
        }
        generation = Math.max(generation, allocatedGeneration);
        targetId = `00000000-0000-4000-8000-${String(allocatedGeneration).padStart(12, "0")}`;
        target = new DatabaseSync(join(directory, `restore-${allocatedGeneration}.sqlite`));
        return success({ uuid: targetId });
      }
      throw new Error(`Unexpected native Cloudflare request ${request.method} ${url}`);
    },
  };
}
