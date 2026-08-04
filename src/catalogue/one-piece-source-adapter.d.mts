export function normalizeOnePieceCardPage(
  value: Readonly<Record<string, unknown>>,
): {
  attributes: Record<string, unknown>;
  printingAttributes: Record<string, unknown>;
};

export function onePieceDonCardObservation(
  value: unknown,
): Record<string, unknown>;

export function onePieceRecordingMemberships(
  value: unknown,
): ReadonlyMap<string, readonly string[]>;
