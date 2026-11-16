/**
 * The web address a task link opens at, built the same way for the browser chips and the Telegram
 * cards: a Jira key on its project's Jira site (`<site>/browse/NX-6284`), a PR on GitHub, a URL as
 * it is. Only `http:` and `https:` ever come out; anything else (or a ref that does not parse) is
 * null, and a chat link is null too because it opens inside PPM, not in a browser tab.
 */
import type { TaskLink } from "./ppm-tasks.ts";
import { parseJiraKey, parsePrRef } from "./ppm-tasks-refs.ts";

/** The address as the browser would load it, when it is an `http:`/`https:` one; null otherwise. */
export function safeWebUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

/**
 * A Jira site address (a project's Jira base URL) without its trailing slash, query or fragment,
 * keeping a path so a Jira Server installed under `/jira` still works; null when it is not a web
 * address or carries credentials.
 */
export function jiraSiteUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  const href = safeWebUrl(baseUrl);
  if (!href) return null;
  const url = new URL(href);
  if (url.username || url.password) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export interface LinkHrefContext {
  /** The task's project's Jira site; without it a Jira key has nowhere to open. */
  jiraSite?: string | null;
}

/** Where this link opens in a browser tab; null when it has no safe web address. */
export function taskLinkWebHref(link: Pick<TaskLink, "kind" | "ref">, ctx: LinkHrefContext = {}): string | null {
  switch (link.kind) {
    case "url":
      return safeWebUrl(link.ref);
    case "pr": {
      const pr = parsePrRef(link.ref);
      return pr ? `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}` : null;
    }
    case "jira": {
      const key = parseJiraKey(link.ref);
      const site = jiraSiteUrl(ctx.jiraSite);
      return key && site ? `${site}/browse/${key}` : null;
    }
    default:
      return null;
  }
}
