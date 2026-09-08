// Accepted synthetic input shapes. These declarations describe intended input,
// never measured retained bytes or successful application capacity.
export const syntheticCapacityTiers = [
  { id: "tier-1", printings: 10_000, images: 20_000, imageBytes: 5 * 1024 ** 3, structuredBytes: 100 * 1024 ** 2 },
  { id: "tier-2", printings: 100_000, images: 200_000, imageBytes: 50 * 1024 ** 3, structuredBytes: 1024 ** 3 },
] as const;

export const capacityPrintingsPerPage = 16;

export function syntheticCapacityTier(id: string) {
  const tier = syntheticCapacityTiers.find((tier) => tier.id === id);
  if (!tier) throw new Error(`Unknown synthetic capacity tier: ${id}`);
  return tier;
}

export function capacityByteShare(total: number, count: number, index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error("Capacity index out of range");
  return Math.floor((total * (index + 1)) / count) - Math.floor((total * index) / count);
}

export function capacityPageUrl(tier: string, page: number) {
  const workload = syntheticCapacityTier(tier);
  if (!Number.isSafeInteger(page) || page < 0 || page >= workload.printings / capacityPrintingsPerPage)
    throw new Error("Capacity page out of range");
  return `https://official-source.invalid/reconciliation/capacity-${tier}-page-${page}`;
}
