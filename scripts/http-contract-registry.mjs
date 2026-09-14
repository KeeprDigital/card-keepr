import { catalogueRoutes } from "../src/catalogue/read";
import { administrationRouteFamilies } from "../src/catalogue/ingestion";
export const workerFamilies = {
  read: { read: catalogueRoutes },
  admin: administrationRouteFamilies,
};
export { httpRouter } from "../src/http/openapi";
