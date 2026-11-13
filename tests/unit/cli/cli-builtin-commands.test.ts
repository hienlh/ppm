import { describe, it, expect } from "bun:test";
import { buildProgram } from "../../../src/index.ts";
import { BUILTIN_CLI_COMMANDS } from "../../../src/shared/cli-builtin-commands.ts";

describe("BUILTIN_CLI_COMMANDS", () => {
  it("lists exactly the top-level names and aliases buildProgram registers", async () => {
    const program = await buildProgram();
    const registered = program.commands.flatMap((c) => [c.name(), ...c.aliases()]).sort();
    // A new built-in command fails here until it is listed, so no extension alias can take it.
    expect([...BUILTIN_CLI_COMMANDS].sort()).toEqual(registered);
  });
});
