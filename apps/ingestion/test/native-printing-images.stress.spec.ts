import { test } from "vitest";
import { assertNativePrintingImagePublication } from "./native-printing-images-assertions";
import { installReconciliationSuite } from "./reconciliation-helpers";

installReconciliationSuite();

test("128 native images retain their streaming, publication and serving contracts at volume", async () => {
  await assertNativePrintingImagePublication("128-images", 128);
}, 120_000);
