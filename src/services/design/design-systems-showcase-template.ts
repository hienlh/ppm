import type { DesignSystemSummary } from "../../shared/design-types.ts";

/**
 * The starter page for an app's showcase design (`designs/system-<id>/index.html`), before
 * the setup brief replaces it with the real showcase — colours, type scale, spacing, and the
 * app's own components drawn with its kit. Links the new `../systems/<id>/…` alias so the
 * canvas renders something sensible even before setup has produced any files there.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function showcaseStarterHtml(system: DesignSystemSummary): string {
  const title = escapeHtml(`${system.label} design system`);
  const prefix = `../systems/${system.id}`;
  const tokensLink = system.hasTokensCss ? `  <link rel="stylesheet" href="${prefix}/tokens.css">\n` : "";
  const frameHint = system.platform === "mobile" ? "Shown in the phone frame once the setup brief runs." : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
${tokensLink}  <style>
    :root { --accent: #4f46e5; --radius: 12px; --space: 24px; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #111827; background: #f9fafb; }
    main { max-width: 960px; margin: 0 auto; padding: calc(var(--space) * 3) var(--space); }
    h1 { margin: 0 0 var(--space); font-size: 2.25rem; }
    p { color: #4b5563; line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>Run "Set up design system" from this app's chat to build colours, type scale, spacing
      and its real components here. ${frameHint}</p>
  </main>
</body>
</html>
`;
}
