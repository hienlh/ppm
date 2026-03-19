import { registerAdapter } from "./adapter-registry.ts";
import { sqliteAdapter } from "./sqlite-adapter.ts";
import { postgresAdapter } from "./postgres-adapter.ts";

/** Register all database adapters. Call once at server startup. */
export function initAdapters(): void {
  registerAdapter("sqlite", sqliteAdapter);
  registerAdapter("postgres", postgresAdapter);
}
