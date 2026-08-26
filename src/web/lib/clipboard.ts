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
