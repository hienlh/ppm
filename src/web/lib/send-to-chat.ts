import { usePanelStore } from "@/stores/panel-store";
import type { Tab } from "@/stores/tab-store";

/**
 * Deliver text (terminal output, and anything else worth quoting) to ONE chat:
 * the one the user last selected.
 *
 * The event is addressed with `targetTabId` because every chat tab stays mounted
 * — an unaddressed event is answered by all of them at once, so the same output
 * lands as an attachment in every open chat.
 */
export const SEND_TO_CHAT_EVENT = "ppm:send-to-chat";
export const SEND_TO_CHAT_ACK_EVENT = "ppm:send-to-chat:ack";

export interface SendToChatDetail {
  text: string;
  label?: string;
  projectName?: string | null;
  /** Only the chat tab with this id may consume the event. */
  targetTabId?: string;
}

/** Wall-clock activation stamp written by the panel store on every tab activation. */
function lastActiveAt(tab: Tab): number {
  return typeof tab.metadata?.lastActiveAt === "number" ? (tab.metadata.lastActiveAt as number) : -1;
}

/**
 * The chat tab the user last selected.
 *
 * Ranked, highest first:
 *  1. selected AND in the focused panel — with a split, the chat being worked in.
 *  2. selected — its panel's active tab, so it is a chat actually on screen. The
 *     activation stamp alone is not enough: a chat opened programmatically carries
 *     a fresh stamp the user never chose, and a chat left behind another tab in its
 *     panel keeps its stamp long after it stopped being the one in view.
 *  3. newest activation — the only ordering that compares across panels, and the
 *     answer when no chat is on screen at all.
 *
 * Chats of the given project always win over other projects' chats.
 */
export function resolveSelectedChatTabId(projectName?: string | null): string | null {
  const { panels, focusedPanelId } = usePanelStore.getState();

  const chats = Object.values(panels).flatMap((p) =>
    p.tabs
      .filter((t) => t.type === "chat")
      .map((t) => ({
        tab: t,
        selected: p.activeTabId === t.id,
        focusedPanel: p.id === focusedPanelId,
      })),
  );
  if (chats.length === 0) return null;

  const sameProject = projectName
    ? chats.filter((c) => c.tab.projectId === projectName || c.tab.metadata?.projectName === projectName)
    : [];
  const pool = sameProject.length > 0 ? sameProject : chats;

  // Panel focus only separates chats that are BOTH on screen. For chats nobody has
  // in view, the panel it happens to live in says nothing about which one the user
  // picked last — only the stamp does.
  const rank = (c: (typeof pool)[number]): [number, number] => [
    c.selected ? (c.focusedPanel ? 2 : 1) : 0,
    lastActiveAt(c.tab),
  ];
  const best = pool.reduce((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < ra.length; i++) {
      if (ra[i]! !== rb[i]!) return ra[i]! > rb[i]! ? a : b;
    }
    return a;
  });
  return best.tab.id;
}

/**
 * Send `text` to the chat the user last selected, as an attachment chip, focusing
 * that chat so the user sees it arrive.
 *
 * Falls back through: live tab answers the event → tab exists but is not mounted
 * yet, so hand the text over as `pendingMessage` → no chat open at all, open one.
 */
export function sendToChat(opts: { text: string; label?: string; projectName?: string | null }): void {
  const { text, label, projectName } = opts;
  if (!text.trim()) return;

  const targetTabId = resolveSelectedChatTabId(projectName);
  const store = usePanelStore.getState();

  if (targetTabId) {
    store.setActiveTab(targetTabId);

    let handled = false;
    const onAck = () => { handled = true; };
    window.addEventListener(SEND_TO_CHAT_ACK_EVENT, onAck);
    window.dispatchEvent(
      new CustomEvent<SendToChatDetail>(SEND_TO_CHAT_EVENT, { detail: { text, label, projectName, targetTabId } }),
    );
    window.removeEventListener(SEND_TO_CHAT_ACK_EVENT, onAck);
    if (handled) return;

    // Lazy-mounted tab: it has no listener yet, so leave the text in its metadata
    // for the composer to pick up on mount.
    const tab = Object.values(store.panels).flatMap((p) => p.tabs).find((t) => t.id === targetTabId);
    store.updateTab(targetTabId, { metadata: { ...tab?.metadata, pendingMessage: text } });
    return;
  }

  store.openTab({
    type: "chat",
    title: "Chat",
    projectId: null,
    metadata: { ...(projectName ? { projectName } : {}), pendingMessage: text },
    closable: true,
  });
}
