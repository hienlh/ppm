import type { Command } from "commander";
import { resolve } from "node:path";
import { inAiChat } from "../../services/ai-chat-env.ts";
import type { DbTestResult, EditableConnectionConfig } from "../../shared/db-connection-config.ts";
import { editableFormSettings } from "../../shared/db-connection-config.ts";
import { canAskOnTerminal, askOnTerminal } from "../utils/tty-prompt.ts";
import { C, fail } from "./projects-cmd-request.ts";
import { closeOpenedHere, connectionOrFail, dbRequest, type ListedConnection } from "./db-cmd-connections-request.ts";

/**
 * `ppm db remove`, `test`, `duplicate` and `import`, through the connection routes. `test` asks the
 * running PPM to test, from the PPM host, as the connection's Test button does; a connection that
 * asks for its password and has no login held is tested with one typed here, which nothing keeps.
 */

type TestAnswer = { ok: boolean; error?: string };

/** A login typed at this terminal for a connection that asks for one; null with no terminal. */
async function loginHere(conn: ListedConnection): Promise<{ user?: string; password: string } | null> {
  if (!canAskOnTerminal()) return null;
  let user: string | undefined;
  if (conn.password_mode === "askUser") {
    const typed = await askOnTerminal(`User for ${conn.name}: `);
    if (typed === null) fail("Cancelled");
    user = typed.trim();
  }
  const password = await askOnTerminal(`Password for ${conn.name}: `, { hidden: true });
  if (password === null) fail("Cancelled");
  return { user, password };
}

async function testConnection(conn: ListedConnection): Promise<TestAnswer> {
  const asks = conn.password_mode !== undefined && conn.password_mode !== "save";
  if (!asks || conn.logged_in) return dbRequest<TestAnswer>("POST", `/connections/${conn.id}/test`, {});
  const login = await loginHere(conn);
  if (!login) {
    fail(`Connection "${conn.name}" asks for its password each time it is opened, and this command has no terminal to ask on. `
      + "Run it in a terminal, or open the connection in PPM.");
  }
  const editable = await dbRequest<EditableConnectionConfig>("GET", `/connections/${conn.id}/config`);
  const connectionConfig = {
    ...editableFormSettings(editable), type: conn.type, keepPassword: true,
    ...(editable.type !== "sqlite" && editable.connectionString ? { connectionString: editable.connectionString } : {}),
  };
  return dbRequest<DbTestResult>("POST", "/test", { type: conn.type, connectionId: conn.id, connectionConfig, login });
}

/** The connections of an export file: the file `GET /api/db/connections/export` answers, or its `data`. */
function exportedConnections(parsed: unknown): unknown[] | null {
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { connections?: unknown; data?: { connections?: unknown } };
  const list = record.connections ?? record.data?.connections;
  return Array.isArray(list) ? list : null;
}

export function registerDbConnectionManageCommands(db: Command): void {
  db.command("remove <name>")
    .description("Remove a saved connection (by name or ID)")
    .action(async (nameOrId: string) => {
      try {
        const conn = await connectionOrFail(nameOrId);
        await dbRequest("DELETE", `/connections/${conn.id}`);
        console.log(`${C.green}Removed connection:${C.reset} ${conn.name}`);
      } catch (e) {
        fail((e as Error).message);
      }
    });

  db.command("test <name>")
    .description("Test a saved connection from the PPM host (by name or ID)")
    .action(async (nameOrId: string) => {
      let id: number | null = null;
      try {
        const conn = await connectionOrFail(nameOrId);
        id = conn.id;
        const result = await testConnection(conn);
        if (!result.ok) throw new Error(`Connection failed: ${result.error ?? "unknown error"}`);
        console.log(`${C.green}✓${C.reset} Connection successful: ${conn.name}${conn.server ? ` (${conn.server})` : ""}`);
      } catch (e) {
        if (id !== null) await closeOpenedHere(id);
        console.error(`${C.red}✗${C.reset} ${(e as Error).message}`);
        process.exit(1);
      }
      if (id !== null) await closeOpenedHere(id);
    });

  db.command("duplicate <name>")
    .description("Copy a saved connection, password included (by name or ID)")
    .action(async (nameOrId: string) => {
      try {
        const conn = await connectionOrFail(nameOrId);
        const copy = await dbRequest<ListedConnection>("POST", `/connections/${conn.id}/duplicate`, {});
        console.log(`${C.green}Copied connection:${C.reset} ${copy.name} #${copy.id}`);
      } catch (e) {
        fail((e as Error).message);
      }
    });

  db.command("import <file>")
    .description("Import connections from an export file (each keeps the file's read-only and AI settings)")
    .action(async (file: string) => {
      try {
        // An export file carries every password and its own read-only flags: bringing one in is the user's to do.
        if (inAiChat()) fail("An AI chat does not import connections: an export file sets passwords and read-only flags. Ask the user to run it.");
        const abs = resolve(file);
        const bunFile = Bun.file(abs);
        if (!(await bunFile.exists())) fail(`File not found: ${abs}`);
        let parsed: unknown;
        try { parsed = JSON.parse(await bunFile.text()); } catch { fail(`${abs} is not JSON`); }
        const connections = exportedConnections(parsed);
        if (!connections) fail(`${abs} is not a PPM connections export (no "connections" list)`);
        const r = await dbRequest<{ imported: number; skipped: number; errors: string[] }>("POST", "/connections/import", { connections });
        console.log(`${C.green}Imported${C.reset} ${r.imported} connection(s)${r.skipped ? `, skipped ${r.skipped}` : ""}`);
        for (const line of r.errors) console.log(`  ${C.yellow}${line}${C.reset}`);
      } catch (e) {
        fail((e as Error).message);
      }
    });
}
