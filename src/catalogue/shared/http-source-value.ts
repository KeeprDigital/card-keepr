import { z } from "@hono/zod-openapi";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
// Used for source-defined values and owner assertions; catalogue facts use explicit route schemas.
const nonNullSourceValue: z.ZodType<Exclude<JsonValue, null>> = z
  .lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.union([nonNullSourceValue, z.null()])),
      z.record(z.string(), z.union([nonNullSourceValue, z.null()])),
    ]),
  )
  .openapi("CandidateNonNullSourceValue");
export const sourceValue = z.union([nonNullSourceValue, z.null()]);
const sourceObject = z.record(z.string(), sourceValue);
// Validate free-form JSON without rebuilding it: literal keys such as __proto__
// are retained evidence and must survive both command parsing and inspection.
export const retainedSourceObject = z
  .custom<z.infer<typeof sourceObject>>((value) => sourceObject.safeParse(value).success)
  .openapi({ type: "object", additionalProperties: true });
