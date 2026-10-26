import { describe, it, expect } from "bun:test";
import {
  buildExtensionDeepLink, parseExtensionDeepLink, stripExtensionDeepLink, deepLinkArgsProblem, deepLinkableCommands,
} from "../../../src/shared/extension-deep-link.ts";
import { contributionRegistry } from "../../../src/services/contribution-registry.ts";
import { notificationPath } from "../../../src/services/notification-format.ts";

/** base64url as the link carries it, so a bad case fails for the reason it names. */
const b64 = (text: string) => btoa(text).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

describe("buildExtensionDeepLink / parseExtensionDeepLink", () => {
  it("round-trips a project-scoped command with args, unicode included", () => {
    const path = buildExtensionDeepLink({ projectName: "my proj", open: { command: "midday.checkIn", args: ["Tiếng Việt ✓", 3, true, null] } });
    expect(path.startsWith("/project/my%20proj?extCommand=midday.checkIn&extArgs=")).toBe(true);
    expect(parseExtensionDeepLink(path)).toEqual({
      kind: "command", command: "midday.checkIn", args: ["Tiếng Việt ✓", 3, true, null], projectName: "my proj",
    });
  });

  it("leaves extArgs out when there are none, and has no project without one", () => {
    expect(buildExtensionDeepLink({ open: { command: "midday.checkIn" } })).toBe("/?extCommand=midday.checkIn");
    expect(parseExtensionDeepLink("/?extCommand=midday.checkIn")).toEqual({ kind: "command", command: "midday.checkIn", args: [] });
  });

  it("builds and parses a view link", () => {
    const path = buildExtensionDeepLink({ projectName: "ppm", open: { view: "midday.review" } });
    expect(path).toBe("/project/ppm?extView=midday.review");
    expect(parseExtensionDeepLink(path)).toEqual({ kind: "view", view: "midday.review", projectName: "ppm" });
  });

  it("parses an absolute URL as the push channel carries it", () => {
    expect(parseExtensionDeepLink("https://ppm.example.com/project/ppm?extView=a.b")).toMatchObject({ kind: "view", view: "a.b" });
  });

  it("survives notificationPath unchanged, so push, Telegram and ntfy all carry it", () => {
    const path = buildExtensionDeepLink({ projectName: "ppm", open: { command: "a.b", args: [1] } });
    expect(notificationPath({ project: "ppm", sessionId: "", path })).toBe(path);
  });

  it("refuses to build a link that breaks a limit", () => {
    expect(() => buildExtensionDeepLink({ open: { command: "bad id" } })).toThrow();
    expect(() => buildExtensionDeepLink({ open: { view: "" } })).toThrow();
    expect(() => buildExtensionDeepLink({ open: { command: "a.b", args: Array(9).fill(0) } })).toThrow();
  });

  for (const [label, url] of [
    ["no parameters", "/project/ppm"],
    ["both a command and a view", "/?extCommand=a.b&extView=a.b"],
    ["an id with a space", "/?extCommand=a%20b"],
    ["args that are not base64url", "/?extCommand=a.b&extArgs=***"],
    ["args that are not JSON", `/?extCommand=a.b&extArgs=${b64("nope")}`],
    ["args that are an object", `/?extCommand=a.b&extArgs=${b64(JSON.stringify({ a: 1 }))}`],
    ["more than 8 args", `/?extCommand=a.b&extArgs=${b64(JSON.stringify(Array(9).fill(1)))}`],
    ["a nested arg", `/?extCommand=a.b&extArgs=${b64(JSON.stringify([[1]]))}`],
  ] as const) {
    it(`gives null for ${label}`, () => {
      expect(parseExtensionDeepLink(url)).toBeNull();
    });
  }
});

describe("deepLinkArgsProblem", () => {
  it("accepts primitives within the limits and names what is wrong otherwise", () => {
    expect(deepLinkArgsProblem(["a", 1, false, null])).toBeNull();
    expect(deepLinkArgsProblem([Number.NaN])).toContain("finite");
    expect(deepLinkArgsProblem(["x".repeat(1100)])).toContain("1024 bytes");
    expect(deepLinkArgsProblem("a")).toContain("array");
  });
});

describe("deepLinkableCommands", () => {
  const commands = [{ command: "midday.checkIn" }, { command: "midday.done" }];

  it("keeps only entries the manifest also declares as commands", () => {
    expect(deepLinkableCommands({ commands, deepLinkCommands: ["midday.checkIn", "midday.ghost", 7] })).toEqual(["midday.checkIn"]);
  });

  it("is empty without the field, or with one that is not an array", () => {
    expect(deepLinkableCommands({ commands })).toEqual([]);
    expect(deepLinkableCommands({ commands, deepLinkCommands: "midday.checkIn" })).toEqual([]);
    expect(deepLinkableCommands(null)).toEqual([]);
  });
});

describe("contribution registry", () => {
  it("publishes each active extension's linkable commands, and forgets them when it deactivates", () => {
    // A fresh instance of the same class, so the shared singleton is left alone.
    const registry = new (contributionRegistry.constructor as unknown as new () => typeof contributionRegistry)();
    registry.register("ppm-midday", {
      commands: [{ command: "midday.checkIn", title: "Check-in" }, { command: "midday.done", title: "Done" }],
      deepLinkCommands: ["midday.checkIn", "not.declared"],
    });
    expect(registry.getAll().deepLinkCommands).toEqual(["midday.checkIn"]);
    registry.unregister("ppm-midday");
    expect(registry.getAll().deepLinkCommands).toEqual([]);
  });
});

describe("stripExtensionDeepLink", () => {
  it("removes only the deep-link parameters", () => {
    const stripped = stripExtensionDeepLink("http://h/project/p?keep=1&extCommand=a.b&extArgs=WzFd#x");
    expect(stripped.pathname + stripped.search + stripped.hash).toBe("/project/p?keep=1#x");
  });
});
