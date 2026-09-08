import { curatedField } from "./document-validators.mjs";
import { curatedFieldSchemaSelector } from "./curated-field-schemas";

/** Unknown schemas fail closed; request handling never compiles executable code. */
export function validCuratedField(schema: Readonly<Record<string, unknown>>, value: unknown): boolean {
  const selector = curatedFieldSchemaSelector(schema);
  return selector !== undefined && curatedField({ schema: selector, value });
}
