import type { CardImage } from "../../../../shared/assistant-cards";

/**
 * The design screenshots a manager put on a report card, numbered as the card lists them. Each
 * opens full size in a new tab. The pictures are served by id (`/api/design-shots/<id>.png`),
 * which is why a plain `<img>` loads them without PPM's token.
 */
export function CardImages({ images }: { images?: CardImage[] }) {
  if (!images?.length) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-card-images>
      {images.map((image, i) => {
        const src = `/api/design-shots/${encodeURIComponent(image.id)}.png`;
        const name = image.label ? `${image.file} · ${image.label}` : image.file;
        return (
          <a
            key={image.id}
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="group block min-w-0 overflow-hidden rounded-md border border-border bg-panel-2"
            title={`${image.designTitle} — ${name}`}
          >
            <img src={src} alt={`${i + 1}. ${image.designTitle} — ${name}`} loading="lazy" className="h-32 w-full object-cover object-top" />
            <span className="block truncate px-2 py-1 text-xs text-text-secondary">
              <span className="font-medium text-text-primary">{i + 1}.</span> {name}
            </span>
          </a>
        );
      })}
    </div>
  );
}
