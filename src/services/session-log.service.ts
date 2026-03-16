import { resolve } from "node:path";
import { homedir } from "node:os";
import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";

const SESSION_LOG_DIR = resolve(homedir(), ".ppm", "sessions");

/** Ensure log directory exists */
function ensureDir() {
  if (!existsSync(SESSION_LOG_DIR)) mkdirSync(SESSION_LOG_DIR, { recursive: true });
}

/** Redact sensitive values */
function redact(text: string): string {
  return text
    .replace(/Token:\s*\S+/gi, "Token: [REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/password['":\s]+\S+/gi, "password: [REDACTED]")
    .replace(/api[_-]?key['":\s]+\S+/gi, "api_key: [REDACTED]")
    .replace(/ANTHROPIC_API_KEY=\S+/gi, "ANTHROPIC_API_KEY=[REDACTED]")
    .replace(/secret['":\s]+\S+/gi, "secret: [REDACTED]");
}

/** Append a log entry to a session's log file */
export function logSessionEvent(sessionId: string, level: string, message: string) {
  ensureDir();
  const ts = new Date().toISOString();
  const logFile = resolve(SESSION_LOG_DIR, `${sessionId}.log`);
  try {
    appendFileSync(logFile, `[${ts}] [${level}] ${redact(message)}\n`);
  } catch { /* ignore write errors */ }
}

/** Read a session's log file (last N lines) */
export function getSessionLog(sessionId: string, tailLines = 100): string {
  const logFile = resolve(SESSION_LOG_DIR, `${sessionId}.log`);
  if (!existsSync(logFile)) return "";
  try {
    const content = readFileSync(logFile, "utf-8");
    const lines = content.split("\n");
    return lines.slice(-tailLines).join("\n").trim();
  } catch {
    return "";
  }
}
