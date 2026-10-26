import { describe, it, expect } from "bun:test";
import {
  formatCommandResult, runExtensionCommand, type CallServer, type CommandRunIo,
} from "../../../src/cli/utils/run-extension-command.ts";
import { HttpError, ServerDownError } from "../../../src/cli/utils/server-client.ts";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const sink: CommandRunIo = { stdout: async (t) => { out.push(t); }, stderr: (t) => { err.push(t); } };
  return { out, err, sink };
}

const answering = (result: unknown): CallServer =>
  (async () => ({ command: "c", extensionId: "e", result, durationMs: 1 })) as unknown as CallServer;
const failing = (error: Error): CallServer => (async () => { throw error; }) as unknown as CallServer;

describe("formatCommandResult", () => {
  it("prints a string verbatim with one newline, other values as indented JSON, null as nothing", () => {
    expect(formatCommandResult("hello", "auto")).toBe("hello\n");
    expect(formatCommandResult("hello\n", "auto")).toBe("hello\n");
    expect(formatCommandResult({ a: [1] }, "auto")).toBe('{\n  "a": [\n    1\n  ]\n}\n');
    expect(formatCommandResult(null, "auto")).toBe("");
  });

  it("--json always prints one line of JSON, null included", () => {
    expect(formatCommandResult("hello", "json")).toBe('"hello"\n');
    expect(formatCommandResult({ a: 1 }, "json")).toBe('{"a":1}\n');
    expect(formatCommandResult(null, "json")).toBe("null\n");
  });
});

describe("runExtensionCommand", () => {
  it("posts the command, its args and the timeout, prints the result, exits 0", async () => {
    const calls: unknown[] = [];
    const call = (async (...a: unknown[]) => { calls.push(a); return { result: "ok", command: "c", extensionId: "e", durationMs: 1 }; }) as unknown as CallServer;
    const { out, err, sink } = io();
    expect(await runExtensionCommand("midday.cli", [["list", "--json"]], { printMode: "auto", timeoutMs: 60000 }, call, sink)).toBe(0);
    expect(calls).toEqual([["POST", "/api/extensions/commands/execute", { command: "midday.cli", args: [["list", "--json"]], timeoutMs: 60000 }, { timeoutMs: 60000 }]]);
    expect(out).toEqual(["ok\n"]);
    expect(err).toEqual([]);
  });

  it("exits 1 with the down message when no server answers", async () => {
    const { out, err, sink } = io();
    expect(await runExtensionCommand("a.b", [], { printMode: "auto", timeoutMs: 1000 }, failing(new ServerDownError()), sink)).toBe(1);
    expect(err).toEqual(["PPM server not running — start with `ppm start`"]);
    expect(out).toEqual([]);
  });

  it("exits 1 when the token is refused", async () => {
    const { err, sink } = io();
    expect(await runExtensionCommand("a.b", [], { printMode: "auto", timeoutMs: 1000 }, failing(new HttpError(401, "Unauthorized")), sink)).toBe(1);
    expect(err[0]).toContain("token");
  });

  for (const [code, status, exit] of [
    ["BAD_REQUEST", 400, 2], ["ORIGIN_REFUSED", 403, 2], ["NOT_FOUND", 404, 2], ["NOT_ACTIVE", 403, 2],
    ["HOST_NOT_READY", 503, 2], ["COMMAND_FAILED", 500, 3], ["TIMEOUT", 504, 3],
  ] as const) {
    it(`exits ${exit} for ${code}, the message on stderr only`, async () => {
      const { out, err, sink } = io();
      expect(await runExtensionCommand("a.b", [], { printMode: "json", timeoutMs: 1000 }, failing(new HttpError(status, `why ${code}`, code)), sink)).toBe(exit);
      expect(err).toEqual([`why ${code}`]);
      expect(out).toEqual([]);
    });
  }

  it("exits 3, like a server-side timeout, when its own wait for the answer runs out", async () => {
    const { err, sink } = io();
    expect(await runExtensionCommand("a.b", [], { printMode: "auto", timeoutMs: 1000 }, failing(new HttpError(0, "PPM server did not answer in time")), sink)).toBe(3);
    expect(err).toEqual(["PPM server did not answer in time"]);
  });

  it("prints nothing for a null result in auto mode", async () => {
    const { out, sink } = io();
    expect(await runExtensionCommand("a.b", [], { printMode: "auto", timeoutMs: 1000 }, answering(null), sink)).toBe(0);
    expect(out).toEqual([""]);
  });
});
