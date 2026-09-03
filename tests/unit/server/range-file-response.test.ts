import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRangeHeader, rangeFileResponse } from "../../../src/server/helpers/range-file-response.ts";

describe("parseRangeHeader", () => {
  const size = 1000;

  it("returns null for absent, malformed or multi-range headers", () => {
    expect(parseRangeHeader(null, size)).toBeNull();
    expect(parseRangeHeader("", size)).toBeNull();
    expect(parseRangeHeader("bytes=", size)).toBeNull();
    expect(parseRangeHeader("bytes=-", size)).toBeNull();
    expect(parseRangeHeader("items=0-10", size)).toBeNull();
    expect(parseRangeHeader("bytes=0-1,5-9", size)).toBeNull();
  });

  it("parses closed, open-ended and suffix ranges", () => {
    expect(parseRangeHeader("bytes=0-99", size)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader("bytes=500-", size)).toEqual({ start: 500, end: 999 });
    expect(parseRangeHeader("bytes=-100", size)).toEqual({ start: 900, end: 999 });
  });

  it("clamps an end past EOF and a suffix larger than the file", () => {
    expect(parseRangeHeader("bytes=990-5000", size)).toEqual({ start: 990, end: 999 });
    expect(parseRangeHeader("bytes=-5000", size)).toEqual({ start: 0, end: 999 });
  });

  it("flags unsatisfiable ranges", () => {
    expect(parseRangeHeader("bytes=1000-", size)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=50-10", size)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=-0", size)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=0-", 0)).toBe("unsatisfiable");
  });
});

describe("rangeFileResponse", () => {
  let dir: string;
  let file: string;
  const body = "0123456789".repeat(10); // 100 bytes

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "range-resp-"));
    file = join(dir, "clip.mp4");
    writeFileSync(file, body);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const req = (range?: string) => new Request("http://x/raw", { headers: range ? { range } : {} });

  it("answers 200 with Accept-Ranges and Content-Length when no Range is sent", async () => {
    const res = rangeFileResponse(file, req());
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("100");
    expect(res.headers.get("content-type")).toContain("video/mp4");
    expect(await res.text()).toBe(body);
  });

  it("answers 206 with the requested slice", async () => {
    const res = rangeFileResponse(file, req("bytes=10-19"));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(res.headers.get("content-length")).toBe("10");
    expect(await res.text()).toBe("0123456789");
  });

  it("serves the tail for an open-ended range", async () => {
    const res = rangeFileResponse(file, req("bytes=95-"));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 95-99/100");
    expect(await res.text()).toBe("56789");
  });

  it("answers 416 for a range beyond EOF", async () => {
    const res = rangeFileResponse(file, req("bytes=100-"));
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */100");
  });

  it("applies extra headers and a content-type override", () => {
    const res = rangeFileResponse(file, req(), { "Content-Disposition": "attachment" }, "application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe("attachment");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });
});
