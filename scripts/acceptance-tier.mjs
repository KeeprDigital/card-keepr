import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { smokeFlows } from "../acceptance/helpers/smoke-tier.mjs";

const tier = process.argv[2];
if (!["smoke", "runtime"].includes(tier)) {
  console.error("usage: node scripts/acceptance-tier.mjs <smoke|runtime>");
  process.exit(2);
}
const root = resolve(import.meta.dirname, "..");
const smoke = new Set(smokeFlows.map(({ file }) => file));
const files = (await readdir(resolve(root, "acceptance")))
  .filter((name) => name.endsWith(".test.mjs") && smoke.has(name) === (tier === "smoke"))
  .sort();
console.log(`${tier}: ${files.join(" ")}`);
const child = spawn(process.execPath, ["--test", ...files.map((name) => `acceptance/${name}`)], {
  cwd: root,
  stdio: "inherit",
});
child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
