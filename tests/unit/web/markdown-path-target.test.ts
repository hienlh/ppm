import { describe, expect, it } from "bun:test";
import {
  markdownUrlTransform,
  parseMarkdownFileTarget,
} from "../../../src/web/components/shared/markdown-context.ts";

describe("parseMarkdownFileTarget", () => {
  const paths = [
    "C:/Users/PC/project/src/app.ts",
    "C:\\Users\\PC\\project\\src\\app.ts",
    "/Users/alex/project/src/app.ts",
    "/home/alex/project/src/app.ts",
    "./src/app.ts",
    "../shared/app.ts",
    "src/app.ts",
    "Dockerfile",
    "Makefile",
    ".gitignore",
    "schema.custom-extension",
    "src/components",
    "src/components/",
    "docs",
    "docs/",
    "~/project/README.md",
    "src/app/[slug]/page.tsx",
  ];

  for (const path of paths) {
    it(`accepts local target ${path}`, () => {
      expect(parseMarkdownFileTarget(path)).toEqual({ path, line: undefined });
    });
  }

  it("normalizes the slash preceding a Windows drive", () => {
    expect(parseMarkdownFileTarget("/C:/Users/PC/app.ts")).toEqual({
      path: "C:/Users/PC/app.ts", line: undefined,
    });
  });

  for (const [href, path] of [
    ["file:///C:/Users/PC/My%20Project/app.ts", "C:/Users/PC/My Project/app.ts"],
    ["file:///home/alex/app.ts", "/home/alex/app.ts"],
    ["file://localhost/home/alex/app.ts", "/home/alex/app.ts"],
    ["file://localhost/C:/Users/PC/app.ts", "C:/Users/PC/app.ts"],
    ["./t%C3%A0i%20li%E1%BB%87u/%5Bslug%5D.md", "./tài liệu/[slug].md"],
  ]) {
    it(`decodes local destination ${href}`, () => {
      expect(parseMarkdownFileTarget(href!)).toEqual({ path, line: undefined });
    });
  }

  for (const [suffix, line] of [
    [":10", { start: 10, end: undefined }],
    [":10-20", { start: 10, end: 20 }],
    [":10:3", { start: 10, end: undefined }],
    ["#L10", { start: 10, end: undefined }],
    ["#L10-L20", { start: 10, end: 20 }],
  ] as const) {
    for (const path of ["src/app.ts", "C:/Users/PC/app.ts", "Dockerfile"]) {
      it(`extracts source location ${path}${suffix}`, () => {
        expect(parseMarkdownFileTarget(`${path}${suffix}`)).toEqual({ path, line });
      });
    }
  }

  it("decodes paths while preserving line ranges", () => {
    expect(parseMarkdownFileTarget("/C:/My%20Project/src/%5Bslug%5D.ts#L12-L18")).toEqual({
      path: "C:/My Project/src/[slug].ts", line: { start: 12, end: 18 },
    });
  });

  it("strips document anchors from local paths", () => {
    expect(parseMarkdownFileTarget("docs/guide.md#installation")).toEqual({
      path: "docs/guide.md", line: undefined,
    });
    expect(parseMarkdownFileTarget("#installation")).toBeNull();
  });

  for (const href of [
    "", "https://example.com/app.ts", "http://example.com/app.ts:10",
    "//example.com/app.ts", "mailto:person@example.com", "javascript:alert(1)",
    "data:text/plain,hello.ts", "vscode://file/C:/app.ts", "custom:app.ts",
    "file://server/share/app.ts", "src/*.ts", "src/app?.ts", "app.ts?raw=1",
    "bad%ZZ.ts", "bad%.ts", "bad%C3.ts", "src/%00app.ts", "src/%0Aapp.ts",
    "src/\u0000app.ts", "src/\napp.ts", "src/\rapp.ts", "src/\tapp.ts",
  ]) {
    it(`rejects nonlocal or invalid destination ${JSON.stringify(href)}`, () => {
      expect(parseMarkdownFileTarget(href)).toBeNull();
    });
  }

  for (const suffix of [":0", ":10-0", ":9007199254740992", "#L0", "#L10-L9007199254740992"]) {
    it(`does not expose invalid source location ${suffix}`, () => {
      const target = parseMarkdownFileTarget(`src/app.ts${suffix}`);
      expect(target?.line).toBeUndefined();
    });
  }
});

describe("markdownUrlTransform local destination safety", () => {
  for (const href of [
    "C:/Users/PC/app.ts:10", "C:\\Users\\PC\\app.ts:10", "/C:/Users/PC/app.ts#L10",
    "file:///home/alex/app.ts", "src/app/[slug]/page.tsx", "Dockerfile", "docs/",
    "https://example.com/docs",
  ]) {
    it(`preserves safe destination ${href}`, () => {
      expect(markdownUrlTransform(href)).toBe(href);
    });
  }

  for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>"]) {
    it(`strips unsafe destination ${href}`, () => {
      expect(markdownUrlTransform(href)).toBe("");
    });
  }
});
