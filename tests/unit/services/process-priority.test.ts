/**
 * Raising a process that started below normal priority.
 *
 * The autostart task's default priority 7 handed the supervisor and every child —
 * the server included — memory priority 2 and I/O priority Low. The server's pages
 * were trimmed first and read back at the lowest I/O priority, and its event loop sat
 * in page-in waits for up to a minute on an idle machine.
 */
import { describe, it, expect } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import {
  priorityRaisePlan,
  describePriority,
  readProcessPriority,
  raiseToNormalPriority,
} from "../../../src/services/process-priority.ts";

describe("what gets raised", () => {
  it("raises each of the three that is below normal", () => {
    expect(priorityRaisePlan({ cpu: "below-normal", memory: 2, io: 1 })).toEqual({ cpu: true, memory: true, io: true });
    expect(priorityRaisePlan({ cpu: "idle", memory: 5, io: 2 })).toEqual({ cpu: true });
  });

  it("never lowers a priority someone set higher on purpose", () => {
    expect(priorityRaisePlan({ cpu: "high", memory: 5, io: 3 })).toEqual({});
    expect(priorityRaisePlan({ cpu: "above-normal" })).toEqual({});
  });

  it("does nothing with a reading it could not take", () => {
    expect(priorityRaisePlan({})).toEqual({});
  });

  it("says which of the three were low in one line", () => {
    expect(describePriority({ cpu: "below-normal", memory: 2, io: 1 })).toBe("cpu=below-normal memory=2/5 io=1/2");
    expect(describePriority({})).toBe("cpu=? memory=?/5 io=?/2");
  });
});

describe("off Windows", () => {
  it("reads nothing and changes nothing", async () => {
    expect(await readProcessPriority("linux")).toEqual({});
    expect((await raiseToNormalPriority("darwin")).changed).toBe(false);
  });
});

describe.if(process.platform === "win32")("on Windows, against this process", () => {
  it("brings a demoted process back to normal on all three", async () => {
    const k32 = dlopen("kernel32.dll", {
      SetPriorityClass: { args: [FFIType.i64, FFIType.u32], returns: FFIType.i32 },
      SetProcessInformation: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    }).symbols;
    const nt = dlopen("ntdll.dll", {
      NtSetInformationProcess: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    }).symbols;
    // Demote this test process the way a priority-7 task starts it.
    k32.SetPriorityClass(-1n, 0x4000);
    k32.SetProcessInformation(-1n, 0, ptr(new Uint32Array([2])), 4);
    nt.NtSetInformationProcess(-1n, 33, ptr(new Uint32Array([1])), 4);
    expect(await readProcessPriority()).toEqual({ cpu: "below-normal", memory: 2, io: 1 });

    const raised = await raiseToNormalPriority();
    expect(raised.changed).toBe(true);
    expect(raised.before).toEqual({ cpu: "below-normal", memory: 2, io: 1 });
    expect(raised.after).toEqual({ cpu: "normal", memory: 5, io: 2 });
    expect((await raiseToNormalPriority()).changed).toBe(false);
  });
});
