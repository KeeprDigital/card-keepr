import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";

/** The native parser handles SQL quoting, triggers and statements spanning stream chunks. */
export async function sqliteFileCommand(args: string[], files: { input?: string; output?: string } = {}) {
  const child = spawn("/usr/bin/sqlite3", ["-bail", "-init", "/dev/null", ...args], {
    stdio: [files.input ? "pipe" : "ignore", files.output ? "pipe" : "ignore", "pipe"],
    timeout: 300_000,
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`SQLite transfer failed (${code ?? signal}): ${stderr}`)),
    );
  });
  const work = [completed];
  if (files.input) work.push(pipeline(createReadStream(files.input), child.stdin!));
  if (files.output) work.push(pipeline(child.stdout!, createWriteStream(files.output, { flags: "wx" })));
  try {
    await Promise.all(work);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.allSettled([...work, closed]);
    throw error;
  }
}

export type SqliteExportFile = { path: string; bytes: number };

export function sqliteExportResponse(file: SqliteExportFile) {
  const input = createReadStream(file.path);
  const iterator = input[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel() {
      input.destroy();
    },
  });
  return new Response(body, {
    headers: { "content-length": String(file.bytes) },
  });
}

/** Locate only the owning test runtime's catalogue, never another project's database. */
export async function localCatalogueDatabase(directory: string) {
  const files = await readdir(directory, { recursive: true });
  const matches: string[] = [];
  for (const name of files.filter((name) => name.endsWith(".sqlite"))) {
    const path = join(directory, name);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='catalogue_state'").get()) matches.push(path);
    } finally {
      db.close();
    }
  }
  if (matches.length !== 1) throw new Error(`Expected one local catalogue database; found ${matches.length}.`);
  return matches[0]!;
}

/** The native SQLite backup API pins a consistent snapshot without a giant JS value. */
export async function sqliteSnapshot(sourcePath: string, targetPath: string) {
  const quotedTarget = '"' + targetPath.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
  await sqliteFileCommand(["-readonly", sourcePath, `.backup ${quotedTarget}`]);
}

export async function exportSqliteFile(sourcePath: string, directory: string): Promise<SqliteExportFile> {
  const snapshot = join(directory, "export-snapshot.sqlite");
  const path = join(directory, "export.sql");
  await rm(path, { force: true });
  await rm(snapshot, { force: true });
  try {
    await sqliteSnapshot(sourcePath, snapshot);
    const copy = new DatabaseSync(snapshot, { readOnly: true });
    let internalTables: string[];
    try {
      internalTables = copy
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB '_cf_*'")
        .all()
        .map((row) => `DROP TABLE "${String(row.name).replaceAll('"', '""')}";`);
    } finally {
      copy.close();
    }
    // Apply metadata removal and dump through one native connection. A read-only
    // dump of a separately modified WAL file may be unable to open its journal.
    await sqliteFileCommand([snapshot, ...internalTables, ".dump"], { output: path });
    const bytes = (await stat(path)).size;
    // SQLite's .dump can exit zero after printing an error and ROLLBACK. Require
    // its completion trailer before advertising the file as a successful export.
    const output = await open(path, "r");
    try {
      const trailer = Buffer.alloc(9);
      const read = await output.read(trailer, 0, trailer.length, Math.max(0, bytes - trailer.length));
      if (read.bytesRead !== trailer.length || trailer.toString() !== "\nCOMMIT;\n")
        throw new Error("SQLite export did not complete its SQL dump.");
    } finally {
      await output.close();
    }
    return { path, bytes };
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    await rm(snapshot, { force: true });
  }
}
