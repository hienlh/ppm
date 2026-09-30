export interface SendMessageOpts {
  /** PPM's bounded, project-scoped shared instructions; kept separate from user text. */
  sharedContext?: string;
  permissionMode?: import("./config").PermissionMode | string;
  priority?: 'now' | 'next' | 'later';
  images?: Array<{ data: string; mediaType: string }>;
  /**
   * Uploaded paths for the same attachments, for providers that take a file rather than a
   * payload. Codex's turn input accepts `localImage` by path and has no base64 form, so an
   * image reaches it this way or not at all.
   */
  imagePaths?: string[];
  /** Per-session model override; falls back to provider config model when absent */
  model?: string;
  /** Override the provider's 1M-context setting for this call (false = never add the
   *  [1m] suffix). Used by lightweight calls (e.g. the group-chat router) whose small
   *  model may not support a 1M window. Falls back to provider config when absent. */
  oneMContext?: boolean;
  /** Per-query turn cap; falls back to provider config max_turns when absent */
  maxTurns?: number;
  /** Per-session effort override (low|medium|high|xhigh|max); falls back to provider config */
  effort?: string;
  /** Per-session thinking tri-state (see THINKING_ADAPTIVE); falls back to provider config */
  thinkingBudget?: number;
  /**
   * Design session instruction block. Resolved by `chatService.prepareSendOptions` from the
   * session's stored design slug and stripped from whatever the caller passed, so it is
   * always server-built. Claude appends it to the system prompt, Codex sends it as
   * `developerInstructions`.
   */
  designInstructions?: string;
  /** Set alongside `designInstructions`; selects the design permission policy. */
  designSession?: boolean;
  /**
   * The design MCP endpoint (`design_check`) for this session: a URL on the port this server
   * actually listens on and the session's capability token. Server-built like
   * `designInstructions`; absent when the process serves no HTTP (the CLI).
   */
  designMcp?: { url: string; token: string };
}

export interface AIProvider {
  id: string;
  name: string;
  /** Handles opts.sharedContext without using it as the user's saved message/title. */
  supportsSharedContext?: boolean;
  /** Delivers opts.designInstructions to the model on every turn. Only such providers may
   *  host a design session; anywhere else the instructions would be silently dropped. */
  supportsDesignInstructions?: boolean;
  /** Additional instruction/memory sources; never return credentials or transcripts. */
  getSharedContextSources?(projectPath: string): Array<{ path: string; directory?: boolean }>;

  // Session lifecycle (required)
  createSession(config: SessionConfig): Promise<Session>;
  resumeSession(sessionId: string): Promise<Session>;
  listSessions(): Promise<SessionInfo[]>;
  deleteSession(sessionId: string): Promise<void>;

  // Streaming (required)
  sendMessage(
    sessionId: string,
    message: string,
    opts?: SendMessageOpts,
  ): AsyncIterable<ChatEvent>;

  // Optional capabilities — providers implement what they support
  resolveApproval?(requestId: string, approved: boolean, data?: unknown): void;
  onToolApproval?: (callback: ToolApprovalHandler) => void;
  abortQuery?(sessionId: string, source?: string): void;
  getMessages?(sessionId: string): Promise<ChatMessage[]>;
  /** Every message in the transcript, including the segments before each compaction.
   *  `getMessages` answers with the resumable *conversation*; this answers with the
   *  whole history. Only the search index asks for it — see `indexSession`. */
  getFullMessages?(sessionId: string): Promise<ChatMessage[]>;
  listSessionsByDir?(dir: string, opts?: { limit?: number; offset?: number }): Promise<SessionInfo[]>;
  ensureProjectPath?(sessionId: string, path: string): void;
  setForkSource?(sessionId: string, sourceSessionId: string): void;
  forkAtMessage?(sessionId: string, messageId: string, opts?: { title?: string; dir?: string }): Promise<{ sessionId: string }>;
  markAsResumed?(sessionId: string): void;
  isAvailable?(): Promise<boolean>;
  listModels?(): Promise<ModelOption[]>;
  /**
   * Skills the provider's own runtime would resolve for this session, for
   * providers that own a skill system PPM cannot read off disk. Implemented by
   * codex; absent for Claude, whose skills come from the shared disk discovery.
   */
  listSkills?(sessionId?: string): Promise<import("../providers/codex-app-server/codex-protocol").CodexSkill[]>;
  /** Drop runtime skill discovery results after a user requests a refresh. */
  invalidateSkillsCache?(): void;
  /** Provider-specific usage/quota (rate limits). Used by GET /chat/usage. */
  getUsage?(sessionId?: string, pickedAccountId?: string): Promise<UsageInfo>;
  /** True when a live streaming subprocess exists for this session */
  hasStreamingSession?(sessionId: string): boolean;
  /** Prompt-cache lifetime for this session, in ms — how long holding its subprocess pays. */
  promptCacheTtlMs?(sessionId: string): number;
}

export interface ModelOption {
  value: string;
  label: string;
}

export interface Session {
  id: string;
  providerId: string;
  title: string;
  projectName?: string;
  projectPath?: string;
  createdAt: string;
  /** Per-session model override (e.g. claude-opus-4-8); falls back to provider config default */
  model?: string;
}

export interface SessionConfig {
  providerId?: string;
  projectName?: string;
  projectPath?: string;
  title?: string;
}

export interface ProjectTag {
  id: number;
  projectPath: string;
  name: string;
  color: string;
  sortOrder: number;
}

export interface SessionInfo {
  id: string;
  providerId: string;
  title: string;
  projectName?: string;
  createdAt: string;
  updatedAt?: string;
  pinned?: boolean;
  tag?: { id: number; name: string; color: string } | null;
  /** Design this session belongs to; null/absent for an ordinary chat. */
  designSlug?: string | null;
}

/**
 * Keeps every history surface in the same order: pinned conversations first,
 * then the conversation most recently written to. Older providers may not
 * expose an update timestamp, so their creation time remains the fallback.
 */
export function compareSessionsByActivity(a: SessionInfo, b: SessionInfo): number {
  if (a.pinned && !b.pinned) return -1;
  if (!a.pinned && b.pinned) return 1;
  return sessionActivityTime(b) - sessionActivityTime(a);
}

function sessionActivityTime(session: SessionInfo): number {
  const updated = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(session.createdAt);
  return Number.isFinite(created) ? created : 0;
}

export interface SessionListResponse {
  sessions: SessionInfo[];
  hasMore: boolean;
}

export interface ChatSearchResult {
  sessionId: string;
  providerId?: string;
  title: string | null;
  /** Highlighted excerpt (may contain <mark>…</mark>); equals title for title-only matches. */
  snippet: string;
  /** Stable ChatMessage id to scroll to; empty for title-only matches. */
  messageId: string;
  matchedIn: "title" | "content";
  ts: string;
  pinned?: boolean;
  tag?: { id: number; name: string; color: string } | null;
  /** Set for a design session, so a result opens in its design tab rather than as a chat. */
  designSlug?: string | null;
}

export interface ChatSearchResponse {
  results: ChatSearchResult[];
  indexing: { total: number; indexed: number; running: boolean };
}

export interface LimitBucket {
  utilization: number;
  resetsAt: string;
  resetsInMinutes: number | null;
  resetsInHours: number | null;
  windowHours: number;
}

export interface UsageInfo {
  /** Cumulative cost across the session */
  totalCostUsd?: number;
  /** Cost of the last query only (resets each query) */
  queryCostUsd?: number;
  /** 0–1 utilization for five_hour limit */
  fiveHour?: number;
  /** 0–1 utilization for seven_day limit */
  sevenDay?: number;
  /** ISO timestamp when five_hour limit resets */
  fiveHourResetsAt?: string;
  /** ISO timestamp when seven_day limit resets */
  sevenDayResetsAt?: string;
  /** Detailed limit buckets from ccburn */
  session?: LimitBucket;
  weekly?: LimitBucket;
  weeklyOpus?: LimitBucket;
  weeklySonnet?: LimitBucket;
  /** Claude's per-model weekly limits ("Fable", …), labelled by model. */
  weeklyScoped?: ScopedLimitBucket[];
  /** Codex's free rate-limit resets still available to this account. */
  resetCredits?: ResetCredits;
  activeAccountId?: string;
  activeAccountLabel?: string;
}

/** A weekly limit that applies to one model only, named as the provider names it. */
export interface ScopedLimitBucket extends LimitBucket {
  label: string;
}

/** Free "reset my rate limits" credits Codex grants an account. */
export interface ResetCredits {
  /** How many can still be used. */
  available: number;
  /** ISO time the soonest-expiring one lapses, if any is available. */
  nextExpiresAt?: string;
  /** What the soonest one resets, as Codex words it ("Full reset (Weekly + 5 hr)"). */
  title?: string;
  /** Codex's opaque id of that soonest-expiring credit — the one "Use reset" spends. */
  nextCreditId?: string;
}

/** Result subtype from SDK ResultMessage */
export type ResultSubtype =
  | "success"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_during_execution"
  | "error_auth";

export type ChatEvent =
  | { type: "text"; content: string; parentToolUseId?: string; arrivalSeq?: number }
  | { type: "thinking"; content: string; parentToolUseId?: string; arrivalSeq?: number }
  | {
      type: "tool_use"; tool: string; input: unknown; toolUseId?: string; parentToolUseId?: string; children?: ChatEvent[];
      /** Terminal state of a backgrounded Agent/Task, once its `<task-notification>` arrives.
       *  Absent on a launched-but-unfinished agent — the card renders that as still running. */
      bgStatus?: import("../shared/background-agent-status").BackgroundAgentStatus;
      /** Agent/Task only: distinct child tool_use ids counted as "steps" so far — a Set-like
       *  array kept stable under a WS replay redelivering the same id. */
      stepIds?: string[];
      /** stepIds.length, cached alongside it so the one-line card need not measure the array. */
      stepCount?: number;
      /** Plain-text description of the most recent step, for the one-line card. */
      lastStep?: string;
      /** Set by a provider when an on-disk transcript was found for this card — its `children`
       *  are safe to reduce to the slimmed set because a session window can stream the rest
       *  from disk instead. Never set by the live stream itself. */
      transcriptAvailable?: boolean;
      /** Bounded ring buffer (last 200, or ~256KB serialized) of child events slimming would
       *  otherwise drop — the fallback shown in a window when no on-disk transcript exists at
       *  all, merged back with `children` in original arrival order via each entry's
       *  `arrivalSeq`. */
      recentChildren?: ChatEvent[];
      /** Monotonic counter this Agent/Task card's own `applyChildToParent` routing bumps once
       *  per incoming child — the source of `arrivalSeq` stamped onto each routed child. */
      childSeq?: number;
      /** Position among this child's siblings in the order they actually arrived — set when a
       *  child is routed by `applyChildToParent`/`pushRecentChild` with a parent's `childSeq`,
       *  so `children` and `recentChildren` (split apart by kept-vs-ring-buffer routing) can be
       *  merged back into arrival order instead of concatenated. */
      arrivalSeq?: number;
    }
  | { type: "tool_result"; output: string; isError?: boolean; exitCode?: number; toolUseId?: string; parentToolUseId?: string; arrivalSeq?: number }
  | { type: "approval_request"; requestId: string; tool: string; input: unknown }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string; resultSubtype?: ResultSubtype; numTurns?: number; contextWindowPct?: number; costUsd?: number; lastMessageUuid?: string; usage?: import("../shared/turn-usage").TurnUsage }
  | { type: "account_info"; accountId: string; accountLabel: string }
  | { type: "account_retry"; reason: string; accountId?: string; accountLabel?: string }
  | { type: "status_update"; phase: "routing" | "refreshing" | "switching" | "retrying"; message: string; accountLabel?: string }
  | { type: "system"; subtype: string }
  | { type: "team_detected"; teamName: string }
  | { type: "team_updated"; teamName: string; team: unknown }
  | { type: "team_inbox"; teamName: string; agent: string; messages: unknown[] }
  | { type: "session_migrated"; oldSessionId: string; newSessionId: string };

export type ToolApprovalHandler = (
  tool: string,
  input: unknown,
) => Promise<{ approved: boolean; reason?: string }>;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  events?: ChatEvent[];
  timestamp: string;
  /** Account used to generate this assistant message */
  accountId?: string;
  accountLabel?: string;
  /** SDK message UUID — used for fork/rewind (maps to JSONL message IDs) */
  sdkUuid?: string;
  /** Token split for the turn that produced this message; drives the cost warning. */
  usage?: import("../shared/turn-usage").TurnUsage;
  /**
   * Set only on the compact-summary message that opens a post-compaction segment,
   * so the divider above it can say what the compaction cost and saved.
   */
  compaction?: CompactionInfo;
}

/**
 * What one compaction did, read back from the `compact_boundary` record Claude Code
 * writes into the transcript.
 *
 * Taken from the file rather than from the live `compact_boundary` event because the
 * figure has to survive a reload: the turn that compacts ends by refetching history,
 * so a notice that existed only in WebSocket state would vanish seconds after it
 * appeared. The event carries the same numbers and is deliberately not plumbed.
 */
export interface CompactionInfo {
  /** `auto` when the context window forced it, `manual` when the user ran /compact. */
  trigger: "manual" | "auto";
  /** Transcript size going in. */
  preTokens: number;
  /** Size of the summary that replaced it. */
  postTokens: number;
  /** `preTokens - postTokens` — this compaction alone, not the session's running total. */
  savedTokens: number;
  /** How long the compaction took, when the record says. */
  durationMs?: number;
}
