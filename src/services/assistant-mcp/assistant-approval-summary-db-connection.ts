import type { ApprovalFact, ApprovalSummary } from "../../shared/assistant-approval.ts";
import { exactFact, fact } from "./assistant-approval-summary.ts";

/**
 * The approval cards of `db_connection_save` and `db_connection_delete`. Pure: built from the
 * connection as PPM lists it and the checked arguments. A URL is shown with its password masked
 * (the tool refuses one that carries a password anyway), a SQLite file by its real path — where a
 * symlink really leads is what decides whether it may be opened — and both whole.
 */

const ENGINE: Record<string, string> = { postgres: "PostgreSQL", mysql: "MySQL", mariadb: "MariaDB", sqlite: "SQLite" };
const engine = (type: string): string => ENGINE[type] ?? type;

export const READ_ONLY_NEW = "Yes — the AI can only read; switch it off in PPM to allow writes";

export interface DbConnectionTarget {
  /** The URL with its password masked. */
  url?: string;
  /** The SQLite file's real path. */
  file?: string;
}

export interface DbConnectionCreateApproval extends DbConnectionTarget {
  name: string;
  type: string;
  passwordMode: "save" | "ask";
  folder?: string | null;
  color?: string | null;
}

const targetFacts = (target: DbConnectionTarget, prefix = "", tone?: "warning"): ApprovalFact[] => [
  ...(target.url !== undefined ? [exactFact(`${prefix}URL`, target.url, tone)] : []),
  ...(target.file !== undefined ? [exactFact(`${prefix}File`, target.file, tone)] : []),
];

const decor = (folder?: string | null, color?: string | null): ApprovalFact[] => [
  ...(folder !== undefined ? [fact("Folder", folder === null ? "None" : folder)] : []),
  ...(color !== undefined ? [fact("Colour", color === null ? "None" : color)] : []),
];

function passwordFact(type: string, mode: "save" | "ask"): ApprovalFact[] {
  if (type === "sqlite") return [];
  return [fact("Password", mode === "ask" ? "Asked each time the connection opens" : "None saved — the user types it in PPM if the database needs one")];
}

export function dbConnectionCreateSummary(input: DbConnectionCreateApproval): ApprovalSummary {
  return {
    headline: `Add the ${engine(input.type)} connection "${input.name}"`,
    facts: [
      ...targetFacts(input),
      ...passwordFact(input.type, input.passwordMode),
      ...decor(input.folder, input.color),
      fact("Read-only", READ_ONLY_NEW),
      fact("Available to the AI chat", "Yes"),
    ],
  };
}

export interface ListedConnection {
  id: number;
  name: string;
  type: string;
  readonly: number;
  group_name: string | null;
  /** host:port, a socket or a SQLite path, as the list gives it. */
  server?: string | null;
}

export interface DbConnectionEditApproval {
  conn: ListedConnection;
  newName?: string;
  /** Where it points now and where it will point, both shown whole. */
  now?: DbConnectionTarget;
  next?: DbConnectionTarget;
  passwordMode?: "save" | "ask";
  folder?: string | null;
  color?: string | null;
}

const readOnlyNow = (conn: ListedConnection): ApprovalFact =>
  conn.readonly ? fact("Read-only", "Yes") : fact("Read-only", "No — writes are allowed", "warning");

export function dbConnectionEditSummary(input: DbConnectionEditApproval): ApprovalSummary {
  const { conn } = input;
  return {
    headline: input.newName ? `Rename the connection "${conn.name}" to "${input.newName}"` : `Change the connection "${conn.name}"`,
    facts: [
      exactFact("Connection", `${conn.name} (${engine(conn.type)}, #${conn.id})`),
      ...(input.newName ? [exactFact("New name", input.newName)] : []),
      ...(input.next ? [...targetFacts(input.now ?? {}, "Now: "), ...targetFacts(input.next, "New ", "warning")] : []),
      ...(input.passwordMode ? passwordFact(conn.type, input.passwordMode) : []),
      ...decor(input.folder, input.color),
      readOnlyNow(conn),
    ],
  };
}

export function dbConnectionDeleteSummary(conn: ListedConnection): ApprovalSummary {
  return {
    headline: `Delete the connection "${conn.name}" from PPM`,
    facts: [
      exactFact("Connection", `${conn.name} (${engine(conn.type)}, #${conn.id})`),
      ...(conn.server ? [exactFact(conn.type === "sqlite" ? "File" : "Server", conn.server)] : []),
      ...(conn.group_name ? [fact("Folder", conn.group_name)] : []),
      readOnlyNow(conn),
    ],
    warning: "The database itself is not touched. PPM forgets how to reach it, with any password it saved; this cannot be undone.",
  };
}
