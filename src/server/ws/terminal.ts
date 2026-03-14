import { terminalService } from "../../services/terminal.service.ts";
import { resolveProjectPath } from "../helpers/resolve-project.ts";

/** Control message prefix for resize commands */
const RESIZE_PREFIX = "\x01RESIZE:";

/**
 * WebSocket handler configuration for Bun.serve().
 * Handles terminal session attach, input, resize, and disconnect.
 */
export const terminalWebSocket = {
  open(ws: { data: { type: string; id: string; project?: string }; send: (data: string) => void }) {
    const { id, project } = ws.data;

    let session = id !== "new" ? terminalService.get(id) : undefined;

    // If session doesn't exist and project is provided, create one
    if (!session && project) {
      try {
        const projectPath = resolveProjectPath(project);
        // Create session with the requested ID — but TerminalService generates its own ID.
        // Instead, create and return the new session ID to client.
        const newId = terminalService.create(projectPath);
        session = terminalService.get(newId);
        if (session) {
          // Update ws.data to reflect actual session ID
          ws.data.id = newId;
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", message: (e as Error).message }));
        return;
      }
    }

    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
      return;
    }

    const sessionId = ws.data.id;

    // Mark connected
    terminalService.setConnected(sessionId, ws);

    // Send session info
    ws.send(JSON.stringify({ type: "session", id: sessionId }));

    // Send buffered output for reconnect
    const buffer = terminalService.getBuffer(sessionId);
    if (buffer) {
      ws.send(buffer);
    }

    // Wire output listener
    terminalService.onOutput(sessionId, (_id, data) => {
      try {
        ws.send(data);
      } catch {
        // WS closed
      }
    });
  },

  message(
    ws: { data: { type: string; id: string } },
    msg: string | ArrayBuffer | Uint8Array,
  ) {
    const sessionId = ws.data.id;
    const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg as ArrayBuffer);

    // Check for resize control message
    if (text.startsWith(RESIZE_PREFIX)) {
      const parts = text.slice(RESIZE_PREFIX.length).split(",");
      const cols = parseInt(parts[0] ?? "80", 10);
      const rows = parseInt(parts[1] ?? "24", 10);
      terminalService.resize(sessionId, cols, rows);
      return;
    }

    // Regular input — write to PTY
    terminalService.write(sessionId, text);
  },

  close(ws: { data: { type: string; id: string } }) {
    const sessionId = ws.data.id;
    terminalService.removeOutputListener(sessionId);
    terminalService.setDisconnected(sessionId);
  },
};
