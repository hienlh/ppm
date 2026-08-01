// Native PPM group-chat engine — shared domain types.
// Message bus is a single table keyed by `kind` + JSON `data` (spike-validated).

export type GroupStatus = "active" | "paused" | "idle";
export type MemberRole = "leader" | "member";
export type MemberStatus = "idle" | "working" | "done" | "error";
export type MessageKind = "task" | "chat" | "status" | "completion" | "final";

/** Per-group cap on AI turns per user message (the "reply burst" ceiling). Configurable
 *  per team; the router usually ends earlier by returning nobody. */
export const DEFAULT_MAX_TURNS = 10;
export const DEFAULT_MAX_COST_USD = 5.0;

export interface Group {
  id: string;
  projectName: string;
  projectPath: string;
  name: string;
  leaderSessionId: string | null;
  status: GroupStatus;
  maxTurns: number;
  maxCostUsd: number;
  createdAt: number;
}

export interface GroupMember {
  id: string;
  groupId: string;
  role: MemberRole;
  persona: string | null;
  agentType: string | null;
  model: string | null;
  sessionId: string | null;
  name: string;
  color: string | null;
  status: MemberStatus;
  joinedAt: number;
}

export interface GroupMessage {
  id: string;
  groupId: string;
  fromMember: string;
  toMember: string | null;
  kind: MessageKind;
  summary: string | null;
  fullSessionRef: string | null;
  data: unknown;
  turnIndex: number;
  createdAt: number;
}

export interface CreateGroupInput {
  projectName: string;
  projectPath: string;
  name: string;
  maxTurns?: number;
  maxCostUsd?: number;
}

export interface AddMemberInput {
  groupId: string;
  role: MemberRole;
  name: string;
  persona?: string | null;
  agentType?: string | null;
  model?: string | null;
  color?: string | null;
}

/** Partial member update — only provided fields change. */
export interface UpdateMemberInput {
  role?: MemberRole;
  name?: string;
  persona?: string | null;
  agentType?: string | null;
  model?: string | null;
  color?: string | null;
}

export interface AppendMessageInput {
  groupId: string;
  fromMember: string;
  toMember?: string | null;
  kind: MessageKind;
  summary?: string | null;
  fullSessionRef?: string | null;
  data?: unknown;
  turnIndex: number;
}

export interface ReadMessagesOptions {
  limit?: number;
  sinceTurn?: number;
}

// ---------------------------------------------------------------------------
// Turn engine
// ---------------------------------------------------------------------------

export interface AgentTurnResult {
  text: string;
  usage?: { costUsd?: number };
}

/** Injected dependencies — engine never imports a provider directly (testable). */
export interface TurnEngineDeps {
  /** Run one turn for a member's session with a prompt; returns full text + usage. */
  runAgent: (member: GroupMember, prompt: string) => Promise<AgentTurnResult>;
  /** Persist a turn to the bus. */
  appendMessage: (input: AppendMessageInput) => GroupMessage;
  /** Read prior bus messages (for windowed context). */
  readMessages: (groupId: string, opts?: ReadMessagesOptions) => GroupMessage[];
  /** Emit a turn to live listeners (WS broadcast). Optional. */
  onMessage?: (message: GroupMessage) => void;
  /** Signal that `member` is composing a reply (drives the typing indicator). Optional. */
  onTyping?: (member: string) => void;
  /** Pick who speaks NEXT given recent context; returns 0-N member names to run **in
   *  parallel** this turn. Empty = end the burst (no one else replies). `isUserTurn` is true
   *  only for the first reply to a fresh user message — on that turn the engine forces the
   *  leader if the router returns none (a user message always gets ≥1 reply). Members that
   *  must build on each other → return just one (sequential). When this dep is absent the
   *  engine falls back to mention-following (conversational mode). Optional. */
  routeNextSpeakers?: (ctx: {
    history: GroupMessage[];
    members: GroupMember[];
    isUserTurn: boolean;
  }) => Promise<string[]>;
  /** External stop signal (user Stop / abort). Checked before each turn. */
  shouldStop?: () => boolean;
}

/** Why a conversational reply burst ended.
 *  - no_more_mentions: last reply addressed the user (no teammate @mention) → wait for user
 *  - cap_reached: hit the per-message AI-turn cap
 *  - stopped: external Stop / abort */
export type BurstEndReason = "no_more_mentions" | "cap_reached" | "stopped";

export interface BurstResult {
  reason: BurstEndReason;
  turns: number;
  costUsd: number;
}
