import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import manifestSchemaV1 from "../../prototype/formalize-implementation-contracts/schemas/catalogue-export-manifest.schema.json";
import manifestSchemaV2 from "../../prototype/formalize-implementation-contracts/schemas/catalogue-export-manifest-v2.schema.json";
import recordSchemaV1 from "../../prototype/formalize-implementation-contracts/schemas/catalogue-export-record.schema.json";
import recordSchemaV2 from "../../prototype/formalize-implementation-contracts/schemas/catalogue-export-record-v2.schema.json";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(manifestSchemaV1);
ajv.addSchema(recordSchemaV1);
const validateManifest = ajv.compile(manifestSchemaV2);
const validateRecord = ajv.compile(recordSchemaV2);

export function verifyExportManifest(manifest: unknown): void {
  assertValid(validateManifest, manifest, "manifest");
}

export function verifyExportRecord(record: unknown): void {
  assertValid(validateRecord, record, "record");
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
