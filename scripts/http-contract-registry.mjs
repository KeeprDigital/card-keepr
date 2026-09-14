import { catalogueRoutes } from "../src/catalogue/read";
import { administrationRouteFamilies } from "../src/catalogue/ingestion";
import { apiUtilityFamilies } from "../apps/api/src/utility-routes";
export const workerFamilies = {
  read: { read: catalogueRoutes, ...apiUtilityFamilies },
  admin: administrationRouteFamilies,
};
export { httpRouter } from "../src/http/openapi";
