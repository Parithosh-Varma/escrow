import { db } from "./db/driver.js";

/** Synchronous DB accessor; initDb() runs during app bootstrap / test setup. */
export const getDbNow = db;
export { db };
