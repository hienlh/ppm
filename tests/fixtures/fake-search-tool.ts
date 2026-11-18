/**
 * A stand-in for ripgrep in `search-run.test.ts`, run as `bun fake-search-tool.ts <config.json> …rg args`
 * so it works on every OS (a shell script does not run on Windows). It records its pid, prints the
 * stdout file, writes `stderr`, then hangs or exits with `code`.
 */
import { readFileSync, writeFileSync } from "node:fs";

interface FakeToolConfig {
  pidFile: string;
  stdoutFile: string;
  stderr?: string;
  code?: number;
  hang?: boolean;
}

const config = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as FakeToolConfig;
writeFileSync(config.pidFile, String(process.pid));
// Each write is awaited: exiting with a pipe write still queued could cut it short.
const write = (stream: NodeJS.WriteStream, data: string | Uint8Array) =>
  new Promise<void>((done) => stream.write(data, () => done()));
await write(process.stdout, readFileSync(config.stdoutFile));
if (config.stderr) await write(process.stderr, config.stderr);
if (config.hang) await Bun.sleep(30_000);
process.exit(config.code ?? 0);
