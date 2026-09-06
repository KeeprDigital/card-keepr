export const maximumExportRecordBytes = 524_288;
export const maximumExportComponentBytes = 12 * 1024 * 1024;
export const maximumCatalogueExportBytes = 24 * 1024 * 1024;
export const maximumCatalogueExportObjectBytes = 25 * 1024 * 1024;

// This is below the relationship component's byte ceiling for every valid
// record. It bounds identity hashing and record allocation independently of
// how compact an input happens to be.

export class CatalogueExportLimitError extends Error {}
