import document from "../../../contracts/admin-openapi.json";
import { documentationRoutes } from "../../../src/http/documentation";

export const administrationDocumentationRoutes = documentationRoutes(document, "owner");
