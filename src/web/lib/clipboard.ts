/**
 * Clipboard write with an insecure-context fallback.
 *
 * `navigator.clipboard` only exists in a secure context (HTTPS or localhost).
 * PPM is regularly reached over plain HTTP — LAN IP, Tailscale MagicDNS name —
 * where the API is absent and every copy button silently no-ops. The legacy
 * `execCommand` path keeps copy working on those origins.
 */

/** Copy text to the clipboard. Returns false only if both paths fail. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied permission or lost user activation — fall through to execCommand.
    }
  }
  return legacyCopy(text);
}

/**
 * Whether an image can be placed on the clipboard at all on this origin.
 *
 * Unlike text there is no `execCommand` fallback for binary data, so on the plain-HTTP
 * origins PPM is often reached from there is nothing to try — callers should disable the
 * action and say why rather than offer a button that always fails.
 */
export function canCopyImage(): boolean {
  return typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;
}

/**
 * Copy an image to the clipboard, converting to PNG first.
 *
 * Browsers accept a very short list of image types on the clipboard — PNG is the only one
 * supported everywhere — so a JPEG or WebP has to be repainted through a canvas.
 */
export async function copyImageToClipboard(src: string): Promise<boolean> {
  if (!canCopyImage()) return false;
  try {
    const blob = await fetch(src).then((r) => r.blob());
    const png = blob.type === "image/png" ? blob : await toPng(blob);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}

async function toPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas produced no blob"))), "image/png");
  });
}

function legacyCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  // Must stay rendered and non-zero sized: iOS Safari refuses to select a
  // hidden or display:none element, which breaks the copy.
  textarea.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:none;opacity:0;";
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const previousRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  try {
    textarea.focus();
    textarea.select();
    // setSelectionRange is what actually selects on iOS; select() alone is ignored.
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (selection && previousRange) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
  }
}
