import { serverRequest, serverSocketUrl, ServerDownError } from "../utils/ppm-server-client.ts";
import { chatSocketPath, sendChatCancel } from "../utils/chat-ws-cancel.ts";
import { waitTurnIdle } from "../../services/chat-control/wait-turn-idle.ts";
import { C, fail, type ChatTarget } from "./chat-cmd-request.ts";

/**
 * `ppm chat stop`: stops a chat's running turn through the chat socket's own stop frame — the one
 * PPM's Stop button sends — then waits for the server to report the turn over. A chat with no
 * turn running, or no PPM running at all, has nothing to stop.
 */
const STOP_WAIT_MS = 10_000;
const POLL_MS = 250;

type Running = Array<{ sessionId: string }>;

export async function stopChatTurn(t: ChatTarget): Promise<void> {
  const runningPath = `/project/${encodeURIComponent(t.project)}/chat/sessions/running`;
  const isRunning = async () => (await serverRequest<Running>("GET", runningPath)).some((s) => s.sessionId === t.id);
  let running: boolean;
  try {
    running = await isRunning();
  } catch (e) {
    if (e instanceof ServerDownError) {
      console.log(`${C.dim}No PPM is running, so no turn is running.${C.reset}`);
      return;
    }
    throw e;
  }
  if (!running) {
    console.log(`${C.dim}No turn is running in ${t.id}.${C.reset}`);
    return;
  }
  await sendChatCancel(await serverSocketUrl(chatSocketPath(t.project, t.id, t.providerId ?? undefined)));
  const stopped = await waitTurnIdle(isRunning, { intervalMs: POLL_MS, timeoutMs: STOP_WAIT_MS });
  if (!stopped) fail(`Asked ${t.id} to stop, but its turn is still running after ${STOP_WAIT_MS / 1000} s`);
  console.log(`${C.green}Stopped:${C.reset} ${t.id}`);
}
