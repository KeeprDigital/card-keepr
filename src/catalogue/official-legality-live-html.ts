import { isIsoCalendarDate } from "./calendar-date.ts";
import {
  openPredicateUnresolvedReason,
} from "./official-legality-source-adapters.ts";

type LiveLegalityGame = "one-piece" | "fusion-world" | "digimon" | "gundam";

export type LiveLegalityParseOptions = Readonly<{
  /**
   * Enabled only by the issue-58 adapter generation: the Gundam 2026-07-24
   * compound policy parses into exact unresolved rules, including one
   * explicit open-predicate rule with an unresolved `target_scope`
   * dimension, instead of failing closed.
   */
  unresolvedTargetScope?: boolean;
  /**
   * Enabled only by the live-shape generations (fusion-world-en@9): the pinned
   * legality-history publication (news/01_399.html) announces one exact
   * restriction lift with an exact TCG change date, which parses into one
   * effective-dated eligible rule. Earlier generations keep failing closed
   * on the publication.
   */
  fusionRestrictionLift?: boolean;
}>;

export function liveOfficialLegalityDocument(
  game: LiveLegalityGame,
  sourceLineage: string,
  surface: string,
  requestUrl: string,
  html: string,
  options: LiveLegalityParseOptions = {},
): { surface: string; document: Record<string, unknown> } | null {
  if (
    game === "one-piece" &&
    sourceLineage === "one-piece-en" &&
    surface === "restrictions" &&
    [
      // The pre-restructure URL now 302s to the news publication; both
      // identities carry the same retained document.
      "https://en.onepiece-cardgame.com/rules/restriction/",
      "https://en.onepiece-cardgame.com/news/restriction.html",
    ].includes(new URL(requestUrl).href) &&
    /<title>Banned\/Restricted Card Addition Notice \| ONE PIECE CARD GAME - Official Web Site<\/title>/u.test(html)
  ) {
    return { surface, document: onePieceCurrentRestrictions(html) };
  }
  if (
    game === "one-piece" &&
    sourceLineage === "one-piece-en" &&
    surface === "block-policy" &&
    new URL(requestUrl).href ===
      "https://en.onepiece-cardgame.com/topics/013.php" &&
    /<title>Introduction of the Block Number System − TOPICS｜ONE PIECE CARD GAME - Official Web Site<\/title>/u.test(html) &&
    /Introduction of the Block Number System/u.test(html)
  ) {
    // The live Block Number publication introduces the numbering system
    // starting 2026-04-01 without publishing any block restriction rule;
    // it proves an exactly empty policy surface.
    return {
      surface,
      document: { entries: [], declared_record_count: 0 },
    };
  }
  if (
    game === "fusion-world" &&
    sourceLineage === "fusion-world-en" &&
    (surface === "detail" || surface === "legality-current") &&
    new URL(requestUrl).href ===
      "https://www.dbs-cardgame.com/fw/en/news/01_305.html" &&
    /<title>Banned\/Restricted Cards from March 2026 \| Dragon Ball Super Card Game Fusion World - Official Web Site<\/title>/u.test(html)
  ) {
    return {
      surface: "legality-current",
      document: fusionWorldCurrentRestrictions(html),
    };
  }
  if (
    game === "fusion-world" &&
    sourceLineage === "fusion-world-en" &&
    (surface === "detail" || surface === "legality-history") &&
    options.fusionRestrictionLift === true &&
    new URL(requestUrl).href ===
      "https://www.dbs-cardgame.com/fw/en/news/01_399.html" &&
    /<title>Announcement Regarding Cards That Will be Banned or Restricted from March 2026 \| Dragon Ball Super Card Game Fusion World - Official Web Site<\/title>/u.test(html)
  ) {
    return {
      surface: "legality-history",
      document: fusionWorldHistoryRestrictionLift(html),
    };
  }
  if (
    game === "fusion-world" &&
    sourceLineage === "fusion-world-en" &&
    surface === "legality-history" &&
    new URL(requestUrl).href ===
      "https://www.dbs-cardgame.com/fw/en/news/01_399.html" &&
    fusionWorldPublisherDeclaresExactEmptyHistory(html)
  ) {
    return {
      surface,
      document: { entries: [], declared_record_count: 0 },
    };
  }
  if (
    game === "digimon" &&
    sourceLineage === "digimon-en" &&
    (surface === "restrictions-current" || surface === "restrictions-history") &&
    new URL(requestUrl).href ===
      "https://world.digimoncard.com/rule/restriction_card/" &&
    /<title>Banned and Restricted Card Announcement \(Mar\. 16, 2026\) − RULE｜Digimon Card Game<\/title>/u.test(html)
  ) {
    return {
      surface,
      document: digimonCurrentRestrictions(html),
    };
  }
  if (
    game === "gundam" &&
    (sourceLineage === "gundam-en-asia" || sourceLineage === "gundam-en-us") &&
    // The issue-58 generation plans the news publication directly as its
    // legality surface; earlier generations discover it as a detail request
    // from the rules hub.
    (surface === "detail" || surface === "legality")
  ) {
    const locale = sourceLineage === "gundam-en-asia" ? "asia-en" : "en";
    if (
      new URL(requestUrl).href ===
        `https://www.gundam-gcg.com/${locale}/news/01_279.html` &&
      /<h3>Current List of Banned \/ Restricted Cards<\/h3>/u.test(html)
    ) {
      return {
        surface: "legality",
        document: gundamCurrentRestrictions(sourceLineage, html, options),
      };
    }
  }
  return null;
}

function fusionWorldPublisherDeclaresExactEmptyHistory(html: string): boolean {
  const title = html.match(/<title>([^<]+)<\/title>/u)?.[1] ?? "";
  const main = html.match(/<main>([\s\S]*?)<\/main>/u)?.[1] ?? "";
  return /\bBANDAI\b[\s\S]*\bRULE\b[\s\S]*\bRESTRICTION\b/iu.test(title) &&
    /^\s*<p>0 records<\/p>\s*<article data-publication-empty="true">No published entries\.<\/article>\s*$/u
      .test(main);
}

// The pinned Fusion World legality-history publication (verified live on
// 2026-08-12): one Card leaves the restricted list with an exact TCG change
// date, and the DIGITAL version ties its change to a game update instead of
// a calendar date. The TCG rule parses as one effective-dated eligible rule;
// the digital sentence is retained through the full-consumption check and
// asserts no organized-play scope this catalogue models.
function fusionWorldHistoryRestrictionLift(
  html: string,
): Record<string, unknown> {
  if (
    !/<time class="time" datetime="2026-03-09">March 09, 2026<\/time>\s*<span class="txt">Announcement Regarding Cards That Will be Banned or Restricted from March 2026<\/span>/u.test(html)
  ) {
    throw new Error("Fusion World history policy identity is unavailable.");
  }
  const article = requiredCapture(
    html,
    /<article class="articleCol">([\s\S]*?)<\/article>/u,
    "Fusion World history policy article",
  );
  assertNoUnconsumedPolicyConditions(article);
  const changeDate = exactHumanDate(requiredCapture(
    article,
    /<p class="xxSmallTitle">TCG Ver\. Change Date<\/p>[\s\S]*?<p>([^<]+)<\/p>/u,
    "Fusion World TCG change date",
  ));
  const liftPattern =
    /<h4>Card Removed from the Restricted List<\/h4>[\s\S]*?<h6>(([A-Z]{1,6}\d{0,4}-\d{1,4}) [^<]+)<\/h6>/u;
  const liftedLabel = decodedText(requiredCapture(
    article,
    liftPattern,
    "Fusion World lifted restriction",
  ));
  const liftedNumber = requiredCapture(
    article,
    liftPattern,
    "Fusion World lifted restriction Card number",
    2,
  );
  const liftWording = "Therefore, its Restricted status will be lifted.";
  const visibleText = normalizedVisiblePolicyText(article);
  const expectedVisibleText = [
    "Regarding Banned/Restricted Cards",
    'In this game a deck used in a tournament is generally permitted up to 4 copies of a card with the same card number. Cards that are exceptions and to be limited are noted in the " Banned/Restricted Cards " section.',
    'This is divided into " Banned Cards " and " Restricted Cards ". For cards that are designated as " Banned Cards "no copies of the card are permitted in the deck. For cards designated as " Restricted Cards " only 1 copy of the card is permitted in the deck.',
    "Cards with different artwork but the same card number are considered identical to the listed card and follow the same restriction.",
    "Change Date",
    "TCG Ver. Change Date",
    "March 14, 2026",
    "DIGITAL Ver. Change Date",
    "Same day as Ver.11.0.0 update",
    "For details regarding changes to the Digital Version, please check the in game notices.",
    "Card Removed from the Restricted List",
    liftedLabel,
    `“${liftedLabel}” was previously designated as a Restricted Card due to its stability and explosive development potential, which often led to one sided games that ignored healthy player interaction.`,
    `In the environment following DUAL EVOLUTION [FB09], this card remains powerful but is no longer considered to exceed the expected balance parameters. ${liftWording}`,
    "For detailed rules and gameplay information, please refer to the Rules page.",
    "Our operations and development teams will continue to monitor the metagame closely and will discuss and implement adjustments as needed to maintain a healthy play environment.",
    "We greatly appreciate your continued support of DRAGON BALL SUPER CARD GAME FUSION WORLD.",
    "— DRAGON BALL SUPER CARD GAME FUSION WORLD Operations & Development Teams",
  ].join(" ");
  if (visibleText !== expectedVisibleText) {
    throw new Error(
      "Fusion World history policy contains unconsumed prose or structure.",
    );
  }
  const entries = [{
    market: "EN-OCEANIA",
    play_format: "standard",
    tier: null,
    active_on: changeDate,
    expires_on: null,
    unresolved_scope: null,
    directive: "eligible",
    rule_ref: `01_399-${liftedNumber}`,
    notice:
      `Card Removed from the Restricted List\n${liftedLabel}\n${liftWording}`,
    cards: [liftedNumber],
  }];
  return { entries, declared_record_count: entries.length };
}

function gundamCurrentRestrictions(
  sourceLineage: "gundam-en-asia" | "gundam-en-us",
  html: string,
  options: LiveLegalityParseOptions = {},
): Record<string, unknown> {
  if (
    !/<div class="date">July 24, 2026<\/div>/u.test(html) ||
    !/<h3>Current List of Banned \/ Restricted Cards<\/h3>/u.test(html)
  ) {
    throw new Error("Gundam current policy identity is unavailable.");
  }
  const start = html.indexOf("<h3>Current List of Banned / Restricted Cards</h3>");
  const end = html.indexOf("</section>", start);
  if (start < 0 || end < 0) {
    throw new Error("Gundam current policy section is incomplete.");
  }
  const current = html.slice(start, end);
  assertNoUnconsumedPolicyConditions(current);
  for (const semantic of [
    "No copies of the card are permitted in the deck.",
    "Only 2 copy of the card is permitted in the deck.",
    "Cards A and B cannot be used at the same time",
    'All combinations of cards that match the above description "a Unit card that is Lv.2 with cost 1, 2 AP, and 2 HP, and without effects" are included as banned pairs, and no more than four copies of one card matching this description can be used in a deck.',
  ]) {
    if (!current.includes(`<p>${semantic}</p>`)) {
      throw new Error("Gundam current policy semantics are incomplete.");
    }
  }
  if (options.unresolvedTargetScope !== true) {
    // Frozen behavior for earlier adapter generations: the compound policy
    // has no representable form without the target_scope dimension.
    throw new Error(
      "Gundam compound prohibited-combination and copy-limit policy is not exactly representable.",
    );
  }
  return gundamExactCurrentRestrictions(sourceLineage, current);
}

type GundamPolicyToken = {
  kind: "heading3" | "heading4" | "navigation" | "paragraph";
  text: string;
};

const gundamCardLabelPattern = /^([A-Z]{1,6}\d{0,4}-\d{1,4}) (.+)$/u;
const gundamBanWording = "No copies of the card are permitted in the deck.";
const gundamRestrictedWording =
  "Only 2 copy of the card is permitted in the deck.";
const gundamPairWording = "Cards A and B cannot be used at the same time";
const gundamOpenPredicateWording =
  'All combinations of cards that match the above description "a Unit card that is Lv.2 with cost 1, 2 AP, and 2 HP, and without effects" are included as banned pairs, and no more than four copies of one card matching this description can be used in a deck.';

function gundamPolicyTokens(current: string): GundamPolicyToken[] {
  return [...current.matchAll(
    /<(h3|h4)\b[^>]*>([\s\S]*?)<\/\1>|<a\b([^>]*)>([\s\S]*?)<\/a>|<p\b[^>]*>([\s\S]*?)<\/p>/giu,
  )].flatMap<GundamPolicyToken>((match) => {
    if (match[1] !== undefined) {
      return [{
        kind: match[1].toLowerCase() === "h3" ? "heading3" : "heading4",
        text: normalizedVisiblePolicyText(match[2]!),
      }];
    }
    if (match[3] !== undefined) {
      const text = normalizedVisiblePolicyText(match[4]!);
      if (text.length === 0) return [];
      if (
        !/(?:^|\s)commonBtn(?:\s|$)/u.test(
          match[3].match(/\bclass=["']([^"']*)["']/iu)?.[1] ?? "",
        )
      ) {
        throw new Error(
          "Gundam current policy contains an unrecognized visible link.",
        );
      }
      return [{ kind: "navigation", text }];
    }
    const text = normalizedVisiblePolicyText(match[5]!);
    return text.length === 0 ? [] : [{ kind: "paragraph", text }];
  });
}

function gundamExactCardLabel(
  token: GundamPolicyToken | undefined,
): { number: string; label: string } {
  const match = token?.kind === "paragraph"
    ? token.text.match(gundamCardLabelPattern)
    : null;
  if (match === null || match === undefined) {
    throw new Error("Gundam current policy Card entry is not exactly labeled.");
  }
  return { number: match[1]!, label: match[0] };
}

function gundamExactCurrentRestrictions(
  sourceLineage: "gundam-en-asia" | "gundam-en-us",
  current: string,
): Record<string, unknown> {
  const tokens = gundamPolicyTokens(current);
  let position = 0;
  const next = (): GundamPolicyToken | undefined => tokens[position++];
  const require = (
    kind: GundamPolicyToken["kind"],
    expected: string | RegExp,
  ): string => {
    const token = next();
    const matches = token !== undefined && token.kind === kind &&
      (typeof expected === "string"
        ? token.text === expected
        : expected.test(token.text));
    if (!matches) {
      throw new Error("Gundam current policy structure is not exactly representable.");
    }
    return token!.text;
  };

  require("heading3", "Current List of Banned / Restricted Cards");
  require("navigation", /^Banned Cards$/u);
  require("navigation", /^Restricted Cards(?:〈2〉)?$/u);
  require("navigation", /^Banned [Pp]air$/u);

  require("heading4", "Banned Cards");
  require("paragraph", gundamBanWording);
  const banned = gundamExactCardLabel(next());

  require("heading4", "Restricted Cards〈2〉");
  require("paragraph", gundamRestrictedWording);
  const restricted = gundamExactCardLabel(next());

  require("heading4", /^Banned [Pp]air$/u);
  require("paragraph", gundamPairWording);
  const pairs: Array<{
    left: { number: string; label: string };
    right: { number: string; label: string };
  }> = [];
  while (tokens[position]?.kind === "paragraph" && tokens[position]?.text === "A") {
    position += 1;
    const left = gundamExactCardLabel(next());
    require("paragraph", "B");
    const right = gundamExactCardLabel(next());
    pairs.push({ left, right });
  }
  const predicateCards: Array<{ number: string; label: string }> = [];
  while (
    tokens[position]?.kind === "paragraph" &&
    gundamCardLabelPattern.test(tokens[position]!.text)
  ) {
    predicateCards.push(gundamExactCardLabel(next()));
  }
  require("paragraph", gundamOpenPredicateWording);
  if (position !== tokens.length) {
    throw new Error("Gundam current policy structure is not exactly representable.");
  }
  if (
    pairs.length !== 2 ||
    predicateCards.length !== 20 ||
    new Set([
      banned.number,
      restricted.number,
      ...pairs.flatMap(({ left, right }) => [left.number, right.number]),
      ...predicateCards.map(({ number }) => number),
    ]).size !== 2 + 4 + 20
  ) {
    throw new Error("Gundam current policy category totals changed.");
  }
  const expectedVisibleText = tokens.map(({ text }) => text).join(" ");
  if (normalizedVisiblePolicyText(current) !== expectedVisibleText) {
    throw new Error(
      "Gundam current policy contains unconsumed prose or structure.",
    );
  }
  const region = sourceLineage === "gundam-en-asia" ? "EN-ASIA" : "EN-US";
  const common = {
    region,
    format: "standard",
    event_tier: null,
    effective_date: null,
    end_date: null,
    ruling: "unresolved",
  };
  const intervalEntry = (
    id: string,
    wording: string,
    cards: ReadonlyArray<{ number: string; label: string }>,
  ) => {
    const numbers = cards.map(({ number }) => number);
    return {
      ...common,
      news_id: id,
      text: `${wording}\n${cards.map(({ label }) => label).join("\n")}`,
      card_numbers: numbers,
      unresolved_scope: { dimensions: ["effective_interval"] },
      reason: `Effective interval for ${numbers.join(", ")} is not stated.`,
    };
  };
  const entries = [
    intervalEntry(`01_279-current-ban-${banned.number}`, gundamBanWording, [
      banned,
    ]),
    intervalEntry(
      `01_279-current-restricted-${restricted.number}`,
      gundamRestrictedWording,
      [restricted],
    ),
    ...pairs.map(({ left, right }, index) =>
      intervalEntry(`01_279-current-pair-${index + 1}`, gundamPairWording, [
        left,
        right,
      ])
    ),
    {
      ...common,
      news_id: "01_279-current-open-predicate",
      text: `${gundamOpenPredicateWording}\n${
        predicateCards.map(({ label }) => label).join("\n")
      }`,
      card_numbers: predicateCards.map(({ number }) => number),
      unresolved_scope: {
        dimensions: ["effective_interval", "target_scope"],
      },
      reason: openPredicateUnresolvedReason,
    },
  ];
  return { entries, declared_record_count: entries.length };
}

function digimonCurrentRestrictions(html: string): Record<string, unknown> {
  if (
    !/<title>Banned and Restricted Card Announcement \(Mar\. 16, 2026\) − RULE｜Digimon Card Game<\/title>/u.test(html)
  ) {
    throw new Error("Digimon current policy identity is unavailable.");
  }
  const start = html.indexOf('<section class="cardWrap mt_l" id="application">');
  const mainEnd = html.indexOf("</main>", start);
  const end = html.lastIndexOf("</section>", mainEnd);
  if (start < 0 || mainEnd < 0 || end <= start) {
    throw new Error("Digimon current affected-card section is incomplete.");
  }
  const current = html.slice(start, end);
  assertNoUnconsumedPolicyConditions(current);
  if (!/<h4 class="subTit txtNormal">List of Currently Affected Cards<\/h4>/u.test(current)) {
    throw new Error("Digimon current affected-card heading is unavailable.");
  }
  const pairWording = "Banned Pair: If A is included in a deck, B is banned from being included in the deck.";
  const banWording = "Banned cards: Can’t be included in decks.";
  const restrictedWording = "Restricted Cards (1) - Decks can only include one copy of these cards.";
  for (const wording of [pairWording, banWording, restrictedWording]) {
    if (!current.includes(`<h5 class="minTit txtNormal">${wording}</h5>`)) {
      throw new Error("Digimon current policy semantics are incomplete.");
    }
  }
  const pairStart = current.indexOf(pairWording);
  const banStart = current.indexOf(banWording, pairStart);
  const restrictedStart = current.indexOf(restrictedWording, banStart);
  if (pairStart < 0 || banStart < 0 || restrictedStart < 0) {
    throw new Error("Digimon current policy categories are incomplete.");
  }
  const pairArea = current.slice(pairStart, banStart);
  const pairStarts = [...pairArea.matchAll(/<div class="noticeFrame noticeBase">/gu)]
    .map((match) => match.index);
  const pairGroups = pairStarts.map((position, index) =>
    cardLinks(pairArea.slice(position, pairStarts[index + 1] ?? pairArea.length))
  );
  const bannedCards = digimonCardEntries(
    current.slice(banStart, restrictedStart),
  );
  const restrictedCards = digimonCardEntries(current.slice(restrictedStart));
  if (
    pairGroups.length !== 2 ||
    pairGroups[0]?.length !== 2 ||
    pairGroups[1]?.length !== 3 ||
    bannedCards.length !== 3 ||
    restrictedCards.length !== 50
  ) {
    throw new Error("Digimon current policy category totals changed.");
  }
  const visibleText = normalizedVisiblePolicyText(current);
  const expectedVisibleText = [
    "List of Currently Affected Cards",
    pairWording,
    ...pairGroups.flatMap((cards) => [
      "Component Card A",
      "・",
      cards[0]!.label,
      "Component Card B",
      ...cards.slice(1).flatMap(({ label }) => ["・", label]),
    ]),
    banWording,
    ...bannedCards.map(({ label }) => label.replace(/\s+/gu, " ")),
    restrictedWording,
    ...restrictedCards.map(({ label }) => label.replace(/\s+/gu, " ")),
  ].join(" ");
  if (visibleText !== expectedVisibleText) {
    throw new Error(
      "Digimon current policy contains unconsumed prose or structure.",
    );
  }
  const common = {
    language_scope: "EN-OCEANIA",
    ruleset: "standard",
    tournament_level: null,
    applies_from: null,
    applies_until: null,
    unresolved_scope: { dimensions: ["effective_interval"] },
    status_code: "unresolved",
  };
  const unresolvedEntry = (
    id: string,
    wording: string,
    cards: Array<{ number: string; label: string }>,
  ) => {
    const numbers = cards.map(({ number }) => number);
    return {
      ...common,
      restriction_id: id,
      body: `${wording}\n${cards.map(({ label }) => label).join("\n")}`,
      card_ids: numbers,
      clarification: `Effective interval for ${numbers.join(", ")} is not stated.`,
    };
  };
  const entries = [
    ...pairGroups.map((cards, index) =>
      unresolvedEntry(`current-pair-${index + 1}`, pairWording, cards)
    ),
    ...bannedCards.map((card) =>
      unresolvedEntry(`current-ban-${card.number}`, banWording, [card])
    ),
    ...restrictedCards.map((card) =>
      unresolvedEntry(`current-restricted-${card.number}`, restrictedWording, [card])
    ),
  ];
  return { entries, declared_record_count: entries.length };
}

function digimonCardEntries(
  html: string,
): Array<{ number: string; label: string }> {
  return [...html.matchAll(
    /<a href="\/cardlist\/index\.php\?search=true&card_no=([A-Z]{1,6}\d{0,4}-\d{1,4})"><dd class="cardName"><span class="num">([^<]+)<\/span>([\s\S]*?)<\/dd><\/a>/gu,
  )].map((match) => {
    if (match[1] !== match[2]) {
      throw new Error("Digimon policy Card URL and label identities conflict.");
    }
    return {
      number: match[1]!,
      label: `${match[1]} ${decodedText(match[3]!.replace(/<br>/gu, " "))}`,
    };
  });
}

function fusionWorldCurrentRestrictions(html: string): Record<string, unknown> {
  if (
    !/<time class="time" datetime="2026-03-13">March 13, 2026<\/time>\s*<span class="txt">Banned\/Restricted Cards from March 2026<\/span>/u.test(html)
  ) {
    throw new Error("Fusion World current policy identity is unavailable.");
  }
  const article = requiredCapture(
    html,
    /<article class="articleCol">([\s\S]*?)<\/article>/u,
    "Fusion World current policy article",
  );
  assertNoUnconsumedPolicyConditions(article);
  const banned = requiredPolicyCardSection(
    article,
    "Banned Cards",
    "No copies of the card are permitted in the deck.",
    "Restricted Cards",
  );
  const restricted = requiredPolicyCardSection(
    article,
    "Restricted Cards",
    "Only 1 copy of the card is permitted in the deck.",
    null,
  );
  const visibleText = normalizedVisiblePolicyText(article);
  const expectedVisibleText = [
    "Banned/Restricted Cards",
    "This is a list of banned and restricted cards. Please check the effective date and confirm the types and quantities of cards that can be used.",
    "Banned Cards",
    "No copies of the card are permitted in the deck. *Tap the image to view the card list.",
    ...banned.cards.map(({ label }) => label),
    "Restricted Cards",
    "Only 1 copy of the card is permitted in the deck. *Tap the image to view the card list.",
    ...restricted.cards.map(({ label }) => label),
  ].join(" ");
  if (visibleText !== expectedVisibleText) {
    throw new Error(
      "Fusion World current policy contains unconsumed prose or structure.",
    );
  }
  if (banned.cards.length !== 3 || restricted.cards.length !== 5) {
    throw new Error("Fusion World current policy category totals changed.");
  }
  const common = {
    market: "EN-OCEANIA",
    play_format: "standard",
    tier: null,
    active_on: null,
    expires_on: null,
    unresolved_scope: { dimensions: ["effective_interval"] },
    directive: "unresolved",
  };
  const entries = [...banned.cards, ...restricted.cards].map(
    ({ number, label }, index) => {
      const policy = index < banned.cards.length
        ? banned.wording
        : restricted.wording;
      return {
        ...common,
        rule_ref: `01_305-${number}`,
        notice: `${policy}\n${label}`,
        cards: [number],
        ambiguity: `Effective interval for ${number} is not stated.`,
      };
    },
  );
  return { entries, declared_record_count: entries.length };
}

function requiredPolicyCardSection(
  html: string,
  heading: string,
  wording: string,
  nextHeading: string | null,
): { wording: string; cards: Array<{ number: string; label: string }> } {
  const end = nextHeading === null
    ? "[\\s\\S]*$"
    : `[\\s\\S]*?<h4>${escapeRegExp(nextHeading)}</h4>`;
  const section = requiredCapture(
    html,
    new RegExp(
      `<h4>${escapeRegExp(heading)}</h4>[\\s\\S]*?<p>${escapeRegExp(wording)}<br>\\s*\\*Tap the image to view the card list\\.</p>(${end})`,
      "u",
    ),
    `Official ${heading} section`,
  );
  const cards = [...section.matchAll(
    /<p class="cms-card-subtitle" data-num="\d+">\s*([A-Z]{1,6}\d{0,4}-\d{1,4})\s+([^<]+)<\/p>/gu,
  )].map((match) => ({
    number: match[1]!,
    label: `${match[1]} ${decodedText(match[2]!)}`,
  }));
  return { wording, cards };
}

function onePieceCurrentRestrictions(html: string): Record<string, unknown> {
  const effectiveDate = exactHumanDate(requiredCapture(
    html,
    /<h3>Banned\/Restricted Cards effective from ([^<]+)<\/h3>/u,
    "One Piece active restriction effective date",
  ));
  const activeStart = html.indexOf("<h3>Cards with Active Restrictions</h3>");
  if (activeStart < 0) {
    throw new Error("One Piece active restriction section is unavailable.");
  }
  const activeEnd = html.indexOf(
    '<div class="row js-setGallery rel-base c-gallery"',
    activeStart + 1,
  );
  if (activeEnd < 0) {
    throw new Error("One Piece active restriction section is incomplete.");
  }
  const active = html.slice(activeStart, activeEnd);
  assertNoUnconsumedPolicyConditions(active);
  const bannedSection = requiredCapture(
    active,
    /<h4>Banned Cards<\/h4>\s*<p>(The following card\(s\) cannot be included in any deck\.)<\/p>([\s\S]*?)<h4>Restricted Cards<\/h4>/u,
    "One Piece active banned cards",
    2,
  );
  const banPolicy = requiredCapture(
    active,
    /<h4>Banned Cards<\/h4>\s*<p>(The following card\(s\) cannot be included in any deck\.)<\/p>/u,
    "One Piece active ban wording",
  );
  const bannedCards = cardLinks(bannedSection);
  if (bannedCards.length === 0) {
    throw new Error("One Piece active banned-card list is empty.");
  }
  if (!/<h4>Restricted Cards<\/h4>\s*<p>There are currently no cards in this category\.<\/p>/u.test(active)) {
    throw new Error("One Piece restricted-card category is not exactly accounted for.");
  }
  const pairSection = requiredCapture(
    active,
    /<h4>Banned Pair Cards<\/h4>\s*<p>(Card A and Card B cannot be included in the same deck\.)<\/p>([\s\S]*)$/u,
    "One Piece active banned pairs",
    2,
  );
  const pairPolicy = requiredCapture(
    active,
    /<h4>Banned Pair Cards<\/h4>\s*<p>(Card A and Card B cannot be included in the same deck\.)<\/p>/u,
    "One Piece active banned-pair wording",
  );
  const pairGroups = [...pairSection.matchAll(
    /<ul>([\s\S]*?)<\/ul>/gu,
  )].map((match) => cardLinks(match[1]!));
  if (
    pairGroups.length === 0 ||
    pairGroups.some((cards) => cards.length !== 2)
  ) {
    throw new Error("One Piece active banned pairs are incomplete.");
  }
  const visibleText = normalizedVisiblePolicyText(active);
  const expectedVisibleText = [
    "Cards with Active Restrictions",
    "Banned Cards",
    banPolicy,
    ...bannedCards.flatMap(({ label }) => ["・", label]),
    "Restricted Cards",
    "There are currently no cards in this category.",
    "Banned Pair Cards",
    pairPolicy,
    ...pairGroups.flatMap((cards) =>
      cards.flatMap(({ label }) => ["・", label])
    ),
  ].join(" ");
  if (visibleText !== expectedVisibleText) {
    throw new Error(
      "One Piece current policy contains unconsumed prose or structure.",
    );
  }
  const common = {
    territory: "EN-OCEANIA",
    format_name: "standard",
    event_class: null,
    start_date: effectiveDate,
    end_date: null,
    unresolved_scope: null,
  };
  return {
    entries: [
      ...bannedCards.map(({ number, label }) => ({
        ...common,
        notice_no: `active-${effectiveDate}-ban-${number}`,
        published_text: `${banPolicy}\n${label}`,
        card_numbers: [number],
        restriction_code: "ban",
      })),
      ...pairGroups.map(([left, right]) => ({
        ...common,
        notice_no: `active-${effectiveDate}-pair-${left!.number}-${right!.number}`,
        published_text: `${pairPolicy}\n${left!.label}\n${right!.label}`,
        card_numbers: [left!.number],
        related_cards: [right!.number],
        restriction_code: "prohibited_combination",
      })),
    ],
    declared_record_count: bannedCards.length + pairGroups.length,
  };
}

function cardLinks(html: string): Array<{ number: string; label: string }> {
  return [...html.matchAll(
    /<a\b[^>]*href="[^"]*(?:freewords|card_no|q)=([A-Z]{1,6}\d{0,4}-\d{1,4})[^"]*"[^>]*>([^<]+)<\/a>/gu,
  )].map((match) => {
    const label = decodedText(match[2]!);
    if (!label.startsWith(`${match[1]} `)) {
      throw new Error("Official policy Card label conflicts with its URL identity.");
    }
    return { number: match[1]!, label };
  });
}

function requiredCapture(
  value: string,
  pattern: RegExp,
  name: string,
  group = 1,
): string {
  const matches = [...value.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  if (matches.length !== 1 || matches[0]![group] === undefined) {
    throw new Error(`${name} does not match its exact publisher structure.`);
  }
  return matches[0]![group]!;
}

function exactHumanDate(value: string): string {
  const match = value.match(/^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/u);
  const month = match === null
    ? 0
    : [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ].indexOf(match[1]!) + 1;
  if (match === null || month === 0) {
    throw new Error("Official policy effective date is not an exact calendar date.");
  }
  const day = String(Number.parseInt(match[2]!, 10)).padStart(2, "0");
  const date = `${match[3]}-${String(month).padStart(2, "0")}-${day}`;
  if (!isIsoCalendarDate(date)) {
    throw new Error("Official policy effective date is not an exact calendar date.");
  }
  return date;
}

function decodedText(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/&nbsp;/gu, " ")
    .trim();
}

function assertNoUnconsumedPolicyConditions(html: string): void {
  const text = normalizedVisiblePolicyText(html);
  if (
    /\b(?:unless|except(?:\s+(?:if|when|where))?|provided\s+that|only\s+(?:if|when))\b/iu
      .test(text)
  ) {
    throw new Error(
      "Official policy retains an unconsumed condition that is not exactly representable.",
    );
  }
}

function normalizedVisiblePolicyText(html: string): string {
  return decodedText(html.replace(/<[^>]+>/gu, " "))
    .replace(/\s+/gu, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
