import { AdministrationProblem } from "./ingestion";

export type OnePieceOfficialErratumObservation = Readonly<{
  kind: "official_erratum";
  game: "one-piece";
  target: Readonly<{
    type: "card";
    official_identity: Readonly<{
      kind: "card_number";
      value: string;
    }>;
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
};

type PairDraft = {
  ordinal: number;
  labelParts: string[];
  valueParts: string[];
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
};

const canonicalOrigin = "https://en.onepiece-cardgame.com";
const entrySelectors = [
  ".contentsWrap div.detailCol",
  ".contentsWrap div.errataModal",
] as const;

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
  const inventoriedModalTargets: string[] = [];

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
        };
        sections.push(section);
        element.onEndTag(() => {
          if (sections.at(-1) !== section) {
            return parseFailure(
              "The Official Errata section nesting is invalid.",
            );
          }
          sections.pop();
        });
      },
    })
    .on("section.contentsLCol h4.mediumTit", {
      text(text) {
        sections.at(-1)?.publishedOnParts.push(text.text);
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
        if (
          target === null ||
          !/^#[A-Za-z][A-Za-z0-9_-]+$/.test(target)
        ) {
          return parseFailure(
            "An Official Errata modal inventory target is invalid.",
          );
        }
        inventoriedModalTargets.push(target);
      },
    });
  const entryHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (activeEntry !== null) {
        return parseFailure("Official Errata entries must not be nested.");
      }
      const section = sections.at(-1);
      const entry: EntryDraft = {
        sourceId: element.getAttribute("id"),
        sectionSourceId: section?.sourceId ?? null,
        sectionPublishedOn: section === undefined
          ? null
          : normalizedText(section.publishedOnParts),
        headingParts: [],
        headingCount: 0,
        imagePaths: [],
        pairs: [],
        notices: [],
        nextWordingOrdinal: 0,
        allTextParts: [],
      };
      matchedEntryCount += 1;
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
    },
  };
  const headingHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (activeEntry === null || activeHeading !== null) {
        return parseFailure(
          "An Official Erratum Card heading is unavailable.",
        );
      }
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
    element() {
      activeHeading?.push("\n");
    },
  };
  const imageHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      const source = element.getAttribute("src");
      if (activeEntry === null || source === null) {
        return parseFailure("An Official Erratum image is unavailable.");
      }
      activeEntry.imagePaths.push(source);
    },
  };
  const labelHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (activeEntry === null || activeLabel !== null) {
        return parseFailure(
          "An Official Erratum field label is invalid.",
        );
      }
      const pair: PairDraft = {
        ordinal: activeEntry.nextWordingOrdinal,
        labelParts: [],
        valueParts: [],
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
        return parseFailure(
          "An Official Erratum field value is invalid.",
        );
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
    element() {
      activeValue?.push("\n");
    },
  };
  const noticeHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (activeEntry === null || activeNotice !== null) {
        return parseFailure(
          "An Official Erratum notice is invalid.",
        );
      }
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
  for (const entrySelector of entrySelectors) {
    rewriter
      .on(entrySelector, entryHandler)
      .on(`${entrySelector} h5.smallTitRed`, headingHandler)
      .on(`${entrySelector} h5.smallTitRed br`, headingBreakHandler)
      .on(`${entrySelector} .typographicalImg img`, imageHandler)
      .on(`${entrySelector} dl > dt`, labelHandler)
      .on(`${entrySelector} dl > dd`, valueHandler)
      .on(`${entrySelector} dl > dd br`, valueBreakHandler)
      .on(
        `${entrySelector} ul.commonNoticeList > li`,
        noticeHandler,
      );
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
      error instanceof Error
        ? error.message
        : "The Official Errata HTML could not be parsed.",
    );
  }

  if (
    pageTitleParts.length !== 1 ||
    normalizedText(pageTitleParts[0] ?? []) !== "Errata Cards"
  ) {
    return parseFailure("The Official Errata page title is unavailable.");
  }
  if (
    inventoriedHeadingCount === 0 ||
    matchedEntryCount !== inventoriedHeadingCount ||
    observations.length !== inventoriedHeadingCount ||
    inventoriedModalTargets.some(
      (target) =>
        !observations.some(
          (observation) => observation.source.fragment === target,
        ),
    )
  ) {
    return parseFailure(
      "The Official Errata entry enumeration is incomplete.",
    );
  }
  return observations;
}

function parsedEntry(
  entry: EntryDraft,
): OnePieceOfficialErratumObservation {
  if (entry.headingCount !== 1) {
    return parseFailure(
      "An Official Erratum must contain exactly one Card heading.",
    );
  }
  const headingLines = normalizedLines(entry.headingParts);
  const embeddedDate = headingLines.length > 1
    ? publishedDate(headingLines[0] ?? "")
    : null;
  const displayName = headingLines.length > 1
    ? normalizedText(headingLines.slice(1))
    : headingLines[0] ?? "";
  const publishedOn = embeddedDate ??
    (entry.sectionPublishedOn === null
      ? parseFailure("An Official Erratum has no published date.")
      : publishedDate(entry.sectionPublishedOn));
  const identity = /^([A-Z]{1,5}[0-9]{0,3}-[A-Z0-9]{1,6})\s+(.+)$/
    .exec(displayName);
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
  if (
    sourceId === null ||
    !/^[A-Za-z][A-Za-z0-9_-]+$/.test(sourceId)
  ) {
    return parseFailure("An Official Erratum source fragment is invalid.");
  }
  const pairs = entry.pairs.map((pair) => ({
    ordinal: pair.ordinal,
    label: normalizedText(pair.labelParts),
    value: normalizedLines(pair.valueParts).join("\n"),
  }));
  const notices = entry.notices.map((notice) => ({
    ordinal: notice.ordinal,
    value: normalizedText(notice.valueParts),
  }));
  if (
    pairs.length < 2 ||
    pairs.some((pair) =>
      !["Note:", "Before:", "After:"].includes(pair.label) ||
      pair.value.length === 0
    ) ||
    notices.some((notice) => notice.value.length === 0)
  ) {
    return parseFailure(
      "An Official Erratum contains an unsupported field.",
    );
  }
  const before = exactlyOnePair(pairs, "Before:");
  const after = exactlyOnePair(pairs, "After:");
  if (pairs.filter((pair) => pair.label === "Note:").length > 1) {
    return parseFailure(
      "An Official Erratum must contain exactly one Before/After pair.",
    );
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
  return {
    kind: "official_erratum",
    game: "one-piece",
    target: {
      type: "card",
      official_identity: {
        kind: "card_number",
        value: identity[1]!,
      },
    },
    published_on: publishedOn,
    effective_from: null,
    observed_printed_rules_text: before,
    corrected_rules_text: after,
    official_wording: officialWording,
    applies_to_parallel_printings:
      /\bAlso applies to parallel card version\./i.test(
        normalizedText(entry.allTextParts),
      ),
    source: {
      fragment: `#${sourceId}`,
      display_name: displayName,
      image_url: `${canonicalOrigin}${imagePath}`,
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
    return parseFailure(
      "An Official Erratum must contain exactly one Before/After pair.",
    );
  }
  return matching[0]!.value;
}

function publishedDate(value: string): string {
  const parsed = /^([A-Z][a-z]+) ([1-9]|[12][0-9]|3[01]), ([0-9]{4})$/
    .exec(value);
  const month = parsed === null
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
  const result = `${parsed[3]}-${String(month + 1).padStart(2, "0")}-${
    parsed[2]!.padStart(2, "0")
  }`;
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

function parseFailure(detail: string): never {
  throw new AdministrationProblem(422, "source_parse_failed", detail);
}
