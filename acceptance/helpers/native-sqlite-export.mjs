import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

// Stream the CLI output to disk so retained evidence is not constrained by
// execFileSync's stdout buffer. The fixture still parses the complete SQL below.
export async function nativeSqliteExport(databasePath, outputPath) {
  const child = spawn("/usr/bin/sqlite3", [databasePath, ".dump"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const completed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`SQLite export failed (${code}): ${stderr}`)),
    );
  });
  const written = pipeline(child.stdout, createWriteStream(outputPath));
  try {
    await Promise.all([written, completed]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.allSettled([written, completed, closed]);
    throw error;
  }
  return readFile(outputPath, "utf8");
}
