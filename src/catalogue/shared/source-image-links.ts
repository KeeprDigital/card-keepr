// Owner decision (#425, 2026-09-22): a Source Image Link is opt-in per Source
// Adapter registration. Scryfall permits embedding its image files; every
// other source stays off until its terms are clarified. Reconciliation stores
// a link under its policy key and the read model attaches the attribution.

/** Terms a consumer must honour when it displays a linked source image. */
export type SourceImageLinkPolicy = Readonly<{
  /** Stable key stored with each link; reads select attribution by it. */
  source: string;
  /** Only an exact https URL on these hosts may be published as a link. */
  hosts: readonly string[];
  attribution: Readonly<{
    provider: string;
    provider_url: string;
    notice: string;
    policy_url: string;
    terms_url: string;
  }>;
}>;

export const scryfallSourceImageLinks: SourceImageLinkPolicy = Object.freeze({
  source: "scryfall",
  hosts: Object.freeze(["cards.scryfall.io"]),
  attribution: Object.freeze({
    provider: "Scryfall",
    provider_url: "https://scryfall.com",
    notice:
      "Card image provided by Scryfall; display it unmodified. Card Keepr is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.",
    policy_url: "https://company.wizards.com/en/legal/fancontentpolicy",
    terms_url: "https://scryfall.com/docs/api/images",
  }),
});

const policies: ReadonlyMap<string, SourceImageLinkPolicy> = new Map([
  [scryfallSourceImageLinks.source, scryfallSourceImageLinks],
]);

/** The policy for a stored link's source, or null when no policy grants it. */
export function sourceImageLinkPolicy(source: unknown): SourceImageLinkPolicy | null {
  return typeof source === "string" ? (policies.get(source) ?? null) : null;
}

/** Accept a claimed URL only as an exact https URL on the policy's hosts, kept verbatim. */
export function sourceImageLinkUrl(policy: SourceImageLinkPolicy, value: unknown): string | null {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !policy.hosts.includes(url.hostname))
    return null;
  // The exact retained string, including Scryfall's cache-busting timestamp query.
  return value;
}

/**
 * The consumer's unverified `source_image`: served only while the Printing has
 * no Printing Image and a policy still grants the stored link's source.
 */
export function sourceImageRepresentation(link: unknown, printingImageCount: number) {
  if (printingImageCount > 0 || link === null || typeof link !== "object") return undefined;
  const { source, url, retrieved_at } = link as Record<string, unknown>;
  const policy = sourceImageLinkPolicy(source);
  const exact = policy && sourceImageLinkUrl(policy, url);
  if (!policy || !exact) return undefined;
  return {
    url: exact,
    role: "front" as const,
    source: policy.source,
    retrieved_at: typeof retrieved_at === "string" ? retrieved_at : null,
    verified: false as const,
    attribution: { ...policy.attribution },
  };
}
