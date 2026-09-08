import { expect, test, vi } from "vitest";
import { extractBoundedAdapterPage } from "../../src/catalogue/adapters/bounded-page-extraction";
import { syntheticAdapterRegistrations } from "../support/source-adapters";
const base = syntheticAdapterRegistrations[0]!;
const context = { url: "https://example.test/page", mediaType: "text/html" };
function chunks(value: string) {
  return async function* () {
    for (let offset = 0; offset < value.length; offset += 65536) yield value.slice(offset, offset + 65536);
  };
}
test("HTML decoded and element budgets fail before invoking the semantic parser", async () => {
  const parseBytes = vi.fn(() => []);
  const adapter = { ...base, parseBytes };
  await expect(extractBoundedAdapterPage(adapter, chunks("a".repeat(2097153)), context)).rejects.toThrow("decoded");
  await expect(extractBoundedAdapterPage(adapter, chunks("<i>".repeat(32769)), context)).rejects.toThrow(
    "construction budget",
  );
  expect(parseBytes).not.toHaveBeenCalled();
});
test("embedded JSON structural budget is checked before constructing semantic records", async () => {
  const parseBytes = vi.fn(() => []);
  await expect(
    extractBoundedAdapterPage(
      { ...base, parseBytes },
      chunks(`<script type="application/json">{"cards":[{"x":[${"0,".repeat(16385)}0]}]}</script>`),
      context,
    ),
  ).rejects.toThrow("structural budget");
  expect(parseBytes).not.toHaveBeenCalled();
});
test("single unwrapped JSON remains one observation and array order preserves admitted identities", async () => {
  const document = { kind: "card", card: { name: "one", rules: "large field" } };
  const single = await extractBoundedAdapterPage(base, chunks(JSON.stringify(document)), context);
  expect(single.count).toBe(1);
  expect(await collect(single.records)).toEqual([{ sourceKey: "0", value: document, request: null }]);
  const ordered = await extractBoundedAdapterPage(
    base,
    chunks('{"product_surfaces":[{"product":1}],"cards":[{"card":1}]}'),
    context,
  );
  expect((await collect(ordered.records)).map((record) => record.value)).toEqual([{ card: 1 }, { product: 1 }]);
  expect((await extractBoundedAdapterPage(base, chunks('{"cards":[]}'), context)).count).toBe(0);
});
test("source I/O errors remain distinguishable from malformed JSON", async () => {
  const outage = new Error("R2 unavailable");
  await expect(
    extractBoundedAdapterPage(
      base,
      async function* () {
        yield '{"cards":[';
        throw outage;
      },
      context,
    ),
  ).rejects.toBe(outage);
  await expect(extractBoundedAdapterPage(base, chunks('{"cards":[,]}'), context)).rejects.toMatchObject({
    category: "source-contract",
  });
});

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

test("publisher rich HTML nested in JSON shares the page construction budget", async () => {
  const parseBytes = vi.fn(() => []);
  const payload = JSON.stringify({ props: { body: "<i>".repeat(32769) } });
  await expect(
    extractBoundedAdapterPage({ ...base, parseBytes }, chunks(`<script id=__NEXT_DATA__>${payload}</script>`), context),
  ).rejects.toThrow("construction budget");
  expect(parseBytes).not.toHaveBeenCalled();
});

test("array-container interpretation belongs to the adapter, including mixed and unwrapped inputs", async () => {
  for (const document of [
    { kind: "card", rows: [] },
    { kind: "card", rows: [1, 2] },
    { cards: "not an array", rows: [] },
  ]) {
    const extracted = await extractBoundedAdapterPage(base, chunks(JSON.stringify(document)), context);
    expect(extracted.count).toBe(1);
    expect((await collect(extracted.records)).map((record) => record.value)).toEqual([document]);
  }
  const mixed = { product_surfaces: [{ product: 1 }], rows: [{ ignored: true }], cards: [{ card: 1 }] };
  const extracted = await extractBoundedAdapterPage(base, chunks(JSON.stringify(mixed)), context);
  expect((await collect(extracted.records)).map((record) => record.value)).toEqual(await base.parse!(mixed));
  const tabular = syntheticAdapterRegistrations.find(
    (adapter) => adapter.adapterVersion === "fixture-one-piece-tabular@1",
  )!;
  const document = { cards: [{ ignored: true }], rows: [{ cells: ["OP01-001", "Name", "Rules", {}], evidence: {} }] };
  const rows = await extractBoundedAdapterPage(tabular, chunks(JSON.stringify(document)), context);
  expect((await collect(rows.records)).map((record) => record.value)).toEqual(await tabular.parse!(document));
});
