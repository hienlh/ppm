import { configService } from "../../services/config.service.ts";
import { getSessionDesignSlug, getSessionPermissionMode } from "../../services/db.service.ts";
import { isAssistantSession } from "../../services/assistant/assistant-session.ts";
import { VALID_PERMISSION_MODES } from "../../types/config.ts";
import type { ModeSource } from "../../services/assistant-mcp/assistant-approval-summary.ts";

/**
 * Which permission mode a chat message will actually run in — what an approval card for a
 * message the PPM Assistant wants to send has to state, and what the message must then run in.
 *
 * Both providers fix the mode for the life of a session's subprocess, so a chat whose
 * subprocess is running takes a new message in the mode that subprocess started in, whatever
 * the message asks for. Otherwise a new turn starts in the chat's saved mode, else the mode it
 * last ran in during this server's life, else the provider's configured default.
 */

/** A provider's configured default, as the provider itself falls back to it. */
export function providerDefaultMode(providerId: string): string {
  const configured = configService.get("ai")?.providers?.[providerId]?.permission_mode;
  return configured && (VALID_PERMISSION_MODES as readonly string[]).includes(configured) ? configured : "bypassPermissions";
}

/** The mode a turn started with `requested` runs in, resolved the way `chatService` resolves it. */
export function effectivePermissionMode(sessionId: string, providerId: string, requested?: string): string {
  if (isAssistantSession(sessionId)) return "default";
  if (requested) return requested;
  if (getSessionDesignSlug(sessionId)) {
    const stored = getSessionPermissionMode(sessionId);
    if (stored) return stored;
  }
  return providerDefaultMode(providerId);
}

/** What the chat socket layer knows about a chat right now. */
export interface ChatDeliveryState {
  providerId: string;
  /** A subprocess is running for the chat: a message joins it. */
  running: boolean;
  /** The mode that subprocess started in. */
  liveMode?: string;
  /** The mode the chat's latest message asked for, while its entry lives. */
  entryMode?: string;
  /** The chat is waiting on an approval card. */
  pendingApproval: boolean;
}

export type TargetModeSource = ModeSource;

export function targetChatMode(sessionId: string, state: ChatDeliveryState): { mode: string; source: TargetModeSource } {
  if (state.running && state.liveMode) return { mode: state.liveMode, source: "running" };
  const stored = getSessionPermissionMode(sessionId);
  if (stored) return { mode: stored, source: "stored" };
  if (state.entryMode) return { mode: state.entryMode, source: "live" };
  return { mode: providerDefaultMode(state.providerId), source: "provider-default" };
}
