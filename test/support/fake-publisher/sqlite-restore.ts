import { createHash } from "node:crypto";
import { createWriteStream, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { sqliteFileCommand, sqliteSnapshot } from "./sqlite-transfer.ts";

/** An independent disposable database: only the bytes uploaded for import populate it. */
export class SqliteRestore {
  private directory = mkdtempSync(join(tmpdir(), "keepr-disposable-restore-"));
  private databasePath = join(this.directory, "restored.sqlite");
  private database = new DatabaseSync(this.databasePath);
  private uploaded = false;

  close() {
    this.database.close();
    rmSync(this.directory, { recursive: true, force: true });
  }

  reset() {
    this.database.close();
    for (const file of [this.databasePath, join(this.directory, "upload.sql"), join(this.directory, "import.sqlite")])
      rmSync(file, { force: true });
    this.database = new DatabaseSync(this.databasePath);
    this.uploaded = false;
  }

  async upload(sql: string | ReadableStream<Uint8Array>) {
    this.uploaded = false;
    const hash = createHash("md5");
    const input = typeof sql === "string" ? [Buffer.from(sql)] : sql;
    await pipeline(
      input,
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(join(this.directory, "upload.sql")),
    );
    this.uploaded = true;
    return hash.digest("hex");
  }

  async import() {
    if (!this.uploaded) throw new Error("No SQL bytes were uploaded for restore.");
    const target = join(this.directory, "import.sqlite");
    try {
      await sqliteSnapshot(this.databasePath, target);
      // Publish only a fully imported target. Invalid SQL cannot expose a partially imported target.
      // A native .dump may contain its own transaction, so do not wrap it in a second BEGIN.
      await sqliteFileCommand(["-cmd", "PRAGMA foreign_keys=OFF;", target], {
        input: join(this.directory, "upload.sql"),
      });
      this.database.close();
      try {
        renameSync(target, this.databasePath);
      } finally {
        this.database = new DatabaseSync(this.databasePath);
      }
      this.database.exec("PRAGMA foreign_keys=ON;");
    } catch (error) {
      rmSync(target, { force: true });
      throw error;
    }
  }

  query(sql: string, params: readonly SQLInputValue[]) {
    try {
      const statement = this.database.prepare(sql);
      if (statement.columns().length > 0) return statement.all(...params);
      statement.run(...params);
      return [];
    } catch (error) {
      throw new Error(`Disposable restore query failed: ${sql}`, { cause: error });
    }
  }
}
