export function normalizeOnePieceCardPage(
  value: Readonly<Record<string, unknown>>,
): {
  attributes: Record<string, unknown>;
  printingAttributes?: Record<string, unknown>;
  normalizedRarity: string | null;
};

export function onePieceDonCardObservation(
  value: unknown,
): Record<string, unknown>;

export function normalizedOnePieceRarity(value: unknown): string | null;

export function onePieceRecordingMemberships(
  value: unknown,
): ReadonlyMap<string, readonly string[]>;
