import { create } from "zustand";

export interface GalleryImage {
  /** Blob URL or data URL of the image. */
  src: string;
  alt: string;
}

interface ImageOverlayState {
  /** Images the overlay can move between; a single entry when opened without a gallery. */
  images: GalleryImage[];
  index: number;
  /** Convenience mirrors of the current entry — every existing consumer reads these. */
  src: string | null;
  alt: string;
  /**
   * Open the overlay. Passing a gallery lets the arrows walk its siblings; the clicked
   * source decides where in that list the viewer starts.
   */
  open: (src: string, alt?: string, gallery?: GalleryImage[]) => void;
  close: () => void;
  /** Move by a signed offset, stopping at the ends rather than wrapping. */
  go: (delta: number) => void;
}

export const useImageOverlay = create<ImageOverlayState>((set, get) => ({
  images: [],
  index: 0,
  src: null,
  alt: "",
  open: (src, alt = "", gallery) => {
    const images = gallery?.length ? gallery : [{ src, alt }];
    const found = images.findIndex((i) => i.src === src);
    const index = found >= 0 ? found : 0;
    const current = images[index]!;
    set({ images, index, src: current.src, alt: current.alt || alt });
  },
  close: () => set({ images: [], index: 0, src: null, alt: "" }),
  go: (delta) => {
    const { images, index } = get();
    const next = index + delta;
    if (next < 0 || next >= images.length) return;
    const current = images[next]!;
    set({ index: next, src: current.src, alt: current.alt });
  },
}));
