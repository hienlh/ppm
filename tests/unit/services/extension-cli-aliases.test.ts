import { describe, it, expect } from "bun:test";
import { Command } from "commander";
import { collectCliAliases } from "../../../src/services/extension-cli-aliases.ts";
import { addExtensionCliAliases, shouldLoadAliases } from "../../../src/cli/commands/extension-cli-alias-cmd.ts";
import { isMachineFacing } from "../../../src/cli/utils/machine-facing-commands.ts";
import type { ExtensionManifest } from "../../../src/types/extension.ts";

function ext(id: string, cli: unknown[], commands: string[] = ["x.cli"]): ExtensionManifest {
  return {
    id, version: "1.0.0", main: "i.js",
    contributes: { commands: commands.map((command) => ({ command, title: command })), cli: cli as never },
  };
}

const everyone = () => true;

describe("collectCliAliases", () => {
  it("keeps a valid alias with its description and owner", () => {
    const { aliases, refused } = collectCliAliases([ext("ppm-midday", [{ name: "midday", description: "Loose ends", command: "x.cli" }])], everyone);
    expect(aliases).toEqual([{ name: "midday", description: "Loose ends", command: "x.cli", extensionId: "ppm-midday" }]);
    expect(refused).toEqual([]);
  });

  it("refuses bad names, built-in names, undeclared commands and duplicates, saying why", () => {
    const { aliases, refused } = collectCliAliases([
      ext("b-ext", [{ name: "dupe", command: "x.cli" }]),
      ext("a-ext", [
        { name: "Bad", command: "x.cli" },
        { name: "x", command: "x.cli" },
        { name: "start", command: "x.cli" },
        { name: "help", command: "x.cli" },
        { name: "ghost", command: "not.declared" },
        { name: "dupe", command: "x.cli" },
      ]),
    ], everyone);
    // The id sorting first keeps a contested name, whatever order they were given in.
    expect(aliases).toEqual([{ name: "dupe", command: "x.cli", extensionId: "a-ext" }]);
    expect(refused.map((r) => `${r.extensionId}:${r.name}:${r.reason}`)).toEqual([
      "a-ext:Bad:invalid-name", "a-ext:x:invalid-name", "a-ext:start:builtin", "a-ext:help:builtin",
      "a-ext:ghost:undeclared-command", "b-ext:dupe:duplicate",
    ]);
  });

  it("ignores disabled extensions entirely", () => {
    expect(collectCliAliases([ext("off", [{ name: "midday", command: "x.cli" }])], () => false).aliases).toEqual([]);
  });

  it("survives a manifest whose cli field is not an array", () => {
    expect(collectCliAliases([ext("odd", "midday" as unknown as unknown[])], everyone)).toEqual({ aliases: [], refused: [] });
  });
});

describe("shouldLoadAliases", () => {
  it("loads for no command, help, or a name that is not built in, and never for a built-in", () => {
    const argv = (...a: string[]) => ["bun", "ppm", ...a];
    expect(shouldLoadAliases(argv())).toBe(true);
    expect(shouldLoadAliases(argv("--help"))).toBe(true);
    expect(shouldLoadAliases(argv("help"))).toBe(true);
    expect(shouldLoadAliases(argv("midday", "list"))).toBe(true);
    expect(shouldLoadAliases(argv("start"))).toBe(false);
    expect(shouldLoadAliases(argv("ext", "run", "x"))).toBe(false);
    expect(shouldLoadAliases(argv("--version"))).toBe(false);
  });
});

describe("addExtensionCliAliases", () => {
  async function parse(...argv: string[]) {
    const program = new Command().name("ppm").exitOverride();
    const ran: Array<{ command: string; argv: string[] }> = [];
    addExtensionCliAliases(program, [{ name: "midday", command: "midday.cli", extensionId: "ppm-midday" }], async (command, a) => {
      ran.push({ command, argv: a });
    });
    await program.parseAsync(["node", "ppm", ...argv]);
    return { ran, program };
  }

  it("hands every token after the name to the command verbatim, --json and --help included", async () => {
    expect((await parse("midday", "list", "--json")).ran).toEqual([{ command: "midday.cli", argv: ["list", "--json"] }]);
    expect((await parse("midday", "--help")).ran).toEqual([{ command: "midday.cli", argv: ["--help"] }]);
    expect((await parse("midday", "note", "--", "-x")).ran).toEqual([{ command: "midday.cli", argv: ["note", "--", "-x"] }]);
    expect((await parse("midday")).ran).toEqual([{ command: "midday.cli", argv: [] }]);
  });

  it("marks each alias machine-facing, so no banner goes to its stdout", async () => {
    const { program } = await parse("midday");
    expect(isMachineFacing(program.commands.find((c) => c.name() === "midday"))).toBe(true);
  });
});
