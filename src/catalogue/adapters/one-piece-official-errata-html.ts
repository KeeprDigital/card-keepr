import { AdministrationProblem } from "../shared";

export type OnePieceOfficialErratumObservation = Readonly<{
  kind: "official_erratum";
  game: "one-piece";
  target:
    | Readonly<{
        type: "card";
        official_identity: Readonly<{
          kind: "card_number";
          value: string;
        }>;
      }>
    | Readonly<{
        type: "printing";
        official_identity: Readonly<{
          kind: "card_number";
          value: string;
        }>;
        locator: string;
      }>;
  published_on: string;
  effective_from: null;
  observed_printed_rules_text: string;
  corrected_rules_text: string;
  official_wording: string;
  applies_to_parallel_printings: boolean;
  source: Readonly<{
    fragment: string;
    display_name: string;
    image_url: string;
  }>;
  completeness: Readonly<{
    structurally_complete: true;
    required_surfaces_complete: true;
    partitions_complete: true;
    declared_record_count: 1;
    parsed_record_count: 1;
  }>;
}>;

type SectionDraft = {
  sourceId: string | null;
  publishedOnParts: string[];
  publishedOnHeadingCount: number;
  recognizedEntryCount: number;
};

type PairDraft = {
  ordinal: number;
  labelParts: string[];
  valueParts: string[];
  valueContainerCount: number;
};

type NoticeDraft = {
  ordinal: number;
  valueParts: string[];
};

type EntryDraft = {
  sourceId: string | null;
  sectionSourceId: string | null;
  sectionPublishedOn: string | null;
  headingParts: string[];
  headingCount: number;
  imagePaths: string[];
  pairs: PairDraft[];
  notices: NoticeDraft[];
  nextWordingOrdinal: number;
  allTextParts: string[];
  residualTextParts: string[];
};

const canonicalOrigin = "https://en.onepiece-cardgame.com";
const entrySelectors = [".contentsWrap div.detailCol", ".contentsWrap div.errataModal"] as const;

export async function parseOnePieceOfficialErrataHtml(
  document: string,
): Promise<readonly OnePieceOfficialErratumObservation[]> {
  const pageTitleParts: string[][] = [];
  const observations: OnePieceOfficialErratumObservation[] = [];
  const sections: SectionDraft[] = [];
  let activeEntry: EntryDraft | null = null;
  let activeHeading: string[] | null = null;
  let activeLabel: string[] | null = null;
  let activeValue: string[] | null = null;
  let activeNotice: string[] | null = null;
  let matchedEntryCount = 0;
  let inventoriedHeadingCount = 0;
  let introductoryContentCount = 0;
  let datedSectionCount = 0;
  const inventoriedModalTargets: string[] = [];
  const recognizedModalFragments: string[] = [];

  const rewriter = new HTMLRewriter()
    .on("h3.pageTit", {
      element(element) {
        const parts: string[] = [];
        pageTitleParts.push(parts);
        element.onEndTag(() => {});
        activeHeading = parts;
        element.onEndTag(() => {
          activeHeading = null;
        });
      },
      text(text) {
        activeHeading?.push(text.text);
      },
    })
    .on("section.contentsLCol", {
      element(element) {
        const section: SectionDraft = {
          sourceId: element.getAttribute("id"),
          publishedOnParts: [],
          publishedOnHeadingCount: 0,
          recognizedEntryCount: 0,
        };
        sections.push(section);
        element.onEndTag(() => {
          if (sections.at(-1) !== section) {
            return parseFailure("The Official Errata section nesting is invalid.");
          }
          if (section.publishedOnHeadingCount !== 1 || section.recognizedEntryCount === 0) {
            return parseFailure("The Official Errata entry enumeration is incomplete.");
          }
          sections.pop();
        });
      },
    })
    .on("section.contentsLCol h4.mediumTit", {
      element() {
        const section = sections.at(-1);
        if (section === undefined) {
          return parseFailure("The Official Errata published date is unavailable.");
        }
        section.publishedOnHeadingCount += 1;
      },
      text(text) {
        sections.at(-1)?.publishedOnParts.push(text.text);
      },
    })
    .on("section.contentsLCol h4.mediumTit > *", {
      element() {
        return unsupportedSemanticContent();
      },
    })
    .on(".contentsWrap h5.smallTitRed", {
      element() {
        inventoriedHeadingCount += 1;
      },
    })
    .on(".contentsWrap a.modalOpen", {
      element(element) {
        const target = element.getAttribute("data-src");
        if (target === null || !/^#[A-Za-z][A-Za-z0-9_-]+$/.test(target)) {
          return parseFailure("An Official Errata modal inventory target is invalid.");
        }
        inventoriedModalTargets.push(target);
      },
    })
    .on(".contentsWrap div.errataModal", {
      element(element) {
        const id = element.getAttribute("id");
        if (id === null || !/^[A-Za-z][A-Za-z0-9_-]+$/.test(id)) {
          return parseFailure("An Official Errata modal fragment is invalid.");
        }
        recognizedModalFragments.push(`#${id}`);
      },
    })
    .on(".contentsWrap > *", {
      element(element) {
        if (element.tagName === "p") {
          assertExactAttributes(element, [["class", "mtS"]]);
          introductoryContentCount += 1;
          return;
        }
        if (element.tagName === "section") {
          assertOptionalIdAttributes(element, "contentsLCol");
          datedSectionCount += 1;
          return;
        }
        return unsupportedSemanticContent();
      },
    })
    .on(".contentsWrap > section.contentsLCol > *", {
      element(element) {
        if (element.tagName === "section") {
          const className = element.getAttribute("class");
          if (className === "contentsMCol mtM") {
            assertExactAttributes(element, [["class", "contentsMCol mtM"]]);
            return;
          }
          if (className === "cardPackCol mtM") {
            assertExactAttributes(element, [["class", "cardPackCol mtM"]]);
            return;
          }
        }
        if (element.tagName === "div" && element.getAttribute("class") === "detailCol mtS") {
          assertOptionalIdAttributes(element, "detailCol mtS");
          return;
        }
        return unsupportedSemanticContent();
      },
    })
    .on(".contentsWrap > section.contentsLCol > section.contentsMCol > *", {
      element(element) {
        if (element.tagName !== "h4") {
          return unsupportedSemanticContent();
        }
        assertExactAttributes(element, [["class", "mediumTit"]]);
      },
    })
    .on(".contentsWrap > section.contentsLCol > section.cardPackCol > *", {
      element(element) {
        if (element.tagName !== "ul") {
          return unsupportedSemanticContent();
        }
        assertExactAttributes(element, [["class", "cardFlexWrap errataPopupCol"]]);
      },
    })
    .on(".contentsWrap > section.contentsLCol > section.cardPackCol > ul.cardFlexWrap > *", {
      element(element) {
        if (element.tagName !== "li") {
          return unsupportedSemanticContent();
        }
        assertExactAttributes(element, []);
      },
    })
    .on(".contentsWrap > section.contentsLCol > section.cardPackCol > ul.cardFlexWrap > li > *", {
      element(element) {
        if (element.tagName === "a") {
          const target = element.getAttribute("data-src");
          if (target === null || !/^#[A-Za-z][A-Za-z0-9_-]+$/.test(target)) {
            return unsupportedSemanticContent();
          }
          assertExactAttributes(element, [
            ["class", "modalOpen"],
            ["data-src", target],
          ]);
          return;
        }
        if (element.tagName === "div") {
          const id = element.getAttribute("id");
          if (id === null || !/^[A-Za-z][A-Za-z0-9_-]+$/.test(id)) {
            return unsupportedSemanticContent();
          }
          assertExactAttributes(element, [
            ["class", "errataModal"],
            ["id", id],
          ]);
          return;
        }
        return unsupportedSemanticContent();
      },
    })
    .on(".contentsWrap > section.contentsLCol > section.cardPackCol a.modalOpen > *", {
      element(element) {
        if (element.tagName !== "img") {
          return unsupportedSemanticContent();
        }
        assertImageAttributes(element);
      },
    });
  const entryHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (activeEntry !== null) {
        return parseFailure("Official Errata entries must not be nested.");
      }
      const section = sections.at(-1);
      if (section === undefined) {
        return parseFailure("An Official Erratum is outside a dated section.");
      }
      if (element.getAttribute("class") === "detailCol mtS") {
        assertOptionalIdAttributes(element, "detailCol mtS");
      } else {
        const id = element.getAttribute("id");
        if (id === null || !/^[A-Za-z][A-Za-z0-9_-]+$/.test(id)) {
          return unsupportedSemanticContent();
        }
        assertExactAttributes(element, [
          ["class", "errataModal"],
          ["id", id],
        ]);
      }
      const entry: EntryDraft = {
        sourceId: element.getAttribute("id"),
        sectionSourceId: section?.sourceId ?? null,
        sectionPublishedOn: section === undefined ? null : normalizedText(section.publishedOnParts),
        headingParts: [],
        headingCount: 0,
        imagePaths: [],
        pairs: [],
        notices: [],
        nextWordingOrdinal: 0,
        allTextParts: [],
        residualTextParts: [],
      };
      matchedEntryCount += 1;
      section.recognizedEntryCount += 1;
      activeEntry = entry;
      element.onEndTag(() => {
        if (activeEntry !== entry) {
          return parseFailure("The Official Errata entry boundary is invalid.");
        }
        observations.push(parsedEntry(entry));
        activeEntry = null;
      });
    },
    text(text) {
      activeEntry?.allTextParts.push(text.text);
      if (
        activeEntry !== null &&
        activeHeading === null &&
        activeLabel === null &&
        activeValue === null &&
        activeNotice === null
      ) {
        activeEntry.residualTextParts.push(text.text);
      }
    },
  };
  const headingHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (activeEntry === null || activeHeading !== null) {
        return parseFailure("An Official Erratum Card heading is unavailable.");
      }
      assertExactAttributes(element, [["class", "smallTitRed"]]);
      activeEntry.headingCount += 1;
      activeHeading = activeEntry.headingParts;
      element.onEndTag(() => {
        activeHeading = null;
      });
    },
    text(text) {
      activeHeading?.push(text.text);
    },
  };
  const headingBreakHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      assertExactAttributes(element, []);
      activeHeading?.push("\n");
    },
  };
  const imageHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      const source = element.getAttribute("src");
      if (activeEntry === null || source === null) {
        return parseFailure("An Official Erratum image is unavailable.");
      }
      assertExactAttributes(element, [
        ["alt", element.getAttribute("alt") ?? ""],
        ["src", source],
      ]);
      activeEntry.imagePaths.push(source);
    },
  };
  const labelHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (activeEntry === null || activeLabel !== null) {
        return parseFailure("An Official Erratum field label is invalid.");
      }
      assertExactAttributes(element, [["class", "txtBlack mtS"]]);
      const pair: PairDraft = {
        ordinal: activeEntry.nextWordingOrdinal,
        labelParts: [],
        valueParts: [],
        valueContainerCount: 0,
      };
      activeEntry.nextWordingOrdinal += 1;
      activeEntry.pairs.push(pair);
      activeLabel = pair.labelParts;
      element.onEndTag(() => {
        activeLabel = null;
      });
    },
    text(text) {
      activeLabel?.push(text.text);
    },
  };
  const valueHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      const pair = activeEntry?.pairs.at(-1);
      if (pair === undefined || activeValue !== null) {
        return parseFailure("An Official Erratum field value is invalid.");
      }
      assertExactAttributes(element, []);
      pair.valueContainerCount += 1;
      if (pair.valueContainerCount !== 1) {
        return parseFailure("An Official Erratum field must contain exactly one value container.");
      }
      activeValue = pair.valueParts;
      element.onEndTag(() => {
        activeValue = null;
      });
    },
    text(text) {
      activeValue?.push(text.text);
    },
  };
  const valueBreakHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      assertExactAttributes(element, []);
      activeValue?.push("\n");
    },
  };
  const noticeHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (activeEntry === null || activeNotice !== null) {
        return parseFailure("An Official Erratum notice is invalid.");
      }
      assertExactAttributes(element, []);
      const notice: NoticeDraft = {
        ordinal: activeEntry.nextWordingOrdinal,
        valueParts: [],
      };
      activeEntry.nextWordingOrdinal += 1;
      activeEntry.notices.push(notice);
      activeNotice = notice.valueParts;
      element.onEndTag(() => {
        activeNotice = null;
      });
    },
    text(text) {
      activeNotice?.push(text.text);
    },
  };
  const unsupportedSemanticHandler: HTMLRewriterElementContentHandlers = {
    element() {
      return parseFailure("An Official Erratum contains unsupported semantic content.");
    },
  };
  const definitionListHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      assertExactAttributes(element, []);
    },
  };
  const noticeListHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      assertExactAttributes(element, [["class", "commonNoticeList isHalf"]]);
    },
  };
  const valueChildHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (element.tagName === "br") {
        assertExactAttributes(element, []);
        return;
      }
      if (element.tagName === "span") {
        assertExactAttributes(element, [["class", "txtStrong"]]);
        return;
      }
      return parseFailure("An Official Erratum contains unsupported semantic content.");
    },
  };
  const entryChildHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (element.tagName === "h5") {
        assertExactAttributes(element, [["class", "smallTitRed"]]);
        return;
      }
      if (element.tagName === "div") {
        const className = element.getAttribute("class");
        if (className !== "typographicalWrap mtS" && className !== "typographicalWrap mtM") {
          return unsupportedSemanticContent();
        }
        assertExactAttributes(element, [["class", className]]);
        return;
      }
      if (element.tagName === "ul") {
        assertExactAttributes(element, [["class", "commonNoticeList isHalf"]]);
        return;
      }
      if (element.tagName === "dl") {
        assertExactAttributes(element, []);
        return;
      }
      return unsupportedSemanticContent();
    },
  };
  const typographicalWrapChildHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (element.tagName !== "div") {
        return unsupportedSemanticContent();
      }
      assertExactAttributes(element, [["class", "typographicalImg spWidthM centering"]]);
    },
  };
  const typographicalImageChildHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (element.tagName !== "img") {
        return unsupportedSemanticContent();
      }
      assertImageAttributes(element);
    },
  };
  const headingChildHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (element.tagName !== "br") {
        return unsupportedSemanticContent();
      }
      assertExactAttributes(element, []);
    },
  };
  const definitionListChildHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (element.tagName === "dt") {
        assertExactAttributes(element, [["class", "txtBlack mtS"]]);
        return;
      }
      if (element.tagName === "dd") {
        assertExactAttributes(element, []);
        return;
      }
      return unsupportedSemanticContent();
    },
  };
  const textOnlyChildHandler: HTMLRewriterElementContentHandlers = {
    element() {
      return unsupportedSemanticContent();
    },
  };
  const noticeListChildHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (element.tagName !== "li") {
        return unsupportedSemanticContent();
      }
      assertExactAttributes(element, []);
    },
  };
  for (const entrySelector of entrySelectors) {
    rewriter
      .on(entrySelector, entryHandler)
      .on(`${entrySelector} > *`, entryChildHandler)
      .on(`${entrySelector} h5.smallTitRed`, headingHandler)
      .on(`${entrySelector} h5.smallTitRed br`, headingBreakHandler)
      .on(`${entrySelector} h5.smallTitRed > *`, headingChildHandler)
      .on(`${entrySelector} .typographicalImg img`, imageHandler)
      .on(`${entrySelector} > div.typographicalWrap > *`, typographicalWrapChildHandler)
      .on(`${entrySelector} > div.typographicalWrap > div.typographicalImg > *`, typographicalImageChildHandler)
      .on(`${entrySelector} dl`, definitionListHandler)
      .on(`${entrySelector} > dl > *`, definitionListChildHandler)
      .on(`${entrySelector} dl > dt`, labelHandler)
      .on(`${entrySelector} dl > dt > *`, textOnlyChildHandler)
      .on(`${entrySelector} dl > dd`, valueHandler)
      .on(`${entrySelector} dl > dd br`, valueBreakHandler)
      .on(`${entrySelector} dl > dd *`, valueChildHandler)
      .on(`${entrySelector} ul`, noticeListHandler)
      .on(`${entrySelector} > ul.commonNoticeList > *`, noticeListChildHandler)
      .on(`${entrySelector} ul.commonNoticeList > li`, noticeHandler)
      .on(`${entrySelector} ul.commonNoticeList > li > *`, textOnlyChildHandler)
      .on(`${entrySelector} p`, unsupportedSemanticHandler)
      .on(`${entrySelector} ol`, unsupportedSemanticHandler);
  }

  const parsed = rewriter.transform(
    new Response(document, {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  );
  try {
    await parsed.arrayBuffer();
  } catch (error) {
    if (error instanceof AdministrationProblem) throw error;
    throw new AdministrationProblem(
      422,
      "source_parse_failed",
      error instanceof Error ? error.message : "The Official Errata HTML could not be parsed.",
    );
  }

  if (pageTitleParts.length !== 1 || normalizedText(pageTitleParts[0] ?? []) !== "Errata Cards") {
    return parseFailure("The Official Errata page title is unavailable.");
  }
  const uniqueModalTargets = new Set(inventoriedModalTargets);
  const uniqueModalFragments = new Set(recognizedModalFragments);
  const modalInventoryMatches =
    uniqueModalTargets.size === inventoriedModalTargets.length &&
    uniqueModalFragments.size === recognizedModalFragments.length &&
    uniqueModalTargets.size === uniqueModalFragments.size &&
    [...uniqueModalTargets].every((target) => uniqueModalFragments.has(target));
  if (
    introductoryContentCount !== 1 ||
    datedSectionCount === 0 ||
    inventoriedHeadingCount === 0 ||
    matchedEntryCount !== inventoriedHeadingCount ||
    observations.length !== inventoriedHeadingCount ||
    !modalInventoryMatches
  ) {
    return parseFailure("The Official Errata entry enumeration is incomplete.");
  }
  return observations;
}

function parsedEntry(entry: EntryDraft): OnePieceOfficialErratumObservation {
  if (entry.headingCount !== 1) {
    return parseFailure("An Official Erratum must contain exactly one Card heading.");
  }
  const headingLines = normalizedLines(entry.headingParts);
  const embeddedDate = headingLines.length > 1 ? publishedDate(headingLines[0] ?? "") : null;
  const displayName = headingLines.length > 1 ? normalizedText(headingLines.slice(1)) : (headingLines[0] ?? "");
  const publishedOn =
    embeddedDate ??
    (entry.sectionPublishedOn === null
      ? parseFailure("An Official Erratum has no published date.")
      : publishedDate(entry.sectionPublishedOn));
  const identity = /^([A-Z]{1,5}[0-9]{0,3}-[A-Z0-9]{1,6})\s+(.+)$/.exec(displayName);
  if (identity === null) {
    return parseFailure("An Official Erratum Card heading is invalid.");
  }
  if (entry.imagePaths.length !== 1) {
    return parseFailure("An Official Erratum image is unavailable.");
  }
  const imagePath = entry.imagePaths[0]!;
  if (!imagePath.startsWith("/")) {
    return parseFailure("An Official Erratum image path is invalid.");
  }
  const sourceId = entry.sourceId ?? entry.sectionSourceId;
  if (sourceId === null || !/^[A-Za-z][A-Za-z0-9_-]+$/.test(sourceId)) {
    return parseFailure("An Official Erratum source fragment is invalid.");
  }
  const pairs = entry.pairs.map((pair) => ({
    ordinal: pair.ordinal,
    label: normalizedText(pair.labelParts),
    value: normalizedLines(pair.valueParts).join("\n"),
    valueContainerCount: pair.valueContainerCount,
  }));
  const notices = entry.notices.map((notice) => ({
    ordinal: notice.ordinal,
    value: normalizedText(notice.valueParts),
  }));
  if (
    normalizedText(entry.residualTextParts).length > 0 ||
    pairs.length < 2 ||
    pairs.some(
      (pair) =>
        !["Note:", "Before:", "After:"].includes(pair.label) ||
        pair.value.length === 0 ||
        pair.valueContainerCount !== 1,
    ) ||
    notices.some((notice) => notice.value.length === 0)
  ) {
    return parseFailure("An Official Erratum contains an unsupported field.");
  }
  const before = exactlyOnePair(pairs, "Before:");
  const after = exactlyOnePair(pairs, "After:");
  if (pairs.filter((pair) => pair.label === "Note:").length > 1) {
    return parseFailure("An Official Erratum must contain exactly one Before/After pair.");
  }
  const officialWording = [
    ...pairs.map((pair) => ({
      ordinal: pair.ordinal,
      value: `${pair.label} ${pair.value}`,
    })),
    ...notices,
  ]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map(({ value }) => value)
    .join("\n");
  const imageUrl = `${canonicalOrigin}${imagePath}`;
  const appliesToParallelPrintings = /\bAlso applies to parallel card version\./i.test(
    normalizedText(entry.allTextParts),
  );
  const officialIdentity = {
    kind: "card_number" as const,
    value: identity[1]!,
  };
  return {
    kind: "official_erratum",
    game: "one-piece",
    target: appliesToParallelPrintings
      ? { type: "card", official_identity: officialIdentity }
      : {
          type: "printing",
          official_identity: officialIdentity,
          locator: imageUrl,
        },
    published_on: publishedOn,
    effective_from: null,
    observed_printed_rules_text: before,
    corrected_rules_text: after,
    official_wording: officialWording,
    applies_to_parallel_printings: appliesToParallelPrintings,
    source: {
      fragment: `#${sourceId}`,
      display_name: displayName,
      image_url: imageUrl,
    },
    completeness: {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 1,
      parsed_record_count: 1,
    },
  };
}

function exactlyOnePair(
  pairs: readonly Readonly<{ label: string; value: string }>[],
  label: "Before:" | "After:",
): string {
  const matching = pairs.filter((pair) => pair.label === label);
  if (matching.length !== 1) {
    return parseFailure("An Official Erratum must contain exactly one Before/After pair.");
  }
  return matching[0]!.value;
}

function publishedDate(value: string): string {
  const parsed = /^([A-Z][a-z]+) ([1-9]|[12][0-9]|3[01]), ([0-9]{4})$/.exec(value);
  const month =
    parsed === null
      ? undefined
      : [
          "January",
          "February",
          "March",
          "April",
          "May",
          "June",
          "July",
          "August",
          "September",
          "October",
          "November",
          "December",
        ].indexOf(parsed[1]!);
  if (parsed === null || month === undefined || month < 0) {
    return parseFailure("An Official Errata published date is invalid.");
  }
  const result = `${parsed[3]}-${String(month + 1).padStart(2, "0")}-${parsed[2]!.padStart(2, "0")}`;
  const instant = new Date(`${result}T00:00:00.000Z`);
  if (instant.toISOString().slice(0, 10) !== result) {
    return parseFailure("An Official Errata published date is invalid.");
  }
  return result;
}

function normalizedLines(parts: readonly string[]): string[] {
  return parts
    .join("")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

function normalizedText(parts: readonly string[]): string {
  return normalizedLines(parts).join(" ");
}

function assertOptionalIdAttributes(element: Element, className: string): void {
  const id = element.getAttribute("id");
  if (id !== null && !/^[A-Za-z][A-Za-z0-9_-]+$/.test(id)) {
    return unsupportedSemanticContent();
  }
  assertExactAttributes(
    element,
    id === null
      ? [["class", className]]
      : [
          ["class", className],
          ["id", id],
        ],
  );
}

function assertImageAttributes(element: Element): void {
  const source = element.getAttribute("src");
  const alternative = element.getAttribute("alt");
  if (source === null || alternative === null) {
    return unsupportedSemanticContent();
  }
  assertExactAttributes(element, [
    ["alt", alternative],
    ["src", source],
  ]);
}

function assertExactAttributes(element: Element, expected: readonly (readonly [string, string])[]): void {
  const observed = [...element.attributes]
    .map((attribute) => {
      const name = attribute[0];
      const value = attribute[1];
      if (name === undefined || value === undefined) {
        return parseFailure("An Official Erratum contains unsupported semantic content.");
      }
      return [name, value] as const;
    })
    .sort(([left], [right]) => left.localeCompare(right));
  const exact = [...expected].sort(([left], [right]) => left.localeCompare(right));
  if (
    observed.length !== exact.length ||
    observed.some(([name, value], index) => name !== exact[index]?.[0] || value !== exact[index]?.[1])
  ) {
    return parseFailure("An Official Erratum contains unsupported semantic content.");
  }
}

function unsupportedSemanticContent(): never {
  return parseFailure("An Official Erratum contains unsupported semantic content.");
}

function parseFailure(detail: string): never {
  throw new AdministrationProblem(422, "source_parse_failed", detail);
}
