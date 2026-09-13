import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const input = "export const value={key:1}\n";

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "keepr-format-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  for (const file of [".prettierignore", "prettier.config.mjs", "scripts/format.mjs"]) cpSync(file, join(root, file));
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe", timeout: 10_000 });
  const write = (file, contents = input) => {
    mkdirSync(resolve(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), contents);
  };
  const read = (file) => readFileSync(join(root, file), "utf8");
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/format.mjs", ...args], { cwd: root, encoding: "utf8", timeout: 10_000 });
  git("init", "--initial-branch=main");
  git("config", "user.name", "Formatter contract");
  git("config", "user.email", "formatter@example.invalid");
  git("config", "commit.gpgsign", "false");
  return { git, write, read, run };
}

test(
  "format selects branch and working changes while preserving unchanged and excluded files",
  { timeout: 30_000 },
  (t) => {
    const { git, write, read, run } = workspace(t);
    for (const file of ["untouched.mjs", "staged.mjs", "unstaged.mjs"]) write(file);
    git("add", ".");
    git("commit", "-m", "Baseline");
    git("switch", "-c", "change");
    write("committed.mjs");
    git("add", "committed.mjs");
    git("commit", "-m", "Committed change");
    for (const file of ["staged.mjs", "unstaged.mjs"]) write(file, `${input}export const second=2\n`);
    git("add", "staged.mjs");
    write("untracked space.mjs");
    write("changed.md", "## Heading\n\n-   Item\n");
    write("changed.yaml", "value:   1\n");
    write("changed.jsonc", '{// retained comment\n"value":1,}\n');
    write("tsconfig.json", '{// retained comment\n"compilerOptions":{"strict":true,},}\n');
    const excluded = [
      "untouched.mjs",
      "acceptance/fixtures/retained.mjs",
      "apps/api/worker-configuration.d.ts",
      "src/catalogue/shared/document-validators.mjs",
      "prototype/throwaway.mjs",
      "pnpm-lock.yaml",
    ];
    for (const file of excluded.slice(1)) write(file);
    const before = run("--check");
    assert.equal(before.status, 1, before.stdout + before.stderr);
    for (const file of [
      "committed.mjs",
      "staged.mjs",
      "unstaged.mjs",
      "untracked space.mjs",
      "changed.md",
      "changed.yaml",
      "changed.jsonc",
      "tsconfig.json",
    ])
      assert.ok(before.stderr.includes(file), `Missing selection: ${file}`);
    const written = run();
    assert.equal(written.status, 0, written.stdout + written.stderr);
    const after = run("--check");
    assert.equal(after.status, 0, after.stdout + after.stderr);
    for (const file of excluded) assert.equal(read(file), input, `Should be excluded: ${file}`);
  },
);

test(
  "format checks unpushed main commits against origin/main and honors an explicit base",
  { timeout: 30_000 },
  (t) => {
    const { git, write, read, run } = workspace(t);
    write("untouched.mjs");
    git("add", ".");
    git("commit", "-m", "Remote baseline");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    write("committed.mjs");
    git("add", "committed.mjs");
    git("commit", "-m", "Local main change");
    const before = run("--check");
    assert.equal(before.status, 1, before.stdout + before.stderr);
    assert.ok(before.stderr.includes("committed.mjs"));
    const explicit = run("--check", "--since=main");
    assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr);
    const written = run();
    assert.equal(written.status, 0, written.stdout + written.stderr);
    assert.equal(read("committed.mjs"), "export const value = { key: 1 };\n");
    assert.equal(read("untouched.mjs"), input);
    const after = run("--check");
    assert.equal(after.status, 0, after.stdout + after.stderr);
  },
);
