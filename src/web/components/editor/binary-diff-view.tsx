/**
 * The diff of a file the text editor cannot show.
 *
 * VS Code's behaviour, in three shapes. An image with two versions is drawn on
 * both sides; an image with *one* — added, or deleted — is drawn alone and full
 * width, because there is nothing to compare and a pane captioned "not in HEAD"
 * is chrome around an empty box; anything else gets the placeholder, since the
 * only honest thing to say about two blobs of bytes is that they are not text.
 *
 * Choosing the text editor is not the same as asking for the bytes. VS Code
 * answers that choice with the placeholder too, and only "Open Anyway" prints
 * the file — which is the point of the gate: a megabyte of U+FFFD is what you
 * get, and nobody means to ask for it twice. So `mode` decides which of the two
 * views is on, and the confirmation belongs to the caller.
 *
 * No store is imported on purpose. The decisions here are asserted by rendering
 * the component, and a zustand store reads localStorage at module scope, which
 * throws under bun:test.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, FileWarning, Loader2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { getAuthToken } from "@/lib/api-client";
import { extensionOf, IMAGE_EXTS } from "@/components/os-explorer/can-open-in-ppm";
import { formatBytes } from "@/components/chat/image-preview-geometry";

/** One version of the file — the left pane is a revision, the right usually the disk. */
export interface BinaryDiffSide {
  /** Where its bytes are; null when the file does not exist on this side. */
  url: string | null;
  /** What this version is called: "HEAD", a short hash, "Working Tree". */
  label: string;
  /** Null when the file does not exist on this side — an addition or a deletion. */
  size: number | null;
}

/** A side that exists, which is the only kind that can be drawn. */
type PresentSide = BinaryDiffSide & { url: string };

export type BinaryViewMode = "preview" | "text";

/** True when the versions are worth drawing rather than describing. */
export function canPreviewBinary(filePath: string): boolean {
  return IMAGE_EXTS.has(extensionOf(filePath));
}

/** A full hash is unreadable as a column header; anything else is already a name. */
export function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

/**
 * VS Code's "Reopen Editor With…", narrowed to the two editors that apply here.
 *
 * A native `<select>` rather than a dropdown: the design guidelines ask for one
 * on mobile, and it is the control `editor-language-picker` already uses. It is
 * offered only for a file that *has* both views — a woff2 has only the text one,
 * which is why the placeholder keeps its own button instead.
 */
export function BinaryViewSwitcher({
  mode,
  onChange,
}: {
  mode: BinaryViewMode;
  onChange: (mode: BinaryViewMode) => void;
}) {
  return (
    <select
      value={mode}
      onChange={(e) => onChange(e.target.value as BinaryViewMode)}
      title="Show this file as an image or as text"
      aria-label="Reopen editor with"
      className="h-11 rounded border border-border bg-transparent px-1 text-xs text-foreground outline-none md:h-6"
    >
      <option value="preview">Image Preview</option>
      <option value="text">Text Editor</option>
    </select>
  );
}

export function BinaryDiffView({
  filePath,
  mode,
  original,
  modified,
  onOpenAnyway,
}: {
  filePath: string;
  /** Which view the switcher is on; a file with no preview is always text. */
  mode: BinaryViewMode;
  original: BinaryDiffSide;
  modified: BinaryDiffSide;
  onOpenAnyway: () => void;
}) {
  if (mode === "text" || !canPreviewBinary(filePath)) {
    return <BinaryPlaceholder onOpenAnyway={onOpenAnyway} />;
  }

  const present = [original, modified].filter((s): s is PresentSide => s.url !== null);
  if (present.length < 2) {
    const only = present[0];
    // Neither side exists only if the file is gone from both, which leaves
    // nothing to draw — the placeholder is then the honest answer.
    return only ? <ImageSide side={only} /> : <BinaryPlaceholder onOpenAnyway={onOpenAnyway} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <ImageSide side={present[0]!} />
      <div className="shrink-0 border-b border-border md:border-b-0 md:border-r" />
      <ImageSide side={present[1]!} />
    </div>
  );
}

function BinaryPlaceholder({ onOpenAnyway }: { onOpenAnyway: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <AlertTriangle className="size-10 text-warning" />
      <p className="max-w-md text-sm leading-relaxed text-text-secondary">
        The file is not displayed in the text editor because it is either binary or uses an
        unsupported text encoding.
      </p>
      {/* `mt-auto` drops the button into the thumb zone on a phone — an auto
          margin eats the free space the centring would have split — and `md:mt-0`
          hands it back to the centred group on a desktop. */}
      <Button onClick={onOpenAnyway} className="mt-auto h-11 w-full max-w-xs md:mt-0 md:w-auto md:px-5">
        Open Anyway
      </Button>
    </div>
  );
}

function ImageSide({ side }: { side: PresentSide }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="truncate text-xs font-medium text-text-secondary">{side.label}</span>
        {side.size !== null && (
          <span className="shrink-0 text-xs text-text-subtle">{formatBytes(side.size)}</span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface p-4">
        <BlobImage url={side.url} />
      </div>
    </div>
  );
}

function BlobImage({ url }: { url: string }) {
  const { blobUrl, failed } = useAuthedBlob(url);

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-2 text-text-subtle">
        <FileWarning className="size-8" />
        <p className="text-xs">Failed to load.</p>
      </div>
    );
  }
  if (!blobUrl) return <Loader2 className="size-5 animate-spin text-text-subtle" />;
  return <img src={blobUrl} alt="" className="max-h-full max-w-full object-contain" />;
}

/**
 * The bytes at `url`, as a blob URL.
 *
 * `useBlobUrl` cannot serve this: it builds its own `/files/raw` URL from a
 * project-relative path, and one of these panes is a *revision*, which only
 * `/git/file-blob` can answer. An `<img src>` carries no Authorization header
 * either, so the fetch happens here and the element gets a blob URL. The old
 * URL is revoked only once the new one exists — revoking one still on screen
 * renders a broken image with no error anywhere.
 */
function useAuthedBlob(url: string) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    const token = getAuthToken();
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = next;
        setBlobUrl(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  return { blobUrl, failed };
}
