import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import manifestSchema from "../../../prototype/formalize-implementation-contracts/schemas/catalogue-export-manifest-v5.schema.json" with {
  type: "json",
};
import recordSchema from "../../../prototype/formalize-implementation-contracts/schemas/catalogue-export-record-v5.schema.json" with {
  type: "json",
};

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
    "RelationshipRecord",
    "IdentityCorrectionRecord",
  ].map((definition) => {
    const uri = `${recordSchema.$id}#/$defs/${definition}`;
    return [uri, requiredValidator(uri)];
  }),
);

export function verifyExportManifest(manifest: unknown): void {
  assertHostIndependent(manifest, "manifest");
  assertValid(validateManifest, manifest, "manifest");
}

export function verifyExportRecord(record: unknown): void {
  assertHostIndependent(record, "record");
  assertValid(validateRecord, record, "record");
}

export function verifyComponentExportRecord(recordSchemaUri: string, record: unknown): void {
  const validate = componentValidators.get(recordSchemaUri);
  if (validate === undefined) {
    throw new Error(`Catalogue Export component advertises an unresolved record_schema ${recordSchemaUri}.`);
  }
  assertHostIndependent(record, "component record");
  assertValid(validate, record, "component record");
}

function requiredValidator(uri: string): ValidateFunction {
  const validate = ajv.getSchema(uri);
  if (validate === undefined) {
    throw new Error(`Catalogue Export component advertises an unresolved record_schema ${uri}.`);
  }
  return validate;
}

// A Catalogue Export is an immutable offline package: it references API
// resources by identifier and never by link, so a consumer applies the route
// templates in SERIALIZATION.md to its own configured API base. Any string
// that addresses an API route, absolute or root-relative, is a defect.
const apiLinkPattern = /^(https?:\/\/[^/?#]+)?(\/[^?#]*)?\/v1\//u;

function assertHostIndependent(value: unknown, artifact: string): void {
  const link = firstApiLink(value);
  if (link !== undefined) {
    throw new Error(`Catalogue Export ${artifact} embeds an API link: ${link}`);
  }
}

function firstApiLink(value: unknown): string | undefined {
  if (typeof value === "string") {
    return apiLinkPattern.test(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const link = firstApiLink(item);
      if (link !== undefined) return link;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      const link = firstApiLink(item);
      if (link !== undefined) return link;
    }
  }
  return undefined;
}

function assertValid(validate: ValidateFunction, value: unknown, artifact: string): void {
  if (!validate(value)) {
    throw new Error(`Catalogue Export ${artifact} failed schema verification: ${ajv.errorsText(validate.errors)}`);
  }
}
