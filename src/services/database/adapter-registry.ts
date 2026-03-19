import type { DbType, DatabaseAdapter } from "../../types/database.ts";

const adapters = new Map<DbType, DatabaseAdapter>();

export function registerAdapter(type: DbType, adapter: DatabaseAdapter): void {
  adapters.set(type, adapter);
}

export function getAdapter(type: DbType): DatabaseAdapter {
  const adapter = adapters.get(type);
  if (!adapter) throw new Error(`No adapter registered for database type: ${type}`);
  return adapter;
}
