/**
 * Values for a script's inputs, in the form and on import. A secret is a password field that is
 * never filled in: a saved one shows as saved, and a blank field keeps it.
 */
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ScheduleInputDecl } from "../../../../types/scheduler";

export function ScheduleInputValues({
  decls,
  values,
  secrets,
  secretsSet = [],
  onValue,
  onSecret,
}: {
  decls: ScheduleInputDecl[];
  values: Record<string, string>;
  secrets: Record<string, string>;
  secretsSet?: readonly string[];
  onValue: (key: string, value: string) => void;
  onSecret: (key: string, value: string) => void;
}) {
  if (decls.length === 0) return null;
  return (
    <div className="space-y-3">
      {decls.map((d) => (
        <div key={d.key} className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            {d.label || d.key}{d.required && <span className="text-error"> *</span>}
          </p>
          {d.type === "boolean" ? (
            <div className="flex items-center min-h-11 md:min-h-9">
              <Switch
                aria-label={d.label || d.key}
                checked={(values[d.key] ?? String(d.default ?? false)) === "true"}
                onCheckedChange={(v) => onValue(d.key, String(v))}
              />
            </div>
          ) : d.type === "secret" ? (
            <Input
              type="password"
              autoComplete="new-password"
              aria-label={d.label || d.key}
              value={secrets[d.key] ?? ""}
              onChange={(e) => onSecret(d.key, e.target.value)}
              placeholder={secretsSet.includes(d.key) ? "Saved — leave blank to keep" : "Not set"}
              className="h-11 md:h-9 text-xs"
            />
          ) : (
            <Input
              aria-label={d.label || d.key}
              value={values[d.key] ?? ""}
              onChange={(e) => onValue(d.key, e.target.value)}
              placeholder={d.default !== undefined ? `Default: ${String(d.default)}` : ""}
              inputMode={d.type === "number" ? "decimal" : undefined}
              className="h-11 md:h-9 text-xs"
            />
          )}
          {d.description && <p className="text-[11px] text-muted-foreground">{d.description}</p>}
        </div>
      ))}
    </div>
  );
}
