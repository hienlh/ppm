import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  generatePlist,
  generateSystemdService,
  generateVbsWrapper,
  buildSchtasksCommand,
  buildSchtasksDeleteCommand,
  buildSchtasksQueryCommand,
  buildExecCommand,
  getPlistPath,
  getServicePath,
  getVbsPath,
  PLIST_LABEL,
  TASK_NAME,
  isCompiledBinary,
} from "../../../src/services/autostart-generator.ts";

const TEST_CONFIG = {
  port: 3210,
  host: "0.0.0.0",
  share: false,
};

const TEST_CONFIG_WITH_SHARE = {
  ...TEST_CONFIG,
  share: true,
  configPath: "/home/user/.ppm/config.yaml",
  profile: "dev",
};

// ─── Plist (macOS launchd) ──────────────────────────────────────────────

describe("generatePlist", () => {
  test("returns valid XML plist structure", () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toStartWith('<?xml version="1.0"');
    expect(plist).toContain("<!DOCTYPE plist");
    expect(plist).toContain("<plist version=\"1.0\">");
    expect(plist).toContain("</plist>");
  });

  test("includes correct label", () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain(`<string>${PLIST_LABEL}</string>`);
  });

  test("includes RunAtLoad true", () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
  });

  test("includes KeepAlive with SuccessfulExit false", () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
  });

  test("uses absolute paths for log files (no ~ or $HOME)", () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).not.toContain("$HOME");
    expect(plist).not.toContain("~");
    // StandardOutPath and StandardErrorPath should have absolute paths
    expect(plist).toMatch(/<key>StandardOutPath<\/key>\s*<string>\/[^<]+<\/string>/);
    expect(plist).toMatch(/<key>StandardErrorPath<\/key>\s*<string>\/[^<]+<\/string>/);
  });

  test("log path points to ~/.ppm/ppm-launchd.log", () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain("ppm-launchd.log");
  });

  test("includes ProgramArguments with port and host", () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain("<string>__serve__</string>");
    expect(plist).toContain("<string>3210</string>");
    expect(plist).toContain("<string>0.0.0.0</string>");
  });

  test("includes ThrottleInterval to prevent restart thrashing", () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("<integer>10</integer>");
  });

  test("includes WorkingDirectory pointing to ~/.ppm", () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain(".ppm</string>");
  });

  test("escapes XML special characters in paths", () => {
    const config = { ...TEST_CONFIG, configPath: "/path/with<special>&chars" };
    const plist = generatePlist(config);
    expect(plist).not.toContain("<special>");
    expect(plist).toContain("&lt;special&gt;");
    expect(plist).toContain("&amp;chars");
  });
});

// ─── Systemd (Linux) ───────────────────────────────────────────────────

describe("generateSystemdService", () => {
  test("includes [Unit] section with network dependency", () => {
    const service = generateSystemdService(TEST_CONFIG);
    expect(service).toContain("[Unit]");
    expect(service).toContain("After=network-online.target");
    expect(service).toContain("Wants=network-online.target");
  });

  test("includes [Service] section with ExecStart", () => {
    const service = generateSystemdService(TEST_CONFIG);
    expect(service).toContain("[Service]");
    expect(service).toContain("ExecStart=");
    expect(service).toContain("__serve__");
    expect(service).toContain("3210");
  });

  test("includes restart policy", () => {
    const service = generateSystemdService(TEST_CONFIG);
    expect(service).toContain("Restart=on-failure");
    expect(service).toContain("RestartSec=5");
  });

  test("includes [Install] section with default.target", () => {
    const service = generateSystemdService(TEST_CONFIG);
    expect(service).toContain("[Install]");
    expect(service).toContain("WantedBy=default.target");
  });

  test("includes Type=simple", () => {
    const service = generateSystemdService(TEST_CONFIG);
    expect(service).toContain("Type=simple");
  });

  test("includes WorkingDirectory", () => {
    const service = generateSystemdService(TEST_CONFIG);
    expect(service).toContain("WorkingDirectory=");
    expect(service).toContain(".ppm");
  });

  test("includes description and documentation", () => {
    const service = generateSystemdService(TEST_CONFIG);
    expect(service).toContain("Description=PPM");
    expect(service).toContain("Documentation=https://github.com/hienlh/ppm");
  });
});

// ─── VBS Wrapper (Windows) ──────────────────────────────────────────────

describe("generateVbsWrapper", () => {
  test("creates WScript.Shell object", () => {
    const vbs = generateVbsWrapper(TEST_CONFIG);
    expect(vbs).toContain('CreateObject("WScript.Shell")');
  });

  test("uses Run method with hidden window flag (0)", () => {
    const vbs = generateVbsWrapper(TEST_CONFIG);
    expect(vbs).toContain(", 0, False");
  });

  test("includes __serve__ argument", () => {
    const vbs = generateVbsWrapper(TEST_CONFIG);
    expect(vbs).toContain("__serve__");
  });

  test("includes port in arguments", () => {
    const vbs = generateVbsWrapper(TEST_CONFIG);
    expect(vbs).toContain("3210");
  });
});

// ─── schtasks commands (Windows) ────────────────────────────────────────

describe("buildSchtasksCommand", () => {
  test("creates task with correct name", () => {
    const cmd = buildSchtasksCommand("/path/to/run-ppm.vbs");
    expect(cmd).toContain(TASK_NAME);
    expect(cmd).toContain("/tn");
  });

  test("uses onlogon schedule", () => {
    const cmd = buildSchtasksCommand("/path/to/run-ppm.vbs");
    expect(cmd).toContain("/sc");
    expect(cmd).toContain("onlogon");
  });

  test("includes cscript.exe to run VBS", () => {
    const cmd = buildSchtasksCommand("/path/to/run-ppm.vbs");
    const trIndex = cmd.indexOf("/tr");
    expect(trIndex).toBeGreaterThan(-1);
    expect(cmd[trIndex + 1]).toContain("cscript.exe");
  });

  test("includes force flag to overwrite existing", () => {
    const cmd = buildSchtasksCommand("/path/to/run-ppm.vbs");
    expect(cmd).toContain("/f");
  });

  test("includes vbs path in /tr argument", () => {
    const cmd = buildSchtasksCommand("/custom/path/run.vbs");
    const trValue = cmd[cmd.indexOf("/tr") + 1];
    expect(trValue).toContain("/custom/path/run.vbs");
  });
});

describe("buildSchtasksDeleteCommand", () => {
  test("uses /delete flag", () => {
    const cmd = buildSchtasksDeleteCommand();
    expect(cmd).toContain("/delete");
    expect(cmd).toContain(TASK_NAME);
    expect(cmd).toContain("/f");
  });
});

describe("buildSchtasksQueryCommand", () => {
  test("uses /query flag with LIST format", () => {
    const cmd = buildSchtasksQueryCommand();
    expect(cmd).toContain("/query");
    expect(cmd).toContain(TASK_NAME);
    expect(cmd).toContain("/fo");
    expect(cmd).toContain("LIST");
  });
});

// ─── buildExecCommand ───────────────────────────────────────────────────

describe("buildExecCommand", () => {
  test("includes __serve__ marker", () => {
    const cmd = buildExecCommand(TEST_CONFIG);
    expect(cmd).toContain("__serve__");
  });

  test("includes port and host", () => {
    const cmd = buildExecCommand(TEST_CONFIG);
    expect(cmd).toContain("3210");
    expect(cmd).toContain("0.0.0.0");
  });

  test("includes config path when provided", () => {
    const cmd = buildExecCommand(TEST_CONFIG_WITH_SHARE);
    expect(cmd).toContain("/home/user/.ppm/config.yaml");
  });

  test("includes profile when provided", () => {
    const cmd = buildExecCommand(TEST_CONFIG_WITH_SHARE);
    expect(cmd).toContain("dev");
  });

  test("first element is an absolute path", () => {
    const cmd = buildExecCommand(TEST_CONFIG);
    expect(cmd[0]).toMatch(/^\//); // starts with / on unix
  });
});

// ─── Path helpers ───────────────────────────────────────────────────────

describe("path helpers", () => {
  test("getPlistPath returns path in ~/Library/LaunchAgents/", () => {
    const path = getPlistPath();
    expect(path).toContain("Library/LaunchAgents");
    expect(path).toContain(PLIST_LABEL);
    expect(path).toEndWith(".plist");
  });

  test("getServicePath returns path in ~/.config/systemd/user/", () => {
    const path = getServicePath();
    expect(path).toContain(".config/systemd/user");
    expect(path).toEndWith("ppm.service");
  });

  test("getVbsPath returns path in ~/.ppm/", () => {
    const path = getVbsPath();
    expect(path).toContain(".ppm");
    expect(path).toEndWith("run-ppm.vbs");
  });
});

// ─── isCompiledBinary ───────────────────────────────────────────────────

describe("isCompiledBinary", () => {
  test("returns boolean", () => {
    const result = isCompiledBinary();
    expect(typeof result).toBe("boolean");
  });

  // When running tests via bun, execPath contains "bun"
  test("returns false when running under bun test", () => {
    expect(isCompiledBinary()).toBe(false);
  });
});

// ─── Constants ──────────────────────────────────────────────────────────

describe("constants", () => {
  test("PLIST_LABEL follows reverse-DNS convention", () => {
    expect(PLIST_LABEL).toMatch(/^[a-z]+\.[a-z]+\.[a-z]+$/);
  });

  test("TASK_NAME is a simple string", () => {
    expect(TASK_NAME).toBe("PPM");
  });
});
