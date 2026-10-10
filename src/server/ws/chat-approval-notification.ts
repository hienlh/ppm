import { chatService } from "../../services/chat.service.ts";
import { getSessionUnreadCount, incrementSessionUnread } from "../../services/db.service.ts";
import { describeApprovalInput } from "../../services/notification-format.ts";
import { broadcastGlobalEvent } from "./global.ts";
import type { PendingApprovalEvent } from "./chat-pending-approval.ts";
import { isNotificationSuppressed } from "../../services/chat-control/notification-suppressor.ts";

/**
 * What every device learns when a chat starts waiting on an approval card — a provider's or the
 * PPM Assistant endpoint's alike: the session is marked unread (with the card's kind) on every
 * tab strip, and a notification goes out unless the card is gone or seen before it would be sent.
 */
export function announceApprovalRequest(
  sessionId: string,
  session: { projectName?: string; providerId: string },
  ev: PendingApprovalEvent,
  /** Whether this card is still the one the session shows. */
  stillShown: () => boolean,
): void {
  const isQuestion = ev.tool === "AskUserQuestion";
  const nType = isQuestion ? "question" : "approval_request";
  const projectName = session.projectName || "";
  const title = chatService.getSession(sessionId)?.title;
  incrementSessionUnread(sessionId, nType, title, projectName || null);
  broadcastGlobalEvent({ type: "session:unread_changed", sessionId, unreadCount: -1, unreadType: nType, projectName, sessionTitle: title || null });

  // Held back when the user is being shown the card another way (on Telegram); the unread mark
  // above stays, since it is what tells every PPM screen where to look.
  if (isNotificationSuppressed(sessionId, "approval")) return;
  import("../../services/notification.service.ts").then(({ notificationService }) => {
    const project = projectName || "Project";
    const sTitle = chatService.getSession(sessionId)?.title || `Session ${sessionId.slice(0, 8)}`;
    // An endpoint card's server-built headline says what will happen better than its raw input.
    const detail = ev.summary
      ? { detail: ev.summary.headline, detailStyle: "quote" as const }
      : describeApprovalInput(ev.tool, ev.input);
    notificationService.broadcast(nType, {
      title: isQuestion ? "AI has a question" : "Waiting for approval",
      body: isQuestion ? `${project} — ${sTitle}` : `${project} — ${ev.tool} needs permission`,
      project: projectName, sessionId, providerId: session.providerId, sessionTitle: sTitle, tool: ev.tool,
      ...detail,
    }, {
      // Answered, or looked at, on any device since — either way it needs no alert.
      stillUnseen: () => stillShown() && getSessionUnreadCount(sessionId) > 0,
    });
  }).catch(() => {});
}
