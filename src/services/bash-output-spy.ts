/**
 * BashOutputSpy — monitors SDK Bash tool execution by tailing output files.
 *
 * SDK redirects bash stdout to /tmp/claude-{uid}/-tmp/{uuid}/tasks/{task-id}.output
 * We find the bash PID via pgrep, resolve its stdout fd to the output file,
 * then poll every 100ms for new content, emitting line-buffered deltas.
 *
 * Cross-platform: Linux (/proc/PID/fd/1), macOS (lsof), Windows native = no-op.
 * Graceful degradation: spy failure = same UX as today (tool_result shows full output).
 */

interface SpyEntry {
  sessionId: string;
  toolUseId: string;
  filePath: string;
  bytesRead: number;
  lineBuffer: string;
  polling: boolean;
  intervalId: ReturnType<typeof setInterval>;
}

export interface SpyOutput {
  sessionId: string;
  toolUseId: string;
  newContent: string;
  totalLineCount: number;
}

type OutputCallback = (output: SpyOutput) => void;

const activeSpies = new Map<string, SpyEntry>();
/** Track total lines per spy for lineCount reporting */
const lineCounters = new Map<string, number>();

/** Escape special regex chars for pgrep -f */
function escapeForPgrep(cmd: string): string {
  // pgrep uses extended regex — escape metacharacters
  return cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find the newest bash PID matching a command substring (current user only) */
async function findBashPid(commandSubstring: string): Promise<number | null> {
  try {
    // Use a short unique substring of the command for matching
    const searchStr = escapeForPgrep(commandSubstring.slice(0, 80));
    const uid = String(process.getuid?.() ?? "");
    const args = uid ? ["pgrep", "-fn", "-u", uid, searchStr] : ["pgrep", "-fn", searchStr];
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const pid = parseInt(text.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Resolve the stdout output file for a PID (cross-platform) */
async function resolveOutputFile(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      // readlink /proc/PID/fd/1 → output file path
      const proc = Bun.spawn(["readlink", `/proc/${pid}/fd/1`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const target = (await new Response(proc.stdout).text()).trim();
      const exitCode = await proc.exited;
      if (exitCode !== 0 || !target) return null;
      if (target.includes("/tasks/") && target.endsWith(".output")) return target;
      return null;
    }

    if (process.platform === "darwin") {
      // lsof -p PID → parse for .output file in /tasks/
      const proc = Bun.spawn(["lsof", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      for (const line of text.split("\n")) {
        const match = line.match(/\s(\/\S+\/tasks\/\S+\.output)\s*$/);
        if (match) return match[1]!;
      }
      return null;
    }

    // Windows native: no-op
    return null;
  } catch {
    return null;
  }
}

/** Poll the output file for new content, emit complete lines */
async function pollFile(entry: SpyEntry, onOutput: OutputCallback): Promise<void> {
  try {
    const file = Bun.file(entry.filePath);
    const size = file.size;
    if (size <= entry.bytesRead) return;

    const newBytes = file.slice(entry.bytesRead, size);
    const chunk = await newBytes.text();
    entry.bytesRead = size;

    // Buffer partial lines — only emit on complete newlines
    const combined = entry.lineBuffer + chunk;
    const lastNewline = combined.lastIndexOf("\n");

    if (lastNewline === -1) {
      // No complete line yet — buffer everything
      entry.lineBuffer = combined;
      return;
    }

    // Emit complete lines, keep remainder in buffer
    const toEmit = combined.slice(0, lastNewline + 1);
    entry.lineBuffer = combined.slice(lastNewline + 1);

    const lineCount = (lineCounters.get(entry.toolUseId) ?? 0) + toEmit.split("\n").length - 1;
    lineCounters.set(entry.toolUseId, lineCount);

    onOutput({
      sessionId: entry.sessionId,
      toolUseId: entry.toolUseId,
      newContent: toEmit,
      totalLineCount: lineCount,
    });
  } catch {
    // File may have been deleted — stop spying
    stopSpy(entry.toolUseId);
  }
}

/** Start monitoring a Bash tool's output */
async function startSpy(
  toolUseId: string,
  command: string,
  sessionId: string,
  onOutput: OutputCallback,
): Promise<void> {
  // Platform guard: skip on native Windows (not WSL)
  if (process.platform === "win32") return;

  // Already spying this tool
  if (activeSpies.has(toolUseId)) return;

  // Retry PID discovery up to 3 times with 100ms delay
  let pid: number | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    pid = await findBashPid(command);
    if (pid) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!pid) {
    console.log(`[bash-spy] toolUseId=${toolUseId} PID not found — skipping`);
    return;
  }

  const filePath = await resolveOutputFile(pid);
  if (!filePath) {
    console.log(`[bash-spy] toolUseId=${toolUseId} output file not resolved — skipping`);
    return;
  }

  const entry: SpyEntry = {
    sessionId,
    toolUseId,
    filePath,
    bytesRead: 0,
    lineBuffer: "",
    polling: false,
    intervalId: setInterval(async () => {
      if (entry.polling) return;
      entry.polling = true;
      try { await pollFile(entry, onOutput); }
      finally { entry.polling = false; }
    }, 100),
  };

  activeSpies.set(toolUseId, entry);
  lineCounters.set(toolUseId, 0);
  console.log(`[bash-spy] started toolUseId=${toolUseId} pid=${pid} file=${filePath}`);
}

/** Stop monitoring a specific Bash tool */
function stopSpy(toolUseId: string): void {
  const entry = activeSpies.get(toolUseId);
  if (!entry) return;
  clearInterval(entry.intervalId);
  activeSpies.delete(toolUseId);
  lineCounters.delete(toolUseId);
  console.log(`[bash-spy] stopped toolUseId=${toolUseId}`);
}

/** Stop all active spies for a session (cleanup on disconnect) */
function stopAllForSession(sessionId: string): void {
  for (const [id, entry] of activeSpies) {
    if (entry.sessionId === sessionId) {
      clearInterval(entry.intervalId);
      activeSpies.delete(id);
      lineCounters.delete(id);
    }
  }
}

export const bashOutputSpy = { startSpy, stopSpy, stopAllForSession };
