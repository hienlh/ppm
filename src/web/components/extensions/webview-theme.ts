/**
 * Hand PPM's active theme to an extension webview.
 *
 * A webview is a sandboxed iframe with its own document, so it inherits nothing
 * from the app: no CSS vars, no `.dark` class on `<html>`. Left to itself the
 * only thing it can ask is `prefers-color-scheme`, which is the *OS* setting —
 * so a phone or laptop in dark mode rendered every panel dark while the app
 * around it was light. The host has to say which theme is on, and in what
 * colours.
 *
 * Both halves matter: the mode drives the panels' own dark rules, and the token
 * block makes a panel use the same surfaces as the app rather than its own
 * near-black stand-in palette.
 */

/**
 * Webview var ← app var.
 *
 * Values are read from the live `<html>` rather than from a `PpmTheme` object so
 * that mobile overrides and imported VSCode themes come through with no second
 * mapping to keep in sync. Two deliberate omissions: `--surface-hover` (the app
 * has no hover token, and `--panel-2` equals `--panel` in some themes, which
 * would make row hover invisible — the panels derive it from `--text` instead)
 * and the decorative `--purple` / `--orange`, which have no app equivalent and
 * only ever colour graph lanes and ref badges.
 */
const VAR_MAP: [webviewVar: string, appVar: string][] = [
  ["--bg", "--bg-solid"],
  ["--surface", "--panel"],
  ["--selected", "--accent-wash"],
  ["--text", "--text"],
  ["--subtext", "--text-2"],
  ["--subtle", "--text-3"],
  // The app's faint divider becomes the panels' hairline and its hairline
  // becomes their stronger border, keeping the two-tier structure they expect.
  ["--border", "--border-soft"],
  ["--border2", "--border"],
  ["--blue", "--accent"],
  ["--green", "--success"],
  ["--yellow", "--warning"],
  ["--red", "--error"],
];

export interface HostTheme {
  mode: "dark" | "light";
  /** A `:root[data-ppm-theme]` block, or "" when no tokens could be read. */
  css: string;
}

/**
 * Build the token block from a var reader.
 *
 * The selector carries an attribute so it ties with the panels' own
 * `:root[data-ppm-theme="dark"]` rules on specificity; being injected last is
 * what makes it win.
 */
export function hostThemeCss(readVar: (name: string) => string): string {
  const decls: string[] = [];
  for (const [webviewVar, appVar] of VAR_MAP) {
    const value = readVar(appVar).trim();
    if (value) decls.push(`${webviewVar}: ${value};`);
  }
  if (!decls.length) return "";
  return `:root[data-ppm-theme] { ${decls.join(" ")} }`;
}

/** Read the mode and tokens the app has actually applied to `<html>`. */
export function readHostTheme(root: HTMLElement): HostTheme {
  const computed = getComputedStyle(root);
  return {
    mode: root.classList.contains("dark") ? "dark" : "light",
    css: hostThemeCss((name) => computed.getPropertyValue(name)),
  };
}

/** Message the host posts into the iframe when the theme changes. */
export const HOST_THEME_MESSAGE = "ppm:theme";

/**
 * Applies a `ppm:theme` message inside the iframe.
 *
 * Live updates arrive this way rather than by rewriting `srcDoc`, which would
 * reload the panel — a graph would refetch every commit and lose its scroll
 * position because the user switched themes.
 */
const HOST_THEME_SHIM = `<script>
window.addEventListener("message",function(e){
  var m=e.data;
  if(!m||m.command!=="${HOST_THEME_MESSAGE}")return;
  document.documentElement.setAttribute("data-ppm-theme",m.mode==="dark"?"dark":"light");
  var el=document.getElementById("ppm-theme-vars");
  if(el)el.textContent=m.css||"";
});
</script>`;

const HTML_TAG = /<html(\s[^>]*)?>/i;

/**
 * Seed the theme into a panel's HTML.
 *
 * The style element goes last in `<head>`, after the panel's own stylesheet, so
 * equal specificity resolves in the host's favour.
 */
export function injectHostTheme(html: string, theme: HostTheme): string {
  if (!html) return html;
  const withMode = html.replace(
    HTML_TAG,
    (tag, attrs: string | undefined) => `<html${attrs ?? ""} data-ppm-theme="${theme.mode}">`,
  );
  const block = `<style id="ppm-theme-vars">${theme.css}</style>${HOST_THEME_SHIM}`;
  const headEnd = withMode.toLowerCase().indexOf("</head>");
  if (headEnd !== -1) return withMode.slice(0, headEnd) + block + withMode.slice(headEnd);
  return withMode + block;
}
