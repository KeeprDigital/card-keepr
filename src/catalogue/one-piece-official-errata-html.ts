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

const canonicalOrigin = "https://en.onepiece-cardgame.com";

export function parseOnePieceOfficialErrataHtml(
  document: string,
): readonly OnePieceOfficialErratumObservation[] {
  if (
    !/<h3\b[^>]*class="[^"]*\bpageTit\b[^"]*"[^>]*>\s*Errata Cards\s*<\/h3>/i
      .test(document)
  ) {
    return parseFailure("The Official Errata page title is unavailable.");
  }
  const headings = [...document.matchAll(
    /<h4\b[^>]*class="[^"]*\bmediumTit\b[^"]*"[^>]*>([\s\S]*?)<\/h4>/gi,
  )].map((match) => ({
    index: match.index,
    publishedOn: publishedDate(textContent(match[1] ?? "")),
  }));
  const details = [...document.matchAll(
    /<div\b(?=[^>]*class="[^"]*\bdetailCol\b[^"]*")(?=[^>]*\bid="([^"]+)")[^>]*>/gi,
  )];
  if (headings.length === 0 || details.length === 0) {
    return parseFailure("The Official Errata dated Card sections are unavailable.");
  }

  return details.map((detail, index) => {
    const start = detail.index;
    const end = details[index + 1]?.index ?? document.length;
    const fragment = document.slice(start, end);
    const heading = [...headings]
      .reverse()
      .find((candidate) => candidate.index < start);
    if (heading === undefined) {
      return parseFailure("An Official Erratum has no published date.");
    }
    const title = singleCapture(
      fragment,
      /<h5\b[^>]*class="[^"]*\bsmallTitRed\b[^"]*"[^>]*>([\s\S]*?)<\/h5>/gi,
      "An Official Erratum Card heading is unavailable.",
    );
    const displayName = textContent(title);
    const identity = /^([A-Z]{1,5}[0-9]{0,3}-[A-Z0-9]{1,6})\s+(.+)$/
      .exec(displayName);
    if (identity === null) {
      return parseFailure("An Official Erratum Card heading is invalid.");
    }
    const pairs = [...fragment.matchAll(
      /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi,
    )].map((match) => ({
      label: textContent(match[1] ?? ""),
      value: textContent(match[2] ?? "", true),
    }));
    if (
      pairs.length !== 2 ||
      pairs[0]?.label !== "Before:" ||
      pairs[1]?.label !== "After:" ||
      pairs.some((pair) => pair.value.length === 0)
    ) {
      return parseFailure(
        "An Official Erratum must contain exactly one Before/After pair.",
      );
    }
    const imagePath = singleCapture(
      fragment,
      /<img\b(?=[^>]*\bsrc="([^"]+)")[^>]*>/gi,
      "An Official Erratum image is unavailable.",
    );
    if (!imagePath.startsWith("/")) {
      return parseFailure("An Official Erratum image path is invalid.");
    }
    const sourceId = detail[1] ?? "";
    if (!/^errata_[A-Za-z0-9_-]+$/.test(sourceId)) {
      return parseFailure("An Official Erratum source fragment is invalid.");
    }
    const before = pairs[0].value;
    const after = pairs[1].value;
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
      published_on: heading.publishedOn,
      effective_from: null,
      observed_printed_rules_text: before,
      corrected_rules_text: after,
      official_wording: `Before: ${before}\nAfter: ${after}`,
      applies_to_parallel_printings:
        /\bAlso applies to parallel card version\./i.test(textContent(fragment)),
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
  });
}

function singleCapture(
  value: string,
  pattern: RegExp,
  detail: string,
): string {
  const matches = [...value.matchAll(pattern)];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    return parseFailure(detail);
  }
  return matches[0][1];
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

function textContent(value: string, preserveBreaks = false): string {
  return decodeEntities(
    value
      .replace(/<br\s*\/?>/gi, preserveBreaks ? "\n" : " ")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join(preserveBreaks ? "\n" : " ");
}

function decodeEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    nbsp: " ",
    quot: "\"",
    rdquo: "”",
    rsquo: "’",
  };
  return value.replace(
    /&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi,
    (entity, encoded: string) => {
      if (encoded.startsWith("#")) {
        const hexadecimal = encoded[1]?.toLowerCase() === "x";
        const point = Number.parseInt(
          encoded.slice(hexadecimal ? 2 : 1),
          hexadecimal ? 16 : 10,
        );
        if (!Number.isInteger(point) || point < 0 || point > 0x10ffff) {
          return parseFailure("The Official Errata HTML entity is invalid.");
        }
        return String.fromCodePoint(point);
      }
      const decoded = named[encoded.toLowerCase()];
      if (decoded === undefined) {
        return parseFailure("The Official Errata HTML entity is unsupported.");
      }
      return decoded;
    },
  );
}

function parseFailure(detail: string): never {
  throw new AdministrationProblem(422, "source_parse_failed", detail);
}
