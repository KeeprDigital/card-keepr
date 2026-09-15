import document from "../../../contracts/read-openapi.json";
import { documentationRoutes } from "../../../src/http/documentation";

export const apiDocumentationRoutes = documentationRoutes(document, "public");
