import { build } from "esbuild";
import { resolve } from "node:path";

let migration;

// Load the same test-only registrations used by the Workers tests. The bundle
// resolves TypeScript imports without maintaining a second adapter/SQL inventory.
export async function syntheticSourceAdapterMigrations() {
  migration ??= build({
    entryPoints: [resolve(import.meta.dirname, "../../test/support/source-adapters/migration.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  }).then(async (result) => {
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
    );
    return [module.syntheticSourceAdapterMigration];
  });
  return migration;
}
