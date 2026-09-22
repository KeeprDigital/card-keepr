import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultOwnerEnvDeps, OwnerEnvError, parseOwnerEnv, withOwnerEnvironment } from "../cli/owner-env.mjs";

/** A main checkout with a committed .gitignore and one linked worktree, like a release checkout. */
async function checkouts(t, { ignoreEnv = true } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "keepr-owner-env-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const main = join(directory, "main");
  const worktree = join(directory, "release");
  await mkdir(main);
  const git = (...args) =>
    execFileSync("git", [
      "-C",
      main,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]);
  git("init", "--quiet");
  await writeFile(join(main, ".gitignore"), ignoreEnv ? ".env\n.env.*\n!.env.example\n" : "node_modules\n");
  git("add", ".gitignore");
  git("commit", "--quiet", "-m", "init");
  git("worktree", "add", "--quiet", "--detach", worktree);
  return { directory, main, worktree, deps: defaultOwnerEnvDeps({ checkout: worktree }) };
}

test("parsing is literal: no expansion, outer quotes only", () => {
  assert.deepEqual(parseOwnerEnv('# c\nexport A=\'x y\'\nB="$(no)"\n  C=plain\nD="$HOME\nnot a line\n'), {
    A: "x y",
    B: "$(no)",
    C: "plain",
    D: '"$HOME',
  });
});

test("a release worktree reads the main checkout's ignored .env and explicit variables win", async (t) => {
  const { main, worktree, deps } = await checkouts(t);
  await writeFile(join(main, ".env"), "KEEPR_STAGING_API_KEY=from-main\nKEEPR_GITHUB_RELEASE_TOKEN=from-file\n", {
    mode: 0o600,
  });
  await writeFile(join(worktree, ".env"), "KEEPR_STAGING_API_KEY=from-worktree\n", { mode: 0o600 });
  const environment = await withOwnerEnvironment({ KEEPR_GITHUB_RELEASE_TOKEN: "explicit", PATH: "p" }, deps);
  assert.deepEqual(environment, {
    KEEPR_GITHUB_RELEASE_TOKEN: "explicit",
    PATH: "p",
    KEEPR_STAGING_API_KEY: "from-main",
  });
});

test("a missing default .env adds nothing", async (t) => {
  const { deps } = await checkouts(t);
  assert.deepEqual(await withOwnerEnvironment({ A: "1" }, deps), { A: "1" });
});

test("an in-repository file that git does not ignore is refused", async (t) => {
  const { main, deps } = await checkouts(t, { ignoreEnv: false });
  await writeFile(join(main, ".env"), "KEEPR_STAGING_API_KEY=value\n", { mode: 0o600 });
  await assert.rejects(withOwnerEnvironment({}, deps), (error) => {
    assert.ok(error instanceof OwnerEnvError);
    assert.match(error.message, /inside the repository and not git-ignored/u);
    assert.doesNotMatch(error.message, /value/u);
    return true;
  });
  await writeFile(join(main, "owner.env"), "A=1\n", { mode: 0o600 });
  await assert.rejects(
    withOwnerEnvironment({ KEEPR_OWNER_ENV_FILE: join(main, "owner.env") }, deps),
    /not git-ignored/u,
  );
});

test("KEEPR_OWNER_ENV_FILE overrides the default and must be absolute and readable", async (t) => {
  const { directory, main, deps } = await checkouts(t);
  await writeFile(join(main, ".env"), "KEEPR_STAGING_API_KEY=from-main\n", { mode: 0o600 });
  const outside = join(directory, "owner.env");
  await writeFile(outside, "export KEEPR_STAGING_API_KEY=from-override\n", { mode: 0o600 });
  assert.deepEqual(await withOwnerEnvironment({ KEEPR_OWNER_ENV_FILE: outside }, deps), {
    KEEPR_OWNER_ENV_FILE: outside,
    KEEPR_STAGING_API_KEY: "from-override",
  });
  await assert.rejects(withOwnerEnvironment({ KEEPR_OWNER_ENV_FILE: "owner.env" }, deps), /must be an absolute path/u);
  await assert.rejects(
    withOwnerEnvironment({ KEEPR_OWNER_ENV_FILE: join(directory, "absent.env") }, deps),
    /is not readable/u,
  );
  assert.deepEqual(await withOwnerEnvironment({ KEEPR_OWNER_ENV_FILE: "/dev/null" }, deps), {
    KEEPR_OWNER_ENV_FILE: "/dev/null",
  });
});

test("the CLI refuses an owner file that sets the un-targeted local profile", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-owner-env-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "owner.env");
  await writeFile(file, "KEEPR_API_URL=https://card.keepr.digital/api\nKEEPR_API_KEY=synthetic-secret\n", {
    mode: 0o600,
  });
  const result = spawnSync(process.execPath, ["cli/keepr.mjs", "health", "--json"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, KEEPR_OWNER_ENV_FILE: file },
  });
  assert.equal(result.status, 2);
  const problem = JSON.parse(result.stdout);
  assert.equal(problem.code, "configuration_error");
  assert.match(problem.detail, /sets KEEPR_API_URL, KEEPR_API_KEY; use --target/u);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret/u);
});
