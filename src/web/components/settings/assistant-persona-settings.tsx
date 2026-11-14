/**
 * Settings → PPM Assistant → General: the Assistant's name, the ways it may address the user, and
 * its character ("soul"). Part of the General pane's draft and saved by its one Save button.
 *
 * These change how the Assistant talks and what PPM calls it — never what it may do. The server
 * puts them after every rule in its instructions (`assistant-instructions-persona.ts`).
 */
import { Plus, Trash2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PERSONA_ADDRESS_FIELD_MAX_CHARS, PERSONA_ADDRESS_WHEN_MAX_CHARS, PERSONA_MAX_ADDRESS_FORMS, PERSONA_NAME_MAX_CHARS,
  PERSONA_SOUL_MAX_CHARS, type AssistantAddressForm, type AssistantPersona,
} from "../../../shared/assistant-persona";
import { IconButton, SectionHeader } from "./settings-rows";

const FIELD = "h-11 md:h-8";

/** Whether the draft can be saved as it stands: only the soul can outgrow its limit while typing. */
export function personaDraftTooLong(persona: AssistantPersona): boolean {
  return persona.soul.length > PERSONA_SOUL_MAX_CHARS;
}

export function AssistantPersonaSettings({ value, disabled, onChange }: {
  value: AssistantPersona;
  disabled?: boolean;
  onChange: (next: AssistantPersona) => void;
}) {
  const forms = value.address_forms;
  const setForm = (index: number, next: Partial<AssistantAddressForm>) =>
    onChange({ ...value, address_forms: forms.map((f, i) => (i === index ? { ...f, ...next } : f)) });
  const soulTooLong = personaDraftTooLong(value);

  return (
    <div className="@container space-y-4" data-assistant-persona="">
      <SectionHeader title="Name and personality">
        How the Assistant talks to you. This changes only its voice: every rule, approval and limit
        stays the same.
      </SectionHeader>

      <div className="space-y-1">
        <Label htmlFor="asst-persona-name" className="text-xs text-text-subtle">Name</Label>
        <Input id="asst-persona-name" className={FIELD} value={value.name} disabled={disabled}
          maxLength={PERSONA_NAME_MAX_CHARS} placeholder="PPM Assistant" autoComplete="off"
          onChange={(e) => onChange({ ...value, name: e.target.value })} />
        <p className="text-xs text-text-subtle">Shown on its window, its cards and its Telegram messages. Empty keeps “PPM Assistant”.</p>
      </div>

      <div className="space-y-2">
        <div>
          <p className="text-xs text-text-subtle">Ways to address you</p>
          <p className="text-xs text-muted-foreground">
            It picks one by the moment — say when each fits — and keeps it for the whole message.
          </p>
        </div>
        {forms.length === 0 && <p className="text-xs text-text-subtle">None yet: it addresses you however it sees fit.</p>}
        <ul className="space-y-2">
          {forms.map((form, i) => (
            <li key={i} data-address-form={i}
              className="grid grid-cols-[1fr_1fr_auto] items-end gap-2 rounded-md border border-border p-2 @[560px]:grid-cols-[8rem_8rem_1fr_auto] @[560px]:border-0 @[560px]:p-0">
              <div className="min-w-0 space-y-1">
                <Label htmlFor={`asst-form-user-${i}`} className="text-[11px] text-text-subtle">Calls you</Label>
                <Input id={`asst-form-user-${i}`} className={FIELD} value={form.user} disabled={disabled}
                  maxLength={PERSONA_ADDRESS_FIELD_MAX_CHARS} placeholder="anh" autoComplete="off"
                  onChange={(e) => setForm(i, { user: e.target.value })} />
              </div>
              <div className="min-w-0 space-y-1">
                <Label htmlFor={`asst-form-self-${i}`} className="text-[11px] text-text-subtle">Calls itself</Label>
                <Input id={`asst-form-self-${i}`} className={FIELD} value={form.self} disabled={disabled}
                  maxLength={PERSONA_ADDRESS_FIELD_MAX_CHARS} placeholder="em" autoComplete="off"
                  onChange={(e) => setForm(i, { self: e.target.value })} />
              </div>
              <div className="col-span-2 min-w-0 space-y-1 @[560px]:col-span-1 @[560px]:col-start-3 @[560px]:row-start-1">
                <Label htmlFor={`asst-form-when-${i}`} className="text-[11px] text-text-subtle">When</Label>
                <Input id={`asst-form-when-${i}`} className={FIELD} value={form.when} disabled={disabled}
                  maxLength={PERSONA_ADDRESS_WHEN_MAX_CHARS} placeholder="e.g. urgent news, asking for approval" autoComplete="off"
                  onChange={(e) => setForm(i, { when: e.target.value })} />
              </div>
              <div className="col-start-3 row-start-1 self-start @[560px]:col-start-4 @[560px]:self-end">
                <IconButton label={`Remove form of address ${i + 1}`} danger disabled={disabled}
                  onClick={() => onChange({ ...value, address_forms: forms.filter((_, idx) => idx !== i) })}>
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
        <Button variant="outline" size="sm" className="h-11 gap-1 md:h-8" disabled={disabled || forms.length >= PERSONA_MAX_ADDRESS_FORMS}
          onClick={() => onChange({ ...value, address_forms: [...forms, { user: "", self: "", when: "" }] })}>
          <Plus className="size-4" /> Add a way to address you
        </Button>
      </div>

      <div className="space-y-1">
        <Label htmlFor="asst-persona-soul" className="text-xs text-text-subtle">Personality</Label>
        <textarea id="asst-persona-soul" rows={4} value={value.soul} disabled={disabled}
          onChange={(e) => onChange({ ...value, soul: e.target.value })}
          placeholder="For example: cheerful and warm, jokes a little when things go well, serious and brief when something breaks."
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <p className={soulTooLong ? "text-xs text-destructive" : "text-xs text-text-subtle"}>
          {value.soul.length.toLocaleString()} / {PERSONA_SOUL_MAX_CHARS.toLocaleString()} characters
        </p>
      </div>
    </div>
  );
}
