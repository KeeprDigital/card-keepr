import assert from "node:assert/strict";
import test from "node:test";
import {
  officialDiscoveryDefinitions,
  officialDiscoveryDocument,
} from "./fixtures/synthetic-official-source.mjs";
import { officialDiscoveryAdapter } from
  "../src/catalogue/product-release-source-adapters.ts";

const adapter = {
  parse: officialDiscoveryAdapter("one-piece", "one-piece"),
};
const rawDocument = () =>
  officialDiscoveryDocument(
    structuredClone(
      officialDiscoveryDefinitions["/raw-one-piece-products"],
    ),
  );

test("production adapters derive coverage and preserve a raw sidecar", () => {
  const observations = adapter.parse(rawDocument());
  assert.equal(observations.length, 1);
  const observation = observations[0];
  assert.deepEqual(observation.completeness, {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: 1,
    parsed_record_count: 1,
  });
  assert.equal(
    observation.source_sidecar.raw.products[0].campaign_note,
    "Optional Official Source marketing copy",
  );
  assert.deepEqual(
    observation.source_sidecar.unmapped_optional_fields,
    [
      {
        path: "source_sidecar.raw.products[0].campaign_note",
        value: "Optional Official Source marketing copy",
      },
      {
        path:
          "source_sidecar.raw.products[0].vendor_metadata.merchandising.channel_code",
        value: "official-web",
      },
    ],
  );
  assert.equal(JSON.stringify(observation).includes("card_record"), false);
  assert.equal(JSON.stringify(observation).includes("product_record"), false);
});

test("a missing required Official Source surface blocks parsing", () => {
  const document = rawDocument();
  delete document.correction_notices;
  assert.throws(
    () => adapter.parse(document),
    /Official correction_notices is invalid/u,
  );
});

test("an Official Source result cap blocks completeness", () => {
  const document = rawDocument();
  document.card_list.result_cap = 1;
  assert.throws(
    () => adapter.parse(document),
    /pagination\/count\/cap evidence does not prove complete coverage/u,
  );
});

test("unfinished Official Source pagination blocks completeness", () => {
  const document = rawDocument();
  document.card_list.pages = 2;
  document.card_list.has_next = true;
  assert.throws(
    () => adapter.parse(document),
    /pagination\/count\/cap evidence does not prove complete coverage/u,
  );
});

test("Distribution Contexts bind the exact evidenced Product in a multi-Product detail", () => {
  const document = rawDocument();
  document.product_catalog.push({
    code: "OP-RAW-02",
    title: "Second evidenced Product",
  });
  document.card_pages[0].product_codes.push("OP-RAW-02");
  document.card_pages[0].distribution.product_reference = {
    kind: "official_code",
    value: "OP-RAW-02",
  };
  const observation = adapter.parse(document)[0];
  assert.deepEqual(
    observation.product_release_catalogue.distribution_contexts[0]
      .product_reference,
    { kind: "official_code", value: "OP-RAW-02" },
  );
  assert.deepEqual(
    observation.product_release_catalogue.relationships.find(
      ({ kind }) => kind === "distribution-context-product",
    ).product_reference,
    { kind: "official_code", value: "OP-RAW-02" },
  );
});

test("a Productless Distribution Context stays nullable and unresolved", () => {
  const document = rawDocument();
  document.card_pages[0].product_codes = [];
  document.card_pages[0].distribution = {
    code: "unresolved-event",
    kind: "promotion",
    label: "Unresolved event",
    product_label: "Unresolved event product",
  };
  const observation = adapter.parse(document)[0];
  const context =
    observation.product_release_catalogue.distribution_contexts[0];
  assert.equal(Object.hasOwn(context, "product_reference"), false);
  assert.ok(
    observation.product_release_catalogue.relationships.some(
      ({ kind, resolution }) =>
        kind === "distribution-context-product" &&
        resolution === "warning",
    ),
  );
});
