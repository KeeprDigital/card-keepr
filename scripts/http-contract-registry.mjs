import { catalogueRoutes } from "../src/catalogue/read";
import { administrationRouteFamilies, platformRoutes } from "../src/catalogue/ingestion";
import { apiUtilityFamilies } from "../apps/api/src/utility-routes";
import { apiDocumentationRoutes } from "../apps/api/src/documentation-routes";
import { administrationDocumentationRoutes } from "../apps/ingestion/src/documentation-routes";
import { administrationUtilityFamilies } from "../apps/ingestion/src/utility-routes";
export const workerFamilies = {
  read: { read: catalogueRoutes, ...apiUtilityFamilies, documentation: apiDocumentationRoutes },
  admin: {
    ...administrationRouteFamilies,
    platform: platformRoutes,
    ...administrationUtilityFamilies,
    documentation: administrationDocumentationRoutes,
  },
};
export { httpRouter } from "../src/http/openapi";
