/**
 * Finding the SSH agent on the PPM host. `SSH_AUTH_SOCK` first; then the per-user sockets the
 * common agents create, because a PPM started by its systemd unit has no `SSH_AUTH_SOCK` even
 * while the desktop beside it runs an agent.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSshAgent } from "../../../../src/services/database/ssh-agent-socket.ts";

const dirs: string[] = [];
const servers: net.Server[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ppm-agent-"));
  dirs.push(dir);
  return dir;
}

/** A real Unix socket at `file`, which is what an agent leaves behind. */
async function socketAt(file: string): Promise<string> {
  mkdirSync(join(file, ".."), { recursive: true });
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(file, resolve));
  return file;
}

afterAll(async () => {
  for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("on Linux and macOS", () => {
  it("takes SSH_AUTH_SOCK when it names a socket", async () => {
    const sock = await socketAt(join(tempDir(), "agent.sock"));
    expect(findSshAgent({ SSH_AUTH_SOCK: sock }, [])).toBe(sock);
  });

  it("looks in the runtime directory when SSH_AUTH_SOCK is unset or stale", async () => {
    const runtime = tempDir();
    const gcr = await socketAt(join(runtime, "gcr", "ssh"));
    expect(findSshAgent({}, [runtime])).toBe(gcr);
    expect(findSshAgent({ SSH_AUTH_SOCK: join(runtime, "gone.sock") }, [runtime])).toBe(gcr);
  });

  it("prefers systemd's own agent socket, and passes over a file that is not a socket", async () => {
    const runtime = tempDir();
    writeFileSync(join(runtime, "ssh-agent.socket"), "");
    const keyring = await socketAt(join(runtime, "keyring", "ssh"));
    expect(findSshAgent({}, [runtime])).toBe(keyring);

    const other = tempDir();
    const systemd = await socketAt(join(other, "ssh-agent.socket"));
    await socketAt(join(other, "gnupg", "S.gpg-agent.ssh"));
    expect(findSshAgent({}, [other])).toBe(systemd);
  });

  it("answers null when there is none", () => {
    expect(findSshAgent({}, [tempDir()])).toBeNull();
    expect(findSshAgent({ SSH_AUTH_SOCK: "/nonexistent/agent.sock" }, [])).toBeNull();
  });

  it("reads the runtime directory from XDG_RUNTIME_DIR by default", async () => {
    const runtime = tempDir();
    const sock = await socketAt(join(runtime, "gnupg", "S.gpg-agent.ssh"));
    expect(findSshAgent({ XDG_RUNTIME_DIR: runtime })).not.toBeNull();
    expect(findSshAgent({ XDG_RUNTIME_DIR: runtime }, [runtime])).toBe(sock);
  });
});

describe.skipIf(process.platform !== "win32")("on Windows", () => {
  it("takes SSH_AUTH_SOCK as it is, a pipe name being no file to check", () => {
    expect(findSshAgent({ SSH_AUTH_SOCK: "\\\\.\\pipe\\my-agent" }, [])).toBe("\\\\.\\pipe\\my-agent");
  });
});
