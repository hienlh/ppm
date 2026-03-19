import { insertSessionLog, getSessionLogs as dbGetSessionLogs } from "./db.service.ts";

/** Redact sensitive values */
function redact(text: string): string {
  return text
    .replace(/Token:\s*\S+/gi, "Token: [REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/password['\":\s]+\S+/gi, "password: [REDACTED]")
    .replace(/api[_-]?key['\":\s]+\S+/gi, "api_key: [REDACTED]")
    .replace(/ANTHROPIC_API_KEY=\S+/gi, "ANTHROPIC_API_KEY=[REDACTED]")
    .replace(/secret['\":\s]+\S+/gi, "secret: [REDACTED]");
}

/** Append a log entry to a session's log in SQLite */
export function logSessionEvent(sessionId: string, level: string, message: string) {
  try {
    insertSessionLog(sessionId, level, redact(message));
  } catch { /* ignore write errors */ }
}

/** Read a session's log entries (last N lines) */
export function getSessionLog(sessionId: string, tailLines = 100): string {
  try {
    const rows = dbGetSessionLogs(sessionId, tailLines);
    // Reverse to chronological order (DB returns DESC)
    return rows.reverse().map((r) =>
      `[${r.created_at}] [${r.level}] ${r.message}`
    ).join("\n").trim();
  } catch {
    return "";
  }
}
