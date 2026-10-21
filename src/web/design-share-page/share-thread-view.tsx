import { ChevronLeft } from "@/lib/icons";
import type { PinStatus } from "../components/design/comments/use-comment-pins";
import { pinStatusText, rootDelete, type GuestThread } from "./share-thread-model";
import { ShareEntry } from "./share-entry";
import { ShareTextForm, type NameControl } from "./share-composer";
import type { ShareActions } from "./use-share-session";
import { buttonQuiet } from "./share-ui";

/**
 * One thread: its pin number and where the pin stands, the comment, every reply oldest
 * first, and the reply box. A resolved thread reads the same with a note that it is done.
 */

export function ShareThreadView({ thread, number, status, names, actions, onBack, onDeleted }: {
  thread: GuestThread;
  number: number | null;
  status: PinStatus;
  names: NameControl;
  actions: ShareActions;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const note = pinStatusText(status, number, !!thread.resolvedAt);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <button type="button" className={buttonQuiet} onClick={onBack}>
          <ChevronLeft className="size-5" /> All comments
        </button>
        {note && <span className="ml-auto truncate pr-2 text-xs text-text-3">{note}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        <ShareEntry
          author={thread.author} createdAt={thread.createdAt} updatedAt={thread.updatedAt} body={thread.body} mine={thread.mine}
          deleteRule={rootDelete(thread)}
          onEdit={thread.mine ? (body) => actions.editThread(thread.id, body) : undefined}
          onDelete={thread.mine ? async () => { const ok = await actions.deleteThread(thread.id); if (ok) onDeleted(); return ok; } : undefined}
        />
        {thread.replies.length > 0 && (
          <ol className="mt-3 flex flex-col gap-3 border-l-2 border-border pl-3" aria-label="Replies">
            {thread.replies.map((r) => (
              <li key={r.id}>
                <ShareEntry
                  author={r.author} createdAt={r.createdAt} updatedAt={r.updatedAt} body={r.body} mine={r.mine}
                  onEdit={r.mine ? (body) => actions.editReply(thread.id, r.id, body) : undefined}
                  onDelete={r.mine ? () => actions.deleteReply(thread.id, r.id) : undefined}
                />
              </li>
            ))}
          </ol>
        )}
      </div>
      {!thread.resolvedAt && (
        <div className="shrink-0 border-t border-border p-3">
          <ShareTextForm names={names} submitLabel="Reply" placeholder="Reply to this thread" compact
            onSubmit={(body, name) => actions.reply(thread.id, body, name)} />
        </div>
      )}
    </div>
  );
}
