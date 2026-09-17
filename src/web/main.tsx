import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { RootErrorBoundary } from "./components/root-error-boundary.tsx";
import { installChunkErrorRecovery } from "./lib/chunk-recovery.ts";
// Self-hosted, because a font stack is only a wish list: -apple-system and
// Segoe UI miss on Linux and a generic sans-serif can resolve to Liberation
// *Serif* through fontconfig, so every surface named a font it never got. Each
// face is a separate lazy request the browser only makes for text that uses it
// — Geist by subset (the Vietnamese range is its own file), Monaspace only once
// an editor or a terminal is on screen — and none of them are precached.
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist/wght-italic.css";
import "@fontsource/monaspace-argon/latin-400.css";
import "@fontsource/monaspace-argon/latin-400-italic.css";
import "@fontsource/monaspace-argon/latin-700.css";
import "@fontsource/monaspace-krypton/latin-400.css";
import "@fontsource/monaspace-krypton/latin-400-italic.css";
// The terminal's icon glyphs, split per Nerd Fonts block so a powerline prompt
// costs 7 KiB and only someone drawing a Material Design icon pays for those.
import "./styles/nerd-font.generated.css";
import "./styles/globals.css";
import "katex/dist/katex.min.css";

// Patch DOM methods to swallow NotFoundError from browser extensions or rehype-raw
// that desync React's virtual DOM. Catch-based approach preserves normal DOM behavior
// (avoids infinite re-render loops from preemptive skipping).
// See: https://github.com/facebook/react/issues/11538
if (typeof Node !== "undefined") {
  const origRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function <T extends Node>(child: T): T {
    try { return origRemoveChild.call(this, child) as T; }
    catch (e) { if (e instanceof DOMException && e.name === "NotFoundError") return child; throw e; }
  };
  const origInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function <T extends Node>(node: T, ref: Node | null): T {
    try { return origInsertBefore.call(this, node, ref) as T; }
    catch (e) { if (e instanceof DOMException && e.name === "NotFoundError") return node; throw e; }
  };
}

// Tells the boot watchdog in index.html that the module graph loaded, so it
// stops watching. Everything past this point has React above it and a root
// boundary to catch it; the watchdog is only for never getting here at all.
(window as unknown as { __ppmEntryRan?: boolean }).__ppmEntryRan = true;

// Before the first render, so a chunk that fails while the tree is still
// mounting is caught too.
installChunkErrorRecovery();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
