/**
 * Token diagnostics: does each stored token still authenticate?
 *
 * Read-only against the accounts — it asks the server to probe a token and reports the
 * status. Nothing here rotates, parks, or rewrites an account, which is why it can be run
 * freely while chasing an auth problem.
 */

import { useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { testAccountToken, type AccountInfo, type TokenTestResult } from "../../../lib/api-settings";
import { AccountExportSimulation } from "./account-export-simulation";

interface TestState {
  loading: boolean;
  result?: TokenTestResult;
  error?: string;
}

/** Minutes until expiry, or how long ago it lapsed. `expiresAt` is in seconds. */
function expiryLabel(expiresAt: number): string {
  const nowSecs = Math.floor(Date.now() / 1000);
  const mins = Math.floor(Math.abs(expiresAt - nowSecs) / 60);
  return expiresAt > nowSecs ? `${mins}m left` : `expired ${mins}m ago`;
}

export function AccountTokenTestDialog({ open, onOpenChange, accounts }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: AccountInfo[];
}) {
  const [results, setResults] = useState<Map<string, TestState>>(new Map());
  const [alsoTestRefresh, setAlsoTestRefresh] = useState(false);

  async function runTest(id: string) {
    setResults((prev) => new Map(prev).set(id, { loading: true }));
    try {
      const result = await testAccountToken(id, alsoTestRefresh);
      setResults((prev) => new Map(prev).set(id, { loading: false, result }));
    } catch (e) {
      setResults((prev) => new Map(prev).set(id, { loading: false, error: (e as Error).message }));
    }
  }

  /** Only OAuth accounts have a token that can expire; an API key has nothing to probe. */
  function runAll() {
    for (const acc of accounts.filter((a) => a.expiresAt !== null)) void runTest(acc.id);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-1.5">
            <FlaskConical className="size-4" /> Token Test
          </DialogTitle>
          <DialogDescription className="text-xs">
            Probe stored tokens for validity. Nothing is modified.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto flex-1 pr-1">
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium">Current tokens</p>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <Switch
                    id="token-test-refresh"
                    checked={alsoTestRefresh}
                    onCheckedChange={setAlsoTestRefresh}
                    className="cursor-pointer"
                  />
                  <Label htmlFor="token-test-refresh" className="text-[11px] cursor-pointer">
                    Also test refresh
                  </Label>
                </div>
                <Button size="sm" variant="outline" className="h-7 text-xs cursor-pointer" onClick={runAll}>
                  Test all
                </Button>
              </div>
            </div>

            {accounts.length === 0 && (
              <p className="text-xs text-muted-foreground">No accounts to test.</p>
            )}

            <div className="space-y-1.5">
              {accounts.map((acc) => {
                const state = results.get(acc.id);
                const status = state?.result?.accessToken.status;
                return (
                  <div key={acc.id} className="p-2 rounded border bg-card space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-medium truncate block">
                          {acc.label ?? acc.email ?? acc.id.slice(0, 8)}
                        </span>
                        {acc.expiresAt && (
                          <span className="text-[10px] text-muted-foreground">{expiryLabel(acc.expiresAt)}</span>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs cursor-pointer shrink-0"
                        disabled={state?.loading}
                        onClick={() => void runTest(acc.id)}
                      >
                        {state?.loading ? <Loader2 className="size-3 animate-spin" /> : "Test"}
                      </Button>
                    </div>
                    {state && !state.loading && (
                      <div className="text-[11px] pl-2 border-l-2 border-muted">
                        {state.error && <p className="text-error">{state.error}</p>}
                        {status && (
                          <span className={status.startsWith("valid") ? "text-success" : "text-error"}>
                            {status}
                            {state.result?.accessToken.code ? ` (${state.result.accessToken.code})` : ""}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <AccountExportSimulation accounts={accounts} />
        </div>

        <DialogFooter>
          <Button size="sm" variant="outline" className="text-xs cursor-pointer" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
