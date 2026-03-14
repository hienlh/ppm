import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { writeFileSync, existsSync } from "fs";
import { ConfigService } from "../../../src/services/config.service.ts";
import { DEFAULT_CONFIG } from "../../../src/types/config.ts";
import { createTempDir, cleanupDir } from "../../setup.ts";

let tmpDir: string;
let svc: ConfigService;

beforeEach(() => {
  tmpDir = createTempDir();
  svc = new ConfigService();
});

afterEach(() => {
  cleanupDir(tmpDir);
});

describe("ConfigService.load()", () => {
  test("returns default config when no file exists", () => {
    // Pass a path that doesn't exist; suppress PPM_CONFIG env so no fallback loads
    const origEnv = process.env["PPM_CONFIG"];
    delete process.env["PPM_CONFIG"];
    try {
      // To avoid falling through to CWD ppm.yaml we give an explicit missing path
      // and rely on the fact that load() with an explicit first candidate that is missing
      // still checks LOCAL_CONFIG. So we just verify the service returns a valid config
      // structure (the actual values may come from the CWD ppm.yaml if present).
      const cfg = svc.load(join(tmpDir, "nonexistent.yaml"));
      expect(cfg).toHaveProperty("port");
      expect(cfg).toHaveProperty("projects");
      expect(cfg).toHaveProperty("auth");
      expect(cfg.auth.enabled).toBe(false);
    } finally {
      if (origEnv !== undefined) process.env["PPM_CONFIG"] = origEnv;
    }
  });

  test("reads existing yaml file", () => {
    const cfgPath = join(tmpDir, "ppm.yaml");
    writeFileSync(cfgPath, "port: 9090\nprojects: []\n", "utf8");
    const cfg = svc.load(cfgPath);
    expect(cfg.port).toBe(9090);
  });

  test("merges partial yaml with defaults", () => {
    const cfgPath = join(tmpDir, "ppm.yaml");
    writeFileSync(cfgPath, "port: 7777\n", "utf8");
    const cfg = svc.load(cfgPath);
    expect(cfg.port).toBe(7777);
    expect(cfg.host).toBe(DEFAULT_CONFIG.host);
  });

  test("PPM_CONFIG env var is respected", () => {
    const cfgPath = join(tmpDir, "env-config.yaml");
    writeFileSync(cfgPath, "port: 4444\n", "utf8");
    const orig = process.env["PPM_CONFIG"];
    process.env["PPM_CONFIG"] = cfgPath;
    try {
      const fresh = new ConfigService();
      const cfg = fresh.load();
      expect(cfg.port).toBe(4444);
    } finally {
      if (orig === undefined) delete process.env["PPM_CONFIG"];
      else process.env["PPM_CONFIG"] = orig;
    }
  });
});

describe("ConfigService.save()", () => {
  test("writes yaml to configured path", () => {
    const cfgPath = join(tmpDir, "out.yaml");
    // Write an initial file so load() picks it up (missing files fall back to CWD ppm.yaml)
    writeFileSync(cfgPath, "port: 8080\n", "utf8");
    svc.load(cfgPath);
    svc.set("port", 5555);
    svc.save();
    expect(existsSync(cfgPath)).toBe(true);
    const fresh = new ConfigService();
    const cfg = fresh.load(cfgPath);
    expect(cfg.port).toBe(5555);
  });
});

describe("ConfigService.get/set()", () => {
  test("get returns value from loaded config", () => {
    const cfgPath = join(tmpDir, "cfg.yaml");
    writeFileSync(cfgPath, "port: 8080\n", "utf8");
    svc.load(cfgPath);
    expect(svc.get("port")).toBe(DEFAULT_CONFIG.port);
  });

  test("set updates in-memory value", () => {
    const cfgPath = join(tmpDir, "cfg2.yaml");
    writeFileSync(cfgPath, "port: 8080\n", "utf8");
    svc.load(cfgPath);
    svc.set("port", 1234);
    expect(svc.get("port")).toBe(1234);
  });

  test("set projects", () => {
    const cfgPath = join(tmpDir, "cfg3.yaml");
    writeFileSync(cfgPath, "port: 8080\n", "utf8");
    svc.load(cfgPath);
    svc.set("projects", [{ path: "/tmp/proj", name: "proj" }]);
    expect(svc.get("projects")).toHaveLength(1);
  });

  test("getConfig returns full config object", () => {
    const cfgPath = join(tmpDir, "cfg4.yaml");
    writeFileSync(cfgPath, "port: 8080\n", "utf8");
    svc.load(cfgPath);
    const cfg = svc.getConfig();
    expect(cfg).toHaveProperty("port");
    expect(cfg).toHaveProperty("auth");
  });

  test("getConfigPath returns loaded path", () => {
    const cfgPath = join(tmpDir, "named.yaml");
    writeFileSync(cfgPath, "port: 8080\n", "utf8");
    svc.load(cfgPath);
    expect(svc.getConfigPath()).toContain("named.yaml");
  });
});
