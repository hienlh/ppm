import {
  insertPPMBotMemory,
  searchPPMBotMemories,
  getPPMBotMemories,
  supersedePPMBotMemory,
  deletePPMBotMemoriesByTopic,
} from "../db.service.ts";
import type {
  PPMBotMemoryCategory,
  MemoryRecallResult,
} from "../../types/ppmbot.ts";

/**
 * Lightweight memory layer for PPMBot.
 *
 * Stores identity, preferences, and explicit user facts (/remember).
 * Contextual memory (decisions, architecture, etc.) is left to the
 * AI provider's native memory system (e.g. Claude Code MEMORY.md).
 */
export class PPMBotMemory {
  /** Get all active memories for a project (+ _global) */
  getSummary(project: string, limit = 30): MemoryRecallResult[] {
    const rows = getPPMBotMemories(project, limit);
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      category: r.category,
      importance: r.importance,
      project: r.project,
    }));
  }

  /** Save a single fact (identity, /remember) */
  saveOne(
    project: string,
    content: string,
    category: PPMBotMemoryCategory = "fact",
    sessionId?: string,
  ): number {
    const existingId = this.findSimilar(project, content);
    const newId = insertPPMBotMemory(project, content.trim(), category, 1.0, sessionId);
    if (existingId) {
      supersedePPMBotMemory(existingId, newId);
    }
    return newId;
  }

  /** Delete memories matching a topic (/forget) */
  forget(project: string, topic: string): number {
    const sanitized = this.sanitizeFtsQuery(topic);
    if (!sanitized) return 0;
    return deletePPMBotMemoriesByTopic(project, sanitized);
  }

  /** Build system prompt section with identity/preferences */
  buildRecallPrompt(memories: MemoryRecallResult[]): string {
    if (memories.length === 0) return "";

    const grouped = new Map<string, string[]>();
    for (const mem of memories) {
      const cat = mem.category || "fact";
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat)!.push(mem.content);
    }

    let prompt = "\n\n## User Identity & Preferences\n";
    for (const [category, facts] of grouped) {
      prompt += `### ${category.charAt(0).toUpperCase() + category.slice(1)}s\n`;
      for (const fact of facts) {
        prompt += `- ${fact}\n`;
      }
      prompt += "\n";
    }
    return prompt;
  }

  // ── Private ─────────────────────────────────────────────────────

  /** Find an existing memory similar to the given content */
  private findSimilar(project: string, content: string): number | null {
    const words = content
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 5);

    if (words.length === 0) return null;

    const query = words.map((w) => w.replace(/[^a-zA-Z0-9]/g, "")).filter(Boolean).join(" OR ");
    if (!query) return null;

    try {
      const results = searchPPMBotMemories(project, query, 3);
      if (results.length > 0 && results[0]!.rank < -5) {
        return results[0]!.id;
      }
    } catch {
      // FTS error — no match
    }

    return null;
  }

  /** Sanitize user input for FTS5 MATCH syntax */
  private sanitizeFtsQuery(input: string): string {
    return input
      .replace(/['"():*^~{}[\]\\]/g, " ")
      .replace(/\b(AND|OR|NOT|NEAR)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }
}
