export const officialSourceAuthorities: Readonly<
  Record<
    string,
    { sourceOrigin: string; documentPathnamePrefixes: readonly string[]; imagePathnamePrefixes: readonly string[] }
  >
> = {
  "one-piece-en": {
    sourceOrigin: "https://en.onepiece-cardgame.com",
    documentPathnamePrefixes: ["/cardlist/", "/products/", "/rules/", "/news/", "/topics/"],
    imagePathnamePrefixes: ["/images/"],
  },
  "fusion-world-en": {
    sourceOrigin: "https://www.dbs-cardgame.com",
    documentPathnamePrefixes: ["/fw/en/"],
    imagePathnamePrefixes: ["/fw/images/"],
  },
  "digimon-en": {
    sourceOrigin: "https://world.digimoncard.com",
    documentPathnamePrefixes: ["/cards/", "/cardlist/", "/products/", "/rule/"],
    imagePathnamePrefixes: ["/images/"],
  },
  "gundam-en-asia": {
    sourceOrigin: "https://www.gundam-gcg.com",
    documentPathnamePrefixes: ["/asia-en/"],
    imagePathnamePrefixes: ["/asia-en/", "/jp/images/cards/card/", "/gcg/bccard/asia-en/"],
  },
  "gundam-en-us": {
    sourceOrigin: "https://www.gundam-gcg.com",
    documentPathnamePrefixes: ["/en/"],
    imagePathnamePrefixes: ["/en/", "/jp/images/cards/card/", "/gcg/bccard/en/"],
  },
};

export function officialUrl(sourceLineage: string, url: URL, role: "document" | "image"): boolean {
  const contract = officialSourceAuthorities[sourceLineage];
  return (
    contract !== undefined &&
    url.origin === contract.sourceOrigin &&
    contract[role === "image" ? "imagePathnamePrefixes" : "documentPathnamePrefixes"].some((prefix) =>
      url.pathname.startsWith(prefix),
    ) &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
  );
}
