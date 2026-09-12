// Routine tests cover bounded application behavior. Retained-data journeys and
// measurement tools require explicit selection so a typo cannot start every
// expensive experiment.
export const extendedAcceptanceFiles = Object.freeze([
  "composed-recovery.test.mjs",
  "one-piece-two-source.test.mjs",
  "riftbound-catalogue.test.mjs",
]);
export const benchmarkAcceptanceFiles = Object.freeze([
  "native-isolate-metrics.test.mjs",
  "native-sqlite-export.test.mjs",
]);
const smokeFiles = new Set(["source-evidence-cli.test.mjs", "riftbound-bounded-intake.test.mjs"]);
export const acceptanceTiers = Object.freeze(["default", "smoke", "extended", "benchmark"]);

export function selectAcceptanceFiles(files, tier = "default") {
  if (!acceptanceTiers.includes(tier)) throw new Error(`Unknown acceptance tier: ${tier}`);
  return files
    .filter((file) => {
      if (!file.endsWith(".test.mjs")) return false;
      const extended = extendedAcceptanceFiles.includes(file);
      const benchmark = benchmarkAcceptanceFiles.includes(file);
      if (tier === "extended") return extended;
      if (tier === "benchmark") return benchmark;
      if (extended || benchmark) return false;
      if (tier === "smoke") return smokeFiles.has(file);
      return true;
    })
    .sort();
}
