/**
 * The browser's half of Settings-installed database drivers.
 *
 * A connection whose driver is not installed answers `424 DB_DRIVER_MISSING`
 * naming the driver, so wherever that surfaces — the grid, the sidebar tree,
 * the connection form's Test — the Install button can be offered in place
 * rather than only in Settings.
 */
import { api, ApiError } from "./api-client";
import { DB_DRIVER_MISSING, type DbDriverMissingBody, type DbDriverStatus } from "../../shared/db-drivers";

export type MissingDbDriver = DbDriverMissingBody["driver"];

/** The driver a failed request needed, when that is why it failed. */
export function missingDbDriverOf(e: unknown): MissingDbDriver | null {
  if (!(e instanceof ApiError) || e.code !== DB_DRIVER_MISSING) return null;
  const driver = (e.body as Partial<DbDriverMissingBody>).driver;
  if (typeof driver?.id !== "string" || typeof driver.displayName !== "string") return null;
  return { id: driver.id, displayName: driver.displayName };
}

export function listDbDrivers(): Promise<DbDriverStatus[]> {
  return api.get<DbDriverStatus[]>("/api/db/drivers");
}

/**
 * Fired on `window` with the driver's id once it is installed, whichever button asked, so every
 * view still showing the Install notice can run again what needed it (`useDbDriverInstalled`).
 */
export const DB_DRIVER_INSTALLED_EVENT = "ppm:db-driver-installed";

/** Resolves once the driver is installed and loads; a second call joins an install already running. */
export async function installDbDriver(id: string): Promise<DbDriverStatus> {
  const status = await api.post<DbDriverStatus>(`/api/db/drivers/${encodeURIComponent(id)}/install`);
  window.dispatchEvent(new CustomEvent<string>(DB_DRIVER_INSTALLED_EVENT, { detail: id }));
  return status;
}

export function removeDbDriver(id: string): Promise<void> {
  return api.del(`/api/db/drivers/${encodeURIComponent(id)}`);
}
