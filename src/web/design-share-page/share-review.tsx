import { useCallback, useEffect, useMemo, useState } from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { DesignShareGuestInfo } from "../../shared/design-share-guest-types";
import type { PickedElement } from "../../shared/design-bridge-messages-picker";
import { defaultFrameFor, framePreset, type DeviceFrameId } from "../components/design/canvas/device-frame-presets";
import { useCommentPins } from "../components/design/comments/use-comment-pins";
import { anchorFromPicked, useElementPicker } from "../components/design/comments/use-element-picker";
import { useShareCanvas } from "./use-share-canvas";
import { useShareSession } from "./use-share-session";
import { asPinComments, groupThreads, pinNumbers } from "./share-thread-model";
import { ShareCanvas } from "./share-canvas";
import { ShareBottomBar, ShareToolbar } from "./share-toolbar";
import { SharePanelContent, type PanelView } from "./share-panel-content";
import { ShareBottomSheet } from "./share-bottom-sheet";
import { ShareNotice, ShareInvalid, ShareUpdatedBar } from "./share-states";
import { formatDate } from "./share-ui";

/**
 * A reviewer's view of one shared version: the design, its pins, and the threads beside it
 * (desktop) or in a bottom sheet (phone). Choosing an element is the canvas's own picker
 * gesture — on touch, a first tap outlines and a second tap (or a long-press) chooses — and
 * choosing opens the new-comment form for it.
 */
export function ShareReview({ info, code }: { info: DesignShareGuestInfo; code: string }) {
  const session = useShareSession(info, code);
  const isMobile = useIsMobile();
  const [file, setFile] = useState(info.entry);
  const [frame, setFrame] = useState<DeviceFrameId>(() => defaultFrameFor(info.kind));
  const [view, setView] = useState<PanelView>({ kind: "list" });
  const [panelOpen, setPanelOpen] = useState(() => !isMobile);
  const canvas = useShareCanvas(code, info.slug, file);

  const threads = useMemo(() => groupThreads(session.threads), [session.threads]);
  const numbers = useMemo(() => pinNumbers(threads.open), [threads.open]);
  const pinComments = useMemo(() => asPinComments(threads.open), [threads.open]);
  // A reviewer proposes no writes: a pin the frame found again by its text is shown where it
  // was found, and nothing is sent anywhere.
  const acceptLocally = useCallback(async (id: string) => {
    const found = pinComments.find((c) => c.id === id);
    if (!found) throw new Error("Not a pin on this page");
    return found;
  }, [pinComments]);
  const pins = useCommentPins(canvas.bridge, pinComments, acceptLocally);
  const picker = useElementPicker(canvas.bridge, () => {});
  const { clear: clearPick, setOn: setPicking } = picker;

  // Choosing an element opens the form for it; nothing else needs choosing on this page.
  useEffect(() => {
    if (!picker.selected) return;
    setView({ kind: "compose" });
    setPanelOpen(true);
  }, [picker.selected]);

  const openThread = useCallback((id: string) => {
    const thread = session.threads.find((t) => t.id === id);
    if (thread && thread.file !== file && info.variants.some((v) => v.file === thread.file)) setFile(thread.file);
    setView({ kind: "thread", id });
    setPanelOpen(true);
  }, [session.threads, file, info.variants]);

  const cancelCompose = useCallback(() => { clearPick(); setView({ kind: "list" }); }, [clearPick]);
  const compose = useCallback((el: PickedElement, body: string, name: string) =>
    session.actions.addThread(anchorFromPicked(el), body, name, (t) => {
      setPicking(false);
      setView({ kind: "thread", id: t.id });
    }), [session.actions, setPicking]);

  const closeSheet = useCallback(() => {
    if (view.kind === "compose") clearPick();
    setPanelOpen(false);
    setView({ kind: "list" });
  }, [view.kind, clearPick]);

  if (session.invalid) return <ShareInvalid />;

  const expiryText = info.expiresAt === null ? null : `Link expires on ${formatDate(info.expiresAt)}`;
  const subtitle = [`Shared version from ${formatDate(info.versionCreatedAt)}`, expiryText].filter(Boolean).join(" · ");
  const shownFrame = isMobile ? defaultFrameFor(info.kind) : frame;
  const names = { name: session.name, setName: session.setName };
  const content = (onClose?: () => void) => (
    <SharePanelContent view={view} setView={setView} threads={threads} numbers={numbers} statusOf={pins.statusOf}
      names={names} actions={session.actions} picked={picker.selected} expiryText={expiryText}
      onCompose={compose} onCancelCompose={cancelCompose} onClose={onClose} />
  );
  const activeId = view.kind === "thread" ? view.id : null;
  // Below the header on a desktop. On a phone, just above the bottom bar, in thumb reach, or
  // at the top of the comments sheet while that is open, since the sheet covers the rest.
  const updatedBar = session.versionChanged ? <ShareUpdatedBar onReload={() => window.location.reload()} /> : null;

  return (
    <div className="flex h-dvh flex-col bg-bg text-text">
      {isMobile ? (
        <header className="shrink-0 border-b border-border bg-panel px-4 pb-1.5 pt-[max(0.375rem,env(safe-area-inset-top))]">
          <h1 className="truncate text-sm font-semibold">{info.title}</h1>
          <p className="truncate text-xs text-text-3">{subtitle}</p>
        </header>
      ) : (
        <ShareToolbar title={info.title} subtitle={subtitle} variants={info.variants} file={file} onVariant={setFile}
          frame={frame} onFrame={setFrame} picking={picker.on} onPicking={setPicking}
          panelOpen={panelOpen} onPanel={setPanelOpen} count={threads.open.length} />
      )}
      {!isMobile && updatedBar}
      <div className="flex min-h-0 flex-1">
        <ShareCanvas canvas={canvas} title={info.title} frameSize={framePreset(shownFrame).size} picker={picker} pins={pins}
          open={threads.open} numbers={numbers} activeId={activeId} onOpenThread={openThread} isMobile={isMobile} />
        {!isMobile && panelOpen && (
          <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-panel lg:w-96" aria-label="Comments">
            {content(() => setPanelOpen(false))}
          </aside>
        )}
      </div>
      {session.notice && <ShareNotice key={session.notice.id} message={session.notice.message} onDismiss={session.dismissNotice} top={isMobile} />}
      {isMobile && (
        <>
          {!panelOpen && updatedBar}
          <ShareBottomBar variants={info.variants} file={file} onVariant={setFile} picking={picker.on} onPicking={setPicking}
            onComments={() => { setView({ kind: "list" }); setPanelOpen(true); }} count={threads.open.length} />
          <ShareBottomSheet open={panelOpen} onClose={closeSheet} label="Comments">{updatedBar}{content(closeSheet)}</ShareBottomSheet>
        </>
      )}
    </div>
  );
}
