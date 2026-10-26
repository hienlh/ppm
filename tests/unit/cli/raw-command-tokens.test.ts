import { describe, it, expect } from "bun:test";
import { Command } from "commander";
import { parseExtRunTokens, rawTokensAfter } from "../../../src/cli/utils/raw-command-tokens.ts";

describe("parseExtRunTokens", () => {
  it("takes --json and --timeout wherever they appear; the first other token is the command", () => {
    expect(parseExtRunTokens(["a.b", "x", "--json", "--timeout", "5000", "y"]))
      .toEqual({ command: "a.b", args: ["x", "y"], json: true, timeout: "5000" });
    expect(parseExtRunTokens(["--timeout=7000", "--json", "a.b"]))
      .toEqual({ command: "a.b", args: [], json: true, timeout: "7000" });
  });

  it("passes everything after -- through as typed, those two flags included, and drops the -- itself", () => {
    expect(parseExtRunTokens(["a.b", "--unknown", "--", "--json", "--timeout", "5"]))
      .toEqual({ command: "a.b", args: ["--unknown", "--json", "--timeout", "5"], json: false });
    expect(parseExtRunTokens(["--", "a.b", "--json"])).toEqual({ command: "a.b", args: ["--json"], json: false });
  });

  it("keeps unknown options as arguments", () => {
    expect(parseExtRunTokens(["a.b", "-x", "--flag=1"])).toEqual({ command: "a.b", args: ["-x", "--flag=1"], json: false });
  });

  it("reports a --timeout with nothing after it, and no command at all", () => {
    expect(parseExtRunTokens(["a.b", "--timeout"]).error).toContain("--timeout");
    expect(parseExtRunTokens(["--json"]).command).toBeUndefined();
  });
});

describe("rawTokensAfter", () => {
  it("answers the tokens after the command's path as typed, -- included", async () => {
    const program = new Command().name("ppm").exitOverride().enablePositionalOptions();
    let seen: string[] = [];
    program.command("midday").allowUnknownOption().allowExcessArguments().passThroughOptions().argument("[args...]")
      .action((_a, _o, self: Command) => { seen = rawTokensAfter(self, ["midday"]); });
    await program.parseAsync(["node", "ppm", "midday", "--", "x", "--json"]);
    expect(seen).toEqual(["--", "x", "--json"]);
  });
});
