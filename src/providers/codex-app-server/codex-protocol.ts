/**
 * Hand-authored subset of the codex app-server JSON-RPC protocol.
 *
 * Mirrors only the ~handful of shapes PPM uses, transcribed from the upstream
 * ts-rs bindings (`@openai/codex` app-server v2). The full generated set is 86
 * files; we keep this curated subset and verify drift via a `--version` log +
 * smoke test rather than vendoring the generated tree.
 */

// ── Enums ──
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type AskForApproval = "untrusted" | "on-failure" | "on-request" | "never";

// ── Handshake ──
export interface InitializeParams {
  clientInfo: { name: string; title?: string; version: string };
  capabilities: {
    experimentalApi: boolean;
    requestAttestation: boolean;
    optOutNotificationMethods: string[] | null;
  };
}

export interface ThreadStartParams {
  cwd?: string;
  sandbox?: SandboxMode;
  approvalPolicy?: AskForApproval;
  model?: string;
}

export interface ThreadResumeParams {
  threadId: string;
  cwd?: string;
  sandbox?: SandboxMode;
  approvalPolicy?: AskForApproval;
  model?: string;
}

/** thread/started notification + thread/start response both carry a Thread. */
export interface Thread {
  id: string;
  cwd?: string;
  [k: string]: unknown;
}

// ── Turn input ──
export type UserInput =
  | { type: "text"; text: string; text_elements: unknown[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  approvalPolicy?: AskForApproval;
  sandboxPolicy?: unknown;
  model?: string;
}

// ── Decisions (approval responses) ──
export type CommandExecutionApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
/** Legacy execCommandApproval / applyPatchApproval. */
export type ReviewDecision = "approved" | "approved_for_session" | "denied" | "abort";

// ── requestUserInput response ──
export interface ToolRequestUserInputAnswer {
  answers: string[];
}
export interface ToolRequestUserInputResponse {
  answers: Record<string, ToolRequestUserInputAnswer>;
}

// ── Model list ──
export interface CodexModel {
  id: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
}
export interface ModelListParams {
  cursor?: string | null;
  limit?: number | null;
  includeHidden?: boolean | null;
}
export interface ModelListResponse {
  data: CodexModel[];
  nextCursor: string | null;
}

// ── JSON-RPC envelopes ──
export interface JsonRpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}
export interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
}
/** Server→client request (approvals / user input). Carries id + method. */
export interface ServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}
