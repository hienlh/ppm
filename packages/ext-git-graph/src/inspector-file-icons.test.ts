/**
 * The inspector's file icons are the app's: the panel names the files it drew,
 * the app answers with each name's class and those classes' drawings
 * (`src/web/components/extensions/webview-file-icons.ts`). This is the panel's
 * half, run from the shipped script in a real DOM.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import { getWebviewHtml } from "./webview-html.ts";

const SCRIPT = (() => {
  const html = getWebviewHtml();
  return html.slice(html.lastIndexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
})();

/** One top-level function, as source; nothing it reaches for has a brace inside a string. */
function functionSource(name: string): string {
  const start = SCRIPT.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`no ${name} in the shipped script`);
  let depth = 0;
  for (let i = SCRIPT.indexOf("{", start); i < SCRIPT.length; i++) {
    if (SCRIPT[i] === "{") depth++;
    else if (SCRIPT[i] === "}" && --depth === 0) return SCRIPT.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${name}`);
}

function stateSource(): string {
  const start = SCRIPT.indexOf("const fileIconClasses = new Map();");
  const end = SCRIPT.indexOf("function fileIconHtml(");
  if (start === -1 || end < start) throw new Error("the icon caches moved");
  return SCRIPT.slice(start, end);
}

interface Panel {
  fileIconHtml(path: string): string;
  requestFileIcons(): void;
  receiveFileIcons(msg: unknown): void;
}

let doc: Document;
let posted: unknown[];
let panel: Panel;

beforeEach(() => {
  doc = new Window().document as unknown as Document;
  doc.body.innerHTML = '<div id="detail-panel"></div>';
  posted = [];
  const vscode = { postMessage: (m: unknown) => posted.push(m) };
  panel = new Function("document", "vscode", `
    ${["escHtml", "splitPath"].map(functionSource).join("\n")}
    ${stateSource()}
    ${["fileIconHtml", "requestFileIcons", "receiveFileIcons"].map(functionSource).join("\n")}
    return { fileIconHtml, requestFileIcons, receiveFileIcons };
  `)(doc, vscode) as Panel;
});

const draw = (...paths: string[]) => {
  doc.getElementById("detail-panel")!.innerHTML = paths.map((p) => panel.fileIconHtml(p)).join("");
};
const classes = () => [...doc.querySelectorAll("[data-fi]")].map((el) => el.className);

describe("the inspector's file icons", () => {
  it("asks once for each name drawn, by its last segment", () => {
    draw("src/a.ts", "lib/a.ts", "Cargo.toml");
    panel.requestFileIcons();
    expect(posted).toEqual([{ command: "__ppm.fileIcons", names: ["a.ts", "Cargo.toml"] }]);

    // Already asked: a redraw of the same files sends nothing.
    draw("src/a.ts");
    panel.requestFileIcons();
    expect(posted).toHaveLength(1);
  });

  it("puts each class on the icons drawn and on the ones drawn after", () => {
    draw("src/a.ts", "Cargo.toml");
    panel.receiveFileIcons({ command: "__ppm.fileIcons", icons: [["a.ts", "vsi-ts"], ["Cargo.toml", "vsi-cargo"]], rules: [] });
    expect(classes()).toEqual(["vsi vsi-ts", "vsi vsi-cargo"]);

    draw("other/a.ts");
    expect(classes()).toEqual(["vsi vsi-ts"]);
    panel.requestFileIcons();
    expect(posted).toEqual([]);
  });

  it("adds each class's drawing once, however many answers carry it", () => {
    const rules = [["vsi-ts", ".vsi-ts { background-image: none; }\n"]];
    panel.receiveFileIcons({ icons: [["a.ts", "vsi-ts"]], rules });
    panel.receiveFileIcons({ icons: [["b.ts", "vsi-ts"]], rules });
    const styles = [...doc.head.querySelectorAll("style")].map((s) => s.textContent);
    expect(styles).toEqual([".vsi-ts { background-image: none; }\n"]);
  });
});
