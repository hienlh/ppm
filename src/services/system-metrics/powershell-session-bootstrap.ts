/**
 * The PowerShell REPL bootstrap and the real spawner for the long-lived session.
 *
 * Why not `-Command -` with stdin scripts: PS 5.1 executes stdin line by line,
 * so a multi-line construct makes the child exit 0 silently with no stderr.
 * Instead this bootstrap IS the loop: one request = one line
 * `<id> <base64(UTF-16LE script)>`, one reply = everything up to a literal
 * `__END_<id>__` line. Per-request ids mean a hostile command line containing a
 * sentinel can desync at most the one in-flight reply.
 */

/** One `-Command` string. `try{} catch{}` must stay one logical statement — a
 *  semicolon before `catch` is a parse error that kills the child at startup
 *  with `MissingCatchOrFinally`. */
export const POWERSHELL_BOOTSTRAP = [
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  "$ErrorActionPreference='Continue'",
  "$in=[Console]::In",
  "while($true){ $line=$in.ReadLine(); if($null -eq $line){break}; if($line -eq ''){continue}; " +
    "$sp=$line.IndexOf(' '); $id=$line.Substring(0,$sp); " +
    "$code=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($line.Substring($sp+1))); " +
    "try { Invoke-Expression $code | Out-String -Width 1000000 -Stream | ForEach-Object { $_ } } catch { Write-Output ('__ERR__ ' + $_.Exception.Message) }; " +
    "Write-Output ('__END_' + $id + '__') }",
].join("; ");

/** The minimal duplex surface the session needs, so tests can inject a fake. */
export interface PsChild {
  pid: number;
  stdin: { write(data: string): unknown; flush?(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(): void;
}

export type PsSpawner = () => PsChild;

/** `-NoProfile`: a user profile can redefine cmdlets and poison the parse.
 *  `-NonInteractive`: a prompt would wedge the pipe forever. */
export const defaultPsSpawner: PsSpawner = () =>
  Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_BOOTSTRAP], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true,
  }) as unknown as PsChild;

/** Encode one request line. The id is a small monotonic counter, never user input. */
export function encodeRequestLine(id: string, script: string): string {
  return `${id} ${Buffer.from(script, "utf16le").toString("base64")}\n`;
}
