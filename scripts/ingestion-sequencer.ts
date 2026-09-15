import { readFile } from "node:fs/promises";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { selectIngestionShard } from "../test/support/ingestion-shards.ts";

export class IngestionSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    // Keep Vitest's explicitly permitted empty selections; ordinary oversized
    // shard counts are rejected by Vitest before this boundary.
    if (this.ctx.config.passWithNoTests && shard.count > files.length) return super.shard(files);
    const sources = await Promise.all(
      files.map(async (file) => ({ file, path: file.moduleId, source: await readFile(file.moduleId, "utf8") })),
    );
    return selectIngestionShard(sources, this.ctx.config.root, shard).map(({ file }) => file);
  }
}
