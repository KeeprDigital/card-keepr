export type ProductionCollectionRequest = {
  id: string;
  method: "GET";
  url: string;
  headers: Record<string, string>;
};

export const fusionWorldProductionCollectionRequests = [
  {
    id: "fusion-world-en:card-search",
    method: "GET",
    url: "https://www.dbs-cardgame.com/fw/en/cardlist/",
    headers: { accept: "text/html" },
  },
  {
    id: "fusion-world-en:products",
    method: "GET",
    url: "https://www.dbs-cardgame.com/fw/en/products/",
    headers: { accept: "text/html" },
  },
  {
    id: "fusion-world-en:releases",
    method: "GET",
    url: "https://www.dbs-cardgame.com/fw/en/products/",
    headers: { accept: "text/html" },
  },
  {
    id: "fusion-world-en:legality-current",
    method: "GET",
    url:
      "https://www.dbs-cardgame.com/fw/en/rules/banned-limited-cards/",
    headers: { accept: "text/html" },
  },
  {
    id: "fusion-world-en:legality-history",
    method: "GET",
    url:
      "https://www.dbs-cardgame.com/fw/en/rules/banned-limited-cards/",
    headers: { accept: "text/html" },
  },
  {
    id: "fusion-world-en:errata",
    method: "GET",
    url: "https://www.dbs-cardgame.com/fw/en/rules/errata-card/",
    headers: { accept: "text/html" },
  },
] satisfies readonly ProductionCollectionRequest[];
export const onePieceProductionCollectionRequests = [
  {
    id: "one-piece-en:card-list",
    method: "GET",
    url: "https://en.onepiece-cardgame.com/cardlist/",
    headers: { accept: "text/html" },
  },
  {
    id: "one-piece-en:products",
    method: "GET",
    url: "https://en.onepiece-cardgame.com/products/",
    headers: { accept: "text/html" },
  },
  {
    id: "one-piece-en:releases",
    method: "GET",
    url: "https://en.onepiece-cardgame.com/products/",
    headers: { accept: "text/html" },
  },
  {
    id: "one-piece-en:restrictions",
    method: "GET",
    url: "https://en.onepiece-cardgame.com/rules/restriction/",
    headers: { accept: "text/html" },
  },
  {
    id: "one-piece-en:block-policy",
    method: "GET",
    url: "https://en.onepiece-cardgame.com/rules/block_icon/",
    headers: { accept: "text/html" },
  },
  {
    id: "one-piece-en:errata",
    method: "GET",
    url: "https://en.onepiece-cardgame.com/rules/errata_card/",
    headers: { accept: "text/html" },
  },
  {
    id: "one-piece-en:don-rules",
    method: "GET",
    url: "https://en.onepiece-cardgame.com/rules/",
    headers: { accept: "text/html" },
  },
] satisfies readonly ProductionCollectionRequest[];

export const digimonProductionCollectionRequests = [
  {
    id: "digimon-en:card-list",
    method: "GET",
    url: "https://world.digimoncard.com/cards/index.php?search=true",
    headers: { accept: "text/html" },
  },
  {
    id: "digimon-en:products",
    method: "GET",
    url: "https://world.digimoncard.com/products/",
    headers: { accept: "text/html" },
  },
  {
    id: "digimon-en:releases",
    method: "GET",
    url: "https://world.digimoncard.com/products/",
    headers: { accept: "text/html" },
  },
  {
    id: "digimon-en:restrictions-current",
    method: "GET",
    url: "https://world.digimoncard.com/rule/restriction_card/",
    headers: { accept: "text/html" },
  },
  {
    id: "digimon-en:restrictions-history",
    method: "GET",
    url: "https://world.digimoncard.com/rule/restriction_card/",
    headers: { accept: "text/html" },
  },
  {
    id: "digimon-en:errata",
    method: "GET",
    url: "https://world.digimoncard.com/rule/errata_card/",
    headers: { accept: "text/html" },
  },
] satisfies readonly ProductionCollectionRequest[];
