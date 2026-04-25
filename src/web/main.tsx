import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./styles/globals.css";
import "katex/dist/katex.min.css";
// Highlight.js themes are loaded dynamically by applyThemeClass() to match light/dark mode

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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
