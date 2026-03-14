import type { ServerWebSocket } from "bun";
import type { TerminalService } from "../../services/terminal.service.ts";

const RESIZE_PREFIX = "\x01RESIZE:";

export interface TerminalWsData {
  kind: "terminal";
  sessionId: string;
  projectPath: string;
  terminalService: TerminalService;
  removeDataHandler?: () => void;
}

export const terminalWsHandlers = {
  open(ws: ServerWebSocket<TerminalWsData>) {
    const { projectPath, terminalService } = ws.data;

    let session = terminalService.get(ws.data.sessionId);
    if (!session) {
      session = terminalService.create({ projectPath });
    }

    terminalService.cancelIdleCleanup(session.id);
    ws.data.sessionId = session.id;

    const remove = terminalService.onData(session.id, (data) => {
      ws.send(data);
    });
    ws.data.removeDataHandler = remove;
  },

  message(ws: ServerWebSocket<TerminalWsData>, msg: string | Buffer) {
    const { sessionId, terminalService } = ws.data;
    const text = typeof msg === "string" ? msg : msg.toString("utf8");

    if (text.startsWith(RESIZE_PREFIX)) {
      const parts = text.slice(RESIZE_PREFIX.length).split(",");
      const cols = parseInt(parts[0] ?? "80", 10);
      const rows = parseInt(parts[1] ?? "24", 10);
      if (!isNaN(cols) && !isNaN(rows)) {
        try { terminalService.resize(sessionId, cols, rows); } catch { /* ignore */ }
      }
      return;
    }

    try {
      terminalService.write(sessionId, text);
    } catch { /* session may have died */ }
  },

  close(ws: ServerWebSocket<TerminalWsData>) {
    const { sessionId, terminalService, removeDataHandler } = ws.data;
    if (removeDataHandler) removeDataHandler();
    terminalService.scheduleIdleCleanup(sessionId);
  },
};
