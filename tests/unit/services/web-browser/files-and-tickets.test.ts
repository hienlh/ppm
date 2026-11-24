import { describe, expect, test } from "bun:test";
import { cleanFileName } from "../../../../src/services/web-browser/upload-store.ts";
import { attachmentHeader, isDownloadTicket, mintDownloadTicket, spendDownloadTicket } from "../../../../src/services/web-browser/download-manager.ts";

describe("cleanFileName", () => {
  test("keeps the name and extension, drops any path and reserved characters", () => {
    expect(cleanFileName("ảnh chụp.png")).toBe("ảnh chụp.png");
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName("C:\\Users\\a\\b<c>.txt")).toBe("b_c_.txt");
    expect(cleanFileName("...hidden")).toBe("hidden");
    expect(cleanFileName("")).toBe("file");
  });

  test("shortens long names without losing the extension", () => {
    const n = cleanFileName(`${"a".repeat(300)}.pdf`);
    expect(n.length).toBe(120);
    expect(n.endsWith(".pdf")).toBe(true);
  });
});

describe("download tickets", () => {
  test("an unknown download gets no ticket, and a random string is no ticket", () => {
    expect(mintDownloadTicket("nope")).toBeNull();
    expect(isDownloadTicket("0190a6e0-0000-7000-8000-000000000000")).toBe(false);
    expect(spendDownloadTicket("whatever")).toBeNull();
  });

  test("the attachment header carries any name safely", () => {
    const h = attachmentHeader('báo "cáo".pdf');
    expect(h).toStartWith('attachment; filename="b_o _c_o_.pdf"');
    expect(h).toContain("filename*=UTF-8''b%C3%A1o%20%22c%C3%A1o%22.pdf");
  });
});
