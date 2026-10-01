import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  DEFAULT_SYSTEM_ID, isValidSystemId, normalizeSystemRoot, parseSystemFile, serializeSystemFile,
  systemAppRoot, systemDeclDir, systemFilesDir, systemsRoot,
} from "../../../src/services/design/design-systems-paths.ts";

describe("isValidSystemId", () => {
  it("follows the same rules as a design slug", () => {
    expect(isValidSystemId("payroll-fe")).toBe(true);
    expect(isValidSystemId("default")).toBe(true);
    expect(isValidSystemId("Bad_Id")).toBe(false);
    expect(isValidSystemId("systems")).toBe(false); // reserved: the route mounted beside /:slug
    expect(isValidSystemId("")).toBe(false);
    expect(isValidSystemId(42)).toBe(false);
  });
});

describe("systemFilesDir", () => {
  it("keeps the default app's files at the legacy designs/ root, every other app under systems/<id>/", () => {
    const root = join("/proj", "designs");
    expect(systemFilesDir(root, DEFAULT_SYSTEM_ID)).toBe(root);
    expect(systemFilesDir(root, "myapp")).toBe(join(root, "systems", "myapp"));
    expect(systemDeclDir(root, DEFAULT_SYSTEM_ID)).toBe(join(root, "systems", "default"));
    expect(systemsRoot(root)).toBe(join(root, "systems"));
  });
});

describe("normalizeSystemRoot", () => {
  const project = join("/work", "nxsys");

  it("accepts the project root and a plain relative folder", () => {
    expect(normalizeSystemRoot(project, ".")).toBe(".");
    expect(normalizeSystemRoot(project, undefined)).toBeNull(); // must be a string
    expect(normalizeSystemRoot(project, "")).toBe(".");
    expect(normalizeSystemRoot(project, "payroll-fe")).toBe("payroll-fe");
    expect(normalizeSystemRoot(project, "./payroll-fe")).toBe("payroll-fe");
    expect(normalizeSystemRoot(project, "apps/payroll-fe")).toBe("apps/payroll-fe");
    expect(normalizeSystemRoot(project, "payroll-fe\\ui")).toBe("payroll-fe/ui");
  });

  it("refuses an absolute path, a drive letter, .. and a .design segment", () => {
    for (const bad of ["/etc/passwd", "C:\\Windows", "../outside", "apps/../../etc", "apps/.design/x", 123]) {
      expect(normalizeSystemRoot(project, bad)).toBeNull();
    }
  });
});

describe("system.json parse/serialize", () => {
  const fallback = { id: "myapp", projectRoot: join("/work", "nxsys") };

  it("is tolerant: a missing or broken file falls back field by field", () => {
    expect(parseSystemFile(null, fallback)).toEqual({ label: "myapp", root: ".", platform: "web" });
    expect(parseSystemFile("{ broken", fallback)).toEqual({ label: "myapp", root: ".", platform: "web" });
    expect(parseSystemFile("[]", fallback)).toEqual({ label: "myapp", root: ".", platform: "web" });
  });

  it("keeps a valid root and platform, and drops an out-of-project root back to the project itself", () => {
    const parsed = parseSystemFile(JSON.stringify({ label: "Payroll", root: "payroll-fe", platform: "mobile" }), fallback);
    expect(parsed).toEqual({ label: "Payroll", root: "payroll-fe", platform: "mobile" });
    const escaping = parseSystemFile(JSON.stringify({ label: "X", root: "../../etc", platform: "web" }), fallback);
    expect(escaping.root).toBe("."); // the escaping value is refused, not followed
  });

  it("keeps a valid builtFrom, and drops a malformed one", () => {
    const withBuilt = parseSystemFile(JSON.stringify({
      label: "X", root: ".", platform: "web", builtFrom: { commit: "abc1234", at: "2026-01-01T00:00:00.000Z" },
    }), fallback);
    expect(withBuilt.builtFrom).toEqual({ commit: "abc1234", at: "2026-01-01T00:00:00.000Z" });
    const bad = parseSystemFile(JSON.stringify({ label: "X", root: ".", platform: "web", builtFrom: { commit: "zz", at: "no" } }), fallback);
    expect(bad.builtFrom).toBeUndefined();
  });

  it("round-trips through serialize, omitting builtFrom when absent", () => {
    const file = { label: "Payroll", root: "payroll-fe", platform: "mobile" as const };
    const raw = serializeSystemFile(file);
    expect(raw).not.toContain("builtFrom");
    expect(parseSystemFile(raw, fallback)).toEqual(file);
  });
});

describe("systemAppRoot", () => {
  it("resolves the app's real root against the project root", () => {
    expect(systemAppRoot("/work/nxsys", "payroll-fe")).toBe(join("/work/nxsys", "payroll-fe"));
    expect(systemAppRoot("/work/nxsys", ".")).toBe(join("/work/nxsys"));
  });
});
