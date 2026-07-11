import { describe, expect, it } from "bun:test";
import { isBlockedIp } from "../../../../src/services/theme-import/fetch-url";
import { isUnsafeEntryName } from "../../../../src/services/theme-import/unzip-vsix";
import { assertSafeColor, sanitizeName, validatePpmTheme } from "../../../../src/services/theme-import/validate-theme";
import { convertVscodeTheme } from "../../../../src/services/theme-import/vscode-converter";

describe("SSRF: isBlockedIp", () => {
  it("blocks private / loopback / link-local IPv4", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.5", "192.168.1.1", "100.64.0.1", "0.0.0.0"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });
  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "140.82.112.3"]) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });
  it("blocks loopback / link-local / ULA IPv6 and mapped v4", () => {
    for (const ip of ["::1", "fe80::1", "fc00::1", "fd12::3", "::ffff:127.0.0.1"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });
  it("treats non-IP strings as blocked", () => {
    expect(isBlockedIp("evil.example.com")).toBe(true);
  });
});

describe("zip-slip: isUnsafeEntryName", () => {
  it("rejects path traversal / absolute paths", () => {
    for (const name of ["../secret", "extension/../../etc/passwd", "/etc/passwd", "\\windows", "C:/win"]) {
      expect(isUnsafeEntryName(name)).toBe(true);
    }
  });
  it("accepts normal entry names", () => {
    expect(isUnsafeEntryName("extension/themes/dracula.json")).toBe(false);
    expect(isUnsafeEntryName("extension/package.json")).toBe(false);
  });
});

describe("color validator", () => {
  it("accepts valid colors", () => {
    for (const c of ["#fff", "#0a0e17", "#0a0e17ff", "rgb(1,2,3)", "rgba(1,2,3,0.5)", "hsl(200,50%,40%)", "tomato"]) {
      expect(assertSafeColor(c, "t")).toBe(c);
    }
  });
  it("rejects CSS injection attempts", () => {
    for (const c of ["red; } body{display:none}", "url(http://x)", "expression(alert(1))", "#fff<script>", "var(--x)"]) {
      expect(() => assertSafeColor(c, "t")).toThrow();
    }
  });
  it("sanitizeName strips unsafe chars and bounds length", () => {
    expect(sanitizeName("Dracula <b>")).toBe("Dracula b");
    expect(sanitizeName("")).toBe("Imported Theme");
    expect(sanitizeName("a".repeat(200)).length).toBe(64);
  });
});

describe("vscode-converter", () => {
  it("converts a minimal dark theme into a valid PpmTheme", () => {
    const theme = convertVscodeTheme({
      name: "Test Dark",
      type: "dark",
      colors: {
        "editor.background": "#101216",
        "foreground": "#e6e6e6",
        "focusBorder": "#5b8cff",
        "button.foreground": "#ffffff",
      },
      tokenColors: [{ scope: "comment", settings: { foreground: "#7f8c98", fontStyle: "italic" } }],
    });
    expect(theme.style).toBe("custom");
    expect(theme.mode).toBe("dark");
    expect(theme.tokens.bgSolid).toBe("#101216");
    expect(theme.tokens.accent).toBe("#5b8cff");
    expect(theme.id.startsWith("custom-")).toBe(true);
    expect(theme.editor?.rules?.[0]?.foreground).toBe("7f8c98"); // '#' stripped for Monaco
    // The full result must pass the security validator.
    expect(() => validatePpmTheme(theme)).not.toThrow();
  });

  it("ignores malicious color values, falling back to safe defaults", () => {
    const theme = convertVscodeTheme({
      type: "dark",
      colors: { "editor.background": "red; } html{}", "foreground": "url(x)" },
    });
    // Malicious values dropped → defaults used → still valid.
    expect(() => validatePpmTheme(theme)).not.toThrow();
    expect(theme.tokens.bgSolid).not.toContain(";");
  });
});
