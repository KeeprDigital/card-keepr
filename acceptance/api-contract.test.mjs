import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("Product detail documents invalid include requests", async () => {
  const openapi = JSON.parse(
    await readFile(
      resolve(
        root,
        "prototype/formalize-implementation-contracts/openapi.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    openapi.paths["/products/{product_id}"].get.responses["400"],
    { $ref: "#/components/responses/InvalidRequest" },
  );
});

test("Printing machine schemas require typed projections with evidence", async () => {
  const [api, exportSchema] = await Promise.all(
    [
      "api.schema.json",
      "catalogue-export-record.schema.json",
    ].map(async (name) =>
      JSON.parse(
        await readFile(
          resolve(
            root,
            "prototype/formalize-implementation-contracts/schemas",
            name,
          ),
          "utf8",
        ),
      )
    ),
  );
  assert.ok(api.$defs.Printing.required.includes("products"));
  assert.equal(
    api.$defs.PrintingProductProjection.properties
      .source_observation_ids.minItems,
    1,
  );
  assert.equal(
    api.$defs.DistributionContext.properties
      .source_observation_ids.minItems,
    1,
  );
  assert.ok(
    exportSchema.$defs.PrintingRecord.required.includes("products"),
  );
  assert.ok(
    exportSchema.$defs.PrintingRecord.required.includes(
      "distribution_contexts",
    ),
  );
  for (const definition of [
    "PrintingProductProjection",
    "PrintingDistributionContextProjection",
  ]) {
    assert.equal(
      exportSchema.$defs[definition].properties
        .source_observation_ids.minItems,
      1,
    );
  }
});
