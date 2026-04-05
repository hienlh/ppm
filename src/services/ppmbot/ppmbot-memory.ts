import {
  insertPPMBotMemory,
  searchPPMBotMemories,
  getPPMBotMemories,
  supersedePPMBotMemory,
  deletePPMBotMemoriesByTopic,
  decayPPMBotMemories,
  getDb,
} from "../db.service.ts";
import { configService } from "../config.service.ts";
import type {
  PPMBotMemoryCategory,
  MemoryRecallResult,
} from "../../types/ppmbot.ts";
import type { ProjectConfig } from "../../types/config.ts";

/** Max memories per project before pruning */
const MAX_MEMORIES_PER_PROJECT = 500;

/** Fact extracted from AI response */
interface ExtractedFact {
  content: string;
  category: PPMBotMemoryCategory;
  importance?: number;
}

export class PPMBotMemory {
  /**
   * Recall relevant memories for a project.
   * If query provided, use FTS5 search. Otherwise return top by importance.
   */
  recall(project: string, query?: string, limit = 20): MemoryRecallResult[] {
    if (query) {
      const sanitized = this.sanitizeFtsQuery(query);
      if (sanitized) {
        try {
          const results = searchPPMBotMemories(project, sanitized, limit);
          return results.map((r) => ({
            id: r.id,
            content: r.content,
            category: r.category,
            importance: r.importance,
            project: r.project,
            rank: r.rank,
          }));
        } catch {
          // FTS query syntax error — fallback to importance-based
        }
      }
    }

    const rows = getPPMBotMemories(project, limit);
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      category: r.category,
      importance: r.importance,
      project: r.project,
    }));
  }

  /**
   * Enhanced recall: include memories from mentioned projects.
   * Detects project names in message and fetches their memories too.
   */
  recallWithCrossProject(
    currentProject: string,
    query: string | undefined,
    message: string,
    limit = 20,
  ): MemoryRecallResult[] {
    const mainMemories = this.recall(currentProject, query, limit);
    const mentioned = this.detectMentionedProjects(message, currentProject);

    if (mentioned.length === 0) return mainMemories;

    const crossMemories: MemoryRecallResult[] = [];
    for (const proj of mentioned.slice(0, 3)) {
      const projMems = this.recall(proj, query, 5);
      crossMemories.push(...projMems.map((m) => ({ ...m, project: proj })));
    }

    return [...mainMemories, ...crossMemories].slice(0, limit);
  }

  /**
   * Save multiple extracted facts. Checks for duplicates via FTS
   * and supersedes old facts when new ones are similar.
   */
  save(project: string, facts: ExtractedFact[], sessionId?: string): number {
    let inserted = 0;
    for (const fact of facts) {
      if (!fact.content?.trim()) continue;

      const existingId = this.findSimilar(project, fact.content);

      const newId = insertPPMBotMemory(
        project,
        fact.content.trim(),
        fact.category || "fact",
        fact.importance ?? 1.0,
        sessionId,
      );

      if (existingId) {
        supersedePPMBotMemory(existingId, newId);
      }

      inserted++;
    }

    this.pruneExcess(project);
    return inserted;
  }

  /** Save a single fact immediately (from /remember command) */
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

  /** Delete memories matching a topic (from /forget command) */
  forget(project: string, topic: string): number {
    const sanitized = this.sanitizeFtsQuery(topic);
    if (!sanitized) return 0;
    return deletePPMBotMemoriesByTopic(project, sanitized);
  }

  /** Get summary of all active memories for a project */
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

  /** Build system prompt section with recalled memories */
  buildRecallPrompt(memories: MemoryRecallResult[]): string {
    if (memories.length === 0) return "";

    const grouped = new Map<string, string[]>();
    for (const mem of memories) {
      const cat = mem.category || "fact";
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat)!.push(mem.content);
    }

    let prompt = "\n\n## Cross-Session Memory\n";
    prompt += "The following facts are recalled from previous sessions:\n\n";

    for (const [category, facts] of grouped) {
      prompt += `### ${category.charAt(0).toUpperCase() + category.slice(1)}s\n`;
      for (const fact of facts) {
        prompt += `- ${fact}\n`;
      }
      prompt += "\n";
    }

    prompt += "Use these as context. Correct any that seem outdated.\n";
    return prompt;
  }

  /** Build the extraction prompt sent at session end */
  buildExtractionPrompt(): string {
    return `Summarize the key facts, decisions, and preferences from this conversation as a JSON array. Each entry:
{"content": "the fact", "category": "fact|decision|preference|architecture|issue", "importance": 0.5-2.0}

Rules:
- Only include facts worth remembering across sessions
- Skip ephemeral details (file line numbers, temp debug info)
- Prefer concise, self-contained statements
- Max 10 entries
- Return ONLY the JSON array, no markdown fencing

If nothing worth remembering, return []`;
  }

  /**
   * Parse the AI's extraction response into structured facts.
   * Handles: raw JSON array, markdown-fenced JSON, or graceful failure.
   */
  parseExtractionResponse(text: string): ExtractedFact[] {
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
    }

    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter(
          (item: unknown): item is Record<string, unknown> =>
            typeof item === "object" && item !== null && "content" in item,
        )
        .map((item) => ({
          content: String(item.content ?? ""),
          category: this.validateCategory(String(item.category ?? "fact")),
          importance: Math.max(0, Math.min(2, Number(item.importance ?? 1))),
        }))
        .filter((f) => f.content.length > 0);
    } catch {
      console.warn("[ppmbot-memory] Failed to parse extraction response");
      return [];
    }
  }

  /**
   * Regex-based fallback for memory extraction.
   * Used when AI extraction returns empty or fails.
   */
  extractiveMemoryFallback(conversationText: string): ExtractedFact[] {
    const facts: ExtractedFact[] = [];
    const patterns: Array<{ re: RegExp; category: PPMBotMemoryCategory }> = [
      { re: /(?:decided|chose|went with|picked|selected)\s+(.{10,100})/gi, category: "decision" },
      { re: /(?:prefer|always use|like to|rather)\s+(.{10,80})/gi, category: "preference" },
      { re: /(?:uses?|built with|stack is|powered by|database is)\s+(.{5,80})/gi, category: "architecture" },
      { re: /(?:bug|issue|problem|broken|fails?|error)\s+(?:with|in|when)\s+(.{10,100})/gi, category: "issue" },
    ];
    for (const { re, category } of patterns) {
      let match: RegExpExecArray | null;
      while ((match = re.exec(conversationText)) !== null) {
        const content = (match[1] || match[0]).trim();
        if (content.length > 10) {
          facts.push({ content, category, importance: 0.7 });
        }
      }
    }
    return facts.slice(0, 10);
  }

  /** Run importance decay on old memories */
  runDecay(): void {
    try {
      decayPPMBotMemories();
    } catch (err) {
      console.error("[ppmbot-memory] Decay error:", (err as Error).message);
    }
  }

  /** Remove excess memories beyond the per-project cap */
  pruneExcess(project: string, maxCount = MAX_MEMORIES_PER_PROJECT): void {
    try {
      const count = (getDb().query(
        `SELECT COUNT(*) as cnt FROM clawbot_memories
         WHERE project = ? AND superseded_by IS NULL`,
      ).get(project) as { cnt: number })?.cnt ?? 0;

      if (count <= maxCount) return;

      const excess = count - maxCount;
      getDb().query(
        `DELETE FROM clawbot_memories WHERE id IN (
           SELECT id FROM clawbot_memories
           WHERE project = ? AND superseded_by IS NULL
           ORDER BY importance ASC, updated_at ASC
           LIMIT ?
         )`,
      ).run(project, excess);
    } catch (err) {
      console.error("[ppmbot-memory] Prune error:", (err as Error).message);
    }
  }

  // ── Private ─────────────────────────────────────────────────────

  /** Detect project names mentioned in user message */
  private detectMentionedProjects(message: string, currentProject: string): string[] {
    const allProjects = configService.get("projects") as ProjectConfig[];
    if (!allProjects?.length) return [];
    return allProjects
      .filter((p) => p.name !== currentProject)
      .filter((p) => message.toLowerCase().includes(p.name.toLowerCase()))
      .map((p) => p.name);
  }

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

  /** Validate category string against known values */
  private validateCategory(cat: string): PPMBotMemoryCategory {
    const valid: PPMBotMemoryCategory[] = [
      "fact", "decision", "preference", "architecture", "issue",
    ];
    return valid.includes(cat as PPMBotMemoryCategory)
      ? (cat as PPMBotMemoryCategory)
      : "fact";
  }
}
