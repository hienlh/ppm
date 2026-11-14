import { describe, expect, it } from "bun:test";
import {
  cleanPastedCallback,
  isLoopbackHostname,
  normalizeLoopbackCallback,
} from "../../../src/shared/loopback-callback-url.ts";

const CB = "/oauth/callback?code=abc-123_XYZ&state=s1";

function accepted(raw: string): string {
  const r = normalizeLoopbackCallback(raw);
  if (!r.ok) throw new Error(`expected ${JSON.stringify(raw)} to be accepted, got: ${r.reason}`);
  return r.url;
}

function rejected(raw: string): string {
  const r = normalizeLoopbackCallback(raw);
  if (r.ok) throw new Error(`expected ${JSON.stringify(raw)} to be rejected, got ${r.url}`);
  return r.reason;
}

describe("normalizeLoopbackCallback — what a phone or a note copies", () => {
  it("adds http:// when the scheme was left behind", () => {
    expect(accepted(`127.0.0.1:54132${CB}`)).toBe(`http://127.0.0.1:54132${CB}`);
    expect(accepted(`localhost:8400${CB}`)).toBe(`http://localhost:8400${CB}`);
    expect(accepted(`[::1]:8400${CB}`)).toBe(`http://[::1]:8400${CB}`);
    expect(accepted(`//127.0.0.1:8400${CB}`)).toBe(`http://127.0.0.1:8400${CB}`);
  });

  it("keeps a scheme that is there, whatever its case", () => {
    expect(accepted(`http://127.0.0.1:54132${CB}`)).toBe(`http://127.0.0.1:54132${CB}`);
    expect(accepted(`HTTP://LOCALHOST:8400${CB}`)).toBe(`http://localhost:8400${CB}`);
    expect(accepted(`https://127.0.0.1:8443${CB}`)).toBe(`https://127.0.0.1:8443${CB}`);
  });

  it("drops whitespace, line breaks and zero-width marks a copy brings along", () => {
    expect(accepted(`  \n127.0.0.1:54132${CB}\n  `)).toBe(`http://127.0.0.1:54132${CB}`);
    expect(accepted(`127.0.0.1:54132/oauth/call\nback?code=abc-\r\n123_XYZ&state=s1`)).toBe(
      `http://127.0.0.1:54132/oauth/callback?code=abc-123_XYZ&state=s1`,
    );
    expect(accepted(`\u200B127.0.0.1:54132${CB}\uFEFF`)).toBe(`http://127.0.0.1:54132${CB}`);
  });

  it("drops quotes, wrapping brackets and sentence punctuation at either end", () => {
    const want = `http://127.0.0.1:54132${CB}`;
    for (const raw of [
      `"127.0.0.1:54132${CB}"`,
      `'http://127.0.0.1:54132${CB}'`,
      `\u201C127.0.0.1:54132${CB}\u201D`,
      `(127.0.0.1:54132${CB})`,
      `<http://127.0.0.1:54132${CB}>`,
      `[http://127.0.0.1:54132${CB}]`,
      `127.0.0.1:54132${CB}.`,
      `127.0.0.1:54132${CB}),`,
      `\`127.0.0.1:54132${CB}\`;`,
      `...127.0.0.1:54132${CB}!`,
    ]) {
      expect(accepted(raw)).toBe(want);
    }
  });

  it("keeps the brackets an IPv6 host needs, and a matched bracket inside the URL", () => {
    expect(cleanPastedCallback("[::1]:8400/cb")).toBe("[::1]:8400/cb");
    expect(cleanPastedCallback("http://[::1]")).toBe("http://[::1]");
    expect(cleanPastedCallback("(http://[::1]:8400/cb)")).toBe("http://[::1]:8400/cb");
    expect(accepted("127.0.0.1:8400/cb?x=(a)")).toBe("http://127.0.0.1:8400/cb?x=(a)");
  });

  it("accepts every 127.x address and localhost without a port", () => {
    expect(accepted("127.1.2.3:9000/cb")).toBe("http://127.1.2.3:9000/cb");
    expect(accepted("localhost/cb")).toBe("http://localhost/cb");
  });
});

describe("normalizeLoopbackCallback - edge cases of the clean-up", () => {
  it("repairs an http scheme whose slashes or colon got mangled", () => {
    expect(accepted("http:127.0.0.1:5000/cb")).toBe("http://127.0.0.1:5000/cb");
    expect(accepted("http:/127.0.0.1:5000/cb")).toBe("http://127.0.0.1:5000/cb");
    expect(accepted("http//127.0.0.1:5000/cb")).toBe("http://127.0.0.1:5000/cb");
    expect(accepted("HTTPS:/localhost:5000/cb")).toBe("https://localhost:5000/cb");
    rejected("http:/evil.com/cb");
  });

  it("gives back the same URL when run on its own output, as the server does", () => {
    for (const raw of [`127.0.0.1:54132${CB}`, `"(http://[::1]:8400/cb?x=(a))".`, "http:127.0.0.1:5000/cb", "127.1:9/cb"]) {
      const once = accepted(raw);
      expect(accepted(once)).toBe(once);
    }
  });

  it("drops sentence punctuation at the very end even when it belonged to a value", () => {
    // A trade-off asked for: a phone copy far more often ends in a stray "." or ")"
    // than a callback's last value does. The field shows the URL it will send.
    expect(accepted("127.0.0.1:1/cb?state=abc.")).toBe("http://127.0.0.1:1/cb?state=abc");
    expect(accepted("127.0.0.1:1/cb?state=abc)")).toBe("http://127.0.0.1:1/cb?state=abc");
    expect(accepted("127.0.0.1:1/cb?state=(abc)")).toBe("http://127.0.0.1:1/cb?state=(abc)");
  });
});

describe("normalizeLoopbackCallback — still only this machine", () => {
  it("rejects a host that only starts or ends like a local one", () => {
    expect(rejected("localhost.evil.com:8400/cb")).toContain("localhost.evil.com");
    expect(rejected("http://localhost.evil.com/cb")).toContain("localhost.evil.com");
    expect(rejected("127.0.0.1.nip.io:8400/cb")).toContain("127.0.0.1.nip.io");
    expect(rejected("evil-localhost:8400/cb")).toContain("evil-localhost");
  });

  it("rejects a local-looking user name in front of another host", () => {
    rejected("127.0.0.1@evil.com/cb");
    rejected("http://127.0.0.1@evil.com/cb");
    rejected("http://localhost:8400@evil.com/cb");
    // A user name in front of a real loopback host has no business in a callback either.
    expect(rejected("http://user:pw@127.0.0.1:8400/cb")).toContain("user name");
  });

  it("judges the host, not a fragment, query or path that mentions a local one", () => {
    expect(rejected("http://evil.com#127.0.0.1")).toContain("evil.com");
    expect(rejected("evil.com#127.0.0.1")).toContain("evil.com");
    expect(rejected("http://evil.com/?redirect=http://127.0.0.1:8400")).toContain("evil.com");
    expect(rejected("http://evil.com/127.0.0.1:8400")).toContain("evil.com");
    expect(rejected("http://evil.com\\@127.0.0.1/cb")).toContain("evil.com");
  });

  it("accepts other spellings of a loopback address only because they parse to one", () => {
    expect(accepted("http://127.1:9/cb")).toBe("http://127.0.0.1:9/cb");
    expect(accepted("http://0x7f.1:9/cb")).toBe("http://127.0.0.1:9/cb");
    expect(accepted("http://2130706433:9/cb")).toBe("http://127.0.0.1:9/cb");
    // A backslash is a slash to the parser: what follows it is path, not host.
    expect(accepted("127.0.0.1\\@evil.com")).toBe("http://127.0.0.1/@evil.com");
    rejected("http://localhost./cb");
    rejected("http://127.0.0.1%2eevil.com/cb");
  });

  it("rejects other networks, private ranges and 0.0.0.0", () => {
    rejected("http://10.0.0.5:8400/cb");
    rejected("192.168.1.10:8400/cb");
    rejected("http://169.254.169.254/latest/meta-data");
    rejected("0.0.0.0:8400/cb");
    rejected("http://example.com/cb");
  });

  it("handles IPv6: only ::1, never an address that embeds 127.0.0.1 or another host", () => {
    expect(accepted("http://[::1]:8400/cb")).toBe("http://[::1]:8400/cb");
    expect(accepted("http://[0:0:0:0:0:0:0:1]:8400/cb")).toBe("http://[::1]:8400/cb");
    rejected("http://[::ffff:127.0.0.1]:8400/cb");
    rejected("http://[::]:8400/cb");
    rejected("http://[fe80::1]:8400/cb");
    rejected("http://[2001:db8::1]/cb");
  });

  it("does not let case hide another host", () => {
    expect(accepted("LOCALHOST:8400/CB")).toBe("http://localhost:8400/CB");
    expect(rejected("LOCALHOST.EVIL.COM:8400/cb")).toContain("localhost.evil.com");
  });

  it("refuses odd ports instead of guessing", () => {
    expect(rejected("127.0.0.1:0/cb")).toContain("Port 0");
    rejected("127.0.0.1:65536/cb");
    rejected("127.0.0.1:99999/cb");
    rejected("127.0.0.1:-1/cb");
    rejected("127.0.0.1:80a/cb");
    expect(accepted("127.0.0.1:65535/cb")).toBe("http://127.0.0.1:65535/cb");
  });

  it("accepts no scheme but http(s), and does not read a scheme-less colon as one", () => {
    expect(rejected("file:///etc/passwd")).toContain("file:");
    expect(rejected("ftp://127.0.0.1/cb")).toContain("ftp:");
    rejected("javascript:alert(1)");
    rejected("data:text/html,hi");
    rejected("ws://127.0.0.1:8400/cb");
  });

  it("gives a reason for empty or meaningless input", () => {
    expect(rejected("   ")).toContain("Paste");
    expect(rejected("\"\"")).toContain("Paste");
    rejected("http://");
  });
});

describe("isLoopbackHostname", () => {
  it("covers 127.0.0.0/8, localhost and ::1, bracketed or not", () => {
    for (const h of ["localhost", "LocalHost", "127.0.0.1", "127.255.0.9", "::1", "[::1]"]) {
      expect(isLoopbackHostname(h)).toBe(true);
    }
    for (const h of ["localhost.evil.com", "127.0.0.1.evil.com", "0.0.0.0", "10.0.0.1", "::", "evil.com"]) {
      expect(isLoopbackHostname(h)).toBe(false);
    }
  });
});
