import type { FrameFit, Size } from "../canvas/canvas-geometry";
import type { DesignCommentsFeature } from "./use-design-comments-feature";
import { CommentPinsOverlay } from "./comment-pins-overlay";
import { ElementActionBar } from "./element-action-bar";
import { CommentComposer } from "./comment-composer";
import { CommentsSendPreview } from "./comments-send-preview";
import { CommentsPanel } from "./comments-panel";

/**
 * Where the comment feature draws. {@link DesignCommentsOverlay} goes inside the canvas
 * stage (pins, the element action bar, and the composer and preview dialogs, which portal
 * out anyway); {@link DesignCommentsSidePanel} is the list, which the canvas pane places
 * beside the stage on desktop and in a bottom sheet on a phone.
 */

export function DesignCommentsOverlay({ feature, fit, stage, isMobile, selectionHint }: {
  feature: DesignCommentsFeature;
  fit: FrameFit;
  stage: Size;
  isMobile: boolean;
  /** A note about the selected element from another canvas mode (e.g. why it cannot be moved). */
  selectionHint?: string | null;
}) {
  return (
    <>
      <CommentPinsOverlay
        open={feature.state.open}
        pins={feature.pins}
        fit={fit}
        stage={stage}
        actions={{
          onOpen: feature.openComment,
          onResolve: (c) => feature.resolveComment(c, true),
          onSend: feature.sendComment,
          onDelete: feature.deleteComment,
        }}
      />
      <ElementActionBar
        picker={feature.picker}
        isMobile={isMobile}
        fit={fit}
        stage={stage}
        onComment={feature.commentOnSelected}
        onSend={feature.sendSelected}
        hint={selectionHint}
      />
      <CommentComposer
        target={feature.composerTarget}
        onClose={feature.closeComposer}
        onSubmit={feature.submitComposer}
        onDelete={feature.deleteFromComposer}
      />
      <CommentsSendPreview preview={feature.preview} onCancel={feature.cancelPreview} onConfirm={feature.confirmPreview} />
    </>
  );
}

export function DesignCommentsSidePanel({ feature }: { feature: DesignCommentsFeature }) {
  return (
    <CommentsPanel
      state={feature.state}
      statusOf={feature.pins.statusOf}
      actions={{
        onOpen: feature.openComment,
        onResolve: feature.resolveComment,
        onSend: feature.sendComment,
        onDelete: feature.deleteComment,
        onSendAll: feature.sendAllOpen,
        onClose: feature.closePanel,
      }}
    />
  );
}
