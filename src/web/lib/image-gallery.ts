import type { GalleryImage } from "@/stores/image-overlay-store";

/** Marks a container whose tagged images form one navigable set. */
export const GALLERY_ROOT_ATTR = "data-image-gallery";
/** Marks an `<img>` that belongs to the enclosing gallery. */
export const GALLERY_ITEM_ATTR = "data-gallery-item";

/**
 * Collect the images a viewer may move between, in the order they appear on screen.
 *
 * Read from the DOM rather than a registry because every image already owns a blob URL that
 * is revoked when its component unmounts — so the mounted elements are exactly the set whose
 * sources are still valid, and the DOM already holds them in the order the user sees.
 *
 * The reach is therefore whatever is mounted. The chat transcript is deliberately not
 * virtualised (`message-list.tsx`), so that is the whole conversation today; if it ever gains
 * data windowing, navigation narrows to the loaded window along with everything else.
 */
export function collectGallery(from: Element | null): GalleryImage[] {
  const root = from?.closest(`[${GALLERY_ROOT_ATTR}]`);
  if (!root) return [];
  return [...root.querySelectorAll<HTMLImageElement>(`img[${GALLERY_ITEM_ATTR}]`)]
    .filter((img) => !!img.src)
    .map((img) => ({ src: img.src, alt: img.alt }));
}
