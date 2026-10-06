/**
 * The ntfy server, topic and access token, with the steps to subscribe to them.
 *
 * The server checks that the address answers as ntfy and accepts the token before saving.
 * Whether the token may publish to the topic only a publish can tell, which is what
 * Send a test is for.
 */
import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ExternalLink } from "@/lib/icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { normalizeNtfyServer, type NtfyStatus } from "../../../shared/notification-settings";

const DEFAULT_SERVER = "https://ntfy.sh";

/** On a public server anyone who knows a topic's name can read it, so the suggestion is not guessable. */
function randomTopic(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `ppm-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

function hostOf(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

export function NtfyServerForm({ status, onSaved, onRemove }: {
  status: NtfyStatus;
  onSaved: (next: NtfyStatus) => void;
  onRemove: () => void;
}) {
  const serverId = useId();
  const topicId = useId();
  const tokenId = useId();
  const [server, setServer] = useState(status.server || DEFAULT_SERVER);
  const [topic, setTopic] = useState(() => status.topic || randomTopic());
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(!status.configured);

  // A saved token is only ever sent to the server it was saved for.
  const typedServer = normalizeNtfyServer(server);
  const keepsToken = status.tokenSet && typedServer === status.server;
  const dirty = !status.configured || typedServer !== status.server || topic.trim() !== status.topic || token.trim() !== "";

  const edit = (set: (value: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    set(e.target.value);
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<NtfyStatus>("/api/notifications/ntfy", {
        server,
        topic,
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      setToken("");
      setGuideOpen(false);
      onSaved(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field id={serverId} label="Server">
          <Input
            id={serverId}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            placeholder={DEFAULT_SERVER}
            value={server}
            onChange={edit(setServer)}
            className="h-11 w-full text-sm md:h-9"
          />
        </Field>
        <Field id={topicId} label="Topic">
          <Input
            id={topicId}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            value={topic}
            onChange={edit(setTopic)}
            className="h-11 w-full font-mono text-sm md:h-9"
          />
        </Field>
        <Field id={tokenId} label="Access token — only if the server requires sign-in">
          <Input
            id={tokenId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={keepsToken ? "••••••  (saved)" : "tk_…"}
            value={token}
            onChange={edit(setToken)}
            className="h-11 w-full font-mono text-sm md:h-9"
          />
        </Field>
        {status.tokenSet && !keepsToken && !token.trim() && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            The saved token is for {hostOf(status.server)} and is not sent to another server.
          </p>
        )}
        {error && <p className="text-xs text-error">{error}</p>}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={saving || !dirty} className="min-h-11 cursor-pointer md:min-h-9">
            {saving ? "Checking…" : "Save"}
          </Button>
          {status.configured && (
            <Button type="button" variant="ghost" onClick={onRemove} className="min-h-11 cursor-pointer text-error hover:text-error md:min-h-9">
              Remove ntfy
            </Button>
          )}
        </div>
      </form>

      <button
        type="button"
        onClick={() => setGuideOpen((open) => !open)}
        aria-expanded={guideOpen}
        className="flex min-h-11 cursor-pointer items-center gap-1 text-xs text-primary md:min-h-8"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", !guideOpen && "-rotate-90")} />
        How to set up ntfy
      </button>
      {guideOpen && (
        <div className="space-y-3 rounded-lg border border-border px-4 py-3">
          <ol className="list-decimal space-y-1.5 pl-4 text-sm leading-relaxed">
            <li>Install the ntfy app on your phone, or open the server in a browser.</li>
            <li>
              Subscribe to the topic above. For a server other than ntfy.sh, turn on <b>Use another server</b> and
              enter its address.
            </li>
            <li>
              If the server asks you to sign in, create a token in its web app under <b>Account → Access tokens</b> and
              paste it above. Its user needs permission to publish to the topic.
            </li>
            <li>Save, then send a test.</li>
          </ol>
          <p className="text-xs leading-relaxed text-muted-foreground">
            On ntfy.sh anyone who knows a topic's name can read it, so keep the name hard to guess. An iPhone gets
            instant alerts from a server of your own only when that server sets{" "}
            <code className="rounded bg-muted px-1 py-0.5">upstream-base-url: "https://ntfy.sh"</code>.
          </p>
          <a
            href="https://docs.ntfy.sh/subscribe/phone/"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: "outline" }), "min-h-11 w-full gap-2 md:min-h-9 sm:w-auto")}
          >
            The ntfy app guide
            <ExternalLink className="size-3.5" />
          </a>
        </div>
      )}
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
