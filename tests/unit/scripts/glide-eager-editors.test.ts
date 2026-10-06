/**
 * Glide's cell editors are imported up front in the build: through `React.lazy`, the first edit
 * after a load waited ~300 ms for its editor and the keys typed meanwhile were lost. These run the
 * transform over Glide's own build, so an upgrade that adds a lazy editor, or writes one another
 * way, fails here rather than in a first edit.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eagerGlideEditors, glideEagerEditors } from "../../../scripts/vite-glide-eager-editors.ts";

const GLIDE = resolve(import.meta.dir, "../../../node_modules/@glideapps/glide-data-grid/dist/esm");
/** Every module of Glide's build: its path inside it, its id as the bundler names it, its source. */
const MODULES = [...new Bun.Glob("**/*.js").scanSync(GLIDE)].map((file) => {
  const id = resolve(GLIDE, file);
  return { file: file.replaceAll("\\", "/"), id, code: readFileSync(id, "utf8") };
});
const js = new Bun.Transpiler({ loader: "js" });
const eager = (file: string) => {
  const m = MODULES.find((x) => x.file === file)!;
  return { ...m, out: eagerGlideEditors(m.code, m.id) };
};

describe("Glide's editors in the build", () => {
  it("leave nothing in Glide loaded lazily", () => {
    expect(MODULES.filter((m) => m.code.includes("import(")).map((m) => m.file).sort())
      .toEqual(["cells/number-cell.js", "data-editor/data-editor.js"]);
    for (const m of MODULES) {
      const out = eagerGlideEditors(m.code, m.id) ?? m.code;
      expect(out).not.toContain("import(");
      expect(out).not.toContain("React.lazy(");
    }
  });

  it("are imported statically, each from the file Glide loaded it from, under the name Glide renders", () => {
    for (const [file, name, path] of [
      ["data-editor/data-editor.js", "DataGridOverlayEditor", "../internal/data-grid-overlay-editor/data-grid-overlay-editor.js"],
      ["cells/number-cell.js", "NumberOverlayEditor", "../internal/data-grid-overlay-editor/private/number-overlay-editor.js"],
    ] as const) {
      const { out, id } = eager(file);
      expect(out).toContain(`\nimport ${name} from "${path}";\n`);
      // Still a module that parses, now importing the editor rather than fetching it.
      expect(js.scanImports(out!)).toContainEqual({ kind: "import-statement", path });
      // What React.lazy rendered was the file's default export.
      expect(js.scan(readFileSync(resolve(id, "..", path), "utf8")).exports).toContain("default");
      // One line for one line.
      expect(out!.split("\n")).toHaveLength(eager(file).code.split("\n").length);
    }
  });

  it("change no other module, and nothing outside Glide", () => {
    for (const m of MODULES) {
      if (m.file === "cells/number-cell.js" || m.file === "data-editor/data-editor.js") continue;
      expect(eagerGlideEditors(m.code, m.id)).toBeNull();
    }
    const { code } = eager("data-editor/data-editor.js");
    expect(eagerGlideEditors(code, resolve(import.meta.dir, "../../../src/web/components/database/glide-data-grid.tsx"))).toBeNull();
    // Vite names a module with forward slashes on every platform; a Windows path is the same module.
    expect(eagerGlideEditors(code, "C:\\work\\node_modules\\@glideapps\\glide-data-grid\\dist\\esm\\data-editor\\data-editor.js")).not.toBeNull();
  });

  it("are changed only in a build, which is the only place this hook sees Glide", () => {
    expect(glideEagerEditors().apply).toBe("build");
  });
});
