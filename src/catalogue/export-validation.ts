import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import manifestSchema from "../../prototype/formalize-implementation-contracts/schemas/catalogue-export-manifest-v5.schema.json" with { type: "json" };
import recordSchema from "../../prototype/formalize-implementation-contracts/schemas/catalogue-export-record-v5.schema.json" with { type: "json" };
import historicalRecordSchemaV3 from "../../prototype/formalize-implementation-contracts/schemas/catalogue-export-record.schema.json" with { type: "json" };
import historicalRecordSchemaV4 from "../../prototype/formalize-implementation-contracts/schemas/catalogue-export-record-v4.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(historicalRecordSchemaV3);
ajv.addSchema(historicalRecordSchemaV4);
const validateManifest = ajv.compile(manifestSchema);
const validateRecord = ajv.compile(recordSchema);
const componentValidators = new Map<string, ValidateFunction>(
  [3, 4, 5].flatMap((major) => [
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
      `https://card-keepr.invalid/schemas/catalogue-export-record@${major}#/$defs/${definition}`;
    return [uri, requiredValidator(uri)];
  })),
);

export function verifyExportManifest(manifest: unknown): void {
  assertValid(validateManifest, manifest, "manifest");
}

export function verifyExportRecord(record: unknown): void {
  assertValid(validateRecord, record, "record");
}

export function verifyComponentExportRecord(
  recordSchemaUri: string,
  record: unknown,
): void {
  const validate = componentValidators.get(recordSchemaUri);
  if (validate === undefined) {
    throw new Error(
      `Catalogue Export component advertises an unresolved record_schema ${recordSchemaUri}.`,
    );
  }
  assertValid(validate, record, "component record");
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
