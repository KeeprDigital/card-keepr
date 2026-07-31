export type OfficialArtworkIdentity = Readonly<{
  official_card_identity: string;
  roles: readonly string[];
  artwork_id: string | null;
}>;

export function officialArtworkFingerprint(
  officialCardIdentity: string,
  roles: readonly string[],
  artworkId: string | null,
): string;

export function parsedOfficialArtworkIdentity(
  fingerprint: string,
): OfficialArtworkIdentity | null;
