// Runs the wrapper's query() against the fake CLI, and closes the query when its stdin closes.
// A process of its own, because in one `bun test` process another file's mock of the SDK outlives
// that file, and Bun patches a module already loaded in place: the mock's `query` then sits beside
// the real exports it does not name, and the fake CLI never starts.
import { query } from "../../src/providers/claude-cli-process-group.ts";

const [cli, pidFile] = process.argv.slice(2);
async function* idle(): AsyncGenerator<never> { await new Promise(() => {}); }
const q = query({
  prompt: idle(),
  options: { pathToClaudeCodeExecutable: cli, executable: process.execPath as "bun", env: { ...process.env, FAKE_CLI_PIDS: pidFile } },
});
const drained = (async () => { try { for await (const _ of q) {} } catch {} })();
for await (const _ of process.stdin) {}
q.close();
await drained;
// Ending the CLI's group is the wrapper's job once the CLI has exited, so stay until the test kills us.
setInterval(() => {}, 60_000);
