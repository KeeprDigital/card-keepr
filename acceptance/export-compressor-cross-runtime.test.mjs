import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  deterministicGzip,
  utf8,
} from "../src/catalogue/serialization.ts";
import { GZIP_PROFILE_GOLDENS } from
  "../apps/ingestion/test/deterministic-gzip-golden.ts";

const productRecord = (name, officialCode, revisionId, id) => ({
  type: "product",
  id,
  game: "one-piece",
  official_code: officialCode,
  name,
  lifecycle: {
    first_revision_id: revisionId,
    last_observed_revision_id: revisionId,
    withdrawn: false,
  },
});

const fixtures = {
  ascii: {
    game_profile: "one-piece@1",
    id: "game_one_piece",
    key: "one-piece",
    name: "One Piece Card Game",
    supported_locales: ["EN-OCEANIA"],
    type: "supported_game",
  },
  non_ascii_nfc: productRecord(
    "Cafe\u0301 E\u0301tude",
    "NFC-1",
    "catrev_gzip_non_ascii_nfc",
    "product_nfc",
  ),
  null_values: productRecord(
    null,
    null,
    "catrev_gzip_null_values",
    "product_null",
  ),
  multiple_deflate_blocks: productRecord(
    `Block ${"abcdef0123456789".repeat(5_000)}`,
    "BLOCKS",
    "catrev_gzip_multiple_deflate_blocks",
    "product_blocks",
  ),
};

test("the pinned compressor emits the Worker profile bytes in Node", () => {
  for (const [name, record] of Object.entries(fixtures)) {
    const compressed = deterministicGzip(
      utf8(`${canonicalJson(record)}\n`),
    );
    assert.equal(
      Buffer.from(compressed).toString("hex"),
      GZIP_PROFILE_GOLDENS[name],
      name,
    );
  }
  assert.equal(
    Buffer.from(deterministicGzip(new Uint8Array())).toString("hex"),
    GZIP_PROFILE_GOLDENS.empty_component,
  );
});
