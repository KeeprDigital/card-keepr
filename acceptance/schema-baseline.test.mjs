import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

// ADR 0006: migrations/0001_baseline.sql replaces the 36-file chain that
// ended at level 36. The chain's last commit is the source of truth for the
// baseline's schema and seed rows; these digests were computed from it and
// are recorded in the ADR. The digest checks always run; when the commit is
// present locally (it is not in a shallow CI checkout) the chain is also
// replayed and diffed object by object so a mismatch names the object.
const chainCommit = "30751a2a46548530d48dc37a1dc507efbbd07c03";
const chainLevel = 36;
const chainSchemaDigest = "4e16338cc27afa79f3ac39bacee5c36ad4807bb09a41d8ea06fcf2fdc78c1bf4";
const chainSeedDigest = "6955a52bb80e757e765b5d6db9e1db025b1e16d0f849771719ae89e2ca00b1c0";

test("the baseline is the first migration and a fresh apply yields level 1", async () => {
  const names = await migrationNames();
  assert.equal(names[0], "0001_baseline.sql");
  const database = new DatabaseSync(":memory:");
  database.exec(await readFile(resolve(root, "migrations", names[0]), "utf8"));
  assert.equal(schemaLevel(database), 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(
    database.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  database.close();
});

test("the baseline schema and seed rows equal the level-36 chain", async () => {
  const baseline = new DatabaseSync(":memory:");
  baseline.exec(
    await readFile(resolve(root, "migrations", "0001_baseline.sql"), "utf8"),
  );
  const baselineSchema = schemaObjects(baseline);
  const baselineSeeds = seedRows(baseline);
  assert.equal(schemaLevel(baseline), 1);
  baseline.close();

  const chain = chainDatabase();
  if (chain !== null) {
    assert.equal(schemaLevel(chain), chainLevel);
    assert.deepEqual(baselineSchema, schemaObjects(chain));
    assert.deepEqual(baselineSeeds, seedRows(chain));
    chain.close();
  }
  assert.equal(digest(baselineSchema), chainSchemaDigest);
  assert.equal(digest(baselineSeeds), chainSeedDigest);
});

// Replays the 36-file chain from git history, or returns null when the
// commit is not in the checkout (a shallow clone). Any other git failure
// propagates so the proof cannot silently degrade to the digest check.
function chainDatabase() {
  try {
    execFileSync("git", ["cat-file", "-e", `${chainCommit}^{commit}`], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    return null;
  }
  const names = git(["ls-tree", "--name-only", chainCommit, "migrations/"])
    .split("\n").filter((name) => name.endsWith(".sql")).sort();
  const database = new DatabaseSync(":memory:");
  for (const name of names) database.exec(git(["show", `${chainCommit}:${name}`]));
  return database;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function schemaObjects(database) {
  return database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
  ).all().map((row) => ({
    type: row.type,
    name: row.name,
    tbl_name: row.tbl_name,
    sql: row.sql === null ? null : normalizeSql(row.sql),
  }));
}

// sqlite_schema stores DDL text as written, so a column added by ALTER TABLE
// lands with the ALTER statement's spacing and a table renamed into place
// keeps its quoted name. Equality is proven at the token level: comments,
// identifier quotes, and whitespace around punctuation carry no meaning.
function normalizeSql(sql) {
  return sql
    .replace(/--[^\n]*/gu, "")
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/gu, "$1")
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),])\s*/gu, "$1")
    .trim();
}

// Every row of every table except the schema level itself, which is the one
// value the baseline deliberately changes.
function seedRows(database) {
  const tables = database.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type = 'table' AND name NOT IN ('catalogue_schema_state')
     ORDER BY name`,
  ).all().map((row) => row.name);
  const seeds = {};
  for (const table of tables) {
    const rows = database.prepare(`SELECT * FROM "${table}"`).all()
      .map((row) => JSON.stringify(row, blobsAsHex))
      .sort();
    if (rows.length > 0) seeds[table] = rows;
  }
  return seeds;
}

function blobsAsHex(_key, value) {
  return value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function schemaLevel(database) {
  return database.prepare(
    "SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1",
  ).get().migration_level;
}

async function migrationNames() {
  return (await readdir(resolve(root, "migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
}
