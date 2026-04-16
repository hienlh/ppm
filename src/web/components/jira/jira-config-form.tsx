import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useJiraStore } from "@/stores/jira-store";
import { CheckCircle, AlertCircle, Loader2, Trash2 } from "lucide-react";

interface Props {
  projectId: number;
  existing?: { baseUrl: string; email: string; hasToken: boolean } | null;
}

export function JiraConfigForm({ projectId, existing }: Props) {
  const { saveConfig, deleteConfig, testConnection } = useJiraStore();
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!baseUrl || !email || (!token && !existing?.hasToken)) return;
    setSaving(true);
    try {
      await saveConfig(projectId, { baseUrl, email, ...(token ? { token } : {}) });
      setToken("");
    } catch {}
    setSaving(false);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const ok = await testConnection(projectId);
      setTestResult(ok ? "ok" : "fail");
    } catch (e: any) {
      setTestResult("fail");
      setTestError(e?.message ?? "Connection failed");
    }
    setTesting(false);
  };

  return (
    <form onSubmit={handleSave} className="space-y-3">
      <div>
        <label className="text-xs text-muted-foreground">Base URL</label>
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://mysite.atlassian.net"
          className="h-9"
        />
      </div>
      <div>
        <label className="text-xs text-muted-foreground">Email</label>
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className="h-9"
        />
      </div>
      <div>
        <label className="text-xs text-muted-foreground">
          API Token {existing?.hasToken && <span className="text-green-500">(saved)</span>}
        </label>
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={existing?.hasToken ? "Enter new token to replace" : "Your Jira API token"}
          className="h-9"
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Button type="submit" size="sm" disabled={saving} className="min-w-[44px] min-h-[44px]">
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
        </Button>
        {existing && (
          <>
            <Button type="button" size="sm" variant="outline" onClick={handleTest} disabled={testing} className="min-h-[44px]">
              {testing ? <Loader2 className="size-4 animate-spin" /> : "Test Connection"}
            </Button>
            <Button type="button" size="sm" variant="destructive" onClick={() => deleteConfig(projectId)} className="min-h-[44px]">
              <Trash2 className="size-4" />
            </Button>
          </>
        )}
        {testResult === "ok" && <CheckCircle className="size-4 text-green-500" />}
        {testResult === "fail" && <AlertCircle className="size-4 text-red-500" />}
      </div>
      {testError && (
        <p className="text-xs text-red-500 break-all">{testError}</p>
      )}
    </form>
  );
}
