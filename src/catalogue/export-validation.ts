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
    "RelationshipRecord",
  ].map((definition) => {
    const uri =
      `https://card-keepr.invalid/schemas/catalogue-export-record@1#/$defs/${definition}`;
    return [uri, requiredValidator(uri)];
  }),
);
const legalityRuleRecordUri =
  "https://card-keepr.invalid/schemas/catalogue-export-record@2#/$defs/LegalityRuleRecord";
componentValidators.set(
  legalityRuleRecordUri,
  requiredValidator(legalityRuleRecordUri),
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
