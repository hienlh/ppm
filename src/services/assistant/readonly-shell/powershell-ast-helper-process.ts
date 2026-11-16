import { existsSync } from "node:fs";
import { join } from "node:path";
import { isNode, type PsNode, type PsParseReply } from "./powershell-ast-types.ts";

/**
 * Which PowerShell parses a script, how the helper child is started, and how one request and
 * one reply are framed.
 *
 * The helper must parse with the same PowerShell that will run the command, or the tree it
 * judges can differ from the one executed (`&&` is a parse error in 5.1 and a chain in 7). Claude
 * Code's PowerShell tool picks, in order, PowerShell 7, PowerShell 7 preview, then Windows
 * PowerShell 5.1 at their install locations; so does this. Elsewhere it is `pwsh` on PATH.
 */
export function findPowerShellExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (platform !== "win32") return Bun.which("pwsh") ?? null;
  const programFiles = env.ProgramFiles || "C:\Program Files";
  const systemRoot = env.SystemRoot || env.windir || "C:\Windows";
  const candidates = [
    join(programFiles, "PowerShell", "7", "pwsh.exe"),
    join(programFiles, "PowerShell", "7-preview", "pwsh.exe"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ];
  return candidates.find((path) => exists(path)) ?? null;
}

/**
 * One request line: a small counter id, then the script as base64 of its UTF-16LE code units,
 * which carries every character of a JavaScript string exactly and can hold no newline.
 */
export function encodeAstRequest(id: string, script: string): string {
  return `${id} ${Buffer.from(script, "utf16le").toString("base64")}\n`;
}

/** The minimal duplex surface the helper needs, so tests can inject a fake child. */
export interface AstHelperChild {
  pid: number;
  stdin: { write(data: string): unknown; flush?(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(): void;
}
export type AstHelperSpawner = (argv: string[]) => AstHelperChild;

export const defaultSpawner: AstHelperSpawner = (argv) =>
  Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true }) as unknown as AstHelperChild;

/** A reply line as the judge's input; anything not shaped like one is a failed parse. */
export function toReply(msg: Record<string, unknown>, psVersion: string): PsParseReply {
  const ast = msg.ast as PsNode | undefined;
  if (msg.ok === true && typeof msg.count === "number" && isNode(ast)) return { ok: true, count: msg.count, ast, psVersion };
  if (msg.ok === false && typeof msg.error === "string") return { ok: false, error: msg.error };
  return { ok: false, error: "PowerShell wrote a malformed reply" };
}

/** A full stderr pipe would block the child; read it, handing each chunk's text on. */
export async function drain(stream: ReadableStream<Uint8Array> | null | undefined, onText: (text: string) => void): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  try {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      onText(decoder.decode(value, { stream: true }));
    }
  } catch { /* closed with the child */ }
}

/** A reply line longer than this is not one the helper would write for a script PPM sends. */
const MAX_LINE_CHARS = 16 * 1024 * 1024;

/**
 * Reads `stdout` line by line, handing each non-blank line to `onLine` while `current()` holds.
 * Resolves with why reading stopped: the stream ended, or a line grew past any real reply.
 */
export async function readReplyLines(stdout: ReadableStream<Uint8Array>, current: () => boolean, onLine: (line: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    const reader = stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done || !current()) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while (current() && (nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.trim()) onLine(line);
      }
      if (buffer.length > MAX_LINE_CHARS) return "PowerShell wrote an oversized reply";
    }
  } catch { /* the stream closed with the child */ }
  return "PowerShell's output closed";
}

/** One line of the helper's output as a JSON object, or null when it is not one. */
export function parseReplyLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
