/**
 * The short highlight a row gets when a jump lands on it, so the eye finds it among its
 * neighbours. Returns a cleanup that clears it at once, for a second jump arriving first.
 */
const FLASH_CLASSES = ["bg-primary/10", "ring-1", "ring-primary/40"];
const FLASH_MS = 1400;

export function flashRow(row: HTMLElement): () => void {
  row.classList.add(...FLASH_CLASSES);
  const clear = () => row.classList.remove(...FLASH_CLASSES);
  const timer = setTimeout(clear, FLASH_MS);
  return () => {
    clearTimeout(timer);
    clear();
  };
}
