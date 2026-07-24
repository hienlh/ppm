import { groupChatService } from "../../services/group-chat/group-chat.service.ts";
import type { GroupChatClientMessage } from "../../types/group-chat-ws.ts";

type GroupWsSocket = {
  data: { type: string; groupId: string; projectName?: string };
  send: (data: string) => void;
};

const PING_INTERVAL_MS = 15_000;
const pings = new Map<GroupWsSocket, ReturnType<typeof setInterval>>();

/** WS handler for /ws/project/:name/group/:groupId — streams bus messages +
 *  member status. On connect it sends group_state + buffered events; a client
 *  "message" starts/feeds the engine, "stop" aborts it. */
export const groupChatWebSocket = {
  open(ws: GroupWsSocket): void {
    groupChatService.addClient(ws.data.groupId, ws);
    const timer = setInterval(() => {
      try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* closed */ }
    }, PING_INTERVAL_MS);
    pings.set(ws, timer);
  },

  message(ws: GroupWsSocket, raw: string | Buffer): void {
    let msg: GroupChatClientMessage;
    try { msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()); }
    catch { ws.send(JSON.stringify({ type: "error", message: "invalid JSON" })); return; }

    const groupId = ws.data.groupId;
    if (msg.type === "message") {
      const content = msg.content?.trim();
      if (!content) { ws.send(JSON.stringify({ type: "error", message: "empty message" })); return; }
      // Detached: FE disconnect does not abort the loop.
      groupChatService.start(groupId, content).catch((e) => {
        ws.send(JSON.stringify({ type: "error", message: (e as Error).message }));
      });
    } else if (msg.type === "stop") {
      groupChatService.stop(groupId);
    }
    // "ready" is a no-op ack.
  },

  close(ws: GroupWsSocket): void {
    const timer = pings.get(ws);
    if (timer) { clearInterval(timer); pings.delete(ws); }
    groupChatService.removeClient(ws.data.groupId, ws);
  },
};
