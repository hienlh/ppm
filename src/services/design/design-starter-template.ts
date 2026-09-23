import type { DesignKind } from "../../shared/design-types.ts";

/**
 * The `index.html` a new design starts with: enough structure for the canvas to render
 * something and for the agent to extend, following the same conventions its instructions
 * describe (a `:root` block for tweakable values, `../tokens.css` when the project has one,
 * `<section class="slide">` at 1280x720 for decks).
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PAGE_STYLE = `    :root {
      --accent: #4f46e5;
      --radius: 12px;
      --space: 24px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #111827;
      background: #f9fafb;
    }
    main {
      max-width: 960px;
      margin: 0 auto;
      padding: calc(var(--space) * 3) var(--space);
    }
    h1 { margin: 0 0 var(--space); font-size: 2.5rem; }
    p { color: #4b5563; line-height: 1.6; }
    .button {
      display: inline-block;
      padding: 12px 20px;
      border-radius: var(--radius);
      background: var(--accent);
      color: #fff;
      text-decoration: none;
    }`;

const SLIDES_STYLE = `    :root {
      --accent: #4f46e5;
      --space: 64px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      background: #e5e7eb;
    }
    .slide {
      width: 1280px;
      height: 720px;
      margin: 0 auto 24px;
      padding: var(--space);
      background: #fff;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .slide h1 { margin: 0 0 24px; font-size: 64px; color: var(--accent); }
    .slide p { margin: 0; font-size: 28px; color: #4b5563; }`;

export function starterHtml(kind: DesignKind, title: string, hasTokens: boolean): string {
  const safeTitle = escapeHtml(title);
  const tokensLink = hasTokens ? `  <link rel="stylesheet" href="../tokens.css">\n` : "";
  const body =
    kind === "slides"
      ? `  <section class="slide">
    <h1>${safeTitle}</h1>
    <p>Describe the deck in the chat and the slides will appear here.</p>
  </section>`
      : `  <main>
    <h1>${safeTitle}</h1>
    <p>Describe what you want in the chat and the design will appear here.</p>
    <a class="button" href="#">Get started</a>
  </main>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
${tokensLink}  <style>
${kind === "slides" ? SLIDES_STYLE : PAGE_STYLE}
  </style>
</head>
<body>
${body}
</body>
</html>
`;
}
