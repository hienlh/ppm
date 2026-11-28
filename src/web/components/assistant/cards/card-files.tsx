import { Download, File, FileText, Image, Play } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { TEXT_BUTTON } from "@/lib/control-size";
import { useCardFileViewer } from "@/stores/card-file-viewer-store";
import { formatFileSize, type CardFile } from "../../../../shared/card-files";
import { cardFileUrl } from "./card-file-viewer";

/**
 * The files a manager put on a report card (`payload.files`): one row each with its name, size,
 * Open and Download. Open shows the original full screen (`card-file-viewer.tsx`, the same page a
 * Telegram card links to): a video streams with Range, so an 83 MB clip starts at once. A small
 * picture also shows a thumbnail on the card.
 *
 * Every byte comes from `/api/card-files/<id>` behind the login. `<img>`, `<video>` and a download
 * link cannot send the token as a header, so it rides in the query string on that one route,
 * which names an id PPM made, never a path. Download is answered as an attachment
 * (`?download=1`), so a browser that ignores `download` still never opens an HTML file as a page.
 */
export function CardFiles({ files }: { files?: CardFile[] }) {
  if (!files?.length) return null;
  return (
    <ul className="space-y-1.5" data-card-files>
      {files.map((file) => <CardFileRow key={file.id} file={file} />)}
    </ul>
  );
}

const KIND_ICON = { image: Image, video: Play, pdf: FileText, other: File } as const;
/** Pictures this small show a thumbnail on the card; larger ones wait for Open. */
const THUMBNAIL_BYTES = 8 * 1024 * 1024;

function CardFileRow({ file }: { file: CardFile }) {
  const open = useCardFileViewer((s) => s.open);
  const Icon = KIND_ICON[file.kind];
  const thumbnail = file.kind === "image" && file.size <= THUMBNAIL_BYTES;
  const openLabel = file.kind === "video" ? "Play" : file.kind === "pdf" ? "View" : "Open";
  return (
    <li className="overflow-hidden rounded-md border border-border bg-panel-2" data-card-file={file.kind}>
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
        <Icon className="size-4 shrink-0 text-text-secondary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-text-primary" title={file.name}>{file.name}</div>
          <div className="text-xs text-text-subtle">{formatFileSize(file.size)}</div>
        </div>
        {file.kind !== "other" && (
          <Button variant="outline" size="sm" className={TEXT_BUTTON} onClick={() => open(file.id)} data-card-file-open>
            {file.kind === "video" && <Play className="size-3.5" />}{openLabel}
          </Button>
        )}
        <Button asChild variant="outline" size="sm" className={TEXT_BUTTON}>
          <a href={cardFileUrl(file.id, { download: true })} download={file.name} aria-label={`Download ${file.name}`} data-card-file-download>
            <Download className="size-3.5" /><span className="max-md:sr-only">Download</span>
          </a>
        </Button>
      </div>
      {thumbnail && (
        <button type="button" className="block w-full border-t border-border-soft bg-background" onClick={() => open(file.id)} aria-label={`Open ${file.name}`}>
          <img src={cardFileUrl(file.id)} alt={file.name} loading="lazy" className="max-h-56 w-full object-contain" />
        </button>
      )}
    </li>
  );
}
