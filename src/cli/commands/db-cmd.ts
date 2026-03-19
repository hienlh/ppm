import { Command } from "commander";
import { isReadOnlyQuery } from "../../services/database/readonly-check.ts";

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

/** Parse connection_config JSON and return the connection string or path */
function parseConfig(row: { type: string; connection_config: string }): { type: string; path?: string; connectionString?: string } {
  const cfg = JSON.parse(row.connection_config);
  return { type: row.type, ...cfg };
}

/** Mask password in postgres connection string: postgresql://user:pass@host → postgresql://user:***@host */
function maskPassword(connectionString: string): string {
  return connectionString.replace(/(:\/\/[^:]+:)[^@]+(@)/, "$1***$2");
}


export function registerDbCommands(program: Command): void {
  const db = program.command("db").description("Manage database connections and execute queries");

  // ── ppm db list ──────────────────────────────────────────────────────
  db.command("list")
    .description("List all saved database connections")
    .action(async () => {
      try {
        const { getConnections } = await import("../../services/db.service.ts");
        const conns = getConnections();
        if (conns.length === 0) {
          console.log(`${C.yellow}No connections saved.${C.reset} Run: ppm db add`);
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
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  // ── ppm db add ───────────────────────────────────────────────────────
  db.command("add")
    .description("Add a new database connection")
    .requiredOption("-n, --name <name>", "Connection name (unique)")
    .requiredOption("-t, --type <type>", "Database type: sqlite | postgres")
    .option("-c, --connection-string <url>", "PostgreSQL connection string")
    .option("-f, --file <path>", "SQLite file path (absolute)")
    .option("-g, --group <group>", "Group name")
    .option("--color <color>", "Tab color (hex, e.g. #3b82f6)")
    .action(async (options) => {
      try {
        const { insertConnection } = await import("../../services/db.service.ts");
        const type = options.type as "sqlite" | "postgres";

        if (!["sqlite", "postgres"].includes(type)) {
          console.error(`${C.red}Error:${C.reset} --type must be 'sqlite' or 'postgres'`);
          process.exit(1);
        }

        let config: import("../../services/db.service.ts").ConnectionConfig;
        if (type === "postgres") {
          if (!options.connectionString) {
            console.error(`${C.red}Error:${C.reset} PostgreSQL requires --connection-string`);
            process.exit(1);
          }
          config = { type: "postgres", connectionString: options.connectionString };
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
        const { deleteConnection } = await import("../../services/db.service.ts");
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
        const cfg = parseConfig(conn);

        if (conn.type === "postgres") {
          const { postgresService } = await import("../../services/postgres.service.ts");
          const result = await postgresService.testConnection(cfg.connectionString!);
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
    .action(async (nameOrId: string) => {
      try {
        const { resolveConnection } = await import("../../services/db.service.ts");
        const conn = resolveConnection(nameOrId);
        if (!conn) {
          console.error(`${C.red}Connection not found:${C.reset} ${nameOrId}`);
          process.exit(1);
        }
        const cfg = parseConfig(conn);

        if (conn.type === "postgres") {
          const { postgresService } = await import("../../services/postgres.service.ts");
          const tables = await postgresService.getTables(cfg.connectionString!);
          if (tables.length === 0) {
            console.log(`${C.dim}No tables found.${C.reset}`);
            return;
          }
          printTable(
            ["Schema", "Table", "Rows (est.)"],
            tables.map((t) => [t.schema, t.name, String(t.rowCount)]),
          );
        } else {
          const { sqliteService } = await import("../../services/sqlite.service.ts");
          const tables = sqliteService.getTables(cfg.path!, cfg.path!);
          if (tables.length === 0) {
            console.log(`${C.dim}No tables found.${C.reset}`);
            return;
          }
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
    .option("-s, --schema <schema>", "PostgreSQL schema name", "public")
    .action(async (nameOrId: string, table: string, options: { schema: string }) => {
      try {
        const { resolveConnection } = await import("../../services/db.service.ts");
        const conn = resolveConnection(nameOrId);
        if (!conn) {
          console.error(`${C.red}Connection not found:${C.reset} ${nameOrId}`);
          process.exit(1);
        }
        const cfg = parseConfig(conn);

        if (conn.type === "postgres") {
          const { postgresService } = await import("../../services/postgres.service.ts");
          const cols = await postgresService.getTableSchema(cfg.connectionString!, table, options.schema);
          printTable(
            ["Column", "Type", "Nullable", "PK", "Default"],
            cols.map((c) => [c.name, c.type, c.nullable ? "YES" : "NO", c.pk ? "PK" : "", c.defaultValue ?? ""]),
          );
        } else {
          const { sqliteService } = await import("../../services/sqlite.service.ts");
          const cols = sqliteService.getTableSchema(cfg.path!, cfg.path!, table);
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
    .option("-s, --schema <schema>", "PostgreSQL schema name", "public")
    .action(async (nameOrId: string, table: string, options) => {
      try {
        const { resolveConnection } = await import("../../services/db.service.ts");
        const conn = resolveConnection(nameOrId);
        if (!conn) {
          console.error(`${C.red}Connection not found:${C.reset} ${nameOrId}`);
          process.exit(1);
        }
        const cfg = parseConfig(conn);
        const page = parseInt(options.page, 10);
        const limit = parseInt(options.limit, 10);
        const orderDir = options.desc ? "DESC" as const : "ASC" as const;

        if (conn.type === "postgres") {
          const { postgresService } = await import("../../services/postgres.service.ts");
          const result = await postgresService.getTableData(
            cfg.connectionString!, table, options.schema, page, limit, options.order, orderDir,
          );
          console.log(`${C.cyan}${table}${C.reset} — page ${result.page}, ${result.total} total rows\n`);
          formatRows(result.columns, result.rows, limit);
        } else {
          const { sqliteService } = await import("../../services/sqlite.service.ts");
          const result = sqliteService.getTableData(
            cfg.path!, cfg.path!, table, page, limit, options.order, orderDir,
          );
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
    .action(async (nameOrId: string, sql: string) => {
      try {
        const { resolveConnection } = await import("../../services/db.service.ts");
        const conn = resolveConnection(nameOrId);
        if (!conn) {
          console.error(`${C.red}Connection not found:${C.reset} ${nameOrId}`);
          process.exit(1);
        }
        const cfg = parseConfig(conn);

        // Enforce readonly — CLI cannot disable this, only the web UI can toggle it
        if (conn.readonly && !isReadOnlyQuery(sql)) {
          console.error(`${C.red}Error:${C.reset} Connection "${conn.name}" is readonly — only SELECT queries allowed.`);
          console.error(`  To allow writes, toggle the readonly switch in the PPM web UI.`);
          process.exit(1);
        }

        if (conn.type === "postgres") {
          const { postgresService } = await import("../../services/postgres.service.ts");
          const result = await postgresService.executeQuery(cfg.connectionString!, sql);
          if (result.changeType === "select") {
            formatRows(result.columns, result.rows);
          } else {
            console.log(`${C.green}OK${C.reset} — ${result.rowsAffected} row(s) affected`);
          }
        } else {
          const { sqliteService } = await import("../../services/sqlite.service.ts");
          const result = sqliteService.executeQuery(cfg.path!, cfg.path!, sql);
          if (result.changeType === "select") {
            formatRows(result.columns, result.rows);
          } else {
            console.log(`${C.green}OK${C.reset} — ${result.rowsAffected} row(s) affected`);
          }
        }
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });
}
