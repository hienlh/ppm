import { describe, it, expect, beforeEach, afterEach } from "bun:test";
// Isolates PPM_HOME and loads the config service before any service import reaches a database.
import "../../test-setup.ts";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileRoutes } from "../../../src/server/routes/files.ts";
import { fsBrowseRoutes } from "../../../src/server/routes/fs-browse.ts";
import { XLSX_PREVIEW_MAX_BYTES } from "../../../src/server/helpers/xlsx-preview.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { makeZip } from "../../helpers/make-zip.ts";

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function workbook(sheets: Record<string, string>): Uint8Array {
  const names = Object.keys(sheets);
  const files: Record<string, string> = {
    "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<workbook xmlns:r="${REL}"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
  };
  names.forEach((n, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${sheets[n]}</t></is></c></row></sheetData></worksheet>`;
  });
  return makeZip(files);
}

let root: string;
let project: string;

beforeEach(() => {
  setDb(openTestDb());
  root = mkdtempSync(join(tmpdir(), "xlsx-routes-"));
  project = join(root, "app");
  mkdirSync(project);
  writeFileSync(join(project, "book.xlsx"), workbook({ One: "first", Two: "second" }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function projectApp() {
  const app = new Hono<{ Variables: { projectPath: string; projectName: string } }>();
  app.use("*", (c, next) => {
    c.set("projectPath", project);
    c.set("projectName", "app");
    return next();
  });
  return app.route("/files", fileRoutes);
}
const fsApp = () => new Hono().route("/fs", fsBrowseRoutes);
const q = encodeURIComponent;

describe("GET /files/xlsx-sheet", () => {
  it("returns the sheet names and the chosen sheet's rows", async () => {
    const res = await projectApp().request(`/files/xlsx-sheet?path=book.xlsx&sheet=1`);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.sheets).toEqual(["One", "Two"]);
    expect(data.sheet).toBe(1);
    expect(data.rows).toEqual([["second"]]);
  });

  it("refuses a sibling directory whose name starts with the project's", async () => {
    const sibling = `${project}-secrets`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, "a.xlsx"), workbook({ S: "secret" }));
    const res = await projectApp().request(`/files/xlsx-sheet?path=${q(`../${basename(sibling)}/a.xlsx`)}`);
    expect(res.status).toBe(403);
  });

  it("refuses a path that climbs out of the project", async () => {
    writeFileSync(join(root, "x.xlsx"), workbook({ S: "out" }));
    expect((await projectApp().request(`/files/xlsx-sheet?path=${q("../x.xlsx")}`)).status).toBe(403);
    expect((await projectApp().request(`/files/xlsx-sheet?path=${q(join(root, "x.xlsx"))}`)).status).toBe(403);
  });

  it("answers 404 for a missing file or sheet, 400 for a bad sheet number", async () => {
    expect((await projectApp().request(`/files/xlsx-sheet?path=nope.xlsx`)).status).toBe(404);
    expect((await projectApp().request(`/files/xlsx-sheet?path=book.xlsx&sheet=7`)).status).toBe(404);
    expect((await projectApp().request(`/files/xlsx-sheet?path=book.xlsx&sheet=-1`)).status).toBe(400);
    expect((await projectApp().request(`/files/xlsx-sheet?path=book.xlsx&sheet=x`)).status).toBe(400);
  });

  it("answers 413 for a file past the preview limit", async () => {
    const big = join(project, "big.xlsx");
    writeFileSync(big, "");
    truncateSync(big, XLSX_PREVIEW_MAX_BYTES + 1);
    const res = await projectApp().request(`/files/xlsx-sheet?path=big.xlsx`);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("File too large to preview.");
  });

  it("names a legacy .xls renamed to .xlsx", async () => {
    writeFileSync(join(project, "old.xlsx"), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    const res = await projectApp().request(`/files/xlsx-sheet?path=old.xlsx`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("legacy .xls");
  });
});

describe("GET /fs/xlsx-sheet", () => {
  it("reads a workbook by absolute path", async () => {
    const res = await fsApp().request(`/fs/xlsx-sheet?path=${q(join(project, "book.xlsx"))}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.rows).toEqual([["first"]]);
  });

  it("refuses a symlink that points into the PPM directory", async () => {
    const inside = join(getPpmDir(), "leak.xlsx");
    writeFileSync(inside, workbook({ S: "credentials" }));
    const link = join(root, "innocent.xlsx");
    symlinkSync(inside, link);
    try {
      const res = await fsApp().request(`/fs/xlsx-sheet?path=${q(link)}`);
      expect(res.status).toBe(403);
    } finally {
      rmSync(inside, { force: true });
    }
  });

  it("requires a path", async () => {
    expect((await fsApp().request(`/fs/xlsx-sheet`)).status).toBe(400);
  });
});
