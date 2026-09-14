import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runExtendedValidation } from "../scripts/staging-release.mjs";

for (const fail of [false, true])
  test(`extended staging runs each selected scenario through the actual selector and ${fail ? "stops at failure" : "retains every result"}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "keepr-staging-command-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const selector = resolve("scripts/acceptance-tier.mjs");
    await writeFile(
      join(directory, "pnpm"),
      `#!${process.execPath}\n` +
        `const { execFileSync } = require("node:child_process");\n` +
        `const args = process.argv.slice(2);\n` +
        `if (args[0] !== "run" || args[1] !== "test:acceptance:extended") process.exit(2);\n` +
        `execFileSync(process.execPath, [${JSON.stringify(selector)}, "extended", ...args.slice(2), "--list"], { stdio: "pipe" });\n` +
        `console.log(JSON.stringify({ scenario: args[2], credentials: ["GH_TOKEN", "CLOUDFLARE_API_TOKEN", "STAGING_ADMINISTRATION_KEY"].some(key => key in process.env) }));\n` +
        `if (${fail} && args[2] === "one-piece-two-source") process.exit(7);\n`,
      { mode: 0o700 },
    );
    const previous = Object.fromEntries(
      ["PATH", "GH_TOKEN", "CLOUDFLARE_API_TOKEN", "STAGING_ADMINISTRATION_KEY"].map((key) => [key, process.env[key]]),
    );
    t.after(() => {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
    Object.assign(process.env, {
      PATH: `${directory}:${process.env.PATH}`,
      GH_TOKEN: "synthetic-github-credential",
      CLOUDFLARE_API_TOKEN: "synthetic-deployment-credential",
      STAGING_ADMINISTRATION_KEY: "synthetic-administration-credential",
    });
    const scenarios = ["composed-recovery", "one-piece-two-source", "riftbound-catalogue"];
    if (fail) await assert.rejects(runExtendedValidation(scenarios, directory), /retained_source_rehearsal_failed/u);
    else
      assert.deepEqual(await runExtendedValidation(scenarios, directory), {
        exit_code: 0,
        results: scenarios.map((scenario) => ({ scenario, exit_code: 0 })),
      });
    assert.deepEqual(
      (await readFile(join(directory, "retained-source-rehearsal.log"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      scenarios.slice(0, fail ? 2 : 3).map((scenario) => ({ scenario, credentials: false })),
    );
  });
