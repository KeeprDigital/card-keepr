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
  const identity = normalizedOfficialArtworkIdentity(
    officialCardIdentity,
    roles,
    artworkId,
  );
  return `${prefix}${JSON.stringify(identity)}`;
}

export function parsedOfficialArtworkIdentity(
  fingerprint: string,
): OfficialArtworkIdentity | null {
  if (!fingerprint.startsWith(prefix)) return null;
  try {
    const value: unknown = JSON.parse(fingerprint.slice(prefix.length));
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !==
        "artwork_id,official_card_identity,roles" ||
      typeof value.official_card_identity !== "string" ||
      value.official_card_identity.length === 0 ||
      !Array.isArray(value.roles) ||
      value.roles.length === 0 ||
      value.roles.some((role) => typeof role !== "string" || role.length === 0) ||
      (
        value.artwork_id !== null &&
        (typeof value.artwork_id !== "string" || value.artwork_id.length === 0)
      )
    ) {
      return null;
    }
    return {
      official_card_identity: value.official_card_identity,
      roles: value.roles as string[],
      artwork_id: value.artwork_id as string | null,
    };
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
  const normalizedArtworkId =
    artworkId?.normalize("NFC").trim().toLocaleLowerCase() ?? null;
  const stableRoles = [...new Set(
    roles.map((role) => role.normalize("NFC").trim().toLocaleLowerCase()),
  )].sort();
  if (
    card.length === 0 ||
    stableRoles.length === 0 ||
    stableRoles.some((role) => role.length === 0)
  ) {
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
