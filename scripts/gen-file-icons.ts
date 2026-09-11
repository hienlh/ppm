/**
 * Vendor the vscode-icons file icon theme into a module the browser can use.
 *
 * Both halves come from `vscode-icons-team.vscode-icons` itself: the artwork
 * from the Iconify collection generated out of that extension, and the
 * *mapping* from the extension's own `src/iconsManifest/` — pinned, digested
 * and re-implemented below exactly as `manifestBuilder.ts` builds it.
 *
 * The mapping used to come from `vscode-icons-js` alone, a third-party
 * repackaging, and that is the whole reason this file was rewritten. It is
 * versioned apart from the extension and lags it badly: its table of
 * *multi-dot* extensions held **41** entries against the real manifest's 1006,
 * so `app.controller.ts`, `app.module.ts` and `app.service.ts` all drew the
 * plain TypeScript glyph while the Nest artwork sat unused in the bundle. It
 * also knows nothing of the manifest's glob form (`babel.config.{js,cjs,mjs,json}`)
 * or of the presets, so every gap had to be patched by hand in an `OVERRIDES`
 * table that only ever grew.
 *
 * It is still read, second, and that is not laziness — the two sources are
 * complementary in a way worth stating. The manifest associates a great many
 * types by *VS Code language id* and nothing else: the `dotenv` entry has
 * `extensions: []`, and `.cc`, `.htm`, `.conf`, `.kts` and twenty more reach
 * their icon only because VS Code already knows which language owns them.
 * `languages.ts` carries one `knownExtensions` list per language and it is the
 * short one, so a manifest-only port silently drops those — measured, against
 * the previous tables: 36 names that had an icon stopped having one. So the
 * manifest wins wherever it answers, `vscode-icons-js` fills the rest, and
 * `LANGUAGE_EXTRAS` holds the handful neither knows.
 *
 * Both are **build-time** dependencies. Resolving names at run time would mean
 * shipping the manifest itself (200 KB of TypeScript) and the lookup code with
 * it, to answer a question whose answer never changes between releases.
 *
 * The outputs are committed. Re-run after bumping `MANIFEST_VERSION`:
 *
 *   bun scripts/gen-file-icons.ts
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const OUT_TS = resolve(import.meta.dir, "../src/web/lib/file-icons.generated.ts");
const OUT_CSS = resolve(import.meta.dir, "../src/web/styles/file-icons.generated.css");

/**
 * Pinned, and checked against a digest rather than trusted.
 *
 * These are the three files the extension builds its own icon theme from. A
 * branch can be force-pushed and a tag moved, so "fetch master" would make the
 * committed tables unreproducible — and a mapping that changed under us moves
 * icons all over the tree with nothing to point at. Bump the tag, run the
 * script, and it will print the digests it actually got.
 */
const MANIFEST_VERSION = "v12.19.0";
const MANIFEST_FILES: Record<string, string> = {
  supportedExtensions: "277b81ecebe527dea6deedf39b891d9746cc58b14dd2e311bc2da0bf2ff8eee6",
  supportedFolders: "8b638f423efdcbeabbc5ede863db7d54ee6738da2eece29cf07833a627a12685",
  languages: "43542118e7438a0c5f31b1c48c085c6b1b8079b2902e241664c4cff1e4c8568e",
};

/**
 * A glyph bigger than this is dropped, and whatever asked for it falls back to
 * the next shorter suffix — `.controller.ts` to `.ts`, and past that to the
 * neutral default.
 *
 * The set is extremely skewed: the median body is ~1 KB and `file-type-composer`
 * alone is 83 KB, because some of these are detailed illustrations rather than
 * icons. At the 16px a file tree draws them at, that detail is invisible; all it
 * costs is download.
 *
 * 5000 rather than something tighter because the distribution has no useful gap
 * below it, and a tight budget cuts by weight rather than by worth: at 1800,
 * `.tsx` (`file-type-reactts`, 1833 bytes — 33 over) drew the blank-page default,
 * and so did `.jsx` (1833), `.go` (1825) and `.rs` (3957). Everything above 5000
 * really is an illustration. `KEEP_ANY_SIZE` exempts the few worth paying for.
 */
const MAX_BODY_BYTES = 5000;

/** Languages common enough to keep whatever they weigh. */
const KEEP_ANY_SIZE = new Set(
  `file-type-ruby file-type-perl file-type-groovy file-type-maven file-type-http
   file-type-pdf2`
    .trim()
    .split(/\s+/),
);

/**
 * Keys the manifest names that the collection spells differently.
 *
 * vscode-icons revises a glyph by publishing it under a numbered name, and the
 * artwork package is versioned apart from the extension — so the manifest can
 * name an icon the collection no longer has. Every unresolved name is reported
 * at the end of a run rather than dropped quietly, and this is where the answer
 * goes.
 */
const ALIASES: Record<string, string> = {
  "file-type-pdf": "file-type-pdf2",
};

/**
 * What neither source knows, because VS Code answers it from somewhere else.
 *
 * All of these resolve in VS Code through a language association contributed by
 * a *different* extension or by a built-in grammar, which is a table neither the
 * icon manifest nor `vscode-icons-js` contains. `.env.local` is the one that
 * matters most here — the manifest's `dotenv` entry declares no extensions at
 * all and leans entirely on the `dotenv` language id, so every qualified env
 * file drew a blank page.
 *
 * Keys are matched the way the runtime matches: whole filename first, then a
 * dotted suffix. Values are checked against the collection at generation time,
 * so an entry that stops resolving is reported rather than silently dropped.
 */
const LANGUAGE_EXTRAS: { names: Record<string, string>; extensions: Record<string, string> } = {
  names: {
    // Bazel, whose two marker files have no extension at all.
    build: "bazel",
    workspace: "bazel",
    // Wrapper scripts and pipeline definitions named after their tool.
    gradlew: "gradle",
    "gradlew.bat": "gradle",
    jenkinsfile: "groovy",
    "cargo.lock": "rust",
    // `file-type-bundler` is 43 KB — an illustration, not an icon, so the
    // budget drops it and Ruby's own glyph is the honest stand-in.
    gemfile: "ruby",
    "gemfile.lock": "ruby",
  },
  extensions: {
    // Languages and formats VS Code associates through a grammar neither source
    // enumerates. Each of these was a line in the old hand-written `OVERRIDES`
    // and drew a blank page without it.
    graphql: "graphql",
    gql: "graphql",
    kts: "kotlin",
    exs: "elixir",
    tif: "image",
    rest: "rest",
    apk: "binary",
    rpm: "binary",
    npmrc: "npm",
    nvmrc: "node",
    // `.env.local`, `.env.production`, `.env.test.local` — the manifest has the
    // artwork and reaches it only by language id.
    "env.local": "dotenv",
    "env.development": "dotenv",
    "env.production": "dotenv",
    "env.staging": "dotenv",
    "env.test": "dotenv",
    "env.example": "dotenv",
    "env.sample": "dotenv",
  },
};

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** One entry of `supportedExtensions.ts` / `supportedFolders.ts`. */
interface ManifestEntry {
  icon: string;
  extensions: string[];
  /** The strings in `extensions` are whole filenames, not suffixes. */
  filename?: boolean;
  /** Cartesian product with `extensionsGlob`, joined by a dot. */
  filenamesGlob?: string[];
  extensionsGlob?: string[];
  languages?: { ids: string | string[]; knownExtensions?: string[]; knownFilenames?: string[] }[];
  /** The theme ships a second drawing of this glyph, for a light workbench. */
  light?: boolean;
  /** Off unless a preset turns it on — `nest_*`, `ng_*`, the `*2` redraws. */
  disabled?: boolean;
}

interface Manifest {
  files: ManifestEntry[];
  folders: ManifestEntry[];
}

/**
 * Fetch the three manifest modules and evaluate them.
 *
 * They are TypeScript that imports its types from `../models`, so they are
 * staged in one temp directory next to a stub supplying that module. Evaluating
 * them is the point: these tables are 200 KB of nested literals, and a regex
 * over them would be a second, worse parser that fails silently the first time
 * upstream reformats a line.
 */
async function loadManifest(): Promise<Manifest> {
  const dir = mkdtempSync(resolve(tmpdir(), "ppm-vscode-icons-"));
  try {
    writeFileSync(
      resolve(dir, "models.ts"),
      "export const FileFormat = { svg: 'svg', png: 'png' };\n" +
        "export const IFileCollection = undefined, IFolderCollection = undefined, ILanguage = undefined;\n",
    );
    for (const [name, digest] of Object.entries(MANIFEST_FILES)) {
      const url =
        `https://raw.githubusercontent.com/vscode-icons/vscode-icons/` +
        `${MANIFEST_VERSION}/src/iconsManifest/${name}.ts`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      const got = createHash("sha256").update(body).digest("hex");
      if (got !== digest) {
        throw new Error(`${name}.ts digest mismatch\n  expected ${digest}\n  got      ${got}`);
      }
      writeFileSync(resolve(dir, `${name}.ts`), body.toString("utf8").replace("../models", "./models"));
    }
    const files = (await import(resolve(dir, "supportedExtensions.ts"))).extensions;
    const folders = (await import(resolve(dir, "supportedFolders.ts"))).extensions;
    return { files: files.supported, folders: folders.supported };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `nest_controller_ts` → `file-type-nest-controller-ts`, the Iconify key. */
function iconifyKey(prefix: string, icon: string): string {
  const key = `${prefix}-${icon.replace(/_/g, "-")}`.toLowerCase();
  return ALIASES[key] ?? key;
}

/**
 * The tables one preset of the manifest produces, built the way
 * `manifestBuilder.buildFiles` builds them.
 *
 * Two details are load-bearing and neither is obvious. Entries are walked in
 * order of *icon name*, because that is what upstream sorts by and later
 * writes overwrite earlier ones — so two icons claiming `service.ts` resolve
 * the same way here as they do in VS Code. And the language layer is written
 * first and then overwritten by the explicit `extensions`, so a hand-declared
 * association always beats one inferred from a language's known extensions.
 */
function buildFiles(entries: ManifestEntry[]): {
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  langNames: Record<string, string>;
  langExtensions: Record<string, string>;
} {
  const langNames: Record<string, string> = {};
  const langExtensions: Record<string, string> = {};
  const names: Record<string, string> = {};
  const extensions: Record<string, string> = {};

  for (const entry of [...entries].sort((a, b) => (a.icon < b.icon ? -1 : a.icon > b.icon ? 1 : 0))) {
    for (const lang of entry.languages ?? []) {
      for (const ext of lang.knownExtensions ?? []) langExtensions[ext.toLowerCase()] = entry.icon;
      for (const name of lang.knownFilenames ?? []) langNames[name.toLowerCase()] = entry.icon;
    }
    const put = (value: string) => {
      if (entry.filename) names[value.toLowerCase()] = entry.icon;
      // `removeFirstDot`: the manifest writes `.babelrc` and means the suffix
      // `babelrc`. Only the *leading* dot goes — `controller.ts` stays whole.
      else extensions[value.replace(/^\./, "").toLowerCase()] = entry.icon;
    };
    for (const value of entry.extensions) put(value);
    if (entry.filenamesGlob?.length && entry.extensionsGlob?.length) {
      for (const stem of entry.filenamesGlob) for (const ext of entry.extensionsGlob) put(`${stem}.${ext}`);
    }
  }
  // The language layer is handed back *separately* rather than merged under the
  // explicit one, because it is the weaker claim in a way the merge cannot
  // express. `knownExtensions` flattens "this language is known by .css" into
  // "a .css file is this icon", and two languages may claim one extension —
  // `tailwindcss` also lists `css`, sorts after it, and so every stylesheet in
  // the app came out with the Tailwind logo. VS Code never sees that collision
  // because it matches the file's *actual* language id. So this layer ranks
  // below `vscode-icons-js`'s flattening of VS Code's own associations, and
  // only answers for languages that package is too old to know.
  return { fileNames: names, fileExtensions: extensions, langNames, langExtensions };
}

// ---------------------------------------------------------------------------
// The artwork
// ---------------------------------------------------------------------------

const collection = (
  await import("@iconify-json/vscode-icons/icons.json", { with: { type: "json" } })
).default as { icons: Record<string, { body: string }>; width?: number; height?: number };

/** Both drawings of one glyph; `light` only when the theme ships a second one. */
type Glyph = { dark: string; light?: string };

const used = new Map<string, Glyph>();
const missing = new Set<string>();
const overBudget = new Map<string, number>();
let lightVariants = 0;

/**
 * Claim a glyph, or report why it cannot be drawn.
 *
 * A `null` here is not an error at the call site: the name simply gets no entry
 * in the tables, and the runtime falls through to a shorter suffix — which for
 * `foo.controller.ts` means the TypeScript glyph rather than a blank page.
 */
function takeIcon(key: string): string | null {
  if (used.has(key)) return key;
  const icon = collection.icons[key];
  if (!icon) {
    // A name the manifest knows and the collection does not: the two are
    // versioned separately, so this is reported rather than silently dropped.
    missing.add(key);
    return null;
  }
  if (icon.body.length > MAX_BODY_BYTES && !KEEP_ANY_SIZE.has(key)) {
    overBudget.set(key, icon.body.length);
    return null;
  }
  // The theme draws 132 of these twice, the second for a light workbench:
  // `#fbc02d` where the normal one is `#f5de19`, and for `toml` a path with no
  // `fill` at all, i.e. black. Shipping the light one as the *only* artwork is
  // how the TOML glyph came out invisible on every dark PPM theme, so the class
  // is named after the theme-independent glyph and carries both drawings.
  // One `replace` per prefix, never a `??` chain: a pattern that does not match
  // returns the key *unchanged*, so chaining would find the dark drawing again
  // and ship it as its own light variant — 1187 of them, silently.
  const lightKey = key.startsWith("file-type-")
    ? key.replace(/^file-type-/, "file-type-light-")
    : key.startsWith("folder-type-")
      ? key.replace(/^folder-type-/, "folder-type-light-")
      : null;
  const light = lightKey === null ? undefined : collection.icons[lightKey];
  // A light drawing over the budget is simply left out: the class still has its
  // dark one, which is legible on a light background, just not tuned for it.
  const within = light !== undefined && light.body.length <= MAX_BODY_BYTES;
  if (within) lightVariants++;
  used.set(key, { dark: icon.body, light: within ? light!.body : undefined });
  return key;
}

/**
 * Rewrite tables of manifest icon names into one table of drawable classes,
 * earlier tables winning.
 *
 * Per key rather than merging first and resolving after, and that is the whole
 * point: a key the manifest claims with a glyph that is missing or over the
 * budget would otherwise be *lost* instead of falling through — `cargo.lock`
 * reached `file-type-cargo`, which the collection does not have, and ended up
 * with no icon at all while the second source's answer sat right there.
 */
function resolve_(prefix: string, ...tables: Record<string, string>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of new Set(tables.flatMap((t) => Object.keys(t)))) {
    for (const table of tables) {
      const icon = table[name];
      if (icon === undefined) continue;
      const key = takeIcon(iconifyKey(prefix, icon));
      if (key) {
        out[name] = key;
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const manifest = await loadManifest();

const DEFAULT_FILE = takeIcon("default-file")!;
const DEFAULT_FOLDER = takeIcon("default-folder")!;
const DEFAULT_FOLDER_OPEN = takeIcon("default-folder-opened")!;

/**
 * The presets, which are the reason this is three passes rather than one.
 *
 * `nest_*` and `ng_*` ship `disabled: true` — in VS Code they are behind
 * `vsicons.presets.nestjs` and `vsicons.presets.angular`, off by default and
 * *mutually exclusive in practice*: they claim the same six suffixes
 * (`module`, `service`, `guard`, `pipe`, `interceptor`, `controller`, each in
 * `.ts` and `.js`), and enabling both would silently hand a NestJS repository
 * the Angular artwork, since `ng_` sorts after `nest_`.
 *
 * So the base tables have neither, and each preset is emitted as an overlay the
 * runtime consults first once it knows which framework the project is built
 * with. Off both overlays, `app.service.ts` falls through to `.ts` — the plain
 * TypeScript glyph, which is what VS Code with no preset also shows.
 */
const isNest = (icon: string) => icon.startsWith("nest_");
const isAngular = (icon: string) => icon.startsWith("ng_");

const base = buildFiles(manifest.files.filter((e) => e.icon && !e.disabled));
const withNest = buildFiles(manifest.files.filter((e) => e.icon && (!e.disabled || isNest(e.icon))));
const withAngular = buildFiles(
  manifest.files.filter((e) => e.icon && (!e.disabled || isAngular(e.icon))),
);

/**
 * The second source, consulted only where the manifest said nothing.
 *
 * `file_type_typescript.svg` → `typescript`, back into the manifest's own
 * vocabulary so both layers go through one `resolve_` and one budget check.
 */
async function legacyTable(name: string): Promise<Record<string, string>> {
  const table = (await import(`vscode-icons-js/dist/generated/${name}`))[name] as Record<
    string,
    string
  >;
  const out: Record<string, string> = {};
  for (const [key, svg] of Object.entries(table)) {
    // `file_type_light_ini.svg` → `ini`. These tables answer with the **light**
    // drawing for 143 glyphs and offer no way to ask for the other one, and
    // those are darker ink meant for a light workbench — `light_toml` has no
    // `fill` at all, i.e. black on black. The class is named after the
    // theme-independent glyph and `takeIcon` attaches both drawings.
    out[key.toLowerCase()] = svg
      .replace(/\.svg$/, "")
      .replace(/^(file|folder)_type_/, "")
      .replace(/^light_/, "");
  }
  return out;
}

/** `b` fills the keys `a` has no answer for; `a` always wins. */
function fill(a: Record<string, string>, b: Record<string, string>): Record<string, string> {
  return { ...b, ...a };
}

const legacyExtensions = fill(
  await legacyTable("FileExtensions2ToIcon"),
  await legacyTable("FileExtensions1ToIcon"),
);
/**
 * The table that actually earns `vscode-icons-js` its place.
 *
 * It is that package's flattening of VS Code's *language* associations — `cc`
 * and `cxx` to C++, `htm` to HTML, `conf` to INI — which is precisely what the
 * icon manifest leaves to the editor and a port therefore has to find
 * somewhere. 
 */
const legacyLanguages = await legacyTable("LanguagesToIcon");
const legacyNames = await legacyTable("FileNamesToIcon");
const legacyFolders = await legacyTable("FolderNamesToIcon");

const extensionSources = [
  base.fileExtensions,
  legacyExtensions,
  legacyLanguages,
  base.langExtensions,
  LANGUAGE_EXTRAS.extensions,
];
const nameSources = [base.fileNames, legacyNames, base.langNames, LANGUAGE_EXTRAS.names];

const extensionIcons = resolve_("file-type", ...extensionSources);
const filenameIcons = resolve_("file-type", ...nameSources);

/**
 * The same cascade, un-resolved, for the preset diff below.
 *
 * The overlay has to be compared at *manifest icon name* level — against the
 * already-resolved class names it would differ on every single key, because
 * `nest_service_ts` is never equal to `file-type-typescript`, and the two
 * overlays came out at 2459 entries instead of 22.
 */
const baseNameSource = nameSources.reduceRight((acc, t) => fill(t, acc));
const baseExtensionSource = extensionSources.reduceRight((acc, t) => fill(t, acc));

/**
 * Only what the preset *changes*, so the overlay is 45 lines rather than 1000.
 *
 * Diffed against the *combined* base rather than the manifest's, or an entry
 * the second source already answers identically would ship twice.
 */
function overlay(
  preset: { fileNames: Record<string, string>; fileExtensions: Record<string, string> },
): { names: Record<string, string>; extensions: Record<string, string> } {
  const diff = (a: Record<string, string>, b: Record<string, string>) =>
    Object.fromEntries(Object.entries(a).filter(([k, v]) => b[k] !== v));
  return {
    names: resolve_("file-type", diff(preset.fileNames, baseNameSource)),
    extensions: resolve_("file-type", diff(preset.fileExtensions, baseExtensionSource)),
  };
}

const frameworks = { nest: overlay(withNest), angular: overlay(withAngular) };

/** `{ … }` on one line when there is nothing in it, so the output reads clean. */
function block(map: Record<string, string>, key: string): string {
  return Object.keys(map).length === 0 ? `  ${key}: {},` : `  ${key}: {\n${record(map, "    ")}\n  },`;
}

const folderTables = buildFiles(manifest.folders.filter((e) => e.icon && !e.disabled));
const baseFolders = fill(folderTables.fileExtensions, legacyFolders);
const folderIcons = resolve_("folder-type", folderTables.fileExtensions, legacyFolders);
const folderOpenIcons: Record<string, string> = {};
for (const [name, icon] of Object.entries(baseFolders)) {
  const key = takeIcon(iconifyKey("folder-type", `${icon}_opened`));
  if (key) folderOpenIcons[name] = key;
}

// A folder whose closed glyph was dropped but whose open one survived would
// change picture on expand for no reason; keep the pair or neither.
for (const name of Object.keys(folderOpenIcons)) {
  if (!folderIcons[name]) delete folderOpenIcons[name];
}
for (const name of Object.keys(folderIcons)) {
  if (!folderOpenIcons[name]) delete folderIcons[name];
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function record(map: Record<string, string>, indent = "  "): string {
  return Object.keys(map)
    .sort()
    .map((k) => `${indent}${JSON.stringify(k)}: ${JSON.stringify(map[k])},`)
    .join("\n");
}

const viewBox = `0 0 ${collection.width ?? 32} ${collection.height ?? 32}`;
const names = [...used.keys()].sort();

const ts = `/**
 * GENERATED by \`bun scripts/gen-file-icons.ts\` — do not edit.
 *
 * Which glyph of the vscode-icons theme (MIT, vscode-icons-team) a name gets,
 * built from that extension's own \`src/iconsManifest\` at ${MANIFEST_VERSION}.
 * The glyphs themselves are in \`src/web/styles/file-icons.generated.css\`, one
 * class each: 3 MB of full-colour SVG has no business in a JS bundle, and as
 * CSS the browser decodes each icon once however many rows use it — which is
 * also how VS Code draws its own file icon themes.
 */

/** Lowercased extension → icon class suffix. Longest suffix wins. */
export const EXTENSION_ICONS: Record<string, string> = {
${record(extensionIcons)}
};

/** Lowercased whole filename → icon; checked before any extension. */
export const FILENAME_ICONS: Record<string, string> = {
${record(filenameIcons)}
};

/**
 * The frameworks whose file-naming convention has artwork of its own.
 *
 * Upstream ships these as presets a user turns on, because they collide: both
 * claim \`.module.ts\`, \`.service.ts\`, \`.guard.ts\`, \`.pipe.ts\`,
 * \`.interceptor.ts\` and \`.controller.ts\`. PPM picks one per project instead —
 * see \`project-framework-store.ts\`.
 */
export type IconFramework = ${Object.keys(frameworks)
  .map((k) => JSON.stringify(k))
  .join(" | ")};

/** Checked before {@link EXTENSION_ICONS} when a project names a framework. */
export const FRAMEWORK_EXTENSION_ICONS: Record<IconFramework, Record<string, string>> = {
${Object.entries(frameworks)
  .map(([key, o]) => block(o.extensions, key))
  .join("\n")}
};

/** Checked before {@link FILENAME_ICONS} when a project names a framework. */
export const FRAMEWORK_FILENAME_ICONS: Record<IconFramework, Record<string, string>> = {
${Object.entries(frameworks)
  .map(([key, o]) => block(o.names, key))
  .join("\n")}
};

/** Lowercased folder name → icon. */
export const FOLDER_ICONS: Record<string, string> = {
${record(folderIcons)}
};

/** Lowercased folder name → icon, for an expanded folder. */
export const FOLDER_OPEN_ICONS: Record<string, string> = {
${record(folderOpenIcons)}
};

export const DEFAULT_FILE_ICON = ${JSON.stringify(DEFAULT_FILE)};
export const DEFAULT_FOLDER_ICON = ${JSON.stringify(DEFAULT_FOLDER)};
export const DEFAULT_FOLDER_OPEN_ICON = ${JSON.stringify(DEFAULT_FOLDER_OPEN)};

/** The longest suffix any entry of {@link EXTENSION_ICONS} is, in dot-segments. */
export const MAX_EXTENSION_SEGMENTS = ${Math.max(
  ...Object.keys(extensionIcons).map((k) => k.split(".").length),
  ...Object.values(frameworks).flatMap((f) => Object.keys(f.extensions).map((k) => k.split(".").length)),
)};

/** Every icon this module can name, for the test that pairs the two files. */
export const ICON_NAMES: readonly string[] = ${JSON.stringify(names)};
`;

/**
 * A data URL rather than a sprite: one \`background-image\` per class is what
 * lets the browser cache each decoded icon independently, and a sprite would
 * need a second table of offsets that has to stay in step with the first.
 *
 * Only \`#\` and \`"\` have to be escaped for a URL inside \`url("…")\` — encoding
 * the whole body would add about a third to the file for no benefit, since the
 * transfer is compressed anyway.
 */
function dataUrl(body: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;
  return `data:image/svg+xml,${svg.replace(/"/g, "'").replace(/#/g, "%23").replace(/\n/g, "")}`;
}

const css = `/**
 * GENERATED by \`bun scripts/gen-file-icons.ts\` — do not edit.
 *
 * The vscode-icons file icon theme (MIT, vscode-icons-team), one class per
 * glyph. Sizing and layout live with the component in \`file-icons.tsx\`; this
 * file is nothing but the artwork.
 *
 * The theme draws some glyphs twice, and the second drawing is for a light
 * workbench — so the bare class is the dark-theme artwork and \`:root.light\`
 * swaps in the other. \`apply-theme.ts\` puts one of those two classes on
 * \`<html>\`, and \`index.html\` starts at \`class="dark"\`, so there is no frame
 * with neither.
 */
${names
  .map((name) => `.vsi-${name} {\n  background-image: url("${dataUrl(used.get(name)!.dark)}");\n}`)
  .join("\n")}

${names
  .filter((name) => used.get(name)!.light)
  .map(
    (name) =>
      `:root.light .vsi-${name} {\n  background-image: url("${dataUrl(used.get(name)!.light!)}");\n}`,
  )
  .join("\n")}
`;

writeFileSync(OUT_TS, ts);
writeFileSync(OUT_CSS, css);

const bodyBytes = [...used.values()].reduce(
  (n, g) => n + g.dark.length + (g.light?.length ?? 0),
  0,
);
console.log(
  `file icons  vscode-icons ${MANIFEST_VERSION}  ${used.size} glyphs ` +
    `(${lightVariants} with a light-theme drawing)`,
);
console.log(
  `            ${Object.keys(extensionIcons).length} extensions  ` +
    `${Object.keys(filenameIcons).length} filenames  ` +
    `${Object.keys(folderIcons).length} folders  ` +
    Object.entries(frameworks)
      .map(([k, o]) => `${Object.keys(o.extensions).length + Object.keys(o.names).length} ${k}`)
      .join("  "),
);
console.log(
  `            ${(Buffer.byteLength(ts) / 1024).toFixed(1)} KiB of mapping (JS)  ` +
    `${(Buffer.byteLength(css) / 1024).toFixed(1)} KiB of artwork (CSS)  ` +
    `${(bodyBytes / 1024).toFixed(1)} KiB raw path data`,
);
if (missing.size > 0) console.log(`            not in the collection: ${[...missing].join(", ")}`);
if (overBudget.size > 0) {
  const worst = [...overBudget.entries()].sort((a, b) => b[1] - a[1]);
  console.log(
    `            over the ${MAX_BODY_BYTES}-byte budget, so left out: ${overBudget.size} ` +
      `(worst: ${worst.slice(0, 4).map(([k, n]) => `${k} ${(n / 1024).toFixed(0)}K`).join(", ")})`,
  );
}
