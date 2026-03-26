import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { ChatMessage, SessionInfo } from "../provider.interface.ts";

const DEFAULT_CHATS_DIR = join(homedir(), ".cursor", "chats");

/**
 * List all Cursor sessions found in ~/.cursor/chats/.
 * Scans directory structure: {cwdHash}/{sessionId}/store.db
 * Reads meta table for session name and createdAt.
 * @param chatsDir — override for testing (defaults to ~/.cursor/chats)
 */
export async function listCursorSessions(providerId: string, chatsDir?: string): Promise<SessionInfo[]> {
  const dir = chatsDir ?? DEFAULT_CHATS_DIR;
  if (!existsSync(dir)) return [];
  const { Database } = await import("bun:sqlite");
  const sessions: SessionInfo[] = [];

  try {
    for (const cwdHash of readdirSync(dir)) {
      const cwdDir = join(dir, cwdHash);
      try {
        for (const sessionId of readdirSync(cwdDir)) {
          const dbPath = join(cwdDir, sessionId, "store.db");
          if (!existsSync(dbPath)) continue;

          let title = `Cursor ${sessionId.slice(0, 8)}`;
          let createdAt = new Date().toISOString();

          // Read meta table for name + createdAt (value is hex-encoded JSON)
          try {
            const db = new Database(dbPath, { readonly: true });
            const row = db.query("SELECT value FROM meta LIMIT 1").get() as { value: string | Buffer } | null;
            db.close();
            if (row?.value) {
              const hex = typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf-8");
              const json = Buffer.from(hex, "hex").toString("utf-8");
              const meta = JSON.parse(json);
              if (meta.name) title = meta.name.split("\n")[0].slice(0, 80);
              if (meta.createdAt) createdAt = new Date(meta.createdAt).toISOString();
            }
          } catch { /* use defaults */ }

          sessions.push({ id: sessionId, providerId, title, createdAt });
        }
      } catch { /* skip unreadable dir */ }
    }
  } catch { /* skip if chats dir unreadable */ }

  return sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Load chat history from Cursor's SQLite DAG storage.
 * Path: ~/.cursor/chats/{MD5(cwd)}/{sessionId}/store.db
 * Falls back to scanning all cwdHash dirs if projectPath doesn't match.
 */
export async function loadCursorHistory(
  sessionId: string,
  projectPath?: string,
  chatsDir?: string,
): Promise<ChatMessage[]> {
  const baseDir = chatsDir ?? DEFAULT_CHATS_DIR;
  let dbPath: string | null = null;

  // Try direct path first (fast path when projectPath is known)
  if (projectPath) {
    const cwdHash = createHash("md5").update(projectPath).digest("hex");
    const candidate = join(baseDir, cwdHash, sessionId, "store.db");
    if (existsSync(candidate)) dbPath = candidate;
  }

  // Fallback: scan all cwdHash dirs for this sessionId
  if (!dbPath && existsSync(baseDir)) {
    try {
      for (const cwdHash of readdirSync(baseDir)) {
        const candidate = join(baseDir, cwdHash, sessionId, "store.db");
        if (existsSync(candidate)) { dbPath = candidate; break; }
      }
    } catch { /* skip */ }
  }

  if (!dbPath) return [];

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

      // Try to parse as JSON
      try {
        const parsed = JSON.parse(text);

        // Format: { role: "...", content: "..." | [...] } — structured message
        // Skip system prompts — they're huge and not useful for history
        if (parsed.role === "system") continue;
        if (parsed.role && parsed.content) {
          let content: string;
          if (typeof parsed.content === "string") {
            content = parsed.content;
          } else if (Array.isArray(parsed.content)) {
            // Content parts: [{ type: "text", text: "..." }, ...]
            content = parsed.content
              .filter((p: any) => p.type === "text" && p.text)
              .map((p: any) => p.text)
              .join("\n") || JSON.stringify(parsed.content);
          } else {
            content = JSON.stringify(parsed.content);
          }
          // Strip Cursor's <user_query> wrapper from user messages
          if (parsed.role === "user") {
            const match = content.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
            if (match?.[1]) content = match[1];
          }
          messages.push({
            id: blob.id,
            role: parsed.role,
            content,
            timestamp: new Date().toISOString(),
          });
          continue;
        }

        // Format: [{ type: "text", text: "..." }] — content parts array
        if (Array.isArray(parsed)) {
          const textParts = parsed
            .filter((p: any) => p.type === "text" && p.text)
            .map((p: any) => p.text)
            .join("\n");
          if (textParts) {
            messages.push({
              id: blob.id,
              role: messages.length % 2 === 0 ? "user" : "assistant",
              content: textParts,
              timestamp: new Date().toISOString(),
            });
            continue;
          }
        }
      } catch { /* not JSON */ }
    } catch { /* skip corrupt blob */ }
  }

  return messages;
}

/**
 * Extract readable text from a DAG blob.
 * Handles 2 known formats:
 * 1. UTF-8 JSON string starting with { or [ (role/content messages)
 * 2. JSON array (content parts like [{type:"text",text:"..."}])
 * Skips binary DAG metadata blobs (parent refs, headers).
 */
function extractTextContent(data: Buffer | Uint8Array): string | null {
  if (!data || data.length === 0) return null;

  const buf = Buffer.from(data);

  // Quick binary check: if first byte is not printable ASCII, it's a DAG metadata blob
  const firstByte = buf[0];
  if (firstByte !== undefined && firstByte < 0x20 && firstByte !== 0x0a && firstByte !== 0x0d && firstByte !== 0x09) {
    return null;
  }

  const text = buf.toString("utf-8");

  // Only accept clean JSON starting with { or [
  if (text.startsWith("{") || text.startsWith("[")) {
    // Validate it's actually parseable JSON
    try {
      JSON.parse(text);
      return text;
    } catch {
      return null;
    }
  }

  return null;
}
