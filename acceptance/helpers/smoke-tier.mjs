// The Gundam flow proves both regional lineages and their shared provenance.
export const smokeFlows = Object.freeze([
  { file: "one-piece-catalogue.test.mjs", lineages: ["one-piece-en"] },
  { file: "fusion-world-catalogue.test.mjs", lineages: ["fusion-world-en"] },
  { file: "digimon-catalogue.test.mjs", lineages: ["digimon-en"] },
  { file: "gundam-catalogue.test.mjs", lineages: ["gundam-en-asia", "gundam-en-us"] },
  { file: "source-evidence-cli.test.mjs", cli: true, lineages: [] },
]);

export function isWranglerSmokeFile(path) {
  return smokeFlows.some(({ file }) => path?.endsWith(`/acceptance/${file}`));
}
