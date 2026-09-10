import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = mkdtempSync(join(tmpdir(), "eslint-303-format-"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const input = "export const value={key:1}\n";
const write = (file) => writeFileSync(join(root, file), input);
try {
  mkdirSync(join(root, "scripts"));
  for (const file of [".prettierignore", "prettier.config.mjs", "scripts/format.mjs"]) cpSync(file, join(root, file));
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  git("init", "--initial-branch=main");
  git("config", "user.name", "Formatter contract");
  git("config", "user.email", "formatter@example.invalid");
  git("config", "commit.gpgsign", "false");
  for (const file of ["untouched.mjs", "staged.mjs", "unstaged.mjs"]) write(file);
  git("add", ".");
  git("commit", "-m", "Formatter experiment baseline");
  git("switch", "-c", "experiment");
  write("committed.mjs");
  git("add", "committed.mjs");
  git("commit", "-m", "Formatter experiment committed change");
  for (const file of ["staged.mjs", "unstaged.mjs"]) writeFileSync(join(root, file), `${input}export const second=2\n`);
  git("add", "staged.mjs");
  write("untracked space.mjs");
  writeFileSync(join(root, "changed.md"), "## Heading\n\n-   Item\n");
  writeFileSync(join(root, "changed.yaml"), "value:   1\n");
  writeFileSync(join(root, "changed.jsonc"), '{// retained comment\n"value":1,}\n');
  writeFileSync(join(root, "tsconfig.json"), '{// retained comment\n"compilerOptions":{"strict":true,},}\n');
  mkdirSync(join(root, "acceptance/fixtures"), { recursive: true });
  mkdirSync(join(root, "apps/api"), { recursive: true });
  write("acceptance/fixtures/retained.mjs");
  write("apps/api/worker-configuration.d.ts");
  const excluded = [
    "untouched.mjs",
    "acceptance/fixtures/retained.mjs",
    "apps/api/worker-configuration.d.ts",
    "src/catalogue/shared/document-validators.mjs",
    "prototype/throwaway.mjs",
    "eslint/fixtures/invalid.mjs",
    "pnpm-lock.yaml",
  ];
  for (const file of excluded.slice(3)) {
    mkdirSync(resolve(root, file, ".."), { recursive: true });
    write(file);
  }
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/format.mjs", "--prettier", ...args, "--since=main"], {
      cwd: root,
      encoding: "utf8",
    });
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
  assert.equal(run().status, 0);
  const after = run("--check");
  assert.equal(after.status, 0, after.stdout + after.stderr);
  for (const file of excluded)
    assert.equal(readFileSync(join(root, file), "utf8"), input, `Should be excluded: ${file}`);
  console.log(
    "PASS: merge-base commit, staged, unstaged and untracked filenames with spaces; unchanged source, generated declarations and retained fixtures excluded.",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
