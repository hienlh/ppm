import { shareCodeFromPath } from "./share-api";
import { useShareInfo } from "./use-share-info";
import { ShareReview } from "./share-review";
import { ShareFailed, ShareInvalid, ShareLoading } from "./share-states";

/** The reviewer page: what the link opens, or why it does not. */
export function ShareApp() {
  const code = shareCodeFromPath(window.location.pathname);
  const { state, retry } = useShareInfo(code);
  if (!code || state.status === "invalid") return <ShareInvalid />;
  if (state.status === "loading") return <ShareLoading />;
  if (state.status === "error") return <ShareFailed message={state.message} onRetry={retry} />;
  return <ShareReview info={state.info} code={code} />;
}
