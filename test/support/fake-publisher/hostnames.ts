// The one hostname routing table every fake-publisher layer resolves through:
// the ingestion vitest outbound mock, the synthetic Official Source wrangler
// worker behind the acceptance harness, and the runtime-free contract tests.

export type OfficialLineage =
  | "one-piece-en"
  | "fusion-world-en"
  | "digimon-en"
  | "gundam-en-asia"
  | "gundam-en-us";

export const officialLineageHostnames: Record<string, OfficialLineage> = {
  "en.onepiece-cardgame.com": "one-piece-en",
  "www.dbs-cardgame.com": "fusion-world-en",
  "world.digimoncard.com": "digimon-en",
};

// Both Gundam lineages publish from one hostname and differ by locale path.
export const gundamHostname = "www.gundam-gcg.com";

// Synthetic (non-Bandai) publishers the workers-pool suites address; every
// hostname under this suffix resolves to the synthetic Official Source
// handlers, so one test file's failure-injection scope never collides with
// another's.
export const syntheticOfficialSourceHostSuffix = "official-source.invalid";

export function officialLineageForUrl(url: URL): OfficialLineage | null {
  const lineage = officialLineageHostnames[url.hostname];
  if (lineage !== undefined) return lineage;
  if (url.hostname === gundamHostname) {
    return url.pathname.startsWith("/asia-en/")
      ? "gundam-en-asia"
      : "gundam-en-us";
  }
  return null;
}

export function isSyntheticOfficialSourceHost(url: URL): boolean {
  return url.hostname.endsWith(syntheticOfficialSourceHostSuffix);
}
