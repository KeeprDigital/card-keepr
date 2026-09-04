import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as schemaQueries from "./helpers/query-helpers/schema.mjs";

const root = resolve(import.meta.dirname, "..");

// #136 folds the final pre-Go-Live chain into one baseline. Compare logical
// schema, seeds and trigger creation order against the retained git commit.
// The chain left an empty sqlite_sequence after deleting its last AUTOINCREMENT
// table; that unused SQLite internal object is the sole schema exclusion.
const chainCommit = "23b1b1128cf9bf5827034d15dcaebf1964ce7c76";
const chainLevel = 13;
const chainSchemaDigest = "12c3e223cdcb1623e1a362307eea051b36797b4735a95a18d96dfb067f1b2a60";
const baselineSeedDigest = "0a7b7d721a7e6d343ca38e607c4285ab46ea32856802a4f2b6a4d35733cc5483";

test("the baseline is the first migration and a fresh apply yields level 1", async () => {
  const names = await migrationNames();
  assert.equal(names[0], "0001_baseline.sql");
  const database = new DatabaseSync(":memory:");
  database.exec(await readFile(resolve(root, "migrations", names[0]), "utf8"));
  assert.equal(schemaLevel(database), 1);
  assert.deepEqual(schemaQueries.foreignKeyViolations(database).all(), []);
  assert.equal(schemaQueries.integrityCheck(database).get().integrity_check, "ok");
  database.close();
});

test("the baseline preserves the final pre-Go-Live schema, seeds and trigger order", async () => {
  const baseline = new DatabaseSync(":memory:");
  baseline.exec(await readFile(resolve(root, "migrations", "0001_baseline.sql"), "utf8"));
  const baselineSchema = schemaObjects(baseline);
  const baselineSeeds = schemaQueries.seedRows(baseline);
  const baselineTriggers = schemaQueries.triggerCreationOrder(baseline).all();
  assert.equal(schemaLevel(baseline), 1);
  baseline.close();

  const chain = chainDatabase();
  if (chain !== null) {
    assert.equal(schemaLevel(chain), chainLevel);
    assert.deepEqual(baselineSchema, schemaObjects(chain));
    assert.deepEqual(baselineSeeds, schemaQueries.seedRows(chain));
    assert.deepEqual(baselineTriggers, schemaQueries.triggerCreationOrder(chain).all());
    assert.deepEqual(schemaQueries.orphanSequenceRows(chain).all(), []);
    assert.ok(
      schemaQueries
        .schemaDefinitionRows(chain)
        .all()
        .every(({ sql }) => !/AUTOINCREMENT/u.test(sql ?? "")),
    );
    chain.close();
  }
  assert.equal(digest(baselineSchema), chainSchemaDigest);
  assert.equal(digest(baselineSeeds), baselineSeedDigest);
});

// Replays the final pre-Go-Live chain from git history, or returns null when the
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
    .split("\n")
    .filter((name) => name.endsWith(".sql"))
    .sort();
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
  return schemaQueries
    .schemaDefinitionRows(database)
    .all()
    .filter((row) => row.name !== "sqlite_sequence")
    .map((row) => ({
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

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function schemaLevel(database) {
  return schemaQueries.schemaMigrationLevel(database).get().migration_level;
}

async function migrationNames() {
  return (await readdir(resolve(root, "migrations"))).filter((name) => name.endsWith(".sql")).sort();
}
