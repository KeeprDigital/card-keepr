import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as schemaQueries from "./helpers/query-helpers/schema.mjs";

const root = resolve(import.meta.dirname, "..");

// ADR 0006: migrations/0001_baseline.sql replaces the 36-file chain that
// ended at level 36. The chain's last commit is the source of truth for the
// baseline's schema DDL; that digest was computed from it and is recorded
// in the ADR. The digest check always runs; when the commit is present
// locally (it is not in a shallow CI checkout) the chain is also replayed
// and diffed object by object so a mismatch names the object.
//
// Seed rows are no longer compared with the chain: under ADR 0008 the
// baseline's source_adapter_versions seed was edited in place (#134, #135)
// and legitimately diverges. The baseline's own seed digest is pinned
// instead so an unintended seed change still fails here.
const chainCommit = "30751a2a46548530d48dc37a1dc507efbbd07c03";
const chainLevel = 36;
const chainSchemaDigest = "4e16338cc27afa79f3ac39bacee5c36ad4807bb09a41d8ea06fcf2fdc78c1bf4";
const baselineSeedDigest = "f5523576e21a352acd13f70a41fe5cdb5fd067d6bd4e2abc78f1c7d0dbe5856e";

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

test("the baseline schema equals the level-36 chain and its seed rows are pinned", async () => {
  const baseline = new DatabaseSync(":memory:");
  baseline.exec(await readFile(resolve(root, "migrations", "0001_baseline.sql"), "utf8"));
  const baselineSchema = schemaObjects(baseline);
  const baselineSeeds = schemaQueries.seedRows(baseline);
  assert.equal(schemaLevel(baseline), 1);
  baseline.close();

  const chain = chainDatabase();
  if (chain !== null) {
    assert.equal(schemaLevel(chain), chainLevel);
    assert.deepEqual(baselineSchema, schemaObjects(chain));
    chain.close();
  }
  assert.equal(digest(baselineSchema), chainSchemaDigest);
  assert.equal(digest(baselineSeeds), baselineSeedDigest);
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
