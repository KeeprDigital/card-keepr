export type ProductionSourceFixtureRole =
  | "retained-discovery"
  | "surface";

const requestRoleSuffix =
  /;\s*request-role=(?:surface|listing|detail|product_detail|image)(?=;|$)/gu;
const requestSurfaceSuffix =
  /;\s*request-surface=[a-z0-9]+(?:-[a-z0-9]+)*(?=;|$)/gu;

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
  return headers.get("user-agent")
    ?.replace(requestRoleSuffix, "")
    .replace(requestSurfaceSuffix, "") ?? null;
}

export function productionSourceFixtureSurface(
  headers: Headers,
): string | null {
  return headers.get("user-agent")?.match(
    /(?:^|;\s*)request-surface=([a-z0-9]+(?:-[a-z0-9]+)*)(?:;|$)/u,
  )?.[1] ?? null;
}

export function productionRepresentableFusionLegalityResponse(
  request: Request,
): Response | null {
  const url = new URL(request.url);
  if (
    url.href !== "https://www.dbs-cardgame.com/fw/en/news/01_305.html" ||
    productionSourceFixtureMarker(request.headers) !==
      "card-keepr-representable-legality-v3" ||
    productionSourceFixtureRole(request.headers) !== "surface" ||
    productionSourceFixtureSurface(request.headers) !== "legality-current"
  ) return null;
  const wording =
    "FB01-001 is eligible 'as printed' – publisher–confirmed &#39;literal&#39;.";
  const payload = {
    publication: "fusion-world-legality-current",
    revision: "2026-08",
    declared_record_count: 1,
    partition: { page: 1, pages: 1, total: 1, has_next: false },
    entries: [{
      rule_ref: "fw_production_eligible",
      notice: wording,
      market: "EN-OCEANIA",
      play_format: "standard",
      tier: null,
      active_on: "2026-01-01",
      expires_on: null,
      cards: ["FB01-001"],
      directive: "eligible",
    }],
  };
  return new Response(
    `<html><title>BANDAI DRAGON BALL CARD RULE RESTRICTION</title>
      <script id="fusion-world-card-game-legality-current-data" type="application/json">${
        JSON.stringify(payload)
      }</script>
      <main><p>1 record</p><article class="restriction-card"><dl>
        <dt>Rule Ref</dt><dd>fw_production_eligible</dd>
        <dt>Notice</dt><dd>FB01-001 is eligible &#39;as printed&#39; &#x2013; publisher&ndash;confirmed &amp;#39;literal&amp;#39;.</dd>
        <dt>Market</dt><dd>EN-OCEANIA</dd>
        <dt>Play Format</dt><dd>standard</dd>
        <dt>Tier</dt><dd>-</dd>
        <dt>Active On</dt><dd>2026-01-01</dd>
        <dt>Expires On</dt><dd>-</dd>
        <dt>Cards</dt><dd>FB01-001</dd>
        <dt>Directive</dt><dd>eligible</dd>
      </dl></article></main></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        etag: '"card-keepr-representable-legality-v3"',
      },
    },
  );
}

export function productionOfficialStageResponse(
  lineage: string,
  request: Request,
  officialNavigation: string,
): Response {
  const url = new URL(request.url);
  return new Response(
    `<html><title>Official Bandai CARD PRODUCT RELEASE RULE ERRATA RESTRICTION publication</title>${officialNavigation}${productionOfficialStageNavigation(lineage, url)}<main>${
      url.pathname === "/fw/en/news/01_305.html" ||
        url.pathname === "/fw/en/news/01_399.html" ||
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
      <a href="/fw/en/news/01_305.html">Current banned and limited cards</a>
      <a href="/fw/en/news/01_399.html">Previous restriction history</a>
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
