import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Temporary failure-only capture: one receipt and at most two 4 MiB SQL files.
export async function retainPokemonImportFailure({ uploaded, exported, metadata }) {
  const directory = join(process.cwd(), "test-results", "pokemon-import-failure");
  const sqlLimit = 4 * 1024 * 1024;
  const receiptLimit = 16 * 1024;
  const inputs = [
    ["uploaded.sql", uploaded],
    ["exported.sql", exported],
  ].map(([name, sql]) => ({ name, data: Buffer.from(sql ?? "", "utf8") }));
  const receipt = JSON.stringify(
    {
      ...metadata,
      platform: process.platform,
      node: process.versions.node,
      sqlite: process.versions.sqlite,
      inputs: inputs.map(({ name, data }) => ({
        name,
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        retained: data.length <= sqlLimit,
      })),
    },
    null,
    2,
  );
  if (Buffer.byteLength(receipt) > receiptLimit) throw new Error("Pokémon import receipt exceeds 16 KiB.");
  await mkdir(directory, { recursive: true });
  let file;
  try {
    file = await open(join(directory, "metadata.json"), "wx");
  } catch (error) {
    if (error.code === "EEXIST") return;
    throw error;
  }
  try {
    await file.writeFile(receipt);
    for (const { name, data } of inputs) {
      if (data.length <= sqlLimit) await writeFile(join(directory, name), data, { flag: "wx" });
    }
    console.error("[DEBUG-329-import] Retained original SQLite import failure:", metadata.error.message);
  } finally {
    await file.close();
  }
}
