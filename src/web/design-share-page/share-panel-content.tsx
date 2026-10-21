import type { PickedElement } from "../../shared/design-bridge-messages-picker";
import type { PinStatus } from "../components/design/comments/use-comment-pins";
import type { GuestThread } from "./share-thread-model";
import type { NameControl } from "./share-composer";
import type { ShareActions } from "./use-share-session";
import { ShareComposer } from "./share-composer";
import { ShareNamePrompt } from "./share-name-prompt";
import { ShareThreadView } from "./share-thread-view";
import { ShareThreadsPanel } from "./share-threads-panel";

/**
 * What the comments column shows — the side panel on a desktop, the bottom sheet on a
 * phone: the list, one thread, the new-comment form for the element just chosen, or the
 * name form. The same content in both places, so the two layouts cannot drift apart.
 */

export type PanelView = { kind: "list" } | { kind: "thread"; id: string } | { kind: "compose" } | { kind: "name" };

export function SharePanelContent({ view, setView, threads, numbers, statusOf, names, actions, picked, expiryText, onCompose, onCancelCompose, onClose }: {
  view: PanelView;
  setView: (view: PanelView) => void;
  threads: { open: GuestThread[]; resolved: GuestThread[] };
  numbers: ReadonlyMap<string, number>;
  statusOf: (id: string) => PinStatus;
  names: NameControl;
  actions: ShareActions;
  picked: PickedElement | null;
  expiryText: string | null;
  onCompose: (el: PickedElement, body: string, name: string) => Promise<boolean>;
  onCancelCompose: () => void;
  onClose?: () => void;
}) {
  if (view.kind === "compose" && picked) {
    return <ShareComposer element={picked} names={names} onCancel={onCancelCompose} onSubmit={(body, name) => onCompose(picked, body, name)} />;
  }
  if (view.kind === "name") {
    return <ShareNamePrompt current={names.name} onSave={names.setName} onDone={() => setView({ kind: "list" })} />;
  }
  const toList = () => setView({ kind: "list" });
  if (view.kind === "thread") {
    const thread = threads.open.find((t) => t.id === view.id) ?? threads.resolved.find((t) => t.id === view.id);
    // A thread the owner deleted meanwhile is simply gone from the list.
    if (thread) {
      return (
        <ShareThreadView thread={thread} number={numbers.get(thread.id) ?? null} status={statusOf(thread.id)}
          names={names} actions={actions} onBack={toList} onDeleted={toList} />
      );
    }
  }
  return (
    <ShareThreadsPanel
      open={threads.open} resolved={threads.resolved} numbers={numbers} statusOf={statusOf}
      activeId={view.kind === "thread" ? view.id : null} name={names.name} expiryText={expiryText}
      onOpen={(id) => setView({ kind: "thread", id })} onChangeName={() => setView({ kind: "name" })} onClose={onClose}
    />
  );
}
