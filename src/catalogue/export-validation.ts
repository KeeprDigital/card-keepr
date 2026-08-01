import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import manifestSchema from "../../prototype/formalize-implementation-contracts/schemas/catalogue-export-manifest.schema.json";
import recordSchema from "../../prototype/formalize-implementation-contracts/schemas/catalogue-export-record.schema.json";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateManifest = ajv.compile(manifestSchema);
const validateRecord = ajv.compile(recordSchema);
const componentValidators = new Map<string, ValidateFunction>(
  [
    "SupportedGameRecord",
    "GameProfileRecord",
    "CardRecord",
    "PrintingRecord",
    "PrintingImageRecord",
    "ProductRecord",
    "ReleaseRecord",
    "DistributionContextRecord",
    "ErratumRecord",
    "LegalityRuleRecord",
    "RelationshipRecord",
  ].map((definition) => {
    const uri =
      `https://card-keepr.invalid/schemas/catalogue-export-record@2#/$defs/${definition}`;
    return [uri, requiredValidator(uri)];
  }),
);

export function verifyExportManifest(manifest: unknown): void {
  assertValid(validateManifest, manifest, "manifest");
}

export function verifyExportRecord(record: unknown): void {
  assertValid(validateRecord, record, "record");
}

function requiredValidator(uri: string): ValidateFunction {
  const validate = ajv.getSchema(uri);
  if (validate === undefined) {
    throw new Error(
      `Catalogue Export component advertises an unresolved record_schema ${uri}.`,
    );
  }
  return validate;
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
