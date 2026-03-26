import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { ChatMessage, SessionInfo } from "../provider.interface.ts";

const CURSOR_CHATS_DIR = join(homedir(), ".cursor", "chats");

/**
 * List all Cursor sessions found in ~/.cursor/chats/.
 * Scans directory structure: {cwdHash}/{sessionId}/store.db
 */
export async function listCursorSessions(providerId: string): Promise<SessionInfo[]> {
  if (!existsSync(CURSOR_CHATS_DIR)) return [];
  const sessions: SessionInfo[] = [];

  try {
    for (const cwdHash of readdirSync(CURSOR_CHATS_DIR)) {
      const cwdDir = join(CURSOR_CHATS_DIR, cwdHash);
      try {
        for (const sessionId of readdirSync(cwdDir)) {
          const dbPath = join(cwdDir, sessionId, "store.db");
          if (existsSync(dbPath)) {
            sessions.push({
              id: sessionId,
              providerId,
              title: `Cursor session ${sessionId.slice(0, 8)}...`,
              createdAt: new Date().toISOString(),
            });
          }
        }
      } catch { /* skip unreadable dir */ }
    }
  } catch { /* skip if chats dir unreadable */ }

  return sessions;
}

/**
 * Load chat history from Cursor's SQLite DAG storage.
 * Path: ~/.cursor/chats/{MD5(cwd)}/{sessionId}/store.db
 */
export async function loadCursorHistory(
  sessionId: string,
  projectPath?: string,
): Promise<ChatMessage[]> {
  const cwdHash = createHash("md5")
    .update(projectPath || process.cwd())
    .digest("hex");
  const dbPath = join(CURSOR_CHATS_DIR, cwdHash, sessionId, "store.db");

  if (!existsSync(dbPath)) return [];

  try {
    // Use Bun's native SQLite
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });

    const blobs = db
      .query("SELECT rowid, id, data FROM blobs ORDER BY rowid")
      .all() as Array<{ rowid: number; id: string; data: Buffer }>;
    db.close();

    return parseDagBlobs(blobs, sessionId);
  } catch (err) {
    console.warn(`[cursor-history] Failed to load session ${sessionId}:`, err);
    return [];
  }
}

/** Parse DAG blobs into ordered ChatMessages */
function parseDagBlobs(
  blobs: Array<{ rowid: number; id: string; data: Buffer }>,
  _sessionId: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const blob of blobs) {
    try {
      const text = extractTextContent(blob.data);
      if (!text) continue;

      // Try to parse as JSON first (structured message)
      try {
        const parsed = JSON.parse(text);
        if (parsed.role && parsed.content) {
          messages.push({
            id: blob.id,
            role: parsed.role,
            content: typeof parsed.content === "string"
              ? parsed.content
              : JSON.stringify(parsed.content),
            timestamp: new Date().toISOString(),
          });
          continue;
        }
      } catch { /* not JSON, treat as plain text */ }

      // Plain text blob — infer role from position (odd = user, even = assistant)
      messages.push({
        id: blob.id,
        role: messages.length % 2 === 0 ? "user" : "assistant",
        content: text,
        timestamp: new Date().toISOString(),
      });
    } catch { /* skip corrupt blob */ }
  }

  return messages;
}

/**
 * Extract readable text from a DAG blob.
 * Handles 3 known formats:
 * 1. UTF-8 JSON string
 * 2. Binary blob with embedded JSON (skip binary header)
 * 3. Raw text
 */
function extractTextContent(data: Buffer | Uint8Array): string | null {
  if (!data || data.length === 0) return null;

  const buf = Buffer.from(data);
  const text = buf.toString("utf-8");

  // Format 1: Clean JSON
  if (text.startsWith("{") || text.startsWith("[")) {
    return text;
  }

  // Format 2: Binary header → find first { or [ for embedded JSON
  const jsonStart = Math.min(
    text.indexOf("{") === -1 ? Infinity : text.indexOf("{"),
    text.indexOf("[") === -1 ? Infinity : text.indexOf("["),
  );
  if (jsonStart !== Infinity && jsonStart < 256) {
    return text.slice(jsonStart);
  }

  // Format 3: Raw text (if printable)
  const printable = text.replace(/[^\x20-\x7E\n\r\t]/g, "").trim();
  return printable.length > 10 ? printable : null;
}
