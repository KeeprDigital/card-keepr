import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** An independent disposable database: only the bytes uploaded for import populate it. */
export class SqliteRestore {
  private database = new DatabaseSync(":memory:");
  private uploaded: string | undefined;

  close() {
    this.database.close();
  }

  reset() {
    this.database.close();
    this.database = new DatabaseSync(":memory:");
    this.uploaded = undefined;
  }

  upload(sql: string) {
    this.uploaded = sql;
  }

  import() {
    if (this.uploaded === undefined) throw new Error("No SQL bytes were uploaded for restore.");
    this.database.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
    try {
      this.database.exec(this.uploaded);
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys=ON;");
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
