import { test } from "vitest";
import { assertNativePrintingImagePublication } from "./native-printing-images-assertions";
import { installReconciliationSuite } from "./reconciliation-helpers";

installReconciliationSuite();

test("native publication streams distinct images into verified serving and export references", async () => {
  // Two distinct images prove streaming and reference identity; each still crosses
  // the 64 KiB transfer chunk boundary. Catalogue volume belongs in the stress case.
  await assertNativePrintingImagePublication("2-images", 2);
});
