import { importedWrite } from "./service.ts";
export async function awaited(db: D1Database, bucket: R2Bucket, keys: string[]) {
  await importedWrite();
  await db.prepare("INSERT INTO diagnostic_only VALUES (1)").run();
  await bucket.put("diagnostic-only", "value");
  await Promise.all(keys.map((key) => bucket.put(key, "value")));
}
export function returned(bucket: R2Bucket) { return bucket.put("diagnostic-only", "value"); }
export function background(ctx: ExecutionContext, bucket: R2Bucket) {
  ctx.waitUntil(bucket.put("diagnostic-only", "value").catch((error: unknown) => { console.error(error); }));
}
export function safelyParsed(text: string): string | null {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed === "object" && parsed !== null && "title" in parsed && typeof parsed.title === "string") return parsed.title;
  return null;
}
export function label(state: "pending" | "approved" | "rejected") {
  switch (state) {
    case "pending": return "Pending";
    case "approved": return "Approved";
    case "rejected": return "Rejected";
  }
}
