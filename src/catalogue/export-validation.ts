import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import manifestSchema from "../../prototype/formalize-implementation-contracts/schemas/catalogue-export-manifest.schema.json";
import recordSchema from "../../prototype/formalize-implementation-contracts/schemas/catalogue-export-record.schema.json";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateManifest = ajv.compile(manifestSchema);
const validateRecord = ajv.compile(recordSchema);

export function verifyExportSchemas(
  manifest: unknown,
  componentRecords: readonly (readonly unknown[])[],
): void {
  assertValid(validateManifest, manifest, "manifest");
  for (const records of componentRecords) {
    for (const record of records) {
      assertValid(validateRecord, record, "record");
    }
  }
}

function assertValid(
  validate: ValidateFunction,
  value: unknown,
  artifact: string,
): void {
  if (!validate(value)) {
    throw new Error(
      `Catalogue Export ${artifact} failed schema verification: ${ajv.errorsText(validate.errors)}`,
    );
  }
}
