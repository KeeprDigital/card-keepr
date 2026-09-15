/** Logical card regions can share a physical side, such as split and Adventure cards. */
export const magicLayouts = [
  "normal",
  "token",
  "art_series",
  "transform",
  "saga",
  "adventure",
  "planar",
  "split",
  "modal_dfc",
  "emblem",
  "double_faced_token",
  "scheme",
  "mutate",
  "prepare",
  "class",
  "meld",
  "leveler",
  "flip",
  "prototype",
  "vanguard",
  "host",
  "case",
  "augment",
  "reversible_card",
] as const;

export function magicFaceRoles(layout: string, count: number): ("front" | "back")[] {
  if (!magicLayouts.some((known) => known === layout)) throw new Error("Magic layout is unsupported.");
  if (["transform", "modal_dfc", "art_series", "double_faced_token", "reversible_card"].includes(layout)) {
    if (count !== 2) throw new Error("Magic double-sided layout requires two faces.");
    return ["front", "back"];
  }
  const sharedSide = ["split", "flip", "adventure", "prepare"].includes(layout);
  if (sharedSide ? count < 2 || count > (layout === "split" ? 5 : 2) : count !== 1)
    throw new Error("Magic layout and logical face count disagree.");
  return Array.from({ length: count }, () => "front");
}
