import { afterEach, describe, expect, it } from "bun:test";
import {
  abandonAllExportTickets, claimExportTicket, isExportTicket, issueExportTicket, type ExportDownload,
} from "../../../../src/services/database/grid-export-tickets.ts";

function download(): ExportDownload & { abandoned: number } {
  const d = {
    fileName: "t.csv",
    contentType: "text/csv",
    abandoned: 0,
    open: () => new ReadableStream<Uint8Array>(),
    abandon: () => { d.abandoned++; },
  };
  return d;
}

afterEach(() => abandonAllExportTickets());

describe("export tickets", () => {
  it("are 32 random bytes as base64url, never the same twice", () => {
    const a = issueExportTicket(download());
    const b = issueExportTicket(download());
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("are claimed once", () => {
    const d = download();
    const ticket = issueExportTicket(d);
    expect(claimExportTicket(ticket)).toBe(d);
    expect(claimExportTicket(ticket)).toBeNull();
  });

  it("are looked at without being spent", () => {
    const ticket = issueExportTicket(download());
    expect(isExportTicket(ticket)).toBe(true);
    expect(isExportTicket(ticket)).toBe(true);
    expect(claimExportTicket(ticket)).not.toBeNull();
    expect(isExportTicket(ticket)).toBe(false);
  });

  it("refuse anything not issued, whatever its shape", () => {
    issueExportTicket(download());
    for (const t of ["", "A".repeat(43), "../etc/passwd", "A".repeat(44), undefined]) {
      expect(isExportTicket(t)).toBe(false);
      if (t !== undefined) expect(claimExportTicket(t)).toBeNull();
    }
  });

  it("let go of a download nobody comes for once they expire", async () => {
    const d = download();
    const ticket = issueExportTicket(d, 20);
    await new Promise((r) => setTimeout(r, 60));
    expect(d.abandoned).toBe(1);
    expect(isExportTicket(ticket)).toBe(false);
    expect(claimExportTicket(ticket)).toBeNull();
  });

  it("do not let go of a download once it is claimed", async () => {
    const d = download();
    const ticket = issueExportTicket(d, 20);
    claimExportTicket(ticket);
    await new Promise((r) => setTimeout(r, 60));
    expect(d.abandoned).toBe(0);
  });

  it("let go of every waiting download at once, and only those", () => {
    const waiting = [download(), download()];
    const claimed = download();
    for (const d of waiting) issueExportTicket(d);
    claimExportTicket(issueExportTicket(claimed));
    abandonAllExportTickets();
    expect(waiting.map((d) => d.abandoned)).toEqual([1, 1]);
    expect(claimed.abandoned).toBe(0);
  });
});
