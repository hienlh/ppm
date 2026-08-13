import {
  insertQueryLog,
  type QueryLogInput,
} from "../../services/query-audit/query-audit.service.ts";

/** CLI has no HTTP identity, so IP/UA are always absent. */
export type CliAuditFields = Omit<QueryLogInput, "actor" | "source" | "callerIp" | "callerUa">;

/**
 * CLI counterpart of the route hook. Never throws and never exits: a failed audit
 * write must not stop a command the user asked for, but it must not be silent either.
 */
export function logCliQuery(fields: CliAuditFields): void {
  try {
    insertQueryLog({ ...fields, source: "cli", actor: "cli" });
  } catch (e) {
    console.error(`[query-audit] failed to write audit log: ${(e as Error).message}`);
  }
}
