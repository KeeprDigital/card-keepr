const marker = "card-keepr-one-piece-complete-v1";
const errataMarker = "card-keepr-one-piece-complete-errata-v1";

export function onePieceCompleteOfficialSourceResponse(request) {
  const url = new URL(request.url);
  const requestedMarker = request.headers.get("user-agent")
    ?.split(";", 1)[0];
  const withErrata = requestedMarker === errataMarker;
  const surface = request.headers.get("user-agent")?.match(
    /(?:^|;\s*)request-surface=([a-z0-9]+(?:-[a-z0-9]+)*)(?:;|$)/u,
  )?.[1] ?? null;
  const role = request.headers.get("user-agent")?.match(
    /(?:^|;\s*)request-role=([a-z_]+)(?:;|$)/u,
  )?.[1] ?? null;
  const recording = url.searchParams.get("recording");
  const isCompleteRecordingLeaf = role === "listing" &&
    ["2201", "2202"].includes(recording);

  if (
    requestedMarker !== marker && !withErrata &&
    !isCompleteRecordingLeaf
  ) {
    return null;
  }
  if (url.hostname !== "en.onepiece-cardgame.com") return null;

  if (role === null) return null;
  if (isCompleteRecordingLeaf) return recordingLeaf(recording);

  if (url.pathname.startsWith("/images/") && role === "image") {
    return new Response(onePixelPng(), {
      headers: {
        "content-type": "image/png",
        etag: `"one-piece-complete-${url.pathname.split("/").at(-1)}"`,
      },
    });
  }
  if (surface === null) return discoveryStage(url);
  if (surface === "card-list") return cardListRoot();
  const document = surfaceDocument(surface, withErrata);
  return new Response(
    `<html><title>${surfaceTitle(surface)}</title>
      <script id="one-piece-card-game-${surface}-data" type="application/json">${
        JSON.stringify(document).replaceAll("<", "\\u003c")
      }</script>
      ${visibleCardListVocabulary(surface)}
      ${visiblePolicy(surface, document)}
    </html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        etag: `"one-piece-complete-${surface}"`,
      },
    },
  );
}

function recordingLeaf(recording) {
  const cards = recording === "2201"
    ? [liveCard("OP31-001")]
    : [liveCard("OP31-001"), liveCard("OP31-002")];
  return new Response(
    `<html><title>BANDAI ONE PIECE CARD LIST</title>
      <select id="recording"><option value="${recording}">Recording ${recording}</option></select>
      <div class="countCol">${cards.length} results</div>${cards.join("")}
    </html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        etag: `"one-piece-complete-recording-${recording}"`,
      },
    },
  );
}

function cardListRoot() {
  return new Response(
    `<html><title>BANDAI ONE PIECE CARD LIST</title>
      <select id="recording">
        <option value="2201">Starter Recording</option>
        <option value="2202">Booster Recording</option>
      </select>
      <div class="countCol">0 results</div>
    </html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        etag: '"one-piece-complete-card-list-root"',
      },
    },
  );
}

function liveCard(number) {
  const leader = number === "OP31-001";
  const rarity = leader ? "L" : "R";
  const category = leader ? "LEADER" : "CHARACTER";
  const name = leader ? "Straw Hat Captain" : "Synthetic Navigator";
  const effect = leader
    ? "Give up to 1 rested DON!! card to this Leader."
    : "Draw 1 card.";
  return `<dl class="modalCol" id="${number}_p1" data-artwork-id="${number.toLowerCase()}-base">
    <dt><div class="infoCol"><span>${number}</span> | <span>${rarity}</span> | <span>${category}</span></div>
      <div class="cardName">${name}</div></dt>
    <dd><div class="frontCol"><img data-src="/images/cardlist/card/${number}.png"></div>
      <div class="backCol">
        <div><h3>${leader ? "Life" : "Cost"}</h3>${leader ? "5" : "3"}</div>
        <div><h3>Color</h3>${leader ? "Red/Green" : "Blue"}</div>
        <div><h3>Attribute</h3>${leader ? "Strike" : "Special"}</div>
        <div><h3>Power</h3>${leader ? "5000" : "4000"}</div>
        <div><h3>Counter</h3>${leader ? "-" : "1000"}</div>
        <div><h3>Type</h3>${leader ? "Straw Hat Crew" : "Straw Hat Crew/Navigator"}</div>
        <div><h3>Block icon</h3>${leader ? "1" : "2"}</div>
        <div><h3>Effect</h3>${effect}</div>
        ${leader ? "" : "<div><h3>Trigger</h3>Play this card.</div>"}
        ${leader ? "" : "<div><h3>New Optional Label</h3>New optional publisher vocabulary</div>"}
        <div class="getInfo"><h3>Card Set(s)</h3>Complete One Piece Product</div>
      </div>
    </dd>
  </dl>`;
}

function discoveryStage(url) {
  const title = url.pathname === "/cardlist/"
    ? "BANDAI ONE PIECE CARD LIST"
    : url.pathname === "/products/"
      ? "BANDAI ONE PIECE CARD PRODUCTS"
      : "BANDAI ONE PIECE CARD RULES";
  const navigation = url.pathname === "/rules/"
    ? `<nav aria-label="Rules publications">
        <a href="/rules/restriction/">Restriction Cards</a>
        <a href="/rules/block_icon/">Block Policy</a>
        <a href="/rules/errata_card/">Errata Cards</a>
      </nav>`
    : "";
  return new Response(`<html><title>${title}</title>${navigation}</html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      etag: `"one-piece-complete-stage-${url.pathname.replaceAll("/", "-")}"`,
    },
  });
}

function surfaceTitle(surface) {
  if (surface === "card-list") return "BANDAI ONE PIECE CARD LIST";
  if (surface === "products" || surface === "releases") {
    return "BANDAI ONE PIECE CARD RELEASE publication";
  }
  return "Official Bandai CARD PRODUCT RELEASE RULE ERRATA RESTRICTION publication";
}

function surfaceDocument(surface, withErrata = false) {
  if (surface === "card-list") return cardList();
  if (surface === "products") {
    return {
      page: "product-list",
      series_options: [{ value: "101", label: "Starter" }],
      result: partitioned("all-products", [product()]),
    };
  }
  if (surface === "releases") {
    return {
      publication: "release-schedule",
      events: partitioned("all-releases", [{
        product: product(),
        release: release(),
      }]),
      release_timing_entries: [],
    };
  }
  if (surface === "restrictions") {
    return policy(surface, [{
      notice_no: "OP-COMPLETE-RESTRICTION-1",
      published_text: "OP31-002 is banned.",
      territory: "EN-OCEANIA",
      format_name: "standard",
      event_class: null,
      start_date: "2026-08-01",
      end_date: null,
      card_numbers: ["OP31-002"],
      restriction_code: "ban",
    }]);
  }
  if (surface === "don-rules") {
    return {
      ...policy(surface, []),
      don_card: {
        functional_designation: "DON!!",
        name: "DON!! Card",
        Category: "DON!! Card",
        Effect: "A rules-level resource Card used to pay costs and increase power.",
      },
    };
  }
  if (surface === "errata" && withErrata) {
    return policy(surface, [erratum()]);
  }
  return policy(surface, []);
}

function erratum() {
  return {
    notice_id: "errata-op31-001",
    card_number: "OP31-001",
    card_name: "Straw Hat Captain",
    published_on: "2026-08-01",
    effective_from: null,
    before_text: "Give up to 1 rested DON!! card to this Leader.",
    after_text: "Give up to 2 rested DON!! cards to this Leader.",
    note: "This correction applies in every game format.",
    applies_to_parallel_printings: true,
    image_url:
      "https://en.onepiece-cardgame.com/images/cardlist/card/OP31-001.png",
  };
}

function cardList() {
  const sharedEntry = { number: "OP31-001", detail: "/cards/OP31-001_p1" };
  return {
    page: "card-list",
    series_options: [
      { value: "2201", label: "Starter Recording" },
      { value: "2202", label: "Booster Recording" },
    ],
    page_info: {
      cap_signal: null,
      partitions: [
        partition("2201", [sharedEntry]),
        partition("2202", [sharedEntry, {
          number: "OP31-002",
          detail: "/cards/OP31-002_p1",
        }]),
      ],
    },
    card_pages: [
      card({
        source_record_id: "/cards/OP31-001_p1",
        card_number: "OP31-001",
        name: "Straw Hat Captain",
        Category: "Leader",
        Color: ["Red", "Green"],
        Cost: null,
        Life: "5",
        Attribute: ["Strike"],
        Power: "5000",
        Counter: null,
        Type: ["Straw Hat Crew"],
        "Block icon": ["1"],
        Effect: "Give up to 1 rested DON!! card to this Leader.",
        Trigger: null,
        image_url:
          "https://en.onepiece-cardgame.com/images/cardlist/card/OP31-001.png",
        rarity: "L",
        illustrationTypes: ["Animation"],
        productCodes: ["OP-COMPLETE-01"],
      }),
      card({
        source_record_id: "/cards/OP31-002_p1",
        card_number: "OP31-002",
        name: "Synthetic Navigator",
        Category: "Character",
        Color: ["Blue"],
        Cost: "3",
        Life: null,
        Attribute: ["Special"],
        Power: "4000",
        Counter: "1000",
        Type: ["Straw Hat Crew", "Navigator"],
        "Block icon": ["2"],
        Effect: "Draw 1 card.",
        Trigger: "Play this card.",
        image_url:
          "https://en.onepiece-cardgame.com/images/cardlist/card/OP31-002.png",
        rarity: "R",
        illustrationTypes: ["Experimental foil vocabulary"],
        productCodes: ["OP-COMPLETE-01"],
        Notes: "New optional publisher vocabulary",
      }),
    ],
    products: [product()],
    release_schedule: [release()],
  };
}

function visibleCardListVocabulary(surface) {
  if (surface !== "card-list") return "";
  return `<select id="recording">
    <option value="2201">Starter Recording</option>
    <option value="2202">Booster Recording</option>
  </select>`;
}

function card(input) {
  const {
    rarity,
    illustrationTypes,
    productCodes,
    ...fields
  } = input;
  return {
    ...fields,
    profile: "one-piece@1",
    product_codes: productCodes,
    distribution: {
      code: "OP-COMPLETE-01-distribution",
      kind: "product",
      label: "Complete One Piece Product distribution",
      product_reference: {
        kind: "official_code",
        value: "OP-COMPLETE-01",
      },
    },
    printing: {
      rarity,
      attributes: { illustration_types: illustrationTypes },
    },
    printed_rules: fields.Effect,
    variant: "base",
  };
}

function product() {
  return {
    product_code: "OP-COMPLETE-01",
    product_name: "Complete One Piece Product",
  };
}

function release() {
  return {
    product_code: "OP-COMPLETE-01",
    announcement_id: "OP-COMPLETE-01-EN-OCEANIA-1",
    region: "EN-OCEANIA",
    precision: "day",
    date: "2026-08-01",
    status: "released",
  };
}

function policy(surface, entries) {
  return {
    publication: `one-piece-${surface}`,
    revision: "2026-08",
    declared_record_count: entries.length,
    partition: {
      page: 1,
      pages: 1,
      total: entries.length,
      has_next: false,
    },
    entries,
  };
}

function partitioned(bucket, entries) {
  return { cap_signal: null, partitions: [partition(bucket, entries)] };
}

function partition(bucket, entries) {
  return {
    bucket,
    page: 1,
    pages: 1,
    total: entries.length,
    has_next: false,
    entries,
  };
}

function visiblePolicy(surface, document) {
  if (surface === "restrictions") {
    const rule = document.entries[0];
    return `<main><p>1 record</p><article class="restriction-card"><dl>
      <dt>Notice No</dt><dd>${rule.notice_no}</dd>
      <dt>Published Text</dt><dd>${rule.published_text}</dd>
      <dt>Territory</dt><dd>${rule.territory}</dd>
      <dt>Format Name</dt><dd>${rule.format_name}</dd>
      <dt>Event Class</dt><dd>-</dd>
      <dt>Start Date</dt><dd>${rule.start_date}</dd>
      <dt>End Date</dt><dd>-</dd>
      <dt>Card Numbers</dt><dd>${rule.card_numbers.join(",")}</dd>
      <dt>Restriction Code</dt><dd>${rule.restriction_code}</dd>
    </dl></article></main>`;
  }
  if (["block-policy", "errata", "don-rules"].includes(surface)) {
    return document.entries.length === 0
      ? "<main><p>0 records</p><article data-publication-empty=\"true\">No published entries.</article></main>"
      : `<main><p>${document.entries.length} records</p></main>`;
  }
  return "";
}

function onePixelPng() {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  ]);
}
