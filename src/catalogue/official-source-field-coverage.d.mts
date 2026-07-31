export type RawLeaf = { path: string; value: unknown };

export function partitionMappedOfficialLeaves(
  value: unknown,
  path: string,
): { consumed: string[]; unmapped: RawLeaf[] };
