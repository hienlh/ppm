/**
 * The Assistant's sessions in Settings, and the control that starts a new one.
 *
 * A tap opens the session in the Assistant (a session other than the main one shows the
 * one-off banner there); the row's menu sets it as the main session, puts it on Telegram while
 * the bridge is on and a chat is connected (one item per chat when there are several), or
 * deletes it after a confirmation.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus } from "@/lib/icons";
import { useAssistantTelegramBinding, type AssistantTelegramChat } from "@/hooks/use-assistant-telegram-binding";
import { ASSISTANT_PROVIDER_IDS } from "@/lib/assistant-deep-link";
import type { ChatProviderInfo } from "@/lib/chat-preparation-cache";
import { AssistantSessionRow, ProviderLogo } from "./assistant-session-row";
import { ConfirmDialog } from "./assistant-settings-dialog";
import { MANAGER_PROVIDER_ID } from "../../../../shared/assistant-managers";
import type { SessionInfo } from "../../../../types/chat";

/** One "New" button per configured provider, so the choice is made by the press itself. */
export function AssistantNewSession({ providers, onNew }: {
  providers: ChatProviderInfo[];
  onNew: (providerId: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {providers.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onNew(p.id)}
          className="flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-surface-elevated active:bg-surface-elevated md:min-h-8 md:text-xs"
          aria-label={`New Assistant session with ${p.name}`}
        >
          <Plus className="size-4 md:size-3.5" />
          <ProviderLogo providerId={p.id} className="size-4 md:size-3.5" />
          <span className="truncate">{providers.length > 1 ? p.name : "New session"}</span>
        </button>
      ))}
    </div>
  );
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AssistantSessionList({ sessions, mainSessionId, onOpen, onSetMain, onDelete }: {
  sessions: SessionInfo[];
  mainSessionId: string | null;
  onOpen: (session: SessionInfo) => void;
  onSetMain: (session: SessionInfo) => void;
  onDelete: (session: SessionInfo) => void;
}) {
  const rows = useMemo(() => sessions.filter((s) => ASSISTANT_PROVIDER_IDS.includes(s.providerId)), [sessions]);
  const telegram = useAssistantTelegramBinding();
  const [deleting, setDeleting] = useState<SessionInfo | null>(null);
  if (rows.length === 0) {
    return <p className="px-3 py-4 text-center text-sm text-text-subtle md:text-xs">No Assistant sessions yet.</p>;
  }
  const putOnTelegram = async (session: SessionInfo, chat: AssistantTelegramChat) => {
    try {
      await telegram.bind(session.id, chat.chatId);
      toast.success(`${chat.name} now talks to this session`);
    } catch (e) {
      toast.error("Could not use this session on Telegram", { description: errorText(e) });
    }
  };
  return (
    <>
      <ul className="flex flex-col py-1" aria-label="Assistant sessions">
        {rows.map((s) => (
          <AssistantSessionRow
            key={s.id}
            session={s}
            isMain={s.id === mainSessionId}
            canBeMain={s.providerId === MANAGER_PROVIDER_ID}
            onOpen={onOpen}
            onSetMain={onSetMain}
            onDelete={setDeleting}
            boundChats={telegram.chatsOn(s.id)}
            bindableChats={telegram.bindableChats}
            onUseOnTelegram={(chat) => void putOnTelegram(s, chat)}
          />
        ))}
      </ul>
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this session?"
        confirmLabel="Delete"
        destructive
        onClose={() => setDeleting(null)}
        onConfirm={() => { if (deleting) onDelete(deleting); setDeleting(null); }}
      >
        “{deleting?.title || "Untitled session"}” and its history are deleted. This cannot be undone.
        {deleting?.id === mainSessionId && " It is the main session, so Telegram has no session to follow until you pick another."}
      </ConfirmDialog>
    </>
  );
}
