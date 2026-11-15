import { useEffect, useState } from "react";
import { getAuthToken } from "@/lib/api-client";
import type { CardImage } from "../../../../shared/assistant-cards";

/**
 * The design screenshots a manager put on a report card, numbered as the card lists them. The
 * pictures are served only to a signed-in PPM (`/api/design-shots/<id>.png` is behind the login),
 * and an `<img>` cannot send the token, so each is fetched with it and shown from a blob URL;
 * clicking opens that copy full size.
 */
export function CardImages({ images }: { images?: CardImage[] }) {
  if (!images?.length) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-card-images>
      {images.map((image, i) => <CardImageTile key={image.id} image={image} index={i} />)}
    </div>
  );
}

function CardImageTile({ image, index }: { image: CardImage; index: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const name = image.label ? `${image.file} · ${image.label}` : image.file;

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    const token = getAuthToken();
    fetch(`/api/design-shots/${encodeURIComponent(image.id)}.png`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([blob], { type: "image/png" }));
        setSrc(url);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [image.id]);

  const label = (
    <span className="block truncate px-2 py-1 text-xs text-text-secondary">
      <span className="font-medium text-text-primary">{index + 1}.</span> {name}
    </span>
  );
  const frame = "block min-w-0 overflow-hidden rounded-md border border-border bg-panel-2";
  if (!src) {
    return (
      <div className={frame} title={`${image.designTitle} — ${name}`}>
        <div className="flex h-32 items-center justify-center text-xs text-text-secondary">
          {failed ? "Picture no longer kept" : "Loading…"}
        </div>
        {label}
      </div>
    );
  }
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className={frame} title={`${image.designTitle} — ${name}`}>
      <img src={src} alt={`${index + 1}. ${image.designTitle} — ${name}`} className="h-32 w-full object-cover object-top" />
      {label}
    </a>
  );
}
