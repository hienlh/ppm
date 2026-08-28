import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useBlobUrl } from "@/hooks/use-blob-url";
import { useImageOverlay } from "@/stores/image-overlay-store";
import { useTabStore } from "@/stores/tab-store";
import { copyToClipboard } from "@/lib/clipboard";
import { basename } from "@/lib/utils";
import { ImagePreviewFailure, ImagePreviewSkeleton } from "./image-preview-states";
import {
  cacheNatural,
  dimensionsLabel,
  formatBytes,
  getCachedNatural,
  previewLayout,
  TILE_WIDTH,
  type NaturalSize,
} from "./image-preview-geometry";

/** Ratio the skeleton assumes before the image has ever been measured. */
const FALLBACK_ASPECT = 4 / 5;

const LABEL = "text-[var(--img-meta-label)] @max-[470px]:hidden";
const VALUE = "truncate text-text @max-[470px]:text-text-2";
const GHOST =
  "h-[30px] @max-[470px]:h-[36px] shrink-0 rounded-[7px] px-[9px] font-mono text-[11.5px] " +
  "text-text-2 bg-[var(--img-ghost)] border border-[var(--img-ghost-border)] backdrop-blur-[6px] " +
  "transition-colors can-hover:hover:bg-[var(--img-ghost-hover)] " +
  "can-hover:hover:border-[var(--img-ghost-hover-border)] can-hover:hover:text-text";

/**
 * The image a Read call opened, shown on a stage lit by a blurred copy of itself, beside
 * the file facts needed to decide whether to open it. Fetched as a blob with an
 * Authorization header, so no auth token ends up in an image URL.
 */
export function ToolImagePreview({
  filePath,
  projectName,
}: {
  filePath: string;
  projectName: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const { blobUrl, blob, error, errorCode } = useBlobUrl(filePath, projectName, undefined, attempt);
  const [natural, setNatural] = useState<NaturalSize | undefined>(() => getCachedNatural(filePath));
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const openOverlay = useImageOverlay((s) => s.open);
  const { openTab } = useTabStore(useShallow((s) => ({ openTab: s.openTab })));
  const name = basename(filePath);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  const measure = (img: HTMLImageElement) => {
    const size = { w: img.naturalWidth, h: img.naturalHeight };
    if (!size.w || !size.h) return setDecodeFailed(true);
    cacheNatural(filePath, size);
    setNatural(size);
  };

  const retry = () => {
    setDecodeFailed(false);
    setAttempt((n) => n + 1);
  };

  if (error || decodeFailed) {
    return (
      <div className="border-t border-border pt-1.5">
        <ImagePreviewFailure code={decodeFailed ? undefined : errorCode ?? undefined} onRetry={retry} />
      </div>
    );
  }

  const layout = natural ? previewLayout(natural, TILE_WIDTH) : null;
  const skeletonAspect = layout?.aspect ?? FALLBACK_ASPECT;

  const actions = (
    <div className="flex flex-wrap gap-[6px]">
      <button type="button" onClick={openInEditor} className={GHOST}>
        <span className="@max-[470px]:hidden">open in editor</span>
        <span className="hidden @max-[470px]:inline">open</span>
      </button>
      <button type="button" onClick={copyPath} className={GHOST}>
        {copied ? "copied" : "copy path"}
      </button>
      <button type="button" onClick={openFull} className={GHOST}>
        full size
      </button>
    </div>
  );

  function openInEditor() {
    if (!projectName) return;
    openTab({
      type: "editor",
      title: name,
      metadata: { filePath, projectName },
      projectId: projectName,
      closable: true,
    });
  }

  function copyPath() {
    void copyToClipboard(filePath).then(() => setCopied(true));
  }

  function openFull() {
    if (blobUrl) openOverlay(blobUrl, name);
  }

  // Loading: the same box as the loaded state, so the transcript never shifts under the
  // reader once the image resolves.
  if (!blobUrl || !layout || !natural) {
    return (
      <div className="@container border-t border-border pt-1.5">
        {blobUrl && (
          <img
            src={blobUrl}
            alt=""
            className="hidden"
            onLoad={(e) => measure(e.currentTarget)}
            onError={() => setDecodeFailed(true)}
          />
        )}
        <ImagePreviewSkeleton aspect={skeletonAspect} actions={actions} />
      </div>
    );
  }

  const metadata = (
    <>
      <dt className={LABEL}>dimensions</dt>
      <dd className={VALUE}>{dimensionsLabel(natural, layout.fit)}</dd>
      {blob && (
        <>
          <dt className={LABEL}>size</dt>
          <dd className={VALUE}>
            {formatBytes(blob.size)}
            {blob.type ? ` · ${blob.type}` : ""}
          </dd>
        </>
      )}
      <dt className={LABEL}>path</dt>
      {/* rtl puts the ellipsis at the head of the path, keeping the filename readable */}
      <dd dir="rtl" className={`${VALUE} text-left`}>
        {filePath}
      </dd>
    </>
  );

  const picture = (
    <img
      src={blobUrl}
      alt={name}
      onLoad={(e) => measure(e.currentTarget)}
      onError={() => setDecodeFailed(true)}
      className={
        layout.fit === "cover"
          ? "size-full object-cover"
          : layout.fit === "contain"
            ? "size-full object-contain"
            : "max-h-full max-w-full"
      }
    />
  );

  return (
    <div className="@container border-t border-border pt-1.5">
      <div className="relative overflow-hidden rounded-lg border border-border p-[14px] @max-[470px]:p-[11px]">
        <img
          aria-hidden="true"
          alt=""
          src={blobUrl}
          className="absolute inset-0 size-full object-cover"
          style={{ filter: "var(--img-backdrop)", transform: "scale(1.3)" }}
        />
        <div className="absolute inset-0" style={{ background: "var(--img-veil)" }} />

        {layout.variant === "band" ? (
          <div className="relative grid gap-[11px]">
            <button
              type="button"
              onClick={openFull}
              title={`Open ${name}`}
              className="img-checkerboard w-full cursor-zoom-in overflow-hidden rounded-lg border border-[var(--img-plate-border)]"
              style={{ aspectRatio: layout.aspect }}
            >
              {picture}
            </button>
            <dl className="grid grid-cols-[auto_auto_1fr] gap-x-[18px] font-mono text-[11.5px] [&_dt]:hidden">
              {metadata}
            </dl>
            {actions}
          </div>
        ) : (
          <div className="relative grid grid-cols-[132px_1fr] items-start gap-[14px] @max-[470px]:grid-cols-[64px_1fr] @max-[470px]:gap-[11px]">
            <button
              type="button"
              onClick={openFull}
              title={`Open ${name}`}
              className={`cursor-zoom-in overflow-hidden rounded-lg border border-[var(--img-plate-border)] bg-[var(--img-plate)] shadow-[var(--img-plate-shadow)] ${
                layout.fit === "cover" ? "" : "img-checkerboard flex items-center justify-center"
              }`}
              style={{ aspectRatio: layout.aspect }}
            >
              {picture}
            </button>
            <div className="flex min-w-0 flex-col gap-[9px]">
              <p className="truncate text-[13px] font-semibold text-text @max-[470px]:hidden">
                {name}
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-[14px] gap-y-[4px] font-mono text-[11.5px] @max-[470px]:grid-cols-[1fr]">
                {metadata}
              </dl>
              {actions}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
