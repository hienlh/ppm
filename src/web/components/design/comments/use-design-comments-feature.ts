import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { deliverToDesignChat, showDesignChat } from "@/lib/design/deliver-to-design-chat";
import { designElementContext } from "@/lib/design/api-design-comments";
import { buildCommentsPrompt } from "@/lib/design/design-comments-prompt";
import type { DesignTabContextValue } from "../design-tab-context";
import type { DesignBridge } from "../canvas/use-design-bridge";
import type { PickedElement } from "../../../../shared/design-bridge-messages-picker";
import type { DesignComment } from "../../../../shared/design-comment-types";
import { useDesignComments } from "./use-design-comments";
import { anchorFromPicked, useElementPicker } from "./use-element-picker";
import { useCommentPins } from "./use-comment-pins";
import type { ComposerTarget } from "./comment-composer";
import type { SendPreview } from "./comments-send-preview";
import type { ThreadActions } from "./comment-thread-view";

/**
 * Pinned comments for one design tab: the list, the picker, the pins, and the flows that
 * join them — comment on an element, open a thread (in the panel, in place of the list),
 * reply to it, and "Send to AI".
 *
 * Sending never sends. It builds the message, shows it whole in the preview, and only on
 * confirmation puts it in the design chat's composer, where the user sends it (or not).
 * On a phone that means switching to the chat pane first, so the attachment lands in a
 * composer the user can actually see and focus.
 */

type Composer = { mode: "create" | "send"; el: PickedElement };

/** Two frames: the pane switch has to be rendered before the composer can take focus. */
const afterPaint = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

const failed = (what: string) => (e: unknown) => toast.error(what, { description: (e as Error).message });

export function useDesignCommentsFeature(tab: DesignTabContextValue, bridge: DesignBridge, opts: { onPanelOpen: () => void }) {
  const { projectName, slug, tabId, isMobile } = tab;
  const state = useDesignComments(projectName, slug);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [thread, setThread] = useState<{ id: string; focusReply: boolean } | null>(null);
  const picker = useElementPicker(bridge, (el) => setComposer({ mode: "create", el }));
  const pins = useCommentPins(bridge, state.open, state.update);
  const onPanelOpen = useRef(opts.onPanelOpen);
  onPanelOpen.current = opts.onPanelOpen;

  const togglePanel = useCallback(() => {
    if (!panelOpen) onPanelOpen.current();
    else setThread(null);
    setPanelOpen(!panelOpen);
  }, [panelOpen]);
  const closePanel = useCallback(() => { setPanelOpen(false); setThread(null); }, []);
  const openThread = useCallback((c: Pick<DesignComment, "id">, focusReply = false) => {
    setThread({ id: c.id, focusReply });
    if (!panelOpen) onPanelOpen.current();
    setPanelOpen(true);
  }, [panelOpen]);

  const composerTarget = useMemo<ComposerTarget | null>(() => {
    if (!composer) return null;
    return { mode: composer.mode, tag: composer.el.tag, text: composer.el.text, markup: composer.el.outerHtml };
  }, [composer]);

  const submitComposer = useCallback(async (body: string) => {
    if (!composer) return;
    if (composer.mode === "create") {
      await state.add(anchorFromPicked(composer.el), body);
      picker.clear();
      toast.success("Comment added");
    } else {
      const anchor = anchorFromPicked(composer.el);
      // The snippet comes from the server, out of the source file, never from the page.
      const ctx = await designElementContext(projectName, slug, anchor);
      const text = buildCommentsPrompt(slug, [{ file: anchor.file, anchor: { ...anchor, quote: ctx.quote }, body, snippet: ctx.snippet }]);
      setPreview({ text, label: `Design element <${anchor.tag}>`, ids: [] });
    }
    setComposer(null);
  }, [composer, state, picker, projectName, slug]);

  const sendComments = useCallback((list: readonly DesignComment[]) => {
    if (list.length === 0) return;
    setPreview({
      text: buildCommentsPrompt(slug, list),
      label: list.length === 1 ? "Design comment" : `Design comments (${list.length})`,
      ids: list.map((c) => c.id),
    });
  }, [slug]);

  const confirmPreview = useCallback(async (text: string) => {
    const p = preview;
    if (!p || !text.trim()) return;
    setPreview(null);
    if (isMobile) {
      // Sheets are portalled, so they would stay over the chat pane.
      setPanelOpen(false);
      showDesignChat(tabId);
      await afterPaint();
    }
    deliverToDesignChat(tabId, text, p.label);
    const results = await Promise.allSettled(p.ids.map((id) => state.update(id, { sent: true })));
    if (results.some((r) => r.status === "rejected")) toast.warning("The message is in the chat, but some comments could not be marked as sent");
  }, [preview, isMobile, tabId, state]);

  const resolveComment = (c: Pick<DesignComment, "id">, resolved = true) => {
    state.update(c.id, { resolved }).catch(failed("Could not update the comment"));
  };
  const deleteComment = (c: Pick<DesignComment, "id">) => {
    state.remove(c.id).then(() => setThread((t) => (t?.id === c.id ? null : t))).catch(failed("Could not delete the comment"));
  };
  const threadActions = (id: string): ThreadActions => ({
    onBack: () => setThread(null),
    onEditBody: async (body) => { await state.update(id, { body }); },
    onResolve: (resolved) => resolveComment({ id }, resolved),
    onSend: () => { const c = state.comments?.find((x) => x.id === id); if (c) sendComments([c]); },
    onDelete: () => deleteComment({ id }),
    onDeleteLinkThreads: (linkId) => state.removeLinkThreads(linkId),
    onReply: async (body) => { await state.reply(id, body); },
    onEditReply: async (replyId, body) => { await state.editReply(id, replyId, body); },
    onDeleteReply: (replyId) => state.removeReply(id, replyId),
  });

  return {
    state, picker, pins, panelOpen, togglePanel, closePanel,
    thread: thread ? { ...thread, actions: threadActions(thread.id) } : null,
    composerTarget, closeComposer: () => setComposer(null), submitComposer,
    preview, cancelPreview: () => setPreview(null), confirmPreview: (text: string) => { void confirmPreview(text).catch(failed("Could not put the message in the chat")); },
    openCount: state.open.length,
    commentOnSelected: () => { if (picker.selected) setComposer({ mode: "create", el: picker.selected }); },
    sendSelected: () => { if (picker.selected) setComposer({ mode: "send", el: picker.selected }); },
    openComment: (c: Pick<DesignComment, "id">) => openThread(c),
    replyToComment: (c: Pick<DesignComment, "id">) => openThread(c, true),
    resolveComment,
    deleteComment,
    sendComment: (c: DesignComment) => sendComments([c]),
    sendAllOpen: () => sendComments(state.open),
  };
}

export type DesignCommentsFeature = ReturnType<typeof useDesignCommentsFeature>;
