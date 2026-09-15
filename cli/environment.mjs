import { environmentNames } from "../src/http/environment-target.mjs";

/** Explicit remote profiles never inherit an unscoped URL or credential. */
export function selectEnvironment(arguments_, environment) {
  const index = arguments_.indexOf("--target");
  if (index === -1) return { arguments_, environment };
  const target = arguments_[index + 1];
  if (!["dev", "staging", "production"].includes(target) || arguments_.lastIndexOf("--target") !== index)
    throw new Error("--target requires exactly one of dev, staging, production.");
  const prefix = `KEEPR_${target.toUpperCase()}_`;
  const { publicBases } = environmentNames(target);
  const selected = { ...environment, KEEPR_TARGET: target };
  for (const key of ["API_KEY", "ADMINISTRATION_KEY"]) selected[`KEEPR_${key}`] = environment[`${prefix}${key}`];
  selected.KEEPR_API_URL = publicBases.api;
  selected.KEEPR_INGESTION_URL = publicBases.ingestion;
  // A remote profile must never inherit a local test clock.
  delete selected.KEEPR_TEST_NOW;
  return {
    arguments_: arguments_.filter((_, position) => position !== index && position !== index + 1),
    environment: selected,
  };
}
