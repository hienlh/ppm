import { describe, it, expect, beforeEach } from "bun:test";
import { Command } from "commander";
import { openTestDb, setDb, getConnections, insertConnection } from "../../../../src/services/db.service.ts";
import { registerDbCommands } from "../../../../src/cli/commands/db-cmd.ts";

beforeEach(() => {
  setDb(openTestDb());
});

describe("registerDbCommands", () => {
  it("registers 'db' parent command with subcommands", () => {
    const program = new Command();
    registerDbCommands(program);

    const dbCmd = program.commands.find((c) => c.name() === "db");
    expect(dbCmd).toBeDefined();
    expect(dbCmd!.description()).toBe("Manage database connections and execute queries");

    const subNames = dbCmd!.commands.map((c) => c.name());
    expect(subNames).toContain("list");
    expect(subNames).toContain("add");
    expect(subNames).toContain("remove");
    expect(subNames).toContain("test");
    expect(subNames).toContain("tables");
    expect(subNames).toContain("schema");
    expect(subNames).toContain("data");
    expect(subNames).toContain("query");
    expect(subNames).toHaveLength(8);
  });

  it("'add' command requires --name and --type options", () => {
    const program = new Command();
    registerDbCommands(program);
    const dbCmd = program.commands.find((c) => c.name() === "db")!;
    const addCmd = dbCmd.commands.find((c) => c.name() === "add")!;

    const optNames = addCmd.options.map((o) => o.long);
    expect(optNames).toContain("--name");
    expect(optNames).toContain("--type");
    expect(optNames).toContain("--connection-string");
    expect(optNames).toContain("--file");
    expect(optNames).toContain("--group");
    expect(optNames).toContain("--color");
  });

  it("'data' command has pagination options", () => {
    const program = new Command();
    registerDbCommands(program);
    const dbCmd = program.commands.find((c) => c.name() === "db")!;
    const dataCmd = dbCmd.commands.find((c) => c.name() === "data")!;

    const optNames = dataCmd.options.map((o) => o.long);
    expect(optNames).toContain("--page");
    expect(optNames).toContain("--limit");
    expect(optNames).toContain("--order");
    expect(optNames).toContain("--desc");
    expect(optNames).toContain("--schema");
  });

  it("'schema' command has --schema option", () => {
    const program = new Command();
    registerDbCommands(program);
    const dbCmd = program.commands.find((c) => c.name() === "db")!;
    const schemaCmd = dbCmd.commands.find((c) => c.name() === "schema")!;

    const optNames = schemaCmd.options.map((o) => o.long);
    expect(optNames).toContain("--schema");
  });
});

describe("db service integration used by CLI", () => {
  it("insertConnection stores and getConnections retrieves", () => {
    const conn = insertConnection("sqlite", "cli-test", { type: "sqlite", path: "/tmp/cli.db" });
    expect(conn.name).toBe("cli-test");
    expect(conn.type).toBe("sqlite");
    expect(conn.readonly).toBe(1); // default readonly

    const all = getConnections();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("cli-test");
  });

  it("insertConnection auto-increments sort_order", () => {
    insertConnection("sqlite", "first", { type: "sqlite", path: "/tmp/a.db" });
    insertConnection("sqlite", "second", { type: "sqlite", path: "/tmp/b.db" });
    const all = getConnections();
    expect(all[0]!.sort_order).toBe(0);
    expect(all[1]!.sort_order).toBe(1);
  });

  it("insertConnection with group and color", () => {
    const conn = insertConnection("postgres", "pg-conn", { type: "postgres", connectionString: "postgresql://localhost" }, "dev-group", "#ff0000");
    expect(conn.group_name).toBe("dev-group");
    expect(conn.color).toBe("#ff0000");
  });
});
