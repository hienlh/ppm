import { describe, expect, it } from "bun:test";
import { parseTasks } from "../../../src/shared/spec-format.ts";
import { planWaves } from "../../../src/shared/spec-waves.ts";

const plan = (text: string) => planWaves(parseTasks(text).topLevel);

describe("planWaves", () => {
  it("puts independent tasks in one wave and dependants after", () => {
    const p = plan(`- [ ] 1. Types
  - _Files: types.ts_
- [ ] 2. HTML
  - _Deps: 1_
  - _Files: html.ts_
- [ ] 3. Menu
  - _Deps: 1_
  - _Files: menu.tsx_
- [ ] 4. Toast
  - _Deps: 2, 3_
  - _Files: toast.ts_
`);
    expect(p.waves).toEqual([["1"], ["2", "3"], ["4"]]);
    expect(p.issues).toEqual([]);
  });

  it("moves a task that shares a file with its wave to the next wave, with a reason", () => {
    const p = plan(`- [ ] 1. A
  - _Files: shared.ts, a.ts_
- [ ] 2. B
  - _Files: b.ts, shared.ts_
- [ ] 3. C
  - _Files: c.ts_
`);
    expect(p.waves).toEqual([["1", "3"], ["2"]]);
    expect(p.moved).toEqual([{ id: "2", reason: expect.stringContaining("shared.ts") }]);
  });

  it("pushes a task's dependants after it when it moves", () => {
    const p = plan(`- [ ] 1. A
  - _Files: x.ts_
- [ ] 2. B
  - _Files: x.ts_
- [ ] 3. C
  - _Deps: 2_
  - _Files: c.ts_
`);
    expect(p.waves).toEqual([["1"], ["2"], ["3"]]);
  });

  it("runs a task that declares no files on its own", () => {
    const p = plan(`- [ ] 1. A
  - _Files: a.ts_
- [ ] 2. B
- [ ] 3. C
  - _Files: c.ts_
`);
    expect(p.waves).toEqual([["1", "3"], ["2"]]);
    expect(p.issues.some((i) => i.severity === "warning" && i.message.includes("2"))).toBe(true);
  });

  it("reports a dependency loop", () => {
    const p = plan(`- [ ] 1. A
  - _Deps: 2_
  - _Files: a.ts_
- [ ] 2. B
  - _Deps: 1_
  - _Files: b.ts_
`);
    expect(p.issues.some((i) => i.severity === "error" && /loop/i.test(i.message))).toBe(true);
  });

  it("leaves optional tasks out, and counts finished ones as satisfied", () => {
    const p = plan(`- [x] 1. A
  - _Files: a.ts_
- [ ] 2. B
  - _Deps: 1_
  - _Files: b.ts_
- [ ]* 3. C
  - _Files: c.ts_
`);
    expect(p.waves).toEqual([["1"], ["2"]]);
    expect(p.optional).toEqual(["3"]);
  });

  it("treats directory-prefix overlaps as shared files", () => {
    const p = plan(`- [ ] 1. A
  - _Files: src/export/_
- [ ] 2. B
  - _Files: src/export/html.ts_
`);
    expect(p.waves).toEqual([["1"], ["2"]]);
  });
});
