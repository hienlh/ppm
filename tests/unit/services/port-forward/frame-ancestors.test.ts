import { afterEach, describe, expect, test } from "bun:test";
import {
  allowFramingFrom,
  cspOrigin,
  forgetFramingOriginsForTest,
  framingOrigins,
  letOriginsFrame,
} from "../../../../src/services/port-forward/frame-ancestors.ts";

const PPM = "http://192.168.1.20:3210";
const PPM_TS = "https://ppm.tail1234.ts.net";

function framed(init: HeadersInit, origins: string[] = [PPM]): Headers {
  const headers = new Headers(init);
  letOriginsFrame(headers, origins);
  return headers;
}

afterEach(forgetFramingOriginsForTest);

describe("cspOrigin", () => {
  test("takes an origin as a browser serializes it", () => {
    for (const origin of [PPM, PPM_TS, "http://localhost:5173", "https://ppm.example.com"]) {
      expect(cspOrigin(origin)).toBe(origin);
    }
  });

  test("refuses what a CSP source list cannot name, or a value that would break out of one", () => {
    for (const value of [
      undefined, 3, "", "null", "http://[::1]:3210", "https://ppm.example.com/", "https://ppm.example.com/x",
      "javascript:alert(1)", "file:///etc/passwd", "ftp://ppm.example.com", "HTTPS://PPM.EXAMPLE.COM",
      "http://ppm.example.com:80", "http://ppm.example.com; script-src *", "http://a_b.example.com",
    ]) {
      expect(cspOrigin(value)).toBeNull();
    }
  });
});

test("allowFramingFrom keeps the sixteen origins used most recently", () => {
  expect(allowFramingFrom("http://[::1]:3210")).toBeNull();
  for (let i = 1; i <= 17; i++) allowFramingFrom(`http://10.0.0.${i}:3210`);
  expect(allowFramingFrom("http://10.0.0.2:3210")).toBe("http://10.0.0.2:3210");
  const origins = framingOrigins();
  expect(origins).toHaveLength(16);
  expect(origins).not.toContain("http://10.0.0.1:3210");
  expect(origins[0]).toBe("http://10.0.0.3:3210");
  expect(origins.at(-1)).toBe("http://10.0.0.2:3210");
});

describe("letOriginsFrame", () => {
  test("turns SAMEORIGIN, Rails' default, into the page's own origin plus PPM", () => {
    const headers = framed({ "x-frame-options": "SAMEORIGIN" });
    expect(headers.get("x-frame-options")).toBeNull();
    expect(headers.get("content-security-policy")).toBe(`frame-ancestors 'self' ${PPM}`);
  });

  test("turns DENY, Django's default, into PPM alone", () => {
    const headers = framed({ "x-frame-options": "DENY" }, [PPM, PPM_TS]);
    expect(headers.get("x-frame-options")).toBeNull();
    expect(headers.get("content-security-policy")).toBe(`frame-ancestors ${PPM} ${PPM_TS}`);
  });

  test("reads conflicting values as a refusal and an unknown one as none, the way HTML does", () => {
    // SAMEORIGIN alone would let the page's own origin in; beside another value it refuses everyone.
    expect(framed({ "x-frame-options": "SAMEORIGIN, ALLOWALL" }).get("content-security-policy")).toBe(`frame-ancestors ${PPM}`);
    const unknown = framed({ "x-frame-options": "ALLOW-FROM https://partner.example" });
    expect(unknown.get("x-frame-options")).toBeNull();
    expect(unknown.get("content-security-policy")).toBeNull();
  });

  test("adds PPM to the page's own frame-ancestors, keeping everything else it says", () => {
    const headers = framed({
      "content-security-policy": "default-src 'self'; frame-ancestors 'self' https://partner.example; img-src *",
      "x-frame-options": "SAMEORIGIN",
    });
    expect(headers.get("content-security-policy"))
      .toBe(`default-src 'self'; frame-ancestors 'self' https://partner.example ${PPM}; img-src *`);
    expect(headers.get("x-frame-options")).toBeNull();
  });

  test("drops 'none', which a browser ignores once it stands beside a source", () => {
    expect(framed({ "content-security-policy": "frame-ancestors 'none'" }).get("content-security-policy"))
      .toBe(`frame-ancestors ${PPM}`);
    expect(framed({ "content-security-policy": "frame-ancestors" }).get("content-security-policy"))
      .toBe(`frame-ancestors ${PPM}`);
  });

  test("extends every policy that limits framing, and leaves the others", () => {
    const headers = framed([
      ["content-security-policy", "script-src 'self'"],
      ["content-security-policy", "frame-ancestors 'self'"],
    ]);
    expect(headers.get("content-security-policy")).toBe(`script-src 'self', frame-ancestors 'self' ${PPM}`);
  });

  test("names each origin once", () => {
    expect(framed({ "content-security-policy": `frame-ancestors ${PPM}` }, [PPM, PPM_TS]).get("content-security-policy"))
      .toBe(`frame-ancestors ${PPM} ${PPM_TS}`);
  });

  test("leaves a page that restricts nothing, a report-only policy, and every page before PPM is known", () => {
    expect(framed({ "content-security-policy": "default-src 'self'" }).get("content-security-policy")).toBe("default-src 'self'");
    const reportOnly = framed({ "content-security-policy-report-only": "frame-ancestors 'none'" });
    expect(reportOnly.get("content-security-policy-report-only")).toBe("frame-ancestors 'none'");
    expect(reportOnly.get("content-security-policy")).toBeNull();
    const unknown = framed({ "x-frame-options": "DENY" }, []);
    expect(unknown.get("x-frame-options")).toBe("DENY");
    expect(unknown.get("content-security-policy")).toBeNull();
  });
});
