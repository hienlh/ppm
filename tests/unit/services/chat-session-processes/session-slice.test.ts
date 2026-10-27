import { describe, expect, it } from "bun:test";
import {
  chatSessionIdOf, instanceSliceName, instanceTag, SLICE_ENV, sessionIdOfSlice, sessionSliceName, withSessionSlice,
} from "../../../../src/services/chat-session-processes/session-slice.ts";

const SESSION = "9788398e-17b7-4ad6-93c0-6356ed3f409e";
const SHELL = { prefix: "/home/u/.ppm/bin/chat-session-shell/run", pathDir: "/home/u/.ppm/bin/chat-session-shell/path" };

describe("session slice names", () => {
  it("names an instance after its database, so dev and prod sharing ~/.ppm stay apart", () => {
    const prod = instanceTag("/home/u/.ppm/ppm.db");
    expect(prod).toMatch(/^[0-9a-f]{8}$/);
    expect(instanceTag("/home/u/.ppm/ppm.db")).toBe(prod);
    expect(instanceTag("/home/u/.ppm/ppm.dev.db")).not.toBe(prod);
  });

  it("nests every session slice of an instance under the instance's slice", () => {
    const slice = sessionSliceName("abcd1234", SESSION)!;
    expect(slice).toBe("app-ppmchat-abcd1234-9788398e17b74ad693c06356ed3f409e.slice");
    // A '-' is a level in systemd: the session slice is a child of the instance slice.
    expect(slice.startsWith(instanceSliceName("abcd1234").replace(/\.slice$/, "-"))).toBe(true);
  });

  it("reads the session id back from the name, and only from its own instance's names", () => {
    const slice = sessionSliceName("abcd1234", SESSION)!;
    expect(sessionIdOfSlice("abcd1234", slice)).toBe(SESSION);
    expect(sessionIdOfSlice("ffff0000", slice)).toBeNull();
    expect(sessionIdOfSlice("abcd1234", "app-ppmchat-abcd1234.slice")).toBeNull();
    expect(sessionIdOfSlice("abcd1234", "app-ppmchat-abcd1234-xyz.slice")).toBeNull();
  });

  it("gives no slice to an id it could not read back", () => {
    expect(sessionSliceName("abcd1234", "not-a-uuid")).toBeNull();
    expect(sessionSliceName("abcd1234", SESSION.toUpperCase())).toBeNull();
  });
});

describe("chatSessionIdOf", () => {
  it("takes a new session's id, or the one it resumes", () => {
    expect(chatSessionIdOf({ sessionId: SESSION })).toBe(SESSION);
    expect(chatSessionIdOf({ resume: SESSION })).toBe(SESSION);
  });

  it("leaves a fork's first CLI untracked rather than filed under its source", () => {
    expect(chatSessionIdOf({ resume: SESSION, forkSession: true })).toBeUndefined();
    expect(chatSessionIdOf(undefined)).toBeUndefined();
  });
});

describe("withSessionSlice", () => {
  const base = { PATH: "/usr/bin:/bin", HOME: "/home/u" };

  it("routes the CLI's commands into the slice and puts the shim first on PATH", () => {
    const env = withSessionSlice(base, "app-ppmchat-a-b.slice", SHELL);
    expect(env[SLICE_ENV]).toBe("app-ppmchat-a-b.slice");
    expect(env.CLAUDE_CODE_SHELL_PREFIX).toBe(SHELL.prefix);
    expect(env.PATH).toBe(`${SHELL.pathDir}:/usr/bin:/bin`);
    expect(env.HOME).toBe("/home/u");
    expect(base.PATH).toBe("/usr/bin:/bin");
  });

  it("drops a routing inherited from a chat PPM was started in, tracked or not", () => {
    const inherited = {
      ...base,
      [SLICE_ENV]: "app-ppmchat-parent-x.slice",
      CLAUDE_CODE_SHELL_PREFIX: "/home/u/.ppm/bin/chat-session-shell/run",
      PATH: `/home/u/.ppm/bin/chat-session-shell/path:/usr/bin:/bin`,
    };
    const untracked = withSessionSlice(inherited, null, null);
    expect(untracked[SLICE_ENV]).toBeUndefined();
    expect(untracked.CLAUDE_CODE_SHELL_PREFIX).toBeUndefined();
    expect(untracked.PATH).toBe("/usr/bin:/bin");

    const scratch = { prefix: "/tmp/scratch/bin/chat-session-shell/run", pathDir: "/tmp/scratch/bin/chat-session-shell/path" };
    const tracked = withSessionSlice(inherited, "app-ppmchat-own-y.slice", scratch);
    expect(tracked[SLICE_ENV]).toBe("app-ppmchat-own-y.slice");
    expect(tracked.CLAUDE_CODE_SHELL_PREFIX).toBe(scratch.prefix);
    expect(tracked.PATH).toBe(`${scratch.pathDir}:/usr/bin:/bin`);
  });

  it("leaves a prefix of the user's own alone, and the session untracked", () => {
    const env = withSessionSlice({ ...base, CLAUDE_CODE_SHELL_PREFIX: "/usr/local/bin/audit" }, "app-ppmchat-a-b.slice", SHELL);
    expect(env.CLAUDE_CODE_SHELL_PREFIX).toBe("/usr/local/bin/audit");
    expect(env[SLICE_ENV]).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("does not route through a prefix path the CLI would split at ' -'", () => {
    const env = withSessionSlice(base, "app-ppmchat-a-b.slice", { prefix: "/home/u/my -dir/run", pathDir: "/home/u/my -dir/path" });
    expect(env.CLAUDE_CODE_SHELL_PREFIX).toBeUndefined();
    expect(env[SLICE_ENV]).toBeUndefined();
  });

  it("never invents a PATH", () => {
    const env = withSessionSlice({ HOME: "/home/u" }, "app-ppmchat-a-b.slice", SHELL);
    expect(env.PATH).toBeUndefined();
    expect(env[SLICE_ENV]).toBeUndefined();
  });
});
