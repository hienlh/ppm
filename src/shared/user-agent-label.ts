/**
 * A browser's user agent as a person would name it: "Chrome 154 on macOS", or "Chrome·Mac" as
 * the tag on its lines in Logs. Only the browsers and systems PPM is opened from are told apart;
 * anything else is "Browser".
 */
export interface UserAgentInfo {
  browser: string;
  version: string | null;
  os: string;
}

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\/(\d+)/, "Edge"],
  [/\bOPR\/(\d+)/, "Opera"],
  [/\bSamsungBrowser\/(\d+)/, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\/(\d+)/, "Firefox"],
  [/\bCriOS\/(\d+)/, "Chrome"],
  [/\bChrome\/(\d+)/, "Chrome"],
  [/\bVersion\/(\d+)(?:\.\d+)*.*\bSafari\//, "Safari"],
];

const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\b(?:Macintosh|Mac OS X)\b/, "macOS"],
  [/\bWindows\b/, "Windows"],
  [/\bLinux\b/, "Linux"],
];

export function describeUserAgent(ua: string | null | undefined): UserAgentInfo {
  const text = ua ?? "";
  let browser = "Browser";
  let version: string | null = null;
  for (const [re, name] of BROWSERS) {
    const m = re.exec(text);
    if (m) {
      browser = name;
      version = m[1] ?? null;
      break;
    }
  }
  const os = SYSTEMS.find(([re]) => re.test(text))?.[1] ?? "Unknown OS";
  return { browser, version, os };
}

/** "Chrome 154 on macOS". */
export function userAgentSummary(ua: string | null | undefined): string {
  const { browser, version, os } = describeUserAgent(ua);
  return `${browser}${version ? ` ${version}` : ""} on ${os}`;
}

/** "Chrome·Mac": short enough for the tag column. */
export function userAgentTag(ua: string | null | undefined): string {
  const { browser, os } = describeUserAgent(ua);
  const shortOs = os === "macOS" ? "Mac" : os === "Unknown OS" ? "" : os;
  const shortBrowser = browser === "Samsung Internet" ? "Samsung" : browser;
  return shortOs ? `${shortBrowser}·${shortOs}` : shortBrowser;
}
