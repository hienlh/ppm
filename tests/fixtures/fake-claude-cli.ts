// A Claude CLI that dies without ending what it started. It starts a stand-in MCP server in its
// own process group, the way the CLI starts stdio MCP servers, and a stand-in Bash-tool command in
// a session of its own, the way the CLI starts those; writes both pids as JSON to the file named
// by FAKE_CLI_PIDS (an env var, because run through the SDK it gets the SDK's arguments); then
// exits when its stdin closes and leaves both running.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const member = spawn("sleep", ["300"], { stdio: "ignore" });
const ownSession = spawn("sleep", ["300"], { stdio: "ignore", detached: true });
writeFileSync(process.env.FAKE_CLI_PIDS!, JSON.stringify({ member: member.pid, ownSession: ownSession.pid }));

for await (const _ of process.stdin) {
  // The SDK's initialize request and messages; nothing answers them.
}
process.exit(0);
