import { Hono } from "hono";
import { isDbDriverId } from "../../services/database/drivers/db-driver-catalog.ts";
import { dbDriverStatus, installDbDriver, listDbDrivers, uninstallDbDriver } from "../../services/database/drivers/db-driver-install.ts";
import { err, ok } from "../../types/api.ts";

/**
 * `/api/db/drivers`: the drivers some engines need, installed on request.
 * Every route takes a driver **id** from the fixed catalog, so no request can
 * name a package, a version or a registry.
 */
export const databaseDriverRoutes = new Hono();

databaseDriverRoutes.get("/", (c) => c.json(ok(listDbDrivers())));

/** Waits for the install: the server's idle timeout (16 min) outlasts the installer's own (5 min). */
databaseDriverRoutes.post("/:id/install", async (c) => {
  const id = c.req.param("id");
  if (!isDbDriverId(id)) return c.json(err(`Unknown database driver: ${id}`), 404);
  try {
    await installDbDriver(id);
    return c.json(ok(dbDriverStatus(id)));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

databaseDriverRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!isDbDriverId(id)) return c.json(err(`Unknown database driver: ${id}`), 404);
  try {
    await uninstallDbDriver(id);
    return c.json(ok(dbDriverStatus(id)));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
