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

export function productionSourceFixtureIsProductDetail(
  headers: Headers,
): boolean {
  return /(?:^|;\s*)request-role=product_detail(?:;|$)/u.test(
    headers.get("user-agent") ?? "",
  );
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

// The restructured Fusion World card search serves one complete category
// listing per request. The synthetic leaf offers only the category the
// request already selected, so discovery derives no further partitions and
// the collection graph closes on the pinned surface alone.
function productionFusionCardSearchLeaf(
  url: URL,
  officialNavigation: string,
): Response | null {
  const categories = url.searchParams.getAll("category[0]");
  if (
    url.hostname !== "www.dbs-cardgame.com" ||
    url.pathname !== "/fw/en/cardlist/" ||
    url.searchParams.get("search") !== "true" ||
    categories.length !== 1 ||
    !/^\d+$/u.test(categories[0]!) ||
    [...url.searchParams.keys()].some((key) =>
      key !== "search" && key !== "category[0]"
    )
  ) return null;
  return new Response(
    `<html><title>Official Bandai DRAGON BALL CARD LIST publication</title>${officialNavigation}<main>
      <section class="searchColSet-product">
        <a href="javascript:void(0);" data-val="${categories[0]}">Filter by series</a>
      </section>
      <div class="resultTxt">Result<span class="num">0</span>cards</div>
      <article data-publication-empty="true">No published entries.</article>
    </main></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        etag: `"official-fusion-card-search-${categories[0]}"`,
      },
    },
  );
}

// Live product detail pages publish their identity through an exactly
// publisher-suffixed document title, so the generic production stage fixture
// serves that shape for every product_detail request. The title stays free of
// bracketed codes and of the accessory vocabulary, which keeps the derived
// Product code-less and name-referenced.
const officialProductTitleSuffix: Record<string, string> = {
  "one-piece-en": "｜ONE PIECE CARD GAME - Official Web Site",
  "digimon-en": "｜Digimon Card Game",
  "fusion-world-en":
    " | Dragon Ball Super Card Game Fusion World - Official Web Site",
  "gundam-en-asia": " | GUNDAM CARD GAME Official Website",
  "gundam-en-us": " | GUNDAM CARD GAME Official Website",
};

const officialProductStageTitle = "Official Bandai Product Publication";

function productionOfficialProductDetailResponse(
  lineage: string,
  url: URL,
): Response {
  const suffix = officialProductTitleSuffix[lineage] ?? "";
  return new Response(
    `<html><title>${officialProductStageTitle}${suffix}</title>
      <h1>BANDAI CARD GAMES</h1>${
      lineage.startsWith("gundam-")
        ? `<h2 class="mvColTitle">${officialProductStageTitle}</h2>`
        : ""
    }
      <main><article data-publication-empty="true">No published entries.</article></main>
    </html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        etag: `"official-product-detail-${url.pathname.replaceAll("/", "-")}"`,
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
  if (productionSourceFixtureIsProductDetail(request.headers)) {
    return productionOfficialProductDetailResponse(lineage, url);
  }
  if (lineage === "fusion-world-en") {
    const cardSearchLeaf = productionFusionCardSearchLeaf(
      url,
      officialNavigation,
    );
    if (cardSearchLeaf !== null) return cardSearchLeaf;
  }
  if (
    lineage === "one-piece-en" &&
    url.hostname === "en.onepiece-cardgame.com" &&
    `${url.pathname}${url.search}` === "/rules/"
  ) {
    // The issue-58 don-rules contract verifies the live hub identity and its
    // pinned policy links, so the synthetic hub mirrors the live shape: the
    // exact document title, the pinned restriction, block-policy, and errata
    // links, one additional rule-manual link, and no DON!! content.
    return new Response(
      `<html><title>RULES｜ONE PIECE CARD GAME - Official Web Site</title>
        ${officialNavigation}<nav aria-label="Rules publications">
        <a href="/news/restriction.html">Banned/Restricted Card Addition Notice</a>
        <a href="/topics/013.php">Introduction of the Block Number System</a>
        <a href="/rules/errata_card/">Errata Cards</a>
        <a href="/rules/pdf/rule_manual.pdf">Official Rule Manual</a>
      </nav><main><p>0 records</p>
      <article data-publication-empty="true">No published entries.</article></main></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"official--rules-"',
        },
      },
    );
  }
  // The live Fusion World listing publishes its statuses as anchored
  // sections (fusion-world-en@8); the synthetic stage mirrors that shape
  // with structurally empty product lists.
  const fusionProductCoverage =
    lineage === "fusion-world-en" && url.pathname === "/fw/en/products/"
      ? `<div class="contentsHead">
          <ul class="ankerList">
            <li class="ankerListItem"><a href="#available">AVAILABLE NOW</a></li>
            <li class="ankerListItem"><a href="#comingsoon">COMING SOON</a></li>
          </ul>
        </div>
        <section class="contentsColInner availableCol" id="available">
          <h2 class="listTit">AVAILABLE NOW</h2>
          <ul class="prpductList"></ul>
        </section>
        <section class="contentsColInner comingsoonCol" id="comingsoon">
          <h2 class="listTit">COMING SOON</h2>
          <ul class="prpductList"></ul>
        </section>`
      : `<article data-publication-empty="true">No published entries.</article>`;
  return new Response(
    `<html><title>Official Bandai CARD PRODUCT RELEASE RULE ERRATA RESTRICTION publication</title>${officialNavigation}${productionOfficialStageNavigation(lineage, url)}<main>${
      url.pathname === "/fw/en/news/01_305.html" ||
        url.pathname === "/fw/en/news/01_399.html" ||
        (
          url.hostname === "www.dbs-cardgame.com" &&
          url.pathname === "/fw/en/rules/errata-card/"
        ) ||
        (
          url.hostname === "world.digimoncard.com" &&
          url.pathname === "/rule/restriction_card/"
        ) ||
        (
          url.hostname === "en.onepiece-cardgame.com" &&
          (
            url.pathname === "/rules/restriction/" ||
            url.pathname === "/news/restriction.html" ||
            url.pathname === "/rules/block_icon/" ||
            url.pathname === "/topics/013.php" ||
            url.pathname === "/rules/"
          )
        )
        ? "<p>0 records</p>"
        : ""
    }${fusionProductCoverage}</main></html>`,
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
      <a href="/news/restriction.html">Restriction Cards</a>
      <a href="/topics/013.php">Block Policy</a>
      <a href="/rules/errata_card/">Errata Cards</a>
    </nav>`;
  }
  if (lineage === "fusion-world-en" && path === "/fw/en/news/01_31.html") {
    return `<nav aria-label="Rules publications">
      <a href="/fw/en/news/01_305.html">Current banned and limited cards</a>
      <a href="/fw/en/news/01_399.html">Previous restriction history</a>
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
    return `<nav><a href="?subcategory=news&amp;tag=all&amp;page=1">NEWS</a></nav>`;
  }
  return "";
}
