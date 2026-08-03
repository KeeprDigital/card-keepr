export type ProductionSourceFixtureRole =
  | "retained-discovery"
  | "surface";

const requestRoleSuffix =
  /;\s*request-role=(?:surface|listing|detail|product_detail|image)(?=;|$)/gu;

export function productionSourceFixtureRole(
  headers: Headers,
): ProductionSourceFixtureRole {
  const role = headers.get("user-agent")?.match(
    /(?:^|;\s*)request-role=(surface|listing|detail|product_detail|image)(?:;|$)/u,
  )?.[1];
  return role === undefined ? "retained-discovery" : "surface";
}

export function productionSourceFixtureMarker(
  headers: Headers,
): string | null {
  return headers.get("user-agent")?.replace(requestRoleSuffix, "") ?? null;
}

export function productionOfficialStageResponse(
  lineage: string,
  request: Request,
  officialNavigation: string,
): Response {
  const url = new URL(request.url);
  return new Response(
    `<html><title>Official Bandai CARD PRODUCT RELEASE RULE ERRATA RESTRICTION publication</title>${officialNavigation}${productionOfficialStageNavigation(lineage, url)}<main>${
      url.pathname === "/fw/en/rules/banned-limited-cards/" ||
        (
          url.hostname === "world.digimoncard.com" &&
          url.pathname === "/rule/restriction_card/"
        ) ||
        (
          url.hostname === "en.onepiece-cardgame.com" &&
          (
            url.pathname === "/rules/restriction/" ||
            url.pathname === "/rules/block_icon/" ||
            url.pathname === "/rules/"
          )
        )
        ? "<p>0 records</p>"
        : ""
    }<article data-publication-empty="true">No published entries.</article></main></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        etag: `"official-${url.pathname.replaceAll("/", "-")}"`,
      },
    },
  );
}

function productionOfficialStageNavigation(lineage: string, url: URL): string {
  const path = `${url.pathname}${url.search}`;
  if (lineage === "one-piece-en" && path === "/rules/") {
    return `<nav aria-label="Rules publications">
      <a href="/rules/restriction/">Restriction Cards</a>
      <a href="/rules/block_icon/">Block Policy</a>
      <a href="/rules/errata_card/">Errata Cards</a>
    </nav>`;
  }
  if (lineage === "fusion-world-en" && path === "/fw/en/news/01_31.html") {
    return `<nav aria-label="Rules publications">
      <a href="/fw/en/rules/banned-limited-cards/">Current banned and limited cards</a>
      <a href="/fw/en/rules/banned-limited-cards/?view=history">Previous restriction history</a>
      <a href="/fw/en/rules/errata-card/">Errata Cards</a>
    </nav>`;
  }
  if (lineage === "digimon-en" && path === "/cardlist/") {
    return `<nav><a href="/cards/index.php?search=true">Card List</a></nav>`;
  }
  if (lineage === "digimon-en" && path === "/rule/") {
    return `<nav aria-label="Rules publications">
      <a href="/rule/restriction_card/">Current restriction cards</a>
      <a href="/rule/restriction_card/?view=history">Previous restriction history</a>
      <a href="/rule/errata_card/">Errata Cards</a>
    </nav>`;
  }
  if (lineage.startsWith("gundam-") && /\/cards\/$/u.test(path)) {
    return `<nav><a href="index.php">Find Cards</a></nav>`;
  }
  if (lineage.startsWith("gundam-") && /\/news\/$/u.test(path)) {
    return `<nav><a href="?subcategory=rules">Errata and corrections</a></nav>`;
  }
  return "";
}
