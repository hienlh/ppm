/**
 * A remote's URL can carry a token (`https://user:token@host/…`) and git repeats it in its own
 * errors, so anything that shows a git error to an AI — the Assistant's git tools, the `ppm git`
 * CLI an AI chat's shell runs — passes it through here first.
 */

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`]+/gi;
/** scp-like remotes: `git@github.com:owner/repo.git`. */
const SCP_LIKE = /\b[\w.+-]+@[\w.-]+:[\w./~+-]+/g;

export function hideRemoteUrls(text: string): string {
  return text.replace(URL_LIKE, "<remote URL hidden>").replace(SCP_LIKE, "<remote URL hidden>");
}
