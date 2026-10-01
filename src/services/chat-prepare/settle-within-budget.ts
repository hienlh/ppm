/**
 * Race a promise against a budget, without ever rejecting and without ever leaving the
 * original promise unhandled.
 *
 * `/chat/prepare` runs several independent parts (slash items, usage, tags, a draft) under
 * their own budgets, so a slow one must not delay the rest — it comes back as `fallback`
 * instead. The original promise is always given both a fulfil and a reject handler, even
 * after the budget has already resolved this wrapper: a promise nobody is `.catch()`-ing
 * that rejects later counts as an unhandled rejection, and three of those in 60 seconds
 * exits the server (see `src/server/index.ts`). `fallback` covers both a timeout and a
 * genuine rejection — a caller that cannot tell the two apart from the outside is exactly
 * the point, since both mean "this part did not come back in time to trust it".
 */
export function settleWithinBudget<T, F>(promise: Promise<T>, budgetMs: number, fallback: F): Promise<T | F> {
  return new Promise<T | F>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, budgetMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
