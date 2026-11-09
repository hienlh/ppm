import { describe, expect, it } from "bun:test";
import { buildDesignCsp } from "../../../src/services/design/preview/design-csp.ts";
import { DESIGN_CDN_HOSTS } from "../../../src/shared/design-cdn-hosts.ts";

const SOURCE = "localhost:8080/api/design-preview/content/tok/";
const OWN = [`https://${SOURCE}`, `http://${SOURCE}`];
const directives = (policy: string): Map<string, string[]> =>
  new Map(policy.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name!, values]));

describe("design canvas CSP", () => {
  const policy = buildDesignCsp(SOURCE);
  const d = directives(policy);
  const cdns = DESIGN_CDN_HOSTS.map((h) => `https://${h}`);

  it("is exactly the canvas policy", () => {
    expect(policy).toBe([
      "sandbox allow-scripts",
      "default-src 'none'",
      `script-src 'unsafe-inline' 'unsafe-eval' ${OWN.join(" ")} ${cdns.join(" ")}`,
      `style-src 'unsafe-inline' ${OWN.join(" ")} ${cdns.join(" ")}`,
      `font-src ${OWN.join(" ")} data: ${cdns.join(" ")}`,
      `img-src ${OWN.join(" ")} data: blob: ${cdns.join(" ")}`,
      `media-src ${OWN.join(" ")} blob:`,
      `connect-src ${OWN.join(" ")}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
      "object-src 'none'",
    ].join("; "));
  });

  it("limits connect-src to the design's own source, with no wildcard anywhere", () => {
    expect(d.get("connect-src")).toEqual(OWN);
    for (const values of d.values()) for (const v of values) expect(v.includes("*")).toBe(false);
  });

  it("names every host with its scheme, since WebKit matches a scheme-less one against nothing in a sandboxed frame", () => {
    for (const [name, values] of d) {
      if (name === "sandbox") continue;
      for (const v of values) expect(v).toMatch(/^(?:'[a-z-]+'|[a-z]+:$|https?:\/\/)/);
    }
  });

  it("allows the five CDN hosts over https for scripts, styles, fonts and images only", () => {
    expect(DESIGN_CDN_HOSTS).toHaveLength(5);
    for (const name of ["script-src", "style-src", "font-src", "img-src"]) {
      for (const cdn of cdns) expect(d.get(name)).toContain(cdn);
    }
    for (const name of ["connect-src", "media-src", "default-src"]) {
      for (const cdn of cdns) expect(d.get(name) ?? []).not.toContain(cdn);
    }
  });

  it("allows eval, never same-origin, and modals only when asked", () => {
    expect(d.get("script-src")).toContain("'unsafe-eval'");
    expect(d.get("sandbox")).toEqual(["allow-scripts"]);
    expect(directives(buildDesignCsp(SOURCE, { allowModals: true })).get("sandbox")).toEqual(["allow-scripts", "allow-modals"]);
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).not.toContain("allow-top-navigation");
    expect(policy).not.toContain("allow-popups");
  });
});
