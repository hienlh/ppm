import { Command } from "commander";
import { isReadOnlyQuery } from "../../services/database/readonly-check.ts";
import { isReadonlyRefusal, readonlyRefusalMessage } from "../../services/database/db-errors.ts";
import { decryptConfig, type ConnectionRow } from "../../services/db.service.ts";
import { savedLoginUser, withLogin } from "../../services/database/connection-config.ts";
import { serviceConnectionString } from "../../services/database/connection-endpoint.ts";
import { asksForPassword } from "../../shared/db-connection-config.ts";
import { DEFAULT_USER } from "../../shared/db-connection-url.ts";
import { askOnTerminal, canAskOnTerminal } from "../utils/tty-prompt.ts";
import { inAiChat } from "../../services/ai-chat-env.ts";
import { defaultSchemaFor } from "../../services/database/grid.service.ts";
import { DB_TYPES, dialectNameOf, isDbType, type DbType } from "../../shared/db-types.ts";
import type { DbColumnInfo, DbPagedData, DbQueryResult, DbTableInfo } from "../../types/database.ts";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  magenta: "\x1b[35m",
};

function printTable(headers: string[], rows: string[][]): void {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const sep = colWidths.map((w) => "-".repeat(w + 2)).join("+");
  const headerLine = headers.map((h, i) => ` ${h.padEnd(colWidths[i]!)} `).join("|");
  console.log(`+${sep}+`);
  console.log(`|${C.bold}${headerLine}${C.reset}|`);
  console.log(`+${sep}+`);
  for (const row of rows) {
    const line = row.map((cell, i) => ` ${(cell ?? "").padEnd(colWidths[i]!)} `).join("|");
    console.log(`|${line}|`);
  }
  console.log(`+${sep}+`);
}

function formatRows(columns: string[], rows: Record<string, unknown>[], limit = 50): void {
  if (rows.length === 0) {
    console.log(`${C.dim}(no rows)${C.reset}`);
    return;
  }
  const displayRows = rows.slice(0, limit);
  const strRows = displayRows.map((r) =>
    columns.map((c) => {
      const v = r[c];
      if (v === null || v === undefined) return `${C.dim}NULL${C.reset}`;
      const s = String(v);
      return s.length > 60 ? s.slice(0, 57) + "..." : s;
    }),
  );
  printTable(columns, strRows);
  if (rows.length > limit) {
    console.log(`${C.dim}... and ${rows.length - limit} more rows${C.reset}`);
  }
}

/** Parse connection_config (encrypted or plaintext) and return the connection string or path */
function parseConfig(row: { type: string; connection_config: string }): { type: string; path?: string; connectionString?: string } {
  const cfg = decryptConfig(row.connection_config);
  return { ...cfg, type: row.type };
}

/**
 * The URL a command connects to a server with. A connection that asks for its password asks for
 * it here: the CLI is a process of its own and never sees a login the PPM server holds. With no
 * terminal to ask on — an AI chat's shell, a pipe, cron — such a connection cannot be used.
 */
async function openConnectionString(conn: ConnectionRow): Promise<string> {
  const config = decryptConfig(conn.connection_config);
  if (config.type === "sqlite") throw new Error(`Connection "${conn.name}" is a SQLite file`);
  // With its SSH tunnel and certificate files, when it has them.
  if (!asksForPassword(config.passwordMode)) return serviceConnectionString(config);
  if (!canAskOnTerminal()) {
    throw new Error(
      `Connection "${conn.name}" asks for its password each time it is opened, and this command has no terminal to ask on. `
      + "Run it in a terminal, or open the connection in PPM. An AI chat cannot use this connection.",
    );
  }
  let user: string | undefined;
  if (config.passwordMode === "askUser") {
    const typed = await askOnTerminal(`User for ${conn.name}: `);
    if (typed === null) throw new Error("Cancelled");
    user = typed.trim();
  }
  const who = user || savedLoginUser(config) || DEFAULT_USER[config.type];
  const password = await askOnTerminal(`Password for ${who} on ${conn.name}: `, { hidden: true });
  if (password === null) throw new Error("Cancelled");
  const opened = withLogin(config, { user, password });
  return opened.type === "sqlite" ? "" : serviceConnectionString(opened);
}

/** A connection kept away from this command because it runs in an AI chat and the connection is not available to one. */
function hiddenFromAi(conn: ConnectionRow): boolean {
  return conn.ai_access === 0 && inAiChat();
}

function hiddenFromAiMessage(conn: ConnectionRow): string {
  return `Connection "${conn.name}" is not available to the AI chat: "Available to the AI chat" is off in its settings in PPM. `
    + "Ask the user to run this command themselves, or to turn that setting on.";
}

/** Stop before a command opens a connection the AI chat it runs in may not use. */
function assertAvailable(conn: ConnectionRow): void {
  if (hiddenFromAi(conn)) throw new Error(hiddenFromAiMessage(conn));
}

/** Mask password in postgres connection string: postgresql://user:pass@host → postgresql://user:***@host */
function maskPassword(connectionString: string): string {
  return connectionString.replace(/(:\/\/[^:]+:)[^@]+(@)/, "$1***$2");
}

/** What the commands below use, which Postgres and MySQL both serve from a connection string. */
interface ServerDbService {
  testConnection(connectionString: string): Promise<{ ok: boolean; error?: string }>;
  getTables(connectionString: string): Promise<DbTableInfo[]>;
  getTableSchema(connectionString: string, table: string, schema?: string): Promise<DbColumnInfo[]>;
  getTableData(
    connectionString: string, table: string, schema: string | undefined,
    page?: number, limit?: number, orderBy?: string, orderDir?: "ASC" | "DESC",
  ): Promise<DbPagedData>;
  executeQuery(connectionString: string, sql: string): Promise<DbQueryResult>;
  executeScript(connectionString: string, sql: string): Promise<{ statementsRun: number; executionTimeMs: number }>;
  closeAll(): Promise<void>;
}

/** A server database's service. A readonly connection runs on pools whose sessions the server itself keeps read-only. */
async function serverService(type: Exclude<DbType, "sqlite">, readonly: boolean): Promise<ServerDbService> {
  let service: ServerDbService;
  if (type === "postgres") {
    const { postgresService, readonlyPostgresService } = await import("../../services/postgres.service.ts");
    service = readonly ? readonlyPostgresService : postgresService;
  } else {
    const { mysqlService, readonlyMysqlService } = await import("../../services/mysql.service.ts");
    service = readonly ? readonlyMysqlService : mysqlService;
  }
  const { closeAllSshTunnels } = await import("../../services/database/ssh-tunnel.ts");
  // A command ends by closing its pools. Its SSH sessions go with them, or their sockets would
  // keep the process from exiting.
  return {
    testConnection: service.testConnection.bind(service),
    getTables: service.getTables.bind(service),
    getTableSchema: service.getTableSchema.bind(service),
    getTableData: service.getTableData.bind(service),
    executeQuery: service.executeQuery.bind(service),
    executeScript: service.executeScript.bind(service),
    closeAll: async () => {
      try {
        await service.closeAll();
      } finally {
        closeAllSshTunnels();
      }
    },
  };
}

/** The schema a table is looked up in: the one asked for, else Postgres' `public`, else the connection's own database. */
function schemaOption(type: DbType, schema: string | undefined): string | undefined {
  return schema ?? defaultSchemaFor(type) ?? undefined;
}


export function registerDbCommands(program: Command): void {
  const db = program.command("db").description("Manage database connections and execute queries");

  // ── ppm db list ──────────────────────────────────────────────────────
  db.command("list")
    .description("List all saved database connections")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const { getConnections } = await import("../../services/db.service.ts");
        const saved = getConnections();
        // Run from an AI chat, only what is available to one.
        const conns = inAiChat() ? saved.filter((c) => c.ai_access !== 0) : saved;
        const hidden = saved.length - conns.length;
        const hiddenNote = hidden ? `${hidden} saved connection${hidden === 1 ? " is" : "s are"} not available to the AI chat.` : "";
        if (conns.length === 0) {
          if (options.json) {
            console.log("[]");
            if (hiddenNote) console.error(hiddenNote);
            return;
          }
          console.log(hiddenNote ? `${C.yellow}${hiddenNote}${C.reset}` : `${C.yellow}No connections saved.${C.reset} Run: ppm db add`);
          return;
        }
        if (options.json) {
          const data = conns.map((c) => {
            const cfg = parseConfig(c);
            let target = cfg.connectionString ?? cfg.path ?? null;
            if (cfg.connectionString) target = maskPassword(target!);
            return { id: c.id, name: c.name, type: c.type, group: c.group_name ?? null, readonly: !!c.readonly, connection: target };
          });
          console.log(JSON.stringify(data, null, 2));
          if (hiddenNote) console.error(hiddenNote);
          return;
        }
        const rows = conns.map((c) => {
          const cfg = parseConfig(c);
          let target = cfg.connectionString ?? cfg.path ?? "-";
          // Mask password in postgres connection strings
          if (cfg.connectionString) target = maskPassword(target);
          const display = target.length > 70 ? target.slice(0, 67) + "..." : target;
          const ro = c.readonly ? `${C.yellow}RO${C.reset}` : `${C.green}RW${C.reset}`;
          return [String(c.id), c.name, c.type, c.group_name ?? "-", ro, display];
        });
        printTable(["ID", "Name", "Type", "Group", "RO", "Connection"], rows);
        if (hiddenNote) console.log(`${C.dim}${hiddenNote}${C.reset}`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  // ── ppm db add ───────────────────────────────────────────────────────
  db.command("add")
    .description("Add a new database connection")
    .requiredOption("-n, --name <name>", "Connection name (unique)")
    .requiredOption("-t, --type <type>", "Database type: postgres | mysql | mariadb | sqlite")
    .option("-c, --connection-string <url>", "Connection string (postgres://…, mysql://…, mariadb://…)")
    .option("-f, --file <path>", "SQLite file path (absolute)")
    .option("-g, --group <group>", "Group name")
    .option("--color <color>", "Tab color (hex, e.g. #3b82f6)")
    .action(async (options) => {
      try {
        const { insertConnection } = await import("../../services/db.service.ts");
        const type: unknown = options.type;

        if (!isDbType(type)) {
          console.error(`${C.red}Error:${C.reset} --type must be one of: ${DB_TYPES.join(", ")}`);
          process.exit(1);
        }

        let config: import("../../services/db.service.ts").ConnectionConfig;
        if (type !== "sqlite") {
          if (!options.connectionString) {
            console.error(`${C.red}Error:${C.reset} ${type} requires --connection-string`);
            process.exit(1);
          }
          config = { type, connectionString: options.connectionString };
        } else {
          if (!options.file) {
            console.error(`${C.red}Error:${C.reset} SQLite requires --file (absolute path)`);
            process.exit(1);
          }
          const { resolve } = await import("node:path");
          config = { type: "sqlite", path: resolve(options.file) };
        }

        const conn = insertConnection(type, options.name, config, options.group, options.color);
        console.log(`${C.green}Added connection:${C.reset} ${conn.name} (${conn.type}) #${conn.id}`);
        const { driverForEngine } = await import("../../services/database/drivers/db-driver-catalog.ts");
        const driver = driverForEngine(type);
        if (driver) {
          const { dbDriverStatus } = await import("../../services/database/drivers/db-driver-install.ts");
          if (dbDriverStatus(driver.id).state !== "installed") {
            console.log(`${C.yellow}The ${driver.displayName} driver is not installed yet.${C.reset} Run: ppm db driver install ${driver.id}`);
          }
        }
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  // ── ppm db remove ────────────────────────────────────────────────────
  db.command("remove <name>")
    .description("Remove a saved connection (by name or ID)")
    .action(async (nameOrId: string) => {
      try {
        const { deleteConnection, resolveConnection } = await import("../../services/db.service.ts");
        const conn = resolveConnection(nameOrId);
        if (conn) assertAvailable(conn);
        if (deleteConnection(nameOrId)) {
          console.log(`${C.green}Removed connection:${C.reset} ${nameOrId}`);
        } else {
          console.error(`${C.red}Connection not found:${C.reset} ${nameOrId}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  // ── ppm db test ──────────────────────────────────────────────────────
  db.command("test <name>")
    .description("Test a saved connection")
    .action(async (nameOrId: string) => {
      try {
        const { resolveConnection } = await import("../../services/db.service.ts");
        const conn = resolveConnection(nameOrId);
        if (!conn) {
          console.error(`${C.red}Connection not found:${C.reset} ${nameOrId}`);
          process.exit(1);
        }
        assertAvailable(conn);
        const cfg = parseConfig(conn);

        if (conn.type !== "sqlite") {
          const url = await openConnectionString(conn);
          const service = await serverService(conn.type, !!conn.readonly);
          const result = await service.testConnection(url);
          await service.closeAll();
          if (result.ok) {
            console.log(`${C.green}✓${C.reset} Connection successful: ${conn.name}`);
          } else {
            console.error(`${C.red}✗${C.reset} Connection failed: ${result.error}`);
            process.exit(1);
          }
        } else {
          const { existsSync } = await import("node:fs");
          if (existsSync(cfg.path!)) {
            // Try opening the file
            const { sqliteService } = await import("../../services/sqlite.service.ts");
            sqliteService.getTables(cfg.path!, cfg.path!);
            sqliteService.closeAll();
            console.log(`${C.green}✓${C.reset} SQLite file accessible: ${conn.name}`);
          } else {
            console.error(`${C.red}✗${C.reset} File not found: ${cfg.path}`);
            process.exit(1);
          }
        }
      } catch (err) {
        console.error(`${C.red}✗${C.reset} Test failed:`, (err as Error).message);
        process.exit(1);
      }
    });

  // ── ppm db tables ────────────────────────────────────────────────────
  db.command("tables <name>")
    .description("List tables in a database connection")
    .option("--json", "Output as JSON")
    .action(async (nameOrId: string, options: { json?: boolean }) => {
      try {
        const { resolveConnection } = await import("../../services/db.service.ts");
        const conn = resolveConnection(nameOrId);
        if (!conn) {
          console.error(`${C.red}Connection not found:${C.reset} ${nameOrId}`);
          process.exit(1);
        }
        assertAvailable(conn);
        const cfg = parseConfig(conn);

        if (conn.type !== "sqlite") {
          const url = await openConnectionString(conn);
          const service = await serverService(conn.type, !!conn.readonly);
          const tables = await service.getTables(url).finally(() => service.closeAll());
          if (tables.length === 0) {
            if (options.json) { console.log("[]"); return; }
            console.log(`${C.dim}No tables found.${C.reset}`);
            return;
          }
          if (options.json) { console.log(JSON.stringify(tables, null, 2)); return; }
          printTable(
            ["Schema", "Table", "Rows (est.)"],
            tables.map((t) => [t.schema, t.name, String(t.rowCount)]),
          );
        } else {
          const { sqliteService } = await import("../../services/sqlite.service.ts");
          const tables = sqliteService.getTables(cfg.path!, cfg.path!);
          sqliteService.closeAll();
          if (tables.length === 0) {
            if (options.json) { console.log("[]"); return; }
            console.log(`${C.dim}No tables found.${C.reset}`);
            return;
          }
          if (options.json) { console.log(JSON.stringify(tables, null, 2)); return; }
          printTable(
            ["Table", "Rows"],
            tables.map((t) => [t.name, String(t.rowCount)]),
          );
        }
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  // ── ppm db schema ────────────────────────────────────────────────────
  db.command("schema <name> <table>")
    .description("Show table schema (columns, types, constraints)")
    .option("-s, --schema <schema>", "Schema (PostgreSQL, default public) or database (MySQL, default from the connection)")
    .option("--json", "Output as JSON")
    .action(async (nameOrId: string, table: string, options: { schema?: string; json?: boolean }) => {
      try {
        const { resolveConnection } = await import("../../services/db.service.ts");
        const conn = resolveConnection(nameOrId);
        if (!conn) {
          console.error(`${C.red}Connection not found:${C.reset} ${nameOrId}`);
          process.exit(1);
        }
        assertAvailable(conn);
        const cfg = parseConfig(conn);

        if (conn.type !== "sqlite") {
          const url = await openConnectionString(conn);
          const service = await serverService(conn.type, !!conn.readonly);
          const cols = await service.getTableSchema(url, table, schemaOption(conn.type, options.schema))
            .finally(() => service.closeAll());
          if (options.json) { console.log(JSON.stringify(cols, null, 2)); return; }
          printTable(
            ["Column", "Type", "Nullable", "PK", "Default"],
            cols.map((c) => [c.name, c.type, c.nullable ? "YES" : "NO", c.pk ? "PK" : "", c.defaultValue ?? ""]),
          );
        } else {
          const { sqliteService } = await import("../../services/sqlite.service.ts");
          const cols = sqliteService.getTableSchema(cfg.path!, cfg.path!, table);
          sqliteService.closeAll();
          if (options.json) { console.log(JSON.stringify(cols, null, 2)); return; }
          printTable(
            ["Column", "Type", "Not Null", "PK", "Default"],
            cols.map((c) => [c.name, c.type, c.notnull ? "YES" : "NO", c.pk ? "PK" : "", c.dflt_value ?? ""]),
          );
        }
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  // ── ppm db data ──────────────────────────────────────────────────────
  db.command("data <name> <table>")
    .description("View table data (paginated)")
    .option("-p, --page <page>", "Page number", "1")
    .option("-l, --limit <limit>", "Rows per page", "50")
    .option("--order <column>", "Order by column")
    .option("--desc", "Descending order")
    .option("-s, --schema <schema>", "Schema (PostgreSQL, default public) or database (MySQL, default from the connection)")
    .option("--json", "Output as JSON")
    .action(async (nameOrId: string, table: string, options) => {
      try {
        const { resolveConnection } = await import("../../services/db.service.ts");
        const conn = resolveConnection(nameOrId);
        if (!conn) {
          console.error(`${C.red}Connection not found:${C.reset} ${nameOrId}`);
          process.exit(1);
        }
        assertAvailable(conn);
        const cfg = parseConfig(conn);
        const page = parseInt(options.page, 10);
        const limit = parseInt(options.limit, 10);
        const orderDir = options.desc ? "DESC" as const : "ASC" as const;

        if (conn.type !== "sqlite") {
          const url = await openConnectionString(conn);
          const service = await serverService(conn.type, !!conn.readonly);
          const result = await service.getTableData(
            url, table, schemaOption(conn.type, options.schema), page, limit, options.order, orderDir,
          ).finally(() => service.closeAll());
          if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
          console.log(`${C.cyan}${table}${C.reset} — page ${result.page}, ${result.total} total rows\n`);
          formatRows(result.columns, result.rows, limit);
        } else {
          const { sqliteService } = await import("../../services/sqlite.service.ts");
          const result = sqliteService.getTableData(
            cfg.path!, cfg.path!, table, page, limit, options.order, orderDir,
          );
          sqliteService.closeAll();
          if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
          console.log(`${C.cyan}${table}${C.reset} — page ${result.page}, ${result.total} total rows\n`);
          formatRows(result.columns, result.rows, limit);
        }
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  // ── ppm db query ─────────────────────────────────────────────────────
  db.command("query <name> <sql>")
    .description("Execute a SQL query against a saved connection")
    .option("--json", "Output as JSON")
    .action(async (nameOrId: string, sql: string, options: { json?: boolean }) => {
      try {
        const { resolveConnection } = await import("../../services/db.service.ts");
        const conn = resolveConnection(nameOrId);
        if (!conn) {
          console.error(`${C.red}Connection not found:${C.reset} ${nameOrId}`);
          process.exit(1);
        }
        const cfg = parseConfig(conn);
        const startedAt = Date.now();
        const { logCliQuery } = await import("./db-cmd-audit.ts");
        const { detectOperation } = await import("../../services/query-audit/query-audit.service.ts");
        const audit = {
          connectionId: conn.id,
          connectionName: conn.name,
          dbType: conn.type,
          operation: detectOperation(sql),
          sql,
        };

        if (hiddenFromAi(conn)) {
          const message = hiddenFromAiMessage(conn);
          logCliQuery({ ...audit, status: "blocked", error: message, durationMs: Date.now() - startedAt });
          console.error(`${C.red}Error:${C.reset} ${message}`);
          process.exit(1);
        }

        // Enforce readonly — CLI cannot disable this, only the web UI can toggle it
        if (conn.readonly && !isReadOnlyQuery(sql, dialectNameOf(conn.type))) {
          const message = `Connection "${conn.name}" is readonly — only SELECT queries allowed.`;
          logCliQuery({ ...audit, status: "blocked", error: message, durationMs: Date.now() - startedAt });
          console.error(`${C.red}Error:${C.reset} ${message}`);
          console.error(`  To allow writes, toggle the readonly switch in the PPM web UI.`);
          process.exit(1);
        }

        try {
          if (conn.type !== "sqlite") {
            const url = await openConnectionString(conn);
            // A readonly connection runs on a pool where the server itself refuses writes.
            const service = await serverService(conn.type, !!conn.readonly);
            const result = await service.executeQuery(url, sql).finally(() => service.closeAll());
            logCliQuery({
              ...audit, status: "ok", rows: result.rows,
              rowCount: result.changeType === "select" ? result.rows.length : result.rowsAffected,
              durationMs: Date.now() - startedAt,
            });
            if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
            if (result.changeType === "select") {
              formatRows(result.columns, result.rows);
            } else {
              console.log(`${C.green}OK${C.reset} — ${result.rowsAffected} row(s) affected`);
            }
          } else {
            const { sqliteService, readonlySqliteService } = await import("../../services/sqlite.service.ts");
            // ...and SQLite on a file handle opened read-only.
            const service = conn.readonly ? readonlySqliteService : sqliteService;
            let result: ReturnType<typeof service.executeQuery>;
            try { result = service.executeQuery(cfg.path!, cfg.path!, sql); } finally { service.closeAll(); }
            logCliQuery({
              ...audit, status: "ok", rows: result.rows,
              rowCount: result.changeType === "select" ? result.rows.length : result.rowsAffected,
              durationMs: Date.now() - startedAt,
            });
            if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
            if (result.changeType === "select") {
              formatRows(result.columns, result.rows);
            } else {
              console.log(`${C.green}OK${C.reset} — ${result.rowsAffected} row(s) affected`);
            }
          }
        } catch (e) {
          if (isReadonlyRefusal(e)) {
            const message = readonlyRefusalMessage(e);
            logCliQuery({ ...audit, status: "blocked", error: message, durationMs: Date.now() - startedAt });
            console.error(`${C.red}Error:${C.reset} ${message}`);
            console.error(`  To allow writes, toggle the readonly switch in the PPM web UI.`);
            process.exit(1);
          }
          logCliQuery({ ...audit, status: "error", error: (e as Error).message, durationMs: Date.now() - startedAt });
          throw e;
        }
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  // ── ppm db driver ───────────────────────────────────────────────────
  const driver = db.command("driver").description("Install or remove the drivers some connections need (MySQL / MariaDB, SSH tunnels)");

  driver.command("list")
    .description("List database drivers and whether each is installed")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const { listDbDrivers } = await import("../../services/database/drivers/db-driver-install.ts");
        const drivers = listDbDrivers();
        if (options.json) { console.log(JSON.stringify(drivers, null, 2)); return; }
        printTable(
          ["ID", "Driver", "For", "Package", "Status"],
          drivers.map((d) => [
            d.id, d.displayName, d.usedFor, `${d.package}@${d.version}`,
            d.state === "installed" ? "installed"
              : d.state === "outdated" ? `outdated (${d.installed?.version ?? "?"})`
              : "not installed",
          ]),
        );
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  driver.command("install <id>")
    .description("Download and install a database driver (e.g. mysql)")
    .action(async (id: string) => {
      try {
        const { DB_DRIVER_IDS, DB_DRIVERS, isDbDriverId } = await import("../../services/database/drivers/db-driver-catalog.ts");
        if (!isDbDriverId(id)) {
          console.error(`${C.red}Unknown driver:${C.reset} ${id} (available: ${DB_DRIVER_IDS.join(", ")})`);
          process.exit(1);
        }
        const def = DB_DRIVERS[id];
        console.log(`${C.cyan}Installing${C.reset} ${def.displayName} driver (${def.package}@${def.version}, ${def.license})...`);
        const { installDbDriver } = await import("../../services/database/drivers/db-driver-install.ts");
        const installed = await installDbDriver(id);
        console.log(`${C.green}✓${C.reset} Installed ${def.package}@${installed.version} (${Math.round(installed.bytes / 1024)} KB)`);
      } catch (err) {
        console.error(`${C.red}✗${C.reset} Install failed:`, (err as Error).message);
        process.exit(1);
      }
    });

  driver.command("remove <id>")
    .description("Remove an installed database driver")
    .action(async (id: string) => {
      try {
        const { DB_DRIVER_IDS, DB_DRIVERS, isDbDriverId } = await import("../../services/database/drivers/db-driver-catalog.ts");
        if (!isDbDriverId(id)) {
          console.error(`${C.red}Unknown driver:${C.reset} ${id} (available: ${DB_DRIVER_IDS.join(", ")})`);
          process.exit(1);
        }
        const { dbDriverStatus, uninstallDbDriver } = await import("../../services/database/drivers/db-driver-install.ts");
        if (dbDriverStatus(id).state === "missing") {
          console.log(`${C.dim}The ${DB_DRIVERS[id].displayName} driver is not installed.${C.reset}`);
          return;
        }
        await uninstallDbDriver(id);
        console.log(`${C.green}Removed${C.reset} the ${DB_DRIVERS[id].displayName} driver. A PPM server that already loaded it keeps using it until restarted.`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  // ── ppm db run ──────────────────────────────────────────────────────
  db.command("run <name> <file>")
    .description("Execute a SQL file against a saved connection")
    .action(async (nameOrId: string, filePath: string) => {
      try {
        const { resolveConnection } = await import("../../services/db.service.ts");
        const conn = resolveConnection(nameOrId);
        if (!conn) {
          console.error(`${C.red}Connection not found:${C.reset} ${nameOrId}`);
          process.exit(1);
        }

        const { resolve } = await import("node:path");
        const absFile = resolve(filePath);
        const file = Bun.file(absFile);
        if (!(await file.exists())) {
          console.error(`${C.red}File not found:${C.reset} ${absFile}`);
          process.exit(1);
        }
        const sql = await file.text();
        if (!sql.trim()) {
          console.error(`${C.yellow}File is empty:${C.reset} ${absFile}`);
          return;
        }

        const startedAt = Date.now();
        const { logCliQuery } = await import("./db-cmd-audit.ts");
        const audit = {
          connectionId: conn.id,
          connectionName: conn.name,
          dbType: conn.type,
          operation: "script" as const,
          sql,
          params: { file: absFile },
        };

        if (hiddenFromAi(conn)) {
          const message = hiddenFromAiMessage(conn);
          logCliQuery({ ...audit, status: "blocked", error: message, durationMs: Date.now() - startedAt });
          console.error(`${C.red}Error:${C.reset} ${message}`);
          process.exit(1);
        }

        // Enforce readonly
        if (conn.readonly && !isReadOnlyQuery(sql, dialectNameOf(conn.type))) {
          const message = `Connection "${conn.name}" is readonly — file contains write statements.`;
          logCliQuery({ ...audit, status: "blocked", error: message, durationMs: Date.now() - startedAt });
          console.error(`${C.red}Error:${C.reset} ${message}`);
          console.error(`  To allow writes, toggle the readonly switch in the PPM web UI.`);
          process.exit(1);
        }

        const cfg = parseConfig(conn);
        console.log(`${C.cyan}Running${C.reset} ${absFile} ${C.dim}on${C.reset} ${conn.name} (${conn.type})...\n`);

        try {
          if (conn.type !== "sqlite") {
            const url = await openConnectionString(conn);
            const service = await serverService(conn.type, !!conn.readonly);
            const result = await service.executeScript(url, sql).finally(() => service.closeAll());
            // row_count means rows everywhere else — keep statement count in params.
            logCliQuery({
              ...audit,
              params: { ...audit.params, statementsRun: result.statementsRun },
              status: "ok",
              durationMs: Date.now() - startedAt,
            });
            console.log(`${C.green}OK${C.reset} — ${result.statementsRun} statement(s) executed (${result.executionTimeMs}ms)`);
          } else {
            const { sqliteService, readonlySqliteService } = await import("../../services/sqlite.service.ts");
            const service = conn.readonly ? readonlySqliteService : sqliteService;
            let result: ReturnType<typeof service.executeScript>;
            try { result = service.executeScript(cfg.path!, cfg.path!, sql); } finally { service.closeAll(); }
            logCliQuery({ ...audit, status: "ok", durationMs: Date.now() - startedAt });
            console.log(`${C.green}OK${C.reset} — script executed (${result.executionTimeMs}ms)`);
          }
        } catch (e) {
          if (isReadonlyRefusal(e)) {
            const message = readonlyRefusalMessage(e);
            logCliQuery({ ...audit, status: "blocked", error: message, durationMs: Date.now() - startedAt });
            console.error(`${C.red}Error:${C.reset} ${message}`);
            console.error(`  To allow writes, toggle the readonly switch in the PPM web UI.`);
            process.exit(1);
          }
          logCliQuery({ ...audit, status: "error", error: (e as Error).message, durationMs: Date.now() - startedAt });
          throw e;
        }
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });
}
