/**
 * How much of a turn the chat shows, Claude Code's transcript view modes (Ctrl+O cycles them):
 * - normal: thinking folds away once it is done, tool cards stay one line unless they are a diff;
 * - thinking: every thinking block stays open;
 * - verbose: thinking open and every tool card expanded.
 * Per device, like the rest of how a screen is laid out.
 */
import { create } from "zustand";

export type ChatViewMode = "normal" | "thinking" | "verbose";
export const CHAT_VIEW_MODES: readonly ChatViewMode[] = ["normal", "thinking", "verbose"];
export const CHAT_VIEW_MODE_LABELS: Record<ChatViewMode, string> = { normal: "Normal", thinking: "Thinking", verbose: "Verbose" };
const KEY = "ppm.chat.viewMode";

function stored(): ChatViewMode {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v === "thinking" || v === "verbose" ? v : "normal";
  } catch {
    return "normal";
  }
}

interface ChatViewModeState {
  mode: ChatViewMode;
  setMode: (mode: ChatViewMode) => void;
  /** Normal → Thinking → Verbose → Normal. */
  cycle: () => void;
}

export const useChatViewMode = create<ChatViewModeState>((set, get) => ({
  mode: stored(),
  setMode: (mode) => {
    try { globalThis.localStorage?.setItem(KEY, mode); } catch { /* private mode: this session only */ }
    set({ mode });
  },
  cycle: () => {
    const at = CHAT_VIEW_MODES.indexOf(get().mode);
    get().setMode(CHAT_VIEW_MODES[(at + 1) % CHAT_VIEW_MODES.length]!);
  },
}));
