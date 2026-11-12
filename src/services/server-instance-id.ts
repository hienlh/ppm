/**
 * One id per running server process, minted at first use.
 *
 * It names this server in `/api/health`, in `/api/cli/hello` and in its endpoint file, and the
 * shells of its AI chats carry it as `PPM_INSTANCE_ID` so a `ppm` command they run picks this
 * server out of several sharing one database. Kept on `globalThis` because `bun --hot`
 * re-evaluates modules: a fresh module-level id would make the endpoint file, the health route
 * and the chats' shells disagree about who this server is.
 */
const KEY = Symbol.for("ppm.server-instance-id");

export function serverInstanceId(): string {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[KEY];
  if (typeof existing === "string") return existing;
  const id = crypto.randomUUID();
  g[KEY] = id;
  return id;
}
