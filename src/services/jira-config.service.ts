import { getDb } from "./db.service.ts";
import { encrypt, decrypt } from "../lib/account-crypto.ts";
import type { JiraConfigRow, JiraConfig, JiraCredentials } from "../types/jira.ts";

// ── Row → API mapper ──────────────────────────────────────────────────

function rowToConfig(row: JiraConfigRow): JiraConfig {
  return {
    id: row.id,
    projectId: row.project_id,
    baseUrl: row.base_url,
    email: row.email,
    hasToken: !!row.api_token_encrypted,
    createdAt: row.created_at,
  };
}

// ── Public API ────────────────────────────────────────────────────────

export function getConfigByProjectId(projectId: number): JiraConfig | null {
  const row = getDb()
    .query("SELECT * FROM jira_config WHERE project_id = ?")
    .get(projectId) as JiraConfigRow | null;
  return row ? rowToConfig(row) : null;
}

export function getConfigById(id: number): JiraConfigRow | null {
  return getDb()
    .query("SELECT * FROM jira_config WHERE id = ?")
    .get(id) as JiraConfigRow | null;
}

export function getAllConfigs(): JiraConfig[] {
  const rows = getDb()
    .query("SELECT * FROM jira_config ORDER BY id")
    .all() as JiraConfigRow[];
  return rows.map(rowToConfig);
}

export function upsertConfig(
  projectId: number,
  baseUrl: string,
  email: string,
  plainToken?: string,
): JiraConfig {
  if (plainToken) {
    // Full upsert with new token
    const encrypted = encrypt(plainToken);
    getDb().query(`
      INSERT INTO jira_config (project_id, base_url, email, api_token_encrypted)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        base_url = excluded.base_url,
        email = excluded.email,
        api_token_encrypted = excluded.api_token_encrypted
    `).run(projectId, baseUrl, email, encrypted);
  } else {
    // Update URL/email only, preserve existing token
    getDb().query(`
      UPDATE jira_config SET base_url = ?, email = ? WHERE project_id = ?
    `).run(baseUrl, email, projectId);
  }
  return getConfigByProjectId(projectId)!;
}

export function deleteConfig(projectId: number): boolean {
  const result = getDb()
    .query("DELETE FROM jira_config WHERE project_id = ?")
    .run(projectId);
  return result.changes > 0;
}

export function getDecryptedCredentials(configId: number): JiraCredentials | null {
  const row = getConfigById(configId);
  if (!row) return null;
  try {
    const token = decrypt(row.api_token_encrypted);
    return { baseUrl: row.base_url, email: row.email, token };
  } catch (e) {
    console.warn(`[jira] Failed to decrypt token for config ${configId}:`, (e as Error).message);
    return null;
  }
}
