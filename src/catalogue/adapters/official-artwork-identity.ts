const prefix = "official-artwork:";

export type OfficialArtworkIdentity = Readonly<{
  official_card_identity: string;
  roles: readonly string[];
  artwork_id: string | null;
}>;

export function officialArtworkFingerprint(
  officialCardIdentity: string,
  roles: readonly string[],
  artworkId: string | null,
): string {
  const identity = normalizedOfficialArtworkIdentity(officialCardIdentity, roles, artworkId);
  return `${prefix}${JSON.stringify(identity)}`;
}

export function parsedOfficialArtworkIdentity(fingerprint: string): OfficialArtworkIdentity | null {
  if (!fingerprint.startsWith(prefix)) return null;
  try {
    const value: unknown = JSON.parse(fingerprint.slice(prefix.length));
    if (!isRecord(value) || Object.keys(value).sort().join(",") !== "artwork_id,official_card_identity,roles") {
      return null;
    }
    const { official_card_identity, roles, artwork_id } = value;
    if (
      typeof official_card_identity !== "string" ||
      official_card_identity.length === 0 ||
      !isNonEmptyStringArray(roles) ||
      (artwork_id !== null && !isNonEmptyString(artwork_id))
    ) {
      return null;
    }
    return { official_card_identity, roles, artwork_id };
  } catch {
    return null;
  }
}

function normalizedOfficialArtworkIdentity(
  officialCardIdentity: string,
  roles: readonly string[],
  artworkId: string | null,
): OfficialArtworkIdentity {
  const card = officialCardIdentity.normalize("NFC").trim().toUpperCase();
  const normalizedArtworkId = artworkId?.normalize("NFC").trim().toLocaleLowerCase() ?? null;
  const stableRoles = [...new Set(roles.map((role) => role.normalize("NFC").trim().toLocaleLowerCase()))].sort();
  if (card.length === 0 || stableRoles.length === 0 || stableRoles.some((role) => role.length === 0)) {
    throw new Error("Official Printing has no stable semantic artwork identity.");
  }
  return {
    official_card_identity: card,
    roles: stableRoles,
    artwork_id: normalizedArtworkId === "" ? null : normalizedArtworkId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}
