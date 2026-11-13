import type { Command } from "commander";
import { resolve } from "node:path";
import { inAiChat } from "../../services/ai-chat-env.ts";
import { DB_TYPES, isDbType } from "../../shared/db-types.ts";
import { editableFormSettings, type EditableConnectionConfig } from "../../shared/db-connection-config.ts";
import { hasPassword } from "../../shared/db-url-secret.ts";
import { C, fail } from "./projects-cmd-request.ts";
import { connectionOrFail, dbRequest, type ListedConnection } from "./db-cmd-connections-request.ts";
import { registerDbConnectionManageCommands } from "./db-cmd-connections-manage.ts";

/**
 * `ppm db add` and `ppm db edit`, through the connection routes (`db-cmd-connections-request.ts`).
 * Neither ever sends `readonly`: a connection made here is read-only (the route's default), and
 * only the user makes one writable, in PPM. From an AI chat a few things are refused before any
 * request — a URL holding a password, `--ai on`, a SQLite file where logins are kept. Advisory, as
 * every check on the AI mark is: the shell's approval card is the control there.
 */

const PASSWORD_MODES: Record<string, string> = { save: "save", ask: "askPassword", "ask-user": "askUser" };

function passwordModeOption(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return PASSWORD_MODES[value] ?? fail("--password-mode must be save, ask or ask-user");
}

function aiOption(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== "on" && value !== "off") fail("--ai must be on or off");
  if (value === "on" && inAiChat()) {
    fail("An AI chat does not make a connection available to the AI chat: that is the user's choice, in PPM or at their own terminal.");
  }
  return value === "on";
}

/** From an AI chat, a URL holding a password is refused before any request. */
function refusePasswordFromAiChat(url: string): void {
  if (inAiChat() && hasPassword(url)) {
    fail("The URL holds a password, and an AI chat does not handle passwords. Add the connection with `--password-mode ask` "
      + "(PPM asks for it when it opens), or without the password and let the user enter it in PPM.");
  }
}

/** The file's absolute path; from an AI chat, refused where logins and keys are kept. */
async function sqliteFileOption(file: string): Promise<string> {
  const abs = resolve(file);
  const { sqlitePathRefusal } = await import("../../services/database/sqlite-path-guard.ts");
  const refusal = sqlitePathRefusal(abs, inAiChat() ? { aiTool: { projectRoots: [] } } : {});
  if (refusal) fail(refusal);
  return abs;
}

/** A colour as the routes take it; "" or "none" clears it on an edit. */
const colorOption = (value: string | undefined, clearable: boolean): string | null | undefined =>
  value === undefined ? undefined : clearable && (value === "" || value === "none") ? null : value;

export function registerDbConnectionCommands(db: Command): void {
  db.command("add")
    .description("Add a database connection (read-only; make it writable in PPM)")
    .requiredOption("-n, --name <name>", "Connection name (unique)")
    .requiredOption("-t, --type <type>", "Database type: postgres | mysql | mariadb | sqlite")
    .option("-c, --connection-string <url>", "Connection string (postgres://…, mysql://…, mariadb://…)")
    .option("-f, --file <path>", "SQLite file path")
    .option("-g, --group <group>", "Folder it is listed in")
    .option("--color <color>", "Colour (hex, e.g. #3b82f6)")
    .option("--password-mode <mode>", "save (default) | ask (PPM asks for it each time) | ask-user (asks for login and password)")
    .option("--ai <on|off>", "Available to the AI chat (default on)")
    .action(async (o: { name: string; type: string; connectionString?: string; file?: string; group?: string; color?: string; passwordMode?: string; ai?: string }) => {
      try {
        const type = o.type;
        if (!isDbType(type)) fail(`--type must be one of: ${DB_TYPES.join(", ")}`);
        const passwordMode = passwordModeOption(o.passwordMode);
        const aiAccess = aiOption(o.ai);
        let connectionConfig: Record<string, unknown>;
        if (type === "sqlite") {
          if (!o.file) fail("SQLite requires --file");
          if (passwordMode) fail("A SQLite file has no password: leave --password-mode out");
          connectionConfig = { type, path: await sqliteFileOption(o.file) };
        } else {
          if (!o.connectionString) fail(`${type} requires --connection-string`);
          refusePasswordFromAiChat(o.connectionString);
          connectionConfig = { type, connectionString: o.connectionString, ...(passwordMode ? { passwordMode } : {}) };
        }
        const conn = await dbRequest<ListedConnection>("POST", "/connections", {
          type, name: o.name, connectionConfig,
          ...(o.group ? { groupName: o.group } : {}),
          ...(o.color ? { color: o.color } : {}),
          ...(aiAccess === undefined ? {} : { aiAccess }),
        });
        console.log(`${C.green}Added connection:${C.reset} ${conn.name} (${conn.type}) #${conn.id} — read-only; make it writable in PPM`);
        await noteMissingDriver(type);
      } catch (e) {
        fail((e as Error).message);
      }
    });

  db.command("edit <name>")
    .description("Change a saved connection (by name or ID); give only what changes")
    .option("--name <name>", "New name")
    .option("-c, --connection-string <url>", "New connection string (a new server or login drops the saved password)")
    .option("-f, --file <path>", "New SQLite file")
    .option("-g, --group <group>", "Folder it is listed in (\"\" for none)")
    .option("--color <color>", "Colour (hex; \"none\" clears it)")
    .option("--password-mode <mode>", "save | ask | ask-user")
    .option("--ai <on|off>", "Available to the AI chat")
    .action(async (nameOrId: string, o: { name?: string; connectionString?: string; file?: string; group?: string; color?: string; passwordMode?: string; ai?: string }) => {
      try {
        const conn = await connectionOrFail(nameOrId);
        const passwordMode = passwordModeOption(o.passwordMode);
        const aiAccess = aiOption(o.ai);
        let connectionConfig: Record<string, unknown> | undefined;
        if (conn.type === "sqlite") {
          if (o.connectionString || passwordMode) fail("A SQLite connection takes --file only");
          if (o.file) connectionConfig = { type: "sqlite", path: await sqliteFileOption(o.file) };
        } else {
          if (o.file) fail(`A ${conn.type} connection takes --connection-string, not --file`);
          if (o.connectionString) refusePasswordFromAiChat(o.connectionString);
          if (o.connectionString || passwordMode) {
            const editable = await dbRequest<EditableConnectionConfig>("GET", `/connections/${conn.id}/config`);
            connectionConfig = {
              ...editableFormSettings(editable), type: conn.type, keepPassword: true,
              ...(o.connectionString ? { connectionString: o.connectionString } : {}),
              ...(passwordMode ? { passwordMode } : {}),
            };
          }
        }
        const body = {
          ...(o.name !== undefined ? { name: o.name } : {}),
          ...(o.group !== undefined ? { groupName: o.group || null } : {}),
          ...(o.color !== undefined ? { color: colorOption(o.color, true) } : {}),
          ...(aiAccess === undefined ? {} : { aiAccess }),
          ...(connectionConfig ? { connectionConfig } : {}),
        };
        if (Object.keys(body).length === 0) fail("Nothing to change: give --name, --connection-string, --file, --group, --color, --password-mode or --ai");
        const updated = await dbRequest<ListedConnection & { secretsCleared?: string[] }>("PUT", `/connections/${conn.id}`, body);
        console.log(`${C.green}Updated connection:${C.reset} ${updated.name} #${updated.id}`);
        if (updated.secretsCleared?.length) {
          console.log(`${C.yellow}It now points somewhere else, so its saved ${updated.secretsCleared.join(", ")} ${updated.secretsCleared.length === 1 ? "was" : "were"} dropped.${C.reset} Enter ${updated.secretsCleared.length === 1 ? "it" : "them"} again in PPM.`);
        }
      } catch (e) {
        fail((e as Error).message);
      }
    });

  registerDbConnectionManageCommands(db);
}

/** After `add`: the driver a server connection needs, when it is not installed yet. */
async function noteMissingDriver(type: string): Promise<void> {
  if (!isDbType(type)) return;
  const { driverForEngine } = await import("../../services/database/drivers/db-driver-catalog.ts");
  const driver = driverForEngine(type);
  if (!driver) return;
  const { dbDriverStatus } = await import("../../services/database/drivers/db-driver-install.ts");
  if (dbDriverStatus(driver.id).state !== "installed") {
    console.log(`${C.yellow}The ${driver.displayName} driver is not installed yet.${C.reset} Run: ppm db driver install ${driver.id}`);
  }
}
