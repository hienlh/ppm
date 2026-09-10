/**
 * Export simulation: run an export and compare the token before, in, and after it.
 *
 * Exists because exporting an OAuth account can rotate the stored token as a side effect —
 * so "the exported file works" and "the account still works" are two different questions.
 * Each run appends a round instead of replacing the last one, because the interesting
 * signal is the difference BETWEEN runs.
 *
 * Tokens are shown as previews from the server; the full values are only ever handed back
 * to the probe endpoint, never rendered or logged.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  testExport, testRawToken,
  type AccountInfo, type ExportedTokenInfo,
} from "../../../lib/api-settings";

interface Round {
  round: number;
  time: string;
  includeRefresh: boolean;
  items: ExportedTokenInfo[];
}

interface RawTest {
  loading: boolean;
  status?: string;
  code?: number;
  error?: string;
}

/** Minutes left, or "exp". `expires` is in seconds. */
function shortExpiry(expires: number): string {
  const nowSecs = Math.floor(Date.now() / 1000);
  return expires > nowSecs ? `${Math.floor((expires - nowSecs) / 60)}m` : "exp";
}

export function AccountExportSimulation({ accounts }: { accounts: AccountInfo[] }) {
  const [rounds, setRounds] = useState<Round[]>([]);
  const [running, setRunning] = useState(false);
  const [includeRefresh, setIncludeRefresh] = useState(false);
  const [rawTests, setRawTests] = useState<Map<string, RawTest>>(new Map());

  const exportable = accounts.filter((a) => a.hasRefreshToken);

  async function run() {
    if (exportable.length === 0) return;
    setRunning(true);
    try {
      const items = await testExport(exportable.map((a) => a.id), includeRefresh);
      setRounds((prev) => [
        ...prev,
        { round: prev.length + 1, time: new Date().toLocaleTimeString(), includeRefresh, items },
      ]);
    } catch {
      /* the rounds already on screen stay useful; a failed run just adds nothing */
    }
    setRunning(false);
  }

  async function probe(key: string, token: string) {
    setRawTests((prev) => new Map(prev).set(key, { loading: true }));
    try {
      const result = await testRawToken(token);
      setRawTests((prev) => new Map(prev).set(key, { loading: false, ...result }));
    } catch (e) {
      setRawTests((prev) => new Map(prev).set(key, { loading: false, status: "error", error: (e as Error).message }));
    }
  }

  function rowsFor(round: Round, item: ExportedTokenInfo) {
    return [
      { key: `r${round.round}-pre-${item.id}`, label: "Pre-export", token: item.preExportTokenFull, preview: item.preExportToken, expires: item.preExportExpires },
      { key: `r${round.round}-exp-${item.id}`, label: "Exported", token: item.exportedTokenFull, preview: item.exportedToken, expires: item.exportedExpires },
      { key: `r${round.round}-post-${item.id}`, label: "Post-export", token: item.postExportTokenFull, preview: item.postExportToken, expires: item.postExportExpires },
    ];
  }

  function probeEverything() {
    for (const round of rounds) {
      for (const item of round.items) {
        for (const row of rowsFor(round, item)) {
          if (row.token) void probe(row.key, row.token);
        }
      }
    }
  }

  return (
    <section className="border-t pt-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">Simulate export</p>
        {rounds.length > 0 && (
          <span className="text-[10px] text-muted-foreground">{rounds.length} round(s)</span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Every run appends a round. Earlier rounds are kept so tokens can be compared across runs.
      </p>

      {exportable.length === 0 ? (
        <p className="text-xs text-muted-foreground">No OAuth account with a refresh token to export.</p>
      ) : (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Switch
              id="sim-include-refresh"
              checked={includeRefresh}
              onCheckedChange={setIncludeRefresh}
              className="cursor-pointer"
            />
            <Label htmlFor="sim-include-refresh" className="text-[11px] cursor-pointer">
              Include refresh tokens
            </Label>
          </div>
          <Button size="sm" className="h-7 text-xs cursor-pointer" disabled={running} onClick={() => void run()}>
            {running ? <><Loader2 className="size-3 animate-spin mr-1" /> Exporting...</> : `Run export #${rounds.length + 1}`}
          </Button>
        </div>
      )}

      {rounds.length > 0 && (
        <div className="space-y-3">
          <Button
            size="sm"
            variant="outline"
            className="w-full h-7 text-[11px] cursor-pointer"
            onClick={probeEverything}
          >
            Test all tokens ({rounds.reduce((n, r) => n + r.items.length * 3, 0)})
          </Button>

          {rounds.map((round) => (
            <div key={round.round} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium text-primary">Round #{round.round}</p>
                <span className="text-[10px] text-muted-foreground">{round.time}</span>
                <Badge variant={round.includeRefresh ? "destructive" : "secondary"} className="text-[9px] px-1 py-0">
                  {round.includeRefresh ? "with refresh" : "access only"}
                </Badge>
              </div>
              {round.items.map((item) => (
                <div key={`r${round.round}-${item.id}`} className="p-2 rounded-lg border bg-card space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium">{item.label ?? item.email ?? item.id.slice(0, 8)}</span>
                    {item.tokenChanged && (
                      <Badge variant="secondary" className="text-[9px] px-1 py-0">DB token changed</Badge>
                    )}
                  </div>
                  {rowsFor(round, item).map((row) => {
                    const test = rawTests.get(row.key);
                    return (
                      <div key={row.key} className="flex items-center gap-1.5 text-[11px]">
                        <span className="w-20 shrink-0 text-muted-foreground text-[10px]">{row.label}</span>
                        <code className="flex-1 truncate font-mono text-[10px] bg-muted px-1 rounded">
                          {row.preview ?? "N/A"}
                        </code>
                        {row.expires && (
                          <span className="text-[10px] text-muted-foreground shrink-0">{shortExpiry(row.expires)}</span>
                        )}
                        {row.token ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[10px] px-1.5 cursor-pointer shrink-0"
                            disabled={test?.loading}
                            onClick={() => void probe(row.key, row.token!)}
                          >
                            {test?.loading ? <Loader2 className="size-3 animate-spin" /> : "Test"}
                          </Button>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">-</span>
                        )}
                        {test && !test.loading && (
                          <span className={`text-[10px] font-medium shrink-0 ${test.status?.startsWith("valid") ? "text-success" : "text-error"}`}>
                            {test.status}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
