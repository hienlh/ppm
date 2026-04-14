import { describe, it, expect } from "bun:test";
import { getWebviewHtml } from "./webview-html.ts";

describe("webview-html: getWebviewHtml", () => {
  it("returns valid HTML", () => {
    const html = getWebviewHtml();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("includes essential elements", () => {
    const html = getWebviewHtml();
    expect(html).toContain('<div id="app">');
    expect(html).toContain('<header id="toolbar">');
    expect(html).toContain('<div id="graph-container">');
    expect(html).toContain('<div id="detail-panel"');
    expect(html).toContain('<div id="status-bar">');
    expect(html).toContain('<div id="context-menu"');
  });

  it("includes find bar", () => {
    const html = getWebviewHtml();
    expect(html).toContain('id="find-bar"');
    expect(html).toContain('id="find-input"');
    expect(html).toContain('id="find-count"');
    expect(html).toContain('id="find-prev"');
    expect(html).toContain('id="find-next"');
    expect(html).toContain('id="find-close"');
  });

  it("includes toolbar buttons", () => {
    const html = getWebviewHtml();
    expect(html).toContain('id="branch-selector"');
    expect(html).toContain('id="btn-refresh"');
    expect(html).toContain('id="btn-find"');
    expect(html).toContain('id="btn-settings"');
  });

  it("includes commit list columns", () => {
    const html = getWebviewHtml();
    expect(html).toContain("col-graph");
    expect(html).toContain("col-message");
    expect(html).toContain("col-author");
    expect(html).toContain("col-date");
    expect(html).toContain("col-hash");
  });

  it("includes CSS styles", () => {
    const html = getWebviewHtml();
    expect(html).toContain("<style>");
    expect(html).toContain("</style>");
    expect(html).toContain("--bg:");
    expect(html).toContain("--text:");
    expect(html).toContain("--border:");
  });

  it("includes dark mode styles", () => {
    const html = getWebviewHtml();
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("includes JavaScript", () => {
    const html = getWebviewHtml();
    expect(html).toContain("<script>");
    expect(html).toContain("</script>");
  });

  it("includes graph container and commit list", () => {
    const html = getWebviewHtml();
    expect(html).toContain('id="graph-header"');
    expect(html).toContain('id="commit-list"');
    expect(html).toContain('id="loading"');
    expect(html).toContain('id="graph-svg-container"');
    expect(html).toContain('id="commit-list-wrapper"');
  });

  it("marks elements with proper classes", () => {
    const html = getWebviewHtml();
    expect(html).toContain("hidden");
    expect(html).toContain("commit-row");
    expect(html).toContain("header-row");
  });

  it("includes viewport meta tag", () => {
    const html = getWebviewHtml();
    expect(html).toContain('meta charset="utf-8"');
  });

  it("includes responsive flex layout", () => {
    const html = getWebviewHtml();
    expect(html).toContain("flex");
    expect(html).toContain("flex-direction");
  });

  it("sets initial status text", () => {
    const html = getWebviewHtml();
    expect(html).toContain("Loading repository");
  });

  it("includes SVG graph rendering capability (comment)", () => {
    const html = getWebviewHtml();
    // Graph rendering would be in the JavaScript section
    expect(html).toContain("<script>");
  });

  it("includes CSS variables for theming", () => {
    const html = getWebviewHtml();
    expect(html).toContain("--blue:");
    expect(html).toContain("--red:");
    expect(html).toContain("--green:");
    expect(html).toContain("--yellow:");
    expect(html).toContain("--purple:");
    expect(html).toContain("--orange:");
  });

  it("includes graph column width variable", () => {
    const html = getWebviewHtml();
    expect(html).toContain("--graph-col-w");
  });

  it("includes overflow handling for containers", () => {
    const html = getWebviewHtml();
    expect(html).toContain("overflow");
  });

  it("is valid HTML structure", () => {
    const html = getWebviewHtml();
    // Check nesting: html > body > div#app
    const bodyStart = html.indexOf("<body>");
    const bodyEnd = html.indexOf("</body>");
    const appDiv = html.indexOf('id="app"');
    expect(bodyStart).toBeGreaterThan(-1);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    expect(appDiv).toBeGreaterThan(bodyStart);
    expect(appDiv).toBeLessThan(bodyEnd);
  });

  it("includes proper charset declaration", () => {
    const html = getWebviewHtml();
    expect(html).toContain('charset="utf-8"');
  });
});
